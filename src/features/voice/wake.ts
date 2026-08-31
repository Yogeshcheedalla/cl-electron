import { WHISPER_RATE, encodeWav } from './wav'

/**
 * The always-on listener.
 *
 * It opens the microphone, watches the signal energy, and cuts a 16 kHz mono WAV
 * for every stretch of speech it hears. Nothing is decided here about *what* was
 * said: each clip is handed to the caller, which transcribes it locally and
 * throws it away unless the wake name is in it.
 *
 * Two design points are deliberate:
 *
 * `ScriptProcessorNode` is used rather than `AudioWorklet`. A worklet has to
 * fetch its module over a URL, and the packaged renderer runs from `file://`
 * under `script-src 'self'`, where that fetch is unreliable -- and relaxing the
 * CSP to `blob:` to work around it would weaken the whole window. The processor
 * node is deprecated but present, and it has one property a polling
 * `AnalyserNode` does not: its callback is driven from the audio thread, so it
 * keeps firing while the window sits minimised in the tray.
 *
 * A pre-roll ring buffer runs at all times. Energy detection is inherently late
 * -- by the time a frame is loud enough to be speech, the first syllable of
 * "Akansha" is already past -- so the previous 400 ms is prepended to every
 * clip. Without it the wake word is clipped to "kansha" and never matches.
 */

/** 4096 frames at 16 kHz is 256 ms of latency, the largest size the node allows. */
const FRAME = 4096
const FRAME_MS = (FRAME / WHISPER_RATE) * 1000
const PRE_ROLL_MS = 400
const PRE_ROLL_FRAMES = Math.ceil(PRE_ROLL_MS / FRAME_MS)
/** Speech ends after this much quiet, which is also the response latency floor. */
const HANG_MS = 700
/** Nothing longer is sent: a stuck-open microphone must not grow without bound. */
const MAX_MS = 12_000
/**
 * While Akansha is talking, her own voice never pauses long enough to close a
 * clip, so clips are cut this often instead. It is the worst-case delay before a
 * spoken "stop" is looked at, and it keeps each transcription small.
 */
const SELF_SPEECH_MAX_MS = 3000
/** Below this there is nothing worth transcribing, whatever the noise floor says. */
const FLOOR = 0.008
/** Speech has to stand this far above the measured room noise. */
const OVER_NOISE = 3.2
/** One frame of noise does not open a clip; a real word covers several. */
const OPEN_FRAMES = 2

export type WakePhase = 'off' | 'starting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'muted' | 'error'

export interface WakeHandlers {
  /** Called on every state change so the indicator can never lag behind the microphone. */
  phase(phase: WakePhase, detail?: string): void
  /** A finished utterance as 16 kHz mono WAV. Rejections are reported, not thrown. */
  utterance(wav: Blob, seconds: number): Promise<void>
}

const rms = (frame: Float32Array): number => {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}

export class WakeListener {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private node: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private sink: GainNode | null = null

  private preRoll: Float32Array[] = []
  private speech: Float32Array[] = []
  private loud = 0
  private quietMs = 0
  private noise = FLOOR
  private open = false
  private busy = false
  private paused = false
  private selfSpeech = false
  private phase: WakePhase = 'off'

  constructor(private readonly handlers: WakeHandlers) {}

  get running(): boolean {
    return this.ctx !== null
  }

  get state(): WakePhase {
    return this.phase
  }

  private to(phase: WakePhase, detail?: string) {
    if (this.phase === phase && !detail) return
    this.phase = phase
    this.handlers.phase(phase, detail)
  }

