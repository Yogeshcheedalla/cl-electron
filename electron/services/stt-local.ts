import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { LocalSttStatus } from '../../shared/types'
import { logger } from '../core/logger'
import { describeError } from '../core/util'
import { readablePath } from './path-guard'
import { runExe } from './shell'
import { settings } from './settings'

/**
 * Offline speech-to-text through whisper.cpp.
 *
 * This is the honest shape of "install open-source voice to text" in a signed
 * desktop app: the recogniser is a real local binary the user already has, not a
 * download this app performs behind their back and not a several-hundred-megabyte
 * model bundled into an installer. The user points at `whisper-cli.exe` and a
 * `ggml-*.bin` model in Settings; both paths go through `readablePath`, so
 * `C:\Windows` is refused, and the binary is launched through `runExe` -- argv
 * only, `shell: false`, hard timeout, tree-kill -- exactly like every other
 * process this app starts. Nothing is passed to a shell, so a path containing a
 * quote or a semicolon is inert.
 *
 * whisper.cpp only reads 16 kHz mono PCM WAV. The renderer converts the recorded
 * clip with `OfflineAudioContext` before it ever reaches here (see
 * `src/features/voice/wav.ts`), which keeps ffmpeg out of the dependency list
 * entirely. A clip that is not a RIFF/WAVE file is refused here with that reason
 * rather than handed to the binary to fail obscurely.
 */

/** Long clips are slow on CPU; 10 minutes is already an unusual dictation. */
const TIMEOUT_MS = 10 * 60_000
const MAX_BYTES = 200 * 1024 * 1024

/** Resolves the configured paths, or explains precisely what is missing. */
async function resolvePaths(): Promise<{ exe: string; model: string } | { problem: string }> {
  const v = settings.get().voice
  if (!v.localStt) return { problem: 'Offline dictation is turned off in Settings > Voice.' }
  const exeRaw = v.whisperExePath.trim()
  const modelRaw = v.whisperModelPath.trim()
  if (!exeRaw || !modelRaw) {
    return {
      problem:
        'Offline dictation needs both a whisper.cpp executable and a model file. Set them in Settings > Voice.'
    }
  }

  let exe: string
  let model: string
  try {
    exe = readablePath(exeRaw)
    model = readablePath(modelRaw)
  } catch (e) {
    return { problem: describeError(e) }
  }

  if (extname(exe).toLowerCase() !== '.exe') {
    return { problem: `${exe} is not an .exe, so Akansha will not try to run it.` }
  }
  for (const [label, path] of [
    ['executable', exe],
    ['model', model]
  ] as const) {
    try {
      const s = await stat(path)
      if (!s.isFile()) return { problem: `The ${label} path ${path} is not a file.` }
    } catch {
      return { problem: `The ${label} ${path} does not exist.` }
    }
  }
  return { exe, model }
}

/** Reads whisper.cpp's `-otxt` output; its stdout is progress logging, not text. */
async function readTranscript(base: string): Promise<string> {
  const raw = await readFile(`${base}.txt`, 'utf8').catch(() => '')
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export const localStt = {
  async status(): Promise<LocalSttStatus> {
    const v = settings.get().voice
    const configured = v.localStt && !!v.whisperExePath.trim() && !!v.whisperModelPath.trim()
    const resolved = await resolvePaths()
    if ('problem' in resolved) return { configured, ready: false, detail: resolved.problem }
    return {
      configured: true,
      ready: true,
      detail: `Offline dictation runs ${basename(resolved.exe)} against ${basename(resolved.model)}. The clip never leaves this machine.`,
      exe: resolved.exe,
      model: resolved.model
    }
  },

  /**
   * Transcribes a 16 kHz mono WAV clip locally. Throws with the reason when the
   * configuration is incomplete, so the caller can fall back to a cloud provider
   * or tell the user what to fix -- never a silent empty string.
   */
  async transcribe(wav: Buffer): Promise<string> {
    const resolved = await resolvePaths()
    if ('problem' in resolved) throw new Error(resolved.problem)
    if (wav.length > MAX_BYTES) throw new Error('That recording is too long for offline transcription.')
    // "RIFF....WAVE": refuse anything else before spawning a process for it.
    if (wav.subarray(0, 4).toString('latin1') !== 'RIFF' || wav.subarray(8, 12).toString('latin1') !== 'WAVE') {
      throw new Error('Offline dictation needs a WAV clip; this recording is in another format.')
    }

    const dir = await mkdtemp(join(tmpdir(), 'akansha-stt-'))
    const input = join(dir, 'clip.wav')
    const outBase = join(dir, 'clip')
    const language = settings.get().voice.whisperLanguage.trim() || 'auto'
    try {
      await writeFile(input, wav)
      const args = [
        '-m', resolved.model,
        '-f', input,
        '-l', language,
        // Plain text out, no timestamps, no per-token noise on stdout.
        '-otxt',
        '-of', outBase,
        '-nt',
        '-np'
      ]
      const started = Date.now()
      const res = await runExe(resolved.exe, args, { timeoutMs: TIMEOUT_MS })
      const text = await readTranscript(outBase)
      logger.info('voice.localTranscribed', {
        ms: Date.now() - started,
        exit: res.exitCode,
        chars: text.length
      })
      if (res.timedOut) throw new Error('Offline transcription timed out and was stopped.')
      if (!text) {
        const why = (res.stderr || res.stdout).trim().slice(-300)
        throw new Error(
          res.exitCode === 0
            ? 'Offline transcription produced no text. The clip may be silent.'
            : `${basename(resolved.exe)} failed (exit ${res.exitCode}): ${why || 'no output'}`
        )
      }
      return text
    } finally {
      // The clip is the user's voice; it does not outlive the transcription.
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
