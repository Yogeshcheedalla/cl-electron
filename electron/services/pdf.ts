import { readFile } from 'node:fs/promises'
import { constants, inflateRawSync, inflateSync } from 'node:zlib'

/**
 * PDF text extraction with nothing but `node:zlib`.
 *
 * The file is not parsed through its cross-reference table. Every `N G obj`
 * header is scanned instead, which survives the broken xref offsets that real
 * PDFs are full of, and the scan skips over stream bytes so binary payloads
 * cannot be mistaken for object headers. Objects hidden inside `/ObjStm`
 * compressed object streams (PDF 1.5+) are expanded and scanned too.
 *
 * Text comes from the content stream operators -- `Tj`, `TJ`, `'` and `"` --
 * with `/ToUnicode` CMaps applied so ligatures and subset-encoded fonts decode
 * to real characters. Line breaks are inferred from the text matrix.
 *
 * ponytail: this replaces a ~4 MB pdfjs-dist dependency with one file, because
 * the only thing Akansha needs from a PDF is its text. What it deliberately does
 * NOT do: OCR a scanned page, decrypt a password-protected file, or resolve
 * CID fonts that ship no `/ToUnicode` map. Each of those reports itself rather
 * than returning a plausible-looking empty string.
 */

const LATIN = 'latin1' as const

interface PdfObject {
  id: number
  dict: string
  stream?: Buffer
}

interface FontInfo {
  bytes: 1 | 2
  map: Map<number, string>
}

export interface PdfText {
  text: string
  pages: number
  /** Characters dropped because their font had no usable Unicode mapping. */
  unmapped: number
}

// ---------------------------------------------------------------- dictionaries

/** Returns `<<...>>` starting at `from`, matching nesting. */
function sliceDict(text: string, from: number): string {
  let depth = 0
  for (let i = from; i < text.length - 1; i++) {
    if (text[i] === '<' && text[i + 1] === '<') {
      depth++
      i++
    } else if (text[i] === '>' && text[i + 1] === '>') {
      depth--
      i++
      if (depth === 0) return text.slice(from, i + 1)
    }
  }
  return text.slice(from)
}

function sliceArray(text: string, from: number): string {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    if (text[i] === '[') depth++
    else if (text[i] === ']') {
      depth--
      if (depth === 0) return text.slice(from, i + 1)
    }
  }
  return text.slice(from)
}

/** The raw token for `/key` in a dictionary: a dict, an array, a ref, a name or a number. */
function entry(dict: string, key: string): string | null {
  const re = new RegExp(`/${key}\\b`, 'g')
  const m = re.exec(dict)
  if (!m) return null
  let i = m.index + m[0].length
  while (i < dict.length && /\s/.test(dict[i] as string)) i++
  if (dict.startsWith('<<', i)) return sliceDict(dict, i)
  if (dict[i] === '[') return sliceArray(dict, i)
  const rest = dict.slice(i)
  const ref = rest.match(/^\d+\s+\d+\s+R\b/)
  if (ref) return ref[0]
  const tok = rest.match(/^(\/[^\s/[\]()<>]*|[-+.\d]+|[A-Za-z]+)/)
  return tok ? tok[0] : null
}

const refId = (token: string | null): number | null => {
  const m = token?.match(/^(\d+)\s+\d+\s+R$/)
  return m ? Number(m[1]) : null
}

const num = (dict: string, key: string, fallback: number): number => {
  const n = Number(entry(dict, key))
  return Number.isFinite(n) ? n : fallback
}

/** Follows an indirect reference to the referenced object's dictionary text. */
function deref(token: string | null, objs: Map<number, PdfObject>): string {
  const id = refId(token)
  if (id === null) return token ?? ''
  return objs.get(id)?.dict ?? ''
}

// -------------------------------------------------------------------- filters

