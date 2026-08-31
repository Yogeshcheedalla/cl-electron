import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { PathDenied, readablePath, safePath, writablePath } from '../electron/services/path-guard'
import { files } from '../electron/services/files'
import { initSettings, settings } from '../electron/services/settings'

let root = ''

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'akansha-fs-'))
  initSettings(join(dir, 'config'))
  root = join(dir, 'workspace')
  mkdirSync(root, { recursive: true })
  settings.update({ automation: { ...settings.get().automation, allowedRoots: [root] } })
})

const denied = (fn: () => unknown) => expect(fn).toThrow(PathDenied)

describe('safePath', () => {
  it('requires a non-empty string path', () => {
    denied(() => safePath(''))
    denied(() => safePath(undefined as unknown as string))
    denied(() => safePath(42 as unknown as string))
  })

  it('returns an absolute normalised path', () => {
    expect(safePath(join(root, 'a', '..', 'b.txt'))).toBe(resolve(root, 'b.txt'))
  })

  it('accepts forward slashes, as the model tends to write them', () => {
    expect(safePath(`${root.replace(/\\/g, '/')}/notes.txt`)).toBe(resolve(root, 'notes.txt'))
  })

  it('refuses protected system locations', () => {
    denied(() => safePath('C:\\Windows'))
    denied(() => safePath('C:\\Windows\\System32\\drivers\\etc\\hosts'))
    denied(() => safePath('c:/windows/system32/config/SAM'))
    denied(() => safePath('C:\\$Recycle.Bin'))
    denied(() => safePath('C:\\System Volume Information\\x'))
    denied(() => safePath('C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\evil.lnk'))
  })

  it('refuses a traversal that lands in a protected location', () => {
    denied(() => safePath('C:\\Users\\me\\..\\..\\Windows\\System32'))
    denied(() => safePath('C:\\Users\\me\\Documents\\..\\..\\..\\Windows\\win.ini'))
    denied(() => safePath('C:/Users/me/../../Windows/System32/config'))
  })

  it('does not treat a similarly named folder as protected', () => {
    expect(() => safePath('C:\\Windows-notes')).not.toThrow()
    expect(() => safePath('C:\\WindowsProjects\\src')).not.toThrow()
  })
})

describe('readablePath', () => {
  it('allows reading outside the write roots', () => {
    expect(() => readablePath('C:\\Users\\me\\Documents\\report.docx')).not.toThrow()
  })

  it('refuses files that look like credentials', () => {
    denied(() => readablePath(join(root, '.env')))
    denied(() => readablePath(join(root, 'id_rsa')))
    denied(() => readablePath(join(root, 'server.pem')))
    denied(() => readablePath(join(root, 'credentials.json')))
    denied(() => readablePath(join(root, 'secrets.bin')))
  })

  it('says why it refused, and suggests the user open it themselves', () => {
    try {
      readablePath(join(root, '.env'))
      expect.unreachable('.env should be refused')
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/credentials file/i)
    }
  })
})

describe('writablePath', () => {
  it('allows writes inside an allowed root', () => {
    expect(writablePath(join(root, 'sub', 'file.txt'))).toBe(resolve(root, 'sub', 'file.txt'))
    expect(writablePath(root)).toBe(resolve(root))
  })

  it('refuses writes outside every allowed root', () => {
    denied(() => writablePath('C:\\Users\\Public\\anything.txt'))
    denied(() => writablePath(join(root, '..', 'sibling.txt')))
  })

  it('refuses a sibling whose name merely starts with the root', () => {
    denied(() => writablePath(`${root}-evil\\file.txt`))
  })

  it('names the setting the user must change', () => {
    try {
      writablePath('D:\\elsewhere\\x.txt')
      expect.unreachable('outside root should be refused')
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/Settings > Automation/)
    }
  })
})

describe('file service', () => {
  it('writes, reads back and lists a file', async () => {
    const file = join(root, 'hello.txt')
    await files.write(file, 'first', false)
    expect(readFileSync(file, 'utf8')).toBe('first')
    const read = await files.read(file)
    expect(read.content).toBe('first')
    expect(read.truncated).toBe(false)
    const listing = await files.list(root)
    expect(listing.map((e) => e.name)).toContain('hello.txt')
  })

  it('refuses to overwrite an existing file unless told to', async () => {
    const file = join(root, 'guard.txt')
    await files.write(file, 'original', false)
    await expect(files.write(file, 'replacement', false)).rejects.toThrow(/already exists/i)
    expect(readFileSync(file, 'utf8')).toBe('original')
    await files.write(file, 'replacement', true)
    expect(readFileSync(file, 'utf8')).toBe('replacement')
  })

  it('refuses to write outside the allowed roots', async () => {
    await expect(files.write('C:\\Users\\Public\\akansha-test.txt', 'x', true)).rejects.toThrow(PathDenied)
  })

  it('refuses to read a binary file instead of returning mojibake', async () => {
    writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await expect(files.read(join(root, 'image.png'))).rejects.toThrow(/binary/i)
  })

  it('truncates a large read rather than loading the whole file', async () => {
    const big = join(root, 'big.txt')
    await files.write(big, 'x'.repeat(50_000), true)
    const read = await files.read(big, 1024)
    expect(read.content).toHaveLength(1024)
    expect(read.truncated).toBe(true)
  })

  it('will not delete a non-empty folder without an explicit recursive flag', async () => {
    const dir = join(root, 'folder')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'inside.txt'), 'x')
    await expect(files.remove(dir, false)).rejects.toThrow(/recursive/i)
    expect(existsSync(dir)).toBe(true)
    await files.remove(dir, true)
    expect(existsSync(dir)).toBe(false)
  })

  it('refuses to delete or overwrite an allowed root itself', async () => {
    await expect(files.remove(root, true)).rejects.toThrow(/allowed-roots/i)
    expect(existsSync(root)).toBe(true)
  })

  it('renames within a folder but refuses a path as the new name', async () => {
    const file = join(root, 'before.txt')
    await files.write(file, 'x', true)
    await expect(files.rename(file, '..\\escape.txt')).rejects.toThrow(/file name, not a path/i)
    await expect(files.rename(file, 'C:\\Windows\\evil.txt')).rejects.toThrow()
    const out = await files.rename(file, 'after.txt')
    expect(out.path).toBe(resolve(root, 'after.txt'))
  })

  it('will not clobber an existing file when copying or moving', async () => {
    await files.write(join(root, 'src.txt'), 'a', true)
    await files.write(join(root, 'dest.txt'), 'b', true)
    await expect(files.copy(join(root, 'src.txt'), join(root, 'dest.txt'))).rejects.toThrow(/already exists/i)
    await expect(files.move(join(root, 'src.txt'), join(root, 'dest.txt'))).rejects.toThrow(/already exists/i)
    expect(readFileSync(join(root, 'dest.txt'), 'utf8')).toBe('b')
  })

  it('searches by name inside a folder and requires a term', async () => {
    writeFileSync(join(root, 'invoice-2026.pdf'), 'x')
    const hits = await files.search(root, 'invoice', 50)
    expect(hits.some((h) => h.name === 'invoice-2026.pdf')).toBe(true)
    await expect(files.search(root, '  ', 50)).rejects.toThrow(/search term/i)
  })
})
