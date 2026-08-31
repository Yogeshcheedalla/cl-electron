import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'
import { extractPdfText } from '../electron/services/pdf'

/**
 * PDF extraction against PDFs built byte by byte in this file.
 *
 * No fixture binaries are committed: every document below is assembled from
 * `N 0 obj` records here, so what each test proves is visible in the test. That
 * matters more than usual because the extractor is a from-scratch parser -- a
 * fixture blob would hide which construct a regression actually broke.
 *
 * Covered: uncompressed content, FlateDecode, `TJ` arrays with hex strings and a
 * `/ToUnicode` CMap, objects hidden in an `/ObjStm` container, and the three
 * refusals that must stay honest instead of returning an empty string -- a file
 * with no `%PDF-` header, an encrypted file, and a page with no text layer.
 */

const LATIN = 'latin1'

interface Obj {
  id: number
  dict: string
  stream?: Buffer
}

let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'akansha-pdf-'))
})

/** Writes a PDF and returns its path. `/Length` is filled in for each stream. */
function write(name: string, objects: Obj[], trailer = '<< /Root 1 0 R >>'): string {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', LATIN)]
  for (const o of objects) {
    if (o.stream) {
      const dict = o.dict.replace('<<', `<< /Length ${o.stream.length}`)
      parts.push(
        Buffer.from(`${o.id} 0 obj\n${dict}\nstream\n`, LATIN),
        o.stream,
        Buffer.from('\nendstream\nendobj\n', LATIN)
      )
    } else {
      parts.push(Buffer.from(`${o.id} 0 obj\n${o.dict}\nendobj\n`, LATIN))
    }
  }
  parts.push(Buffer.from(`trailer\n${trailer}\n%%EOF\n`, LATIN))
  const path = join(dir, name)
  writeFileSync(path, Buffer.concat(parts))
  return path
}

const latin = (s: string) => Buffer.from(s, LATIN)