/** Undoes the PNG row predictors that xref and object streams normally use. */
function applyPredictor(data: Buffer, parms: string): Buffer {
  const predictor = num(parms, 'Predictor', 1)
  if (predictor < 10) return data
  const colors = num(parms, 'Colors', 1)
  const bpc = num(parms, 'BitsPerComponent', 8)
  const columns = num(parms, 'Columns', 1)
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8))
  const rowLen = Math.ceil((colors * bpc * columns) / 8)
  const rows: Buffer[] = []
  let prev = Buffer.alloc(rowLen)
  for (let pos = 0; pos + 1 < data.length; pos += rowLen + 1) {
    const type = data[pos] as number
    const row = Buffer.from(data.subarray(pos + 1, pos + 1 + rowLen))
    if (!row.length) break
    for (let i = 0; i < row.length; i++) {
      const left = i >= bpp ? (row[i - bpp] as number) : 0
      const up = prev[i] ?? 0
      const upLeft = i >= bpp ? prev[i - bpp] ?? 0 : 0
      const raw = row[i] as number
      if (type === 1) row[i] = (raw + left) & 0xff
      else if (type === 2) row[i] = (raw + up) & 0xff
      else if (type === 3) row[i] = (raw + ((left + up) >> 1)) & 0xff
      else if (type === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        row[i] = (raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff
      }
    }
    rows.push(row)
    prev = row
  }
  return rows.length ? Buffer.concat(rows) : data
}

/** Tolerates the truncated deflate streams some writers emit. */
function inflate(data: Buffer): Buffer {
  const opts = { finishFlush: constants.Z_SYNC_FLUSH }
  try {
    return inflateSync(data, opts)
  } catch {
    /* fall through */
  }
  try {
    return inflateRawSync(data, opts)
  } catch {
    /* fall through */
  }
  const at = data.indexOf(0x78)
  if (at > 0) {
    try {
      return inflateSync(data.subarray(at), opts)
    } catch {
      /* fall through */
    }
  }
  throw new Error('a compressed stream could not be inflated')
}

function asciiHexDecode(data: Buffer): Buffer {
  const hex = data.toString(LATIN).split('>')[0]?.replace(/[^0-9a-fA-F]/g, '') ?? ''
  return Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex')
}

function ascii85Decode(data: Buffer): Buffer {
  const out: number[] = []
  let tuple: number[] = []
  const flush = (count: number) => {
    while (tuple.length < 5) tuple.push(84)
    let value = 0
    for (const t of tuple) value = value * 85 + t
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    out.push(...bytes.slice(0, count))
    tuple = []
  }
  for (const ch of data.toString(LATIN).replace(/^<~/, '')) {
    if (/\s/.test(ch)) continue
    if (ch === '~') break
    if (ch === 'z' && !tuple.length) {
      out.push(0, 0, 0, 0)
      continue
    }
    tuple.push(ch.charCodeAt(0) - 33)
    if (tuple.length === 5) flush(4)
  }
  if (tuple.length > 1) flush(tuple.length - 1)
  return Buffer.from(out)
}

function runLengthDecode(data: Buffer): Buffer {
  const out: number[] = []
  for (let i = 0; i < data.length; ) {
    const len = data[i++] as number
    if (len === 128) break
    if (len < 128) {
      for (let k = 0; k <= len; k++) out.push(data[i++] as number)
    } else {
      const byte = data[i++] as number
      for (let k = 0; k < 257 - len; k++) out.push(byte)
    }
  }
  return Buffer.from(out)
}

/** PDF LZW: 8-bit codes growing to 12, with the early-change offset. */
function lzwDecode(data: Buffer, earlyChange = 1): Buffer {
  const out: number[] = []
  let table: number[][] = []
  const reset = () => {
    table = []
    for (let i = 0; i < 256; i++) table.push([i])
    table.push([], [])
  }
  reset()
  let width = 9
  let prev: number[] | null = null
  let buffer = 0
  let bits = 0
  for (const byte of data) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= width) {
      const code = (buffer >> (bits - width)) & ((1 << width) - 1)
      bits -= width
      if (code === 256) {
        reset()
        width = 9
        prev = null
        continue
      }
      if (code === 257) return Buffer.from(out)
      let seq = table[code]
      if (!seq) {
        if (!prev) return Buffer.from(out)
        seq = [...prev, prev[0] as number]
      }
      out.push(...seq)
      if (prev) table.push([...prev, seq[0] as number])
      prev = seq
      if (table.length + earlyChange >= 1 << width && width < 12) width++
    }
  }
  return Buffer.from(out)
}