  /** Opens the microphone. Throws with the browser's reason if it is refused. */
  async start(): Promise<void> {
    if (this.ctx) return
    this.to('starting')
    try {
      // Mono at the rate whisper wants, with the browser's own cleanup on: the
      // clips are short and speech-only, so aggressive processing helps here.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: WHISPER_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      const ctx = new AudioContext({ sampleRate: WHISPER_RATE })
      if (ctx.state === 'suspended') await ctx.resume()
      if (typeof ctx.createScriptProcessor !== 'function') {
        throw new Error('This build of Chromium has no ScriptProcessorNode, so continuous listening cannot run.')
      }
      this.ctx = ctx
      this.source = ctx.createMediaStreamSource(this.stream)
      this.node = ctx.createScriptProcessor(FRAME, 1, 1)
      this.node.onaudioprocess = (e) => this.frame(e.inputBuffer.getChannelData(0))
      // Chromium only pumps a processor node that reaches the destination, so a
      // silent gain stage stands in for playback. Nothing is audible.
      this.sink = ctx.createGain()
      this.sink.gain.value = 0
      this.source.connect(this.node)
      this.node.connect(this.sink)
      this.sink.connect(ctx.destination)
      this.reset()
      this.to(this.idle())
    } catch (e) {
      this.stop()
      this.to('error', e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  /** Closes the microphone and releases the device. Safe to call at any time. */
  stop() {
    if (this.node) this.node.onaudioprocess = null
    this.node?.disconnect()
    this.source?.disconnect()
    this.sink?.disconnect()
    void this.ctx?.close().catch(() => undefined)
    this.stream?.getTracks().forEach((t) => t.stop())
    this.node = null
    this.source = null
    this.sink = null
    this.ctx = null
    this.stream = null
    this.reset()
    this.to('off')
  }

  /**
   * Stops feeding the detector without dropping the device, used for the mute
   * control: the microphone stays open but nothing is examined or kept.
   */
  pause() {
    this.paused = true
    this.discard()
    if (this.ctx) this.to(this.idle())
  }

  resume() {
    this.paused = false
    this.discard()
    if (this.ctx) this.to(this.idle())
  }

  /**
   * Marks the stretch while Akansha herself is talking.
   *
   * The detector deliberately keeps running: "stop" can only interrupt her if
   * the microphone is still open to hear it. What changes is what the caller is
   * told -- the phase reads `speaking`, and the caller is expected to throw away
   * any transcript that is not an interruption, so her own voice returning
   * through the microphone can never be acted on as an instruction.
   */
  speaking(on: boolean) {
    this.selfSpeech = on
    this.discard()
    if (this.ctx) this.to(this.idle())
  }

  /** True while the caller has declared that Akansha is talking. */
  get talking(): boolean {
    return this.selfSpeech
  }

  /** The phase to fall back to whenever a clip finishes and nothing is being said. */
  private idle(): WakePhase {
    return this.paused ? 'muted' : this.selfSpeech ? 'speaking' : 'listening'
  }

  private reset() {
    this.preRoll = []
    this.discard()
    this.noise = FLOOR
    this.selfSpeech = false
  }

  private discard() {
    this.speech = []
    this.loud = 0
    this.quietMs = 0
    this.open = false
  }

  private frame(input: Float32Array) {
    if (this.paused) return
    // The node hands back a view onto a reused buffer, so it has to be copied
    // before it is kept for longer than this call.
    const frame = new Float32Array(input)
    const level = rms(frame)

    if (!this.open) {
      this.preRoll.push(frame)
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift()
      // The noise floor tracks the room slowly and only while nothing is being
      // said, so a passing truck raises the bar instead of opening a clip.
      this.noise = this.noise * 0.95 + level * 0.05
    }

    const threshold = Math.max(FLOOR, this.noise * OVER_NOISE)

    if (!this.open) {
      this.loud = level > threshold ? this.loud + 1 : 0
      if (this.loud < OPEN_FRAMES) return
      this.open = true
      this.quietMs = 0
      this.speech = [...this.preRoll]
      if (!this.selfSpeech) this.to('hearing')
      return
    }

    this.speech.push(frame)
    this.quietMs = level > threshold ? 0 : this.quietMs + FRAME_MS
    const heldMs = this.speech.length * FRAME_MS
    const cap = this.selfSpeech ? SELF_SPEECH_MAX_MS : MAX_MS
    if (this.quietMs >= HANG_MS || heldMs >= cap) this.close()
  }

  private close() {
    const frames = this.speech
    this.discard()
    this.preRoll = []
    if (this.busy) return // A clip is already in flight; this one is dropped rather than queued.
    const total = frames.reduce((n, f) => n + f.length, 0)
    const seconds = total / WHISPER_RATE
    // Anything this short is a door or a cough, never a two-syllable name.
    if (seconds < 0.35) {
      this.to(this.idle())
      return
    }
    const samples = new Float32Array(total)
    let at = 0
    for (const f of frames) {
      samples.set(f, at)
      at += f.length
    }
    this.busy = true
    // While she is talking the phase stays `speaking`: the clip is only being
    // checked for an interruption, and flashing "Thinking" at her own voice
    // would tell the user something untrue.
    if (!this.selfSpeech) this.to('thinking')
    void this.handlers
      .utterance(encodeWav(samples, WHISPER_RATE), seconds)
      .catch(() => undefined)
      .finally(() => {
        this.busy = false
        if (this.ctx) this.to(this.idle())
      })
  }
}
