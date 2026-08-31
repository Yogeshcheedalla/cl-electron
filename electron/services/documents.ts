import { mkdtemp, copyFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, basename } from 'node:path'
import { truncate, describeError } from '../core/util'
import { readablePath } from './path-guard'
import { extractPdfText } from './pdf'
import { runPowerShell, psQuote } from './shell'

const MAX_TEXT = 200_000

const PLAIN = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.yml', '.yaml', '.xml',
  '.ini', '.cfg', '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cs', '.go', '.rs', '.rb', '.php',
  '.sql', '.sh', '.ps1', '.bat', '.html', '.htm', '.css'
])

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')

const stripTags = (xml: string) => decode(xml.replace(/<[^>]+>/g, ''))

const matchAll = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1] ?? '')

/**
 * Office files are ZIP containers, so PowerShell's Expand-Archive is enough to
 * read them -- no native parser dependency, no optional install that might be
 * missing at runtime.
 */
async function unzip(file: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'akansha-doc-'))
  const zip = join(dir, 'bundle.zip')
  await copyFile(file, zip)
  const out = join(dir, 'x')
  const res = await runPowerShell(
    `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(out)} -Force`,
    { timeoutMs: 60_000 }
  )
  if (res.exitCode !== 0) {
    await rm(dir, { recursive: true, force: true })
    throw new Error(`${basename(file)} could not be unpacked: ${res.stderr.trim() || 'unknown error'}`)
  }
  return dir
}

const readIfPresent = (p: string) => readFile(p, 'utf8').catch(() => '')

async function docx(file: string): Promise<string> {
  const dir = await unzip(file)
  try {
    const xml = await readIfPresent(join(dir, 'x', 'word', 'document.xml'))
    if (!xml) throw new Error('No document body was found inside the .docx.')
    return stripTags(
      xml
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<w:br\/>/g, '\n')
    ).replace(/\n{3,}/g, '\n\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function xlsx(file: string): Promise<string> {
  const dir = await unzip(file)
  try {
    const base = join(dir, 'x', 'xl')
    const sharedXml = await readIfPresent(join(base, 'sharedStrings.xml'))
    const shared = matchAll(sharedXml, 'si').map((si) => matchAll(si, 't').map(decode).join(''))
    const sheetDir = join(base, 'worksheets')
    const sheets = (await readdir(sheetDir).catch(() => [])).filter((f) => f.endsWith('.xml')).sort()
    const out: string[] = []
    for (const sheet of sheets) {
      const xml = await readIfPresent(join(sheetDir, sheet))
      out.push(`# ${basename(sheet, '.xml')}`)
      for (const row of matchAll(xml, 'row')) {
        const cells = [...row.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((m) => {
          const attrs = m[1] ?? ''
          const body = m[2] ?? ''
          const value = matchAll(body, 'v')[0] ?? matchAll(body, 't')[0] ?? ''
          if (/t="s"/.test(attrs)) return shared[Number(decode(value))] ?? ''
          if (/t="inlineStr"/.test(attrs)) return stripTags(body).trim()
          return decode(value)
        })
        if (cells.some((c) => c !== '')) out.push(cells.join('\t'))
      }
    }
    if (!out.length) throw new Error('The workbook has no readable cells.')
    return out.join('\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function pptx(file: string): Promise<string> {
  const dir = await unzip(file)
  try {
    const slideDir = join(dir, 'x', 'ppt', 'slides')
    const slides = (await readdir(slideDir).catch(() => []))
      .filter((f) => f.endsWith('.xml'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    const out: string[] = []
    for (const slide of slides) {
      const xml = await readIfPresent(join(slideDir, slide))
      out.push(`## ${basename(slide, '.xml')}`, ...matchAll(xml, 'a:t').map(decode))
    }
    if (!out.length) throw new Error('No slide text was found.')
    return out.join('\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export const documents = {
  /**
   * ponytail: every format here is parsed with the standard library and the
   * tools Windows already has -- Office files are ZIP containers unpacked with
   * `Expand-Archive`, and PDFs go through `pdf.ts`, which is `node:zlib` and a
   * tokeniser rather than a 4 MB pdfjs-dist dependency. What that costs is
   * scanned pages (no OCR) and encrypted files, both of which report themselves.
   */
  async read(path: string): Promise<{ path: string; kind: string; text: string; truncated: boolean }> {
    const abs = readablePath(path)
    const ext = extname(abs).toLowerCase()

    let text: string
    let kind: string
    if (PLAIN.has(ext) || ext === '') {
      kind = ext.replace('.', '') || 'text'
      text = await readFile(abs, 'utf8')
      if (ext === '.html' || ext === '.htm') {
        text = stripTags(
          text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<\/(p|div|h\d|li|tr)>/gi, '\n')
        ).replace(/\n{3,}/g, '\n\n')
      }
    } else if (ext === '.pdf') {
      kind = 'pdf'
      try {
        text = (await extractPdfText(abs)).text
      } catch (e) {
        throw new Error(`${basename(abs)} could not be read: ${describeError(e)}`, { cause: e })
      }
    } else if (ext === '.docx') {
      kind = 'docx'
      text = await docx(abs)
    } else if (ext === '.xlsx' || ext === '.xlsm') {
      kind = 'xlsx'
      text = await xlsx(abs)
    } else if (ext === '.pptx') {
      kind = 'pptx'
      text = await pptx(abs)
    } else {
      throw new Error(
        `Akansha cannot read ${ext || 'files without an extension'} as a document. Supported: plain text and code files, .pdf, .docx, .xlsx, .pptx.`
      )
    }

    return {
      path: abs,
      kind,
      text: truncate(text.trim(), MAX_TEXT),
      truncated: text.length > MAX_TEXT
    }
  }
}