function decodeStream(obj: PdfObject): Buffer {
  let data = obj.stream ?? Buffer.alloc(0)
  const filterTok = entry(obj.dict, 'Filter')
  if (!filterTok) return data
  const filters = [...filterTok.matchAll(/\/(\w+)/g)].map((m) => m[1] as string)
  const parmsTok = entry(obj.dict, 'DecodeParms') ?? entry(obj.dict, 'DP') ?? ''
  const parmList = parmsTok.startsWith('<<')
    ? [parmsTok]
    : [...parmsTok.matchAll(/<<[\s\S]*?>>/g)].map((m) => m[0])
  filters.forEach((filter, i) => {
    const parms = parmList[i] ?? parmList[0] ?? ''
    if (filter === 'FlateDecode' || filter === 'Fl') data = applyPredictor(inflate(data), parms)
    else if (filter === 'LZWDecode' || filter === 'LZW') {
      data = applyPredictor(lzwDecode(data, num(parms, 'EarlyChange', 1)), parms)
    } else if (filter === 'ASCIIHexDecode' || filter === 'AHx') data = asciiHexDecode(data)
    else if (filter === 'ASCII85Decode' || filter === 'A85') data = ascii85Decode(data)
    else if (filter === 'RunLengthDecode' || filter === 'RL') data = runLengthDecode(data)
    // DCTDecode / JPXDecode / CCITTFaxDecode are images: nothing to read as text.
  })
  return data
}

// -------------------------------------------------------------------- objects

const skipEol = (text: string, i: number): number => {
  let j = i
  if (text[j] === '\r') j++
  if (text[j] === '\n') j++
  return j
}

/**
 * Scans every `N G obj` header. After an object with a stream, the cursor jumps
 * past `endstream`, so bytes inside a compressed payload can never be read as
 * another object header.
 */
function scanObjects(buf: Buffer): Map<number, PdfObject> {
  const text = buf.toString(LATIN)
  const objs = new Map<number, PdfObject>()
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const bodyStart = m.index + m[0].length
    const endObj = text.indexOf('endobj', bodyStart)
    const streamAt = text.indexOf('stream', bodyStart)
    const hasStream = streamAt !== -1 && (endObj === -1 || streamAt < endObj)
    const dictEnd = hasStream ? streamAt : endObj === -1 ? text.length : endObj
    const obj: PdfObject = { id: Number(m[1]), dict: text.slice(bodyStart, dictEnd) }
    if (hasStream) {
      const start = skipEol(text, streamAt + 'stream'.length)
      const declared = Number(entry(obj.dict, 'Length'))
      let end = -1
      if (Number.isFinite(declared) && declared >= 0) {
        const after = skipEol(text, start + declared)
        if (text.startsWith('endstream', after)) end = start + declared
      }
      if (end < 0) {
        const found = text.indexOf('endstream', start)
        end = found === -1 ? buf.length : found
        while (end > start && (text[end - 1] === '\n' || text[end - 1] === '\r')) end--
      }
      obj.stream = buf.subarray(start, end)
      re.lastIndex = Math.max(re.lastIndex, end)
    }
    objs.set(obj.id, obj)
  }
  return objs
}

