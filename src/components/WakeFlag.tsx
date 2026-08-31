import { useApp } from '../stores/app'
import { stopVoiceCapture } from '../hooks/useWakeWord'
import type { WakePhase } from '../features/voice/wake'

/**
 * The always-on-microphone indicator.
 *
 * This is not decoration and it is not dismissible: while the wake listener holds
 * the microphone open, this sits above every screen and says so, with a stop
 * button that closes the device in one click. If it is not on screen, Akansha is
 * not listening.
 */

const LABEL: Record<WakePhase, string> = {
  off: 'Microphone closed',
  starting: 'Opening the microphone…',
  listening: 'Microphone open — say the wake word',
  hearing: 'Hearing speech…',
  thinking: 'Checking for the wake word…',
  speaking: 'Speaking — say “stop” to interrupt',
  muted: 'Microphone muted',
  error: 'Continuous listening is off'
}

export function WakeFlag() {
  const wake = useApp((s) => s.wake)
  const settings = useApp((s) => s.settings)
  const saveSettings = useApp((s) => s.saveSettings)
  const go = useApp((s) => s.go)

  const enabled = Boolean(settings?.voice.wakeWordEnabled)
  // The failure state is worth showing too, but only to someone who asked for the
  // feature: otherwise it would nag every user who never turned it on.
  if (!wake.armed && !(enabled && wake.phase === 'error')) return null

  const phrase = settings?.voice.wakeWord?.trim() || 'hey akansha'
  const label = wake.phase === 'listening' ? `Microphone open — say “${phrase}”` : LABEL[wake.phase]
  // With continuous listening off, an open microphone can only be the one-shot
  // capture Ctrl + Space opened, and that gets its own way to close.
  const capture = wake.armed && !enabled
  const text = capture && wake.phase === 'listening' ? 'Microphone open — go ahead' : label

  return (
    <div className={`wake-flag ${wake.phase}`} role="status" aria-live="polite">
      <span className="wake-dot" aria-hidden="true" />
      <span className="wake-text">
        {wake.awaiting && !capture ? 'Awake — go ahead' : text}
        {wake.phase === 'error' && wake.detail ? `: ${wake.detail}` : ''}
      </span>
      {wake.spoken && wake.phase !== 'error' && <span className="wake-last">“{wake.spoken}”</span>}
      <button className="wake-btn" onClick={() => go('voice')} title="Voice settings">
        Voice
      </button>
      {capture && (
        <button className="wake-btn danger" onClick={() => stopVoiceCapture()}>
          Close microphone
        </button>
      )}
      {settings && enabled && (
        <button
          className="wake-btn danger"
          onClick={() =>
            void saveSettings({ voice: { ...settings.voice, wakeWordEnabled: false } }).catch(() => undefined)
          }
        >
          Stop listening
        </button>
      )}
    </div>
  )
}
