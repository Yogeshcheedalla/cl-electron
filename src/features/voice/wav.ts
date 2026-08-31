/**
 * 16 kHz mono 16-bit PCM WAV, produced in the renderer.
 *
 * whisper.cpp cannot decode webm/opus -- it reads exactly one format. The
 * conversion therefore has to happen somewhere, and the renderer is the only
 * place that already owns an audio decoder: `decodeAudioData` handles whatever
 * `MediaRecorder` produced, and `OfflineAudioContext` resamples it. Doing it here
 * keeps ffmpeg, a native resampler and a second binary out of the installer
 * entirely.
 *
 * OpenAI accepts WAV too, so the same clip serves both engines and there is no
 * branch on which recogniser will run.
 */

/** whisper.cpp's fixed input rate. Anything else is rejected by the binary. */
export const WHISPER_RATE = 16_000

/** Decodes a recording, downmixes to mono and resamples to 16 kHz. */
async function toMono16k(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer()
  // A short-lived context purely to decode; closed immediately so no device is held.
  const decoder = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await decoder.decodeAudioData(bytes)
  } finally {
    void decoder.close()
  }

  const frames = Math.max(1, Math.ceil((decoded.duration || 0) * WHISPER_RATE))
  const offline = new OfflineAudioContext(1, frames, WHISPER_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}

/**
 * Writes a canonical 44-byte RIFF header followed by little-endian PCM16.
 * Exported because the wake listener already holds 16 kHz mono PCM straight from
 * the audio graph and needs no decode step at all.
 */
export function encodeWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // format: PCM
  view.setUint16(22, 1, true) // channels: mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling: a sample above 1 would otherwise wrap to full-scale
    // negative and put a click in the audio.
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/**
 * Best-effort conversion. On failure the original recording is returned rather
 * than throwing, so a browser that cannot decode its own output still reaches the
 * cloud engine instead of losing the clip.
 */
export async function toWhisperWav(blob: Blob): Promise<{ blob: Blob; converted: boolean }> {
  try {
    const samples = await toMono16k(blob)
    if (!samples.length) return { blob, converted: false }
    return { blob: encodeWav(samples, WHISPER_RATE), converted: true }
  } catch {
    return { blob, converted: false }
  }
}

/** Chunked base64 so a multi-megabyte clip does not blow the argument limit. */
export async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}