/** Expands `/ObjStm` containers so their objects can be looked up like any other. */
function expandObjectStreams(objs: Map<number, PdfObject>) {
  for (const container of [...objs.values()]) {
    if (!container.stream || !/\/Type\s*\/ObjStm\b/.test(container.dict)) continue
    let body: string
    try {
      body = decodeStream(container).toString(LATIN)
    } catch {
      continue
    }
    const count = num(container.dict, 'N', 0)
    const first = num(container.dict, 'First', 0)
    const header = body
      .slice(0, first)
      .trim()
      .split(/\s+/)
      .map(Number)
    for (let i = 0; i < count; i++) {
      const id = header[i * 2]
      const offset = header[i * 2 + 1]
      if (!Number.isFinite(id) || !Number.isFinite(offset)) continue
      const nextOffset = i + 1 < count ? header[(i + 1) * 2 + 1] : undefined
      const end = Number.isFinite(nextOffset) ? first + (nextOffset as number) : body.length
      if (!objs.has(id as number)) {
        objs.set(id as number, { id: id as number, dict: body.slice(first + (offset as number), end) })
      }
    }
  }
}

// ---------------------------------------------------------------------- fonts

/** UTF-16BE hex (`0041` or `00660069` for a ligature) to a JS string. */
function hexToText(hex: string): string {
  if (hex.length <= 2) return String.fromCharCode(parseInt(hex || '0', 16))
  let out = ''
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
  return out
}

/** Reads the `beginbfchar` / `beginbfrange` sections of a `/ToUnicode` CMap. */
function parseCMap(text: string): Map<number, string> {
  const map = new Map<number, string>()
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(pair[1] as string, 16), hexToText(pair[2] as string))
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? ''
    for (const m of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      const lo = parseInt(m[1] as string, 16)
      const hi = parseInt(m[2] as string, 16)
      const base = m[3] as string
      for (let code = lo; code <= hi && code - lo < 65_536; code++) {
        const shifted = (parseInt(base || '0', 16) + (code - lo)).toString(16).padStart(base.length, '0')
        map.set(code, hexToText(shifted))
      }
    }
    for (const m of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(m[1] as string, 16)
      const items = [...(m[3] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)]
      items.forEach((item, k) => map.set(lo + k, hexToText(item[1] as string)))
    }
  }
  return map
}

/** Resource name (`/F1`) to decoding rules, for one page's `/Resources /Font`. */
function pageFonts(resources: string, objs: Map<number, PdfObject>): Map<string, FontInfo> {
  const out = new Map<string, FontInfo>()
  const fontDict = deref(entry(resources, 'Font'), objs)
  for (const m of fontDict.matchAll(/\/([^\s/[\]()<>]+)\s+(\d+)\s+\d+\s+R/g)) {
    const font = objs.get(Number(m[2]))
    if (!font) continue
    const twoByte = /\/Subtype\s*\/Type0\b/.test(font.dict)
    const toUnicode = objs.get(refId(entry(font.dict, 'ToUnicode')) ?? -1)
    let map = new Map<number, string>()
    if (toUnicode) {
      try {
        map = parseCMap(decodeStream(toUnicode).toString(LATIN))
      } catch {
        map = new Map()
      }
    }
    out.set(m[1] as string, { bytes: twoByte ? 2 : 1, map })
  }
  return out
}

// ------------------------------------------------------------- content streams

interface ShowState {
  objs: Map<number, PdfObject>
  out: string[]
  unmapped: number
}

/** Bytes shown by `Tj` to text, through the font's `/ToUnicode` map when it has one. */
function decodeShow(raw: Buffer, font: FontInfo | undefined, state: ShowState): string {
  if (!font || font.bytes === 1) {
    let text = ''
    for (const byte of raw) text += font?.map.get(byte) ?? String.fromCharCode(byte)
    return text
  }
  let text = ''
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const code = ((raw[i] as number) << 8) | (raw[i + 1] as number)
    const mapped = font.map.get(code)
    if (mapped === undefined) state.unmapped++
    else text += mapped
  }
  return text
}