/** Catalogue, page tree and one page, all pointing at object 4 for content. */
const page = (fontRef = '5 0 R'): Obj[] => [
  { id: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
  { id: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
  {
    id: 3,
    dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontRef} >> >> /Contents 4 0 R >>`
  }
]

describe('pdf text extraction', () => {
  it('reads an uncompressed content stream', async () => {
    const path = write('plain.pdf', [
      ...page(),
      {
        id: 4,
        dict: '<< >>',
        stream: latin('BT /F1 12 Tf 72 720 Td (Hello from the assistant.) Tj ET')
      },
      { id: 5, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' }
    ])
    const out = await extractPdfText(path)
    expect(out.text).toBe('Hello from the assistant.')
    expect(out.pages).toBe(1)
    expect(out.unmapped).toBe(0)
  })

  it('inflates a FlateDecode content stream', async () => {
    const path = write('flate.pdf', [
      ...page(),
      {
        id: 4,
        dict: '<< /Filter /FlateDecode >>',
        stream: deflateSync(latin('BT /F1 12 Tf 72 720 Td (Compressed line one.) Tj 0 -14 Td (And line two.) Tj ET'))
      },
      { id: 5, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' }
    ])
    const out = await extractPdfText(path)
    // The second `Td` moves down a line, so the text matrix -- not a guess about
    // spacing -- is what puts the newline in.
    expect(out.text).toBe('Compressed line one.\nAnd line two.')
  })

  it('applies a /ToUnicode CMap to a TJ array of hex strings', async () => {
    const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 beginbfrange
<0001> <0003> <0041>
endbfrange
2 beginbfchar
<0004> <0068>
<0005> <00660069>
endbfchar
endcmap
end
end`
    const path = write('cmap.pdf', [
      ...page('6 0 R'),
      {
        id: 4,
        dict: '<< >>',
        // Codes 1-3 map through the bfrange to A-C; 4 and 5 through bfchar to
        // "h" and the "fi" ligature; 0x0099 is deliberately unmapped. The -300
        // kern is how a writer encodes a word gap.
        stream: latin('BT /F1 12 Tf 72 700 Td [<00010002> -300 <00040005> <0099>] TJ ET')
      },
      { id: 6, dict: '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Sub /ToUnicode 7 0 R >>' },
      { id: 7, dict: '<< /Filter /FlateDecode >>', stream: deflateSync(latin(cmap)) }
    ])
    const out = await extractPdfText(path)
    expect(out.text).toBe('AB hfi')
    // The glyph with no mapping is counted, not silently dropped.
    expect(out.unmapped).toBe(1)
  })

  it('expands objects hidden inside an /ObjStm container', async () => {
    // The catalogue, page tree, page and font live inside a compressed object
    // stream, which is how every PDF 1.5+ writer emits them.
    const bodies = [
      { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { id: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        id: 3,
        body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
      },
      { id: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' }
    ]
    let offset = 0
    const header: string[] = []
    const payload: string[] = []
    for (const b of bodies) {
      header.push(`${b.id} ${offset}`)
      payload.push(`${b.body} `)
      offset += b.body.length + 1
    }
    const head = `${header.join(' ')}\n`
    const body = latin(head + payload.join(''))
    const path = write('objstm.pdf', [
      { id: 4, dict: '<< >>', stream: latin('BT /F1 12 Tf 72 720 Td (Inside an object stream.) Tj ET') },
      {
        id: 8,
        dict: `<< /Type /ObjStm /N ${bodies.length} /First ${head.length} /Filter /FlateDecode >>`,
        stream: deflateSync(body)
      }
    ])
    const out = await extractPdfText(path)
    expect(out.text).toBe('Inside an object stream.')
    expect(out.pages).toBe(1)
  })

  it('says a page with no text layer looks like a scan', async () => {
    const path = write('scan.pdf', [
      ...page(),
      // A filled rectangle and an image placeholder: drawing operators only.
      { id: 4, dict: '<< >>', stream: latin('q 1 0 0 1 0 0 cm 0 0 0 rg 10 10 100 100 re f Q') },
      { id: 5, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' }
    ])
    await expect(extractPdfText(path)).rejects.toThrow(/scan/i)
  })

  it('refuses a file with no %PDF- header', async () => {
    const path = join(dir, 'not-a.pdf')
    writeFileSync(path, 'This is a text file that somebody renamed.\n')
    await expect(extractPdfText(path)).rejects.toThrow(/%PDF-/)
  })

  it('refuses an encrypted PDF instead of returning nothing', async () => {
    const path = write(
      'encrypted.pdf',
      [
        ...page(),
        { id: 4, dict: '<< >>', stream: latin('BT /F1 12 Tf 72 720 Td (Locked.) Tj ET') },
        { id: 5, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
        { id: 9, dict: '<< /Filter /Standard /V 2 /R 3 /Length 128 >>' }
      ],
      '<< /Root 1 0 R /Encrypt 9 0 R >>'
    )
    await expect(extractPdfText(path)).rejects.toThrow(/encrypted/i)
  })

  it('reads text out of a /Form XObject', async () => {
    const path = write('xobject.pdf', [
      { id: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
      { id: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        id: 3,
        dict:
          '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /X1 6 0 R >> >> /Contents 4 0 R >>'
      },
      { id: 4, dict: '<< >>', stream: latin('BT /F1 12 Tf 72 720 Td (Outer.) Tj ET\n/X1 Do') },
      { id: 5, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      {
        id: 6,
        dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] >>',
        stream: latin('BT /F1 12 Tf 72 600 Td (Inner.) Tj ET')
      }
    ])
    const out = await extractPdfText(path)
    expect(out.text).toContain('Outer.')
    expect(out.text).toContain('Inner.')
  })

  it('keeps reading when one page of several is unreadable', async () => {
    const path = write('mixed.pdf', [
      { id: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
      { id: 2, dict: '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>' },
      {
        id: 3,
        dict: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
      },
      { id: 4, dict: '<< >>', stream: latin('BT /F1 12 Tf 72 720 Td (Page one is fine.) Tj ET') },
      { id: 5, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      {
        id: 6,
        dict: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>'
      },
      // Claims Flate but carries bytes no inflater will accept.
      { id: 7, dict: '<< /Filter /FlateDecode >>', stream: Buffer.from([0x00, 0x01, 0x02, 0x03]) }
    ])
    const out = await extractPdfText(path)
    expect(out.pages).toBe(2)
    expect(out.text).toBe('Page one is fine.')
  })
})
