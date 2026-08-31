import { useEffect, useRef, useState } from 'react'
import { Btn, Card, Empty, Field, Pill, Toggle } from '../components/ui'
import { Orb } from '../components/Orb'
import type { WakePhase } from '../features/voice/wake'
import { toBase64, toWhisperWav } from '../features/voice/wav'
import { useLoad } from '../hooks/useAsync'
import { call, errorText } from '../services/api'
import { useApp } from '../stores/app'
import { useChat } from '../stores/chat'

/** What the listener is doing right now, in words. */
const WAKE_PHASE: Record<WakePhase, string> = {
  off: 'Not listening',
  starting: 'Opening the microphone',
  listening: 'Waiting for the wake word',
  hearing: 'Hearing speech',
  thinking: 'Checking the transcript',
  speaking: 'Speaking — listening only for “stop”',
  muted: 'Muted',
  error: 'Unavailable'
}

/**
 * Recording is explicit: the microphone only opens when the button is pressed
 * and the stream is torn down the moment it stops, so nothing here can listen
 * in the background -- unless the wake word is switched on below, which opens the
 * microphone permanently and says so on every screen while it does. Speech
 * synthesis uses the browser voices Electron ships.
 */
export function VoicePage() {
  const { settings, saveSettings, toast, go, wake } = useApp()
  const send = useChat((s) => s.send)
  const caps = useLoad(
    () => call(() => window.akansha.voice.capabilities()),
    // Re-probed whenever the whisper configuration changes, so the badge reflects
    // what a recording would actually reach rather than what it would have.
    [settings?.voice.localStt, settings?.voice.whisperExePath, settings?.voice.whisperModelPath]
  )
  const [recording, setRecording] = useState(false)
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  /** Which recogniser actually ran, so a fallback to the cloud is visible. */
  const [lastEngine, setLastEngine] = useState<'local' | 'openai' | null>(null)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])

  useEffect(() => {
    const read = () => setVoices(window.speechSynthesis?.getVoices() ?? [])
    read()
    window.speechSynthesis?.addEventListener('voiceschanged', read)
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', read)
  }, [])

  useEffect(
    () => () => {
      recorder.current?.stream.getTracks().forEach((t) => t.stop())
    },
    []
  )

  const start = async () => {
    if (settings?.privacy.privacyMode) {
      toast({ kind: 'bad', title: 'Privacy mode is on', body: 'Turn privacy mode off before using the microphone.' })
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      chunks.current = []
      mr.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        void transcribe(new Blob(chunks.current, { type: mr.mimeType || 'audio/webm' }))
      }
      recorder.current = mr
      mr.start()
      setRecording(true)
    } catch (e) {
      toast({ kind: 'bad', title: 'Microphone unavailable', body: errorText(e) })
    }
  }

  const stop = () => {
    recorder.current?.stop()
    recorder.current = null
    setRecording(false)
  }

  const transcribe = async (blob: Blob) => {
    setPending(true)
    try {
      // Convert here, where an AudioContext exists: whisper.cpp reads only
      // 16 kHz mono WAV, and OpenAI accepts WAV as well, so one clip serves both.
      const { blob: clip, converted } = await toWhisperWav(blob)
      const base64 = await toBase64(clip)
      const result = await call(() =>
        window.akansha.voice.transcribe({ base64, mimeType: clip.type || 'audio/webm' })
      )
      setText(result.text)
      setLastEngine(result.engine)
      if (!converted && caps.data?.engine === 'local') {
        toast({
          kind: 'info',
          title: 'Clip could not be converted',
          body: 'This recording could not be resampled to 16 kHz mono, so offline transcription was skipped.'
        })
      }
    } catch (e) {
      toast({ kind: 'bad', title: 'Transcription failed', body: errorText(e) })
    } finally {
      setPending(false)
    }
  }

  const speak = (value: string) => {
    if (!value.trim() || !window.speechSynthesis) return
    const utterance = new SpeechSynthesisUtterance(value)
    const chosen = voices.find((v) => v.name === settings?.voice.voiceName)
    if (chosen) utterance.voice = chosen
    utterance.rate = settings?.voice.rate ?? 1
    utterance.volume = settings?.voice.volume ?? 1
    window.speechSynthesis.speak(utterance)
  }

  const sendIt = async () => {
    const value = text.trim()
    if (!value) return
    try {
      await send(value, [])
      setText('')
      go('chat')
    } catch (e) {
      toast({ kind: 'bad', title: 'Message not sent', body: errorText(e) })
    }
  }

  const voice = settings?.voice

  /**
   * Why continuous listening cannot be switched on, or null when it can. The main
   * process enforces the same two conditions; this is here so the toggle explains
   * itself instead of failing when it is pressed.
   */
  const wakeBlocked = settings?.privacy.privacyMode
    ? 'Privacy mode is on, so the microphone cannot be opened. Turn it off in Settings > Privacy first.'
    : caps.data && !caps.data.local.ready
      ? `Continuous listening needs whisper.cpp on this machine: ${caps.data.local.detail} Cloud dictation would upload everything the microphone hears, so it is not allowed for this.`
      : null

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <h1 style={{ margin: 0, fontSize: 20 }}>Voice</h1>
        <span className="grow" />
        <Pill tone={caps.data?.stt ? 'ok' : 'warn'}>
          {caps.data?.engine === 'local'
            ? 'Dictation: offline'
            : caps.data?.engine === 'openai'
              ? 'Dictation: OpenAI'
              : caps.data?.sttDetail ?? 'Checking transcription…'}
        </Pill>
        <Pill tone={caps.data?.tts ? 'ok' : 'warn'}>{caps.data?.tts ? 'Speech ready' : 'No speech voices'}</Pill>
      </div>

      <Card>
        <div className="row wrap" style={{ gap: 16 }}>
          <Orb state={recording ? 'LISTENING' : pending ? 'THINKING' : 'IDLE'} size={72} />
          <div className="col grow" style={{ gap: 8, minWidth: 260 }}>
            <div className="row wrap" style={{ gap: 8 }}>
              {recording ? (
                <Btn variant="danger" onClick={stop}>
                  Stop recording
                </Btn>
              ) : (
                <Btn variant="primary" disabled={pending} onClick={() => void start()}>
                  {pending ? 'Transcribing…' : 'Record'}
                </Btn>
              )}
              <Btn disabled={!text.trim()} onClick={() => speak(text)}>
                Read it back
              </Btn>
              <Btn variant="primary" disabled={!text.trim()} onClick={() => void sendIt()}>
                Send to Akansha
              </Btn>
            </div>
            <div className="dim small">
              {recording
                ? 'The microphone is open. It closes as soon as you press stop.'
                : 'The microphone is closed. Akansha never opens it on its own.'}
            </div>
          </div>
        </div>
      </Card>

      <Card title="Transcript">
        <textarea
          value={text}
          rows={5}
          placeholder="Recorded speech appears here so you can correct it before sending."
          aria-label="Transcript"
          onChange={(e) => setText(e.target.value)}
        />
        {lastEngine && (
          <div className="dim small">
            {lastEngine === 'local'
              ? 'Transcribed on this machine by whisper.cpp. The clip was deleted afterwards and never left the device.'
              : 'Transcribed by OpenAI Whisper, which means the clip was uploaded.'}
          </div>
        )}
        {!caps.data?.stt && <Empty>{caps.data?.sttDetail ?? caps.error ?? 'Transcription is unavailable.'}</Empty>}
      </Card>

      {voice && (
        <Card title="Offline dictation (whisper.cpp)">
          <div className="col" style={{ gap: 10 }}>
            <div className="dim small">
              whisper.cpp is the open-source recogniser Akansha supports. Nothing is bundled and nothing is
              downloaded: get a release from{' '}
              <code>github.com/ggml-org/whisper.cpp</code> and a <code>ggml-*.bin</code> model, then point at both
              below. Recordings are then transcribed on this machine with no API key and no upload.
            </div>
            <Toggle
              label="Use whisper.cpp when it is available"
              hint="When off, or when either path is missing, dictation falls back to OpenAI if a key is stored."
              checked={voice.localStt}
              onChange={(localStt) => void saveSettings({ voice: { ...voice, localStt } })}
            />
            <div className="grid cols-2">
              <Field label="whisper-cli.exe" hint="From a whisper.cpp release. Older builds call it main.exe.">
                <input
                  value={voice.whisperExePath}
                  spellCheck={false}
                  placeholder="C:\tools\whisper\whisper-cli.exe"
                  onChange={(e) => void saveSettings({ voice: { ...voice, whisperExePath: e.target.value } })}
                />
              </Field>
              <Field label="Model file" hint="ggml-base.en.bin is a good first choice: fast, ~150 MB.">
                <input
                  value={voice.whisperModelPath}
                  spellCheck={false}
                  placeholder="C:\tools\whisper\ggml-base.en.bin"
                  onChange={(e) => void saveSettings({ voice: { ...voice, whisperModelPath: e.target.value } })}
                />
              </Field>
              <Field label="Language" hint="An ISO code such as en or hi, or auto to let whisper detect it.">
                <input
                  value={voice.whisperLanguage}
                  spellCheck={false}
                  placeholder="auto"
                  onChange={(e) => void saveSettings({ voice: { ...voice, whisperLanguage: e.target.value } })}
                />
              </Field>
              <div className="col" style={{ gap: 6, justifyContent: 'flex-end' }}>
                <Pill tone={caps.data?.local.ready ? 'ok' : caps.data?.local.configured ? 'warn' : ''}>
                  {caps.data?.local.ready ? 'Ready' : caps.data?.local.configured ? 'Not usable' : 'Not configured'}
                </Pill>
                <div className="dim small">{caps.data?.local.detail ?? 'Checking…'}</div>
                <Btn size="sm" onClick={() => void caps.reload()}>
                  Re-check
                </Btn>
              </div>
            </div>
          </div>
        </Card>
      )}

      {voice && (
        <Card title="Hands-free (wake word)">
          <div className="col" style={{ gap: 10 }}>
            <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
              <Pill tone={wake.armed ? 'ok' : wake.phase === 'error' ? 'warn' : ''}>
                {wake.armed ? 'Microphone open' : 'Microphone closed'}
              </Pill>
              <Pill tone="info">{WAKE_PHASE[wake.phase]}</Pill>
              {wake.awaiting && <Pill tone="ok">Awake — waiting for your instruction</Pill>}
            </div>
            <Toggle
              label={`Listen continuously for “${voice.wakeWord.trim() || 'hey akansha'}”`}
              hint={wakeBlocked ?? 'The microphone stays open. A green badge sits at the bottom of the window the whole time it is, with a stop button on it.'}
              checked={voice.wakeWordEnabled}
              disabled={Boolean(wakeBlocked)}
              onChange={(wakeWordEnabled) =>
                void saveSettings({ voice: { ...voice, wakeWordEnabled } }).catch((e) =>
                  toast({ kind: 'bad', title: 'Wake word not changed', body: errorText(e) })
                )
              }
            />
            <div className="grid cols-2">
              <Field
                label="Wake phrase"
                hint="The greeting is optional: with “hey akansha” saved, plain “Akansha” wakes it too."
              >
                <input
                  value={voice.wakeWord}
                  spellCheck={false}
                  placeholder="hey akansha"
                  onChange={(e) => void saveSettings({ voice: { ...voice, wakeWord: e.target.value } })}
                />
              </Field>
              <div className="col" style={{ gap: 6, justifyContent: 'flex-end' }}>
                <div className="dim small">
                  {wake.heard ? (
                    <>
                      Last wake: <span className="mono">{wake.heard}</span>
                    </>
                  ) : (
                    'Nothing has woken it yet this session.'
                  )}
                </div>
                <div className="dim small">
                  {wake.spoken ? (
                    <>
                      Last command: <span className="mono">{wake.spoken}</span>
                    </>
                  ) : (
                    'No spoken command has been sent yet.'
                  )}
                </div>
                {wake.detail && <div className="dim small">{wake.detail}</div>}
              </div>
            </div>
            <div className="dim small">
              How it works: sound is buffered on this machine and every stretch of speech is transcribed by whisper.cpp
              locally. If the wake name is not in the transcript the clip is discarded immediately — it is not saved, not
              added to a conversation and not sent to any model. Only what you say after the name is sent, and the answer
              is read back out loud. Whisper is required for exactly this reason: with cloud dictation, continuous
              listening would upload everything the microphone hears.
            </div>
          </div>
        </Card>
      )}

      {voice && (
        <Card title="Voice settings">
          <div className="grid cols-2">
            <Field label="Speech voice">
              <select
                value={voice.voiceName}
                onChange={(e) => void saveSettings({ voice: { ...voice, voiceName: e.target.value } })}
              >
                <option value="">System default</option>
                {voices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Rate — ${voice.rate.toFixed(1)}×`}>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.1}
                value={voice.rate}
                onChange={(e) => void saveSettings({ voice: { ...voice, rate: Number(e.target.value) } })}
              />
            </Field>
            <Field label={`Volume — ${Math.round(voice.volume * 100)}%`}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={voice.volume}
                onChange={(e) => void saveSettings({ voice: { ...voice, volume: Number(e.target.value) } })}
              />
            </Field>
            <div className="col" style={{ gap: 8 }}>
              <Toggle
                label="Speak replies out loud"
                hint="Applies to typed questions too. Answers to spoken commands are always read back."
                checked={voice.autoSpeak}
                onChange={(autoSpeak) => void saveSettings({ voice: { ...voice, autoSpeak } })}
              />
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}