/** Reads a `(...)` literal string, honouring escapes and nested parentheses. */
function readLiteral(s: string, from: number): { bytes: Buffer; next: number } {
  const out: number[] = []
  let depth = 1
  let i = from
  while (i < s.length) {
    const c = s[i++] as string
    if (c === '\\') {
      const e = s[i++] as string
      if (e === 'n') out.push(10)
      else if (e === 'r') out.push(13)
      else if (e === 't') out.push(9)
      else if (e === 'b') out.push(8)
      else if (e === 'f') out.push(12)
      else if (e === '\n') continue
      else if (e === '\r') {
        if (s[i] === '\n') i++
      } else if (e >= '0' && e <= '7') {
        let oct = e
        while (oct.length < 3 && s[i] >= '0' && s[i] <= '7') oct += s[i++] as string
        out.push(parseInt(oct, 8) & 0xff)
      } else out.push(e.charCodeAt(0))
    } else if (c === '(') {
      depth++
      out.push(40)
    } else if (c === ')') {
      depth--
      if (depth === 0) break
      out.push(41)
    } else out.push(c.charCodeAt(0))
  }
  return { bytes: Buffer.from(out), next: i }
}

/** Elements of a `TJ` array: strings to show and kerning numbers. */
function parseArray(text: string): (Buffer | number)[] {
  const out: (Buffer | number)[] = []
  let i = 1
  while (i < text.length) {
    const c = text[i]
    if (c === undefined || c === ']') break
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '(') {
      const lit = readLiteral(text, i + 1)
      out.push(lit.bytes)
      i = lit.next
      continue
    }
    if (c === '<') {
      const close = text.indexOf('>', i)
      const hex = text.slice(i + 1, close === -1 ? text.length : close).replace(/[^0-9a-fA-F]/g, '')
      out.push(Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex'))
      i = close === -1 ? text.length : close + 1
      continue
    }
    const numeric = text.slice(i).match(/^[-+]?[\d.]+/)
    if (numeric) {
      out.push(Number(numeric[0]))
      i += numeric[0].length
      continue
    }
    i++
  }
  return out
}

const lastBuffer = (ops: unknown[]): Buffer | undefined => {
  for (let i = ops.length - 1; i >= 0; i--) if (Buffer.isBuffer(ops[i])) return ops[i] as Buffer
  return undefined
}

const lastName = (ops: unknown[]): string | undefined => {
  for (let i = ops.length - 1; i >= 0; i--) {
    const v = ops[i]
    if (typeof v === 'string' && v.startsWith('/')) return v.slice(1)
  }
  return undefined
}

const lastArray = (ops: unknown[]): (Buffer | number)[] => {
  for (let i = ops.length - 1; i >= 0; i--) {
    if (Array.isArray(ops[i])) return ops[i] as (Buffer | number)[]
  }
  return []
}

