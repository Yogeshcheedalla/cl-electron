import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Offline dictation is a local binary this app launches on the user's behalf, so
 * the tests that matter are about refusal: what happens when it is off, when a
 * path is blank, when the path points at something that is not an executable, and
 * when a caller hands it audio that whisper.cpp could not read anyway. The one
 * success path stubs `runExe` -- spawning a real recogniser in a unit test would
 * need a 150 MB model.
 */

const runExe = vi.hoisted(() => vi.fn())
vi.mock('../electron/services/shell', () => ({ runExe }))

const { localStt } = await import('../electron/services/stt-local')
const { settings, DEFAULT_SETTINGS } = await import('../electron/services/settings')

/** A minimal but structurally valid 16 kHz mono WAV: header plus silence. */
function wav(samples = 8000): Buffer {
  const data = Buffer.alloc(samples * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8, 'latin1')
  head.write('fmt ', 12, 'latin1')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(16_000, 24)
  head.writeUInt32LE(32_000, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36, 'latin1')
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

const dir = mkdtempSync(join(tmpdir(), 'akansha-stt-test-'))
const exe = join(dir, 'whisper-cli.exe')
const model = join(dir, 'ggml-base.en.bin')
const notExe = join(dir, 'whisper-cli.txt')
writeFileSync(exe, 'MZ')
chmodSync(exe, 0o755)
writeFileSync(model, 'ggml')
writeFileSync(notExe, 'MZ')

/** Turns the feature on with whatever paths the case is exercising. */
function configure(patch: Partial<(typeof DEFAULT_SETTINGS)['voice']> = {}) {
  settings.update({
    voice: { ...DEFAULT_SETTINGS.voice, localStt: true, whisperExePath: exe, whisperModelPath: model, ...patch }
  })
}

beforeEach(() => {
  runExe.mockReset()
  settings.update({ voice: { ...DEFAULT_SETTINGS.voice } })
})

describe('local STT status', () => {
  it('reports not configured when the feature is off', async () => {
    const s = await localStt.status()
    expect(s.configured).toBe(false)
    expect(s.ready).toBe(false)
    expect(s.detail).toMatch(/turned off/i)
  })

  it('names the missing half when only one path is set', async () => {
    configure({ whisperModelPath: '' })
    const s = await localStt.status()
    expect(s.ready).toBe(false)
    expect(s.detail).toMatch(/both a whisper\.cpp executable and a model/i)
  })

  it('refuses a path that is not an .exe', async () => {
    configure({ whisperExePath: notExe })
    const s = await localStt.status()
    expect(s.ready).toBe(false)
    expect(s.detail).toMatch(/is not an \.exe/i)
  })

  it('reports the file that does not exist', async () => {
    configure({ whisperModelPath: join(dir, 'absent.bin') })
    const s = await localStt.status()
    expect(s.ready).toBe(false)
    expect(s.detail).toMatch(/does not exist/i)
  })

  it('is ready once both files are present, and says the clip stays local', async () => {
    configure()
    const s = await localStt.status()
    expect(s.ready).toBe(true)
    expect(s.configured).toBe(true)
    expect(s.detail).toMatch(/never leaves this machine/i)
    expect(s.exe).toBe(exe)
    expect(s.model).toBe(model)
  })

  it('refuses a path under a denied system location', async () => {
    configure({ whisperExePath: 'C:\\Windows\\System32\\whisper-cli.exe' })
    const s = await localStt.status()
    expect(s.ready).toBe(false)
    expect(s.detail).toMatch(/Windows/i)
  })
})

describe('local STT transcribe', () => {
  it('throws the configuration problem rather than returning empty text', async () => {
    await expect(localStt.transcribe(wav())).rejects.toThrow(/turned off/i)
    expect(runExe).not.toHaveBeenCalled()
  })

  it('refuses a clip that is not a RIFF/WAVE file before spawning anything', async () => {
    configure()
    await expect(localStt.transcribe(Buffer.from('OggS-not-a-wav-file'))).rejects.toThrow(/needs a WAV clip/i)
    expect(runExe).not.toHaveBeenCalled()
  })

  it('passes argv only, with the model, the clip and the language', async () => {
    configure({ whisperLanguage: 'en' })
    runExe.mockImplementation(async (_file: string, args: string[]) => {
      const outBase = args[args.indexOf('-of') + 1]
      const { writeFile } = await import('node:fs/promises')
      await writeFile(`${outBase}.txt`, '  Turn the kitchen light off.  \n\n')
      return { stdout: 'whisper progress noise', stderr: '', exitCode: 0, timedOut: false }
    })

    const text = await localStt.transcribe(wav())
    expect(text).toBe('Turn the kitchen light off.')

    const [file, args] = runExe.mock.calls[0]
    expect(file).toBe(exe)
    expect(args).toContain('-m')
    expect(args[args.indexOf('-m') + 1]).toBe(model)
    expect(args[args.indexOf('-l') + 1]).toBe('en')
    expect(args).toContain('-otxt')
    expect(args).toContain('-nt')
    // No shell metacharacter can matter, because no string is ever concatenated.
    expect(args.every((a: string) => typeof a === 'string')).toBe(true)
  })

  it('reports the exit code and stderr when the binary fails', async () => {
    configure()
    runExe.mockResolvedValue({ stdout: '', stderr: 'failed to load model', exitCode: 3, timedOut: false })
    await expect(localStt.transcribe(wav())).rejects.toThrow(/exit 3.*failed to load model/i)
  })

  it('says the clip may be silent when the binary succeeds with no text', async () => {
    configure()
    runExe.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, timedOut: false })
    await expect(localStt.transcribe(wav())).rejects.toThrow(/may be silent/i)
  })

  it('reports a timeout as a timeout', async () => {
    configure()
    runExe.mockResolvedValue({ stdout: '', stderr: '', exitCode: null, timedOut: true })
    await expect(localStt.transcribe(wav())).rejects.toThrow(/timed out/i)
  })

  it('deletes the temporary clip afterwards', async () => {
    configure()
    let clipPath = ''
    runExe.mockImplementation(async (_file: string, args: string[]) => {
      clipPath = args[args.indexOf('-f') + 1]
      const { writeFile } = await import('node:fs/promises')
      await writeFile(`${args[args.indexOf('-of') + 1]}.txt`, 'hello')
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false }
    })
    await localStt.transcribe(wav())
    const { existsSync } = await import('node:fs')
    expect(clipPath).not.toBe('')
    expect(existsSync(clipPath)).toBe(false)
  })
})
