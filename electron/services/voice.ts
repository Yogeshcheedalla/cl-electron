import type { VoiceCapabilities } from '../../shared/types'
import { logger } from '../core/logger'
import { describeError } from '../core/util'
import { secrets } from './secrets'
import { settings } from './settings'
import { localStt } from './stt-local'

const OPENAI_STT_MODEL = 'whisper-1'

/**
 * Speech is split between the two processes on purpose:
 *  - TTS runs in the renderer with the Web Speech API (real Windows voices, no key)
 *  - STT is either whisper.cpp on this machine or OpenAI's endpoint
 *
 * Offline first, when it is available. whisper.cpp is the open-source recogniser
 * this app supports, and if the user has pointed at a binary and a model then a
 * recording is transcribed locally and never leaves the machine -- no key, no
 * upload, no per-minute cost. It is *not* bundled: a usable model is hundreds of
 * megabytes and choosing one would be choosing the user's accuracy/size trade-off
 * for them, so `Settings > Voice` asks for the two paths and `capabilities()`
 * reports exactly which engine a recording would reach before the user speaks.
 *
 * The cloud path stays as a fallback because it needs no setup. If neither is
 * available the UI is told so up front rather than after someone has dictated a
 * paragraph.
 */
export const voice = {
  async capabilities(): Promise<VoiceCapabilities> {
    const local = await localStt.status()
    const cloud = secrets.has('openai')
    const engine = local.ready ? 'local' : cloud ? 'openai' : 'none'
    const sttDetail =
      engine === 'local'
        ? local.detail
        : engine === 'openai'
          ? local.configured
            ? `Offline dictation is not usable (${local.detail}) so recordings go to OpenAI Whisper instead.`
            : 'Dictation uploads the recorded clip to OpenAI Whisper. Point Settings > Voice at whisper.cpp to keep it on this machine.'
          : 'Dictation needs either whisper.cpp (Settings > Voice) or an OpenAI API key (Settings > AI Providers).'
    return { stt: engine !== 'none', sttDetail, tts: true, engine, local, cloud }
  },

  /**
   * Transcribes a recording. Prefers the local recogniser; falls back to OpenAI
   * only when local transcription is unavailable or fails, and says which one ran
   * so a silent downgrade to the cloud cannot happen unnoticed.
   *
   * The fallback is switched off entirely while the wake word is armed. Continuous
   * listening means clips arrive without anyone pressing a button, so an upload
   * would send the room to an API; if whisper breaks mid-session the honest answer
   * is an error, not a quiet stream of audio to OpenAI.
   */
  async transcribe(audio: { base64: string; mimeType: string }): Promise<{ text: string; engine: 'local' | 'openai' }> {
    if (!audio?.base64) throw new Error('No audio was recorded.')
    const bytes = Buffer.from(audio.base64, 'base64')
    if (bytes.length < 1000) throw new Error('The recording was too short to transcribe.')

    const local = await localStt.status()
    const listening = settings.get().voice.wakeWordEnabled
    const cloud = secrets.has('openai') && !listening

    if (local.ready) {
      try {
        return { text: await localStt.transcribe(bytes), engine: 'local' }
      } catch (e) {
        // A configured local recogniser that fails is worth surfacing even when a
        // fallback exists, so the user can fix the setup instead of quietly
        // paying for the cloud from then on.
        const reason = describeError(e)
        logger.warn('voice.localFailed', { message: reason, fallback: cloud, listening })
        if (!cloud) throw e
        return { text: await transcribeWithOpenAI(bytes, audio.mimeType), engine: 'openai' }
      }
    }

    if (!cloud) {
      throw new Error(
        listening
          ? `Continuous listening only uses whisper.cpp on this machine, and it is not usable: ${local.detail}`
          : local.configured
            ? `Offline dictation is configured but not usable: ${local.detail}`
            : 'Dictation needs either whisper.cpp (Settings > Voice) or an OpenAI API key (Settings > AI Providers).'
      )
    }
    return { text: await transcribeWithOpenAI(bytes, audio.mimeType), engine: 'openai' }
  }
}

/**
 * Throws with the reason when continuous listening may not be armed. Both the
 * IPC handler and the tray checkbox go through this, so there is one place that
 * decides whether the microphone is allowed to stay open.
 */
export async function assertWakeAllowed(): Promise<void> {
  if (settings.get().privacy.privacyMode) {
    throw new Error('Privacy mode is on, so continuous listening cannot be switched on. Turn privacy mode off first.')
  }
  const local = await localStt.status()
  if (!local.ready) {
    throw new Error(
      `Continuous listening needs whisper.cpp on this machine so clips are transcribed here and deleted: ${local.detail}`
    )
  }
}

/** The cloud fallback. Unchanged behaviour, just no longer the only option. */
async function transcribeWithOpenAI(bytes: Buffer, mimeType: string): Promise<string> {
  const key = secrets.get('openai')
  if (!key) throw new Error('No OpenAI API key is stored.')
  if (bytes.length > 24 * 1024 * 1024) throw new Error('The recording is larger than the 25 MB limit.')

  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'webm'
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), `clip.${ext}`)
  form.append('model', OPENAI_STT_MODEL)

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(120_000)
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Transcription failed (HTTP ${res.status}): ${detail.slice(0, 300)}`)
  }
  const json = (await res.json()) as { text?: string }
  const text = (json.text ?? '').trim()
  if (!text) throw new Error('The transcription came back empty.')
  return text
}