// Sticky, so the tokeniser can match at an offset without slicing the stream.
const NAME_RE = /\/[^\s/[\]()<>{}%]*/y
const NUMBER_RE = /[-+]?(?:\d+\.?\d*|\.\d+)/y
const WORD_RE = /[A-Za-z'"][A-Za-z0-9*'"]*/y

/** Runs a `/Form` XObject's own content stream, so text inside it is not lost. */
function runXObject(name: string, resources: string, state: ShowState, depth: number) {
  const dict = deref(entry(resources, 'XObject'), state.objs)
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = dict.match(new RegExp(`/${escaped}\\s+(\\d+)\\s+\\d+\\s+R`))
  if (!m) return
  const form = state.objs.get(Number(m[1]))
  if (!form?.stream || !/\/Subtype\s*\/Form\b/.test(form.dict)) return
  const inner = deref(entry(form.dict, 'Resources'), state.objs) || resources
  try {
    runContent(decodeStream(form).toString(LATIN), inner, state, depth + 1)
  } catch {
    // A form we cannot inflate is not worth failing the rest of the page for.
  }
}

/** Tokenises a content stream and follows only the text-showing operators. */
function runContent(content: string, resources: string, state: ShowState, depth = 0) {
  if (depth > 3) return
  const fonts = pageFonts(resources, state.objs)
  let font: FontInfo | undefined
  let leading = 0
  let x = 0
  let y = 0
  let lastY: number | null = null
  let lastX = 0
  const ops: unknown[] = []
  const at = (fromEnd: number) => {
    const v = ops[ops.length - fromEnd]
    return typeof v === 'number' ? v : 0
  }
  const emit = (text: string) => {
    if (!text) return
    if (lastY !== null && Math.abs(y - lastY) > 0.6) state.out.push('\n')
    else if (lastY !== null && x - lastX > 1.5) state.out.push(' ')
    lastY = y
    lastX = x
    state.out.push(text)
  }

  let i = 0
  while (i < content.length) {
    const c = content[i] as string
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '%') {
      while (i < content.length && content[i] !== '\n' && content[i] !== '\r') i++
      continue
    }
    if (c === '(') {
      const lit = readLiteral(content, i + 1)
      ops.push(lit.bytes)
      i = lit.next
      continue
    }
    if (content.startsWith('<<', i)) {
      i += sliceDict(content, i).length
      continue
    }
    if (c === '<') {
      const close = content.indexOf('>', i)
      const hex = content.slice(i + 1, close === -1 ? content.length : close).replace(/[^0-9a-fA-F]/g, '')
      ops.push(Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex'))
      i = close === -1 ? content.length : close + 1
      continue
    }
    if (c === '[') {
      const raw = sliceArray(content, i)
      ops.push(parseArray(raw))
      i += raw.length
      continue
    }
    if (c === '/') {
      NAME_RE.lastIndex = i
      const m = NAME_RE.exec(content)
      ops.push(m ? m[0] : '/')
      i += m ? m[0].length : 1
      continue
    }
    NUMBER_RE.lastIndex = i
    const numeric = NUMBER_RE.exec(content)
    if (numeric) {
      ops.push(Number(numeric[0]))
      i += numeric[0].length
      continue
    }
    WORD_RE.lastIndex = i
    const word = WORD_RE.exec(content)
    if (!word) {
      i++
      continue
    }
    i += word[0].length
    const op = word[0]
    if (op === 'BT') {
      x = 0
      y = 0
      lastX = 0
      lastY = null
    } else if (op === 'Tf') {
      const name = lastName(ops)
      font = name ? fonts.get(name) : undefined
    } else if (op === 'TL') leading = at(1)
    else if (op === 'Td') {
      x += at(2)
      y += at(1)
    } else if (op === 'TD') {
      leading = -at(1)
      x += at(2)
      y += at(1)
    } else if (op === 'Tm') {
      x = at(2)
      y = at(1)
    } else if (op === 'T*') y -= leading
    else if (op === 'Tj') {
      const raw = lastBuffer(ops)
      if (raw) emit(decodeShow(raw, font, state))
    } else if (op === "'" || op === '"') {
      y -= leading
      const raw = lastBuffer(ops)
      if (raw) emit(decodeShow(raw, font, state))
    } else if (op === 'TJ') {
      let text = ''
      for (const item of lastArray(ops)) {
        // A large negative adjustment is how most writers encode a word gap.
        if (typeof item === 'number') text += item < -120 ? ' ' : ''
        else text += decodeShow(item, font, state)
      }
      emit(text)
    } else if (op === 'Do') {
      const name = lastName(ops)
      if (name) runXObject(name, resources, state, depth)
    } else if (op === 'BI') {
      // Inline image: its binary payload must not be tokenised.
      const end = content.indexOf('EI', i)
      i = end === -1 ? content.length : end + 2
    }
    ops.length = 0
  }
}

// ---------------------------------------------------------------------- pages

interface PageRef {
  dict: string
  resources: string
}

/** The `/Pages` node the catalogue points at, when the catalogue is readable. */
function findPageTreeRoot(objs: Map<number, PdfObject>): PdfObject | undefined {
  for (const obj of objs.values()) {
    if (!/\/Type\s*\/Catalog\b/.test(obj.dict)) continue
    const root = objs.get(refId(entry(obj.dict, 'Pages')) ?? -1)
    if (root) return root
  }
  return undefined
}

/**
 * Walks `/Kids` so pages come out in reading order, carrying `/Resources` down
 * the tree the way the spec says inheritable attributes work.
 */
function walkPages(
  node: PdfObject | undefined,
  objs: Map<number, PdfObject>,
  inherited: string,
  out: PageRef[],
  seen: Set<number>,
  depth = 0
) {
  if (!node || depth > 32 || seen.has(node.id) || out.length >= 5000) return
  seen.add(node.id)
  const own = entry(node.dict, 'Resources')
  const resources = own ? deref(own, objs) : inherited
  if (/\/Type\s*\/Pages\b/.test(node.dict)) {
    for (const m of (entry(node.dict, 'Kids') ?? '').matchAll(/(\d+)\s+\d+\s+R/g)) {
      walkPages(objs.get(Number(m[1])), objs, resources, out, seen, depth + 1)
    }
    return
  }
  if (/\/Type\s*\/Page\b/.test(node.dict)) out.push({ dict: node.dict, resources })
}

/** `/Contents` as decoded text: one ref, an array of refs, or a ref to an array. */
function contentStreams(dict: string, objs: Map<number, PdfObject>): string[] {
  const token = entry(dict, 'Contents')
  if (!token) return []
  const parts: string[] = []
  const push = (obj: PdfObject | undefined) => {
    if (!obj?.stream) return
    try {
      parts.push(decodeStream(obj).toString(LATIN))
    } catch {
      // One unreadable stream costs that page its text, not the whole document.
    }
  }
  for (const m of token.matchAll(/(\d+)\s+\d+\s+R/g)) {
    const obj = objs.get(Number(m[1]))
    if (!obj) continue
    if (obj.stream) push(obj)
    else for (const inner of obj.dict.matchAll(/(\d+)\s+\d+\s+R/g)) push(objs.get(Number(inner[1])))
  }
  return parts
}

/** True when the trailer names an `/Encrypt` dictionary. */
function hasEncryptDict(buf: Buffer): boolean {
  const at = buf.lastIndexOf('/Encrypt')
  if (at === -1) return false
  return /^\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(buf.subarray(at, at + 48).toString(LATIN))
}

/**
 * Reads a PDF's text layer. Throws with the reason when there is nothing to
 * read -- an encrypted file, a scan, or fonts with no `/ToUnicode` map -- rather
 * than returning an empty string that looks like an empty document.
 */
export async function extractPdfText(path: string): Promise<PdfText> {
  const buf = await readFile(path)
  if (!buf.subarray(0, 1024).toString(LATIN).includes('%PDF-')) {
    throw new Error('that file has no %PDF- header, so it is not a PDF')
  }
  if (hasEncryptDict(buf)) {
    throw new Error(
      'that PDF is encrypted. Akansha does not bundle a PDF decryptor -- open it in a reader, remove the protection and save a copy.'
    )
  }
  const objs = scanObjects(buf)
  expandObjectStreams(objs)

  const pages: PageRef[] = []
  walkPages(findPageTreeRoot(objs), objs, '', pages, new Set())
  if (!pages.length) {
    // No usable catalogue: fall back to object order, which is page order in
    // every writer I have looked at.
    for (const obj of [...objs.values()].sort((a, b) => a.id - b.id)) {
      if (!/\/Type\s*\/Page\b/.test(obj.dict)) continue
      pages.push({ dict: obj.dict, resources: deref(entry(obj.dict, 'Resources'), objs) })
    }
  }
  if (!pages.length) {
    throw new Error('no pages could be found in that PDF; its structure is damaged beyond what Akansha can repair')
  }

  const state: ShowState = { objs, out: [], unmapped: 0 }
  const rendered: string[] = []
  for (const page of pages) {
    state.out = []
    for (const content of contentStreams(page.dict, objs)) runContent(content, page.resources, state)
    rendered.push(state.out.join('').replace(/[ \t]+(?=\n)/g, '').trim())
  }

  const text = rendered
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
  if (!text) {
    throw new Error(
      state.unmapped > 0
        ? `that PDF's fonts carry no /ToUnicode map, so its ${state.unmapped} glyphs cannot be turned back into characters. Re-export it with Unicode font embedding, or copy the passage from a reader.`
        : 'that PDF has no text layer, so it looks like a scan. Akansha does not bundle OCR, and there is nothing else to read.'
    )
  }
  return { text, pages: pages.length, unmapped: state.unmapped }
}

