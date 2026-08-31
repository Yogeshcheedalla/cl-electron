import { useEffect, useRef } from 'react'
import { followUp, isStopCommand, matchWake } from '../../shared/wake'
import { WakeListener, type WakePhase } from '../features/voice/wake'
import { toBase64 } from '../features/voice/wav'
import { useAkanshaEvent } from './useEvents'
import { call, errorText } from '../services/api'
import { useApp } from '../stores/app'
import { useChat } from '../stores/chat'

/**
 * Hands-free voice. It shows what it is doing at all times, because an always-on
 * microphone that is not obvious is a microphone that is spying.
 *
 * The rules it will not bend:
 *
 * - It arms only when the user turned `voice.wakeWordEnabled` on themselves. The
 *   shipped default is off and nothing here can flip it.
 * - It refuses to arm unless whisper.cpp is ready on this machine. Continuous
 *   capture routed to a cloud recogniser would upload every sound in the room;
 *   with the local engine the clips are transcribed on the PC and deleted.
 * - Privacy mode disarms it immediately, mid-sentence if need be.
 * - A clip without the wake name in it is dropped where it was decoded. It is
 *   never stored, never added to a conversation and never sent to a model.
 *
 * A bare "Akansha" with no instruction opens a short follow-up window, so the
 * natural two-part form -- "Akansha?" ... "what's on my calendar" -- works as
 * well as the one-liner.
 *
 * Ctrl + Space is the way in when the wake word is not available at all -- no
 * whisper model, a refused microphone, or the feature simply switched off. A
 * keypress is consent for exactly one capture, so it opens the microphone, takes
 * one instruction with no name required, and closes it again.
 */

/** How long a bare wake stays open waiting for the actual instruction. */
const FOLLOW_UP_MS = 9_000
/** How long a Ctrl + Space capture keeps the microphone open with nothing said. */
const CAPTURE_MS = 12_000

/**
 * Set while the hook is mounted. It lets the on-screen indicator close a
 * Ctrl + Space capture in one click without knowing anything about the audio
 * pipeline -- the same promise the "Stop listening" button makes for the
 * always-on listener.
 */
let closeCapture: (() => void) | null = null

/** Closes any microphone opened by Ctrl + Space. Does nothing when none is open. */
export const stopVoiceCapture = () => closeCapture?.()

export function useWakeWord() {
  const wake = useApp((s) => s.wake)
  const enabled = useApp((s) => Boolean(s.settings?.voice.wakeWordEnabled))
  const privacyMode = useApp((s) => Boolean(s.settings?.privacy.privacyMode))

  const listener = useRef<WakeListener | null>(null)
  const awaitUntil = useRef(0)
  /** A one-shot listener opened by Ctrl + Space when the always-on one is not running. */
  const oneShot = useRef<WakeListener | null>(null)
  const oneShotTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Runs started by voice, so those are always read back even if auto-speak is off. */
  const voiceRuns = useRef(new Set<string>())

  const wanted = enabled && !privacyMode

  /** Silences Akansha mid-sentence and puts the listener back into wake mode. */
  const hush = useRef(() => {
    window.speechSynthesis?.cancel()
    listener.current?.speaking(false)
  })

  /** Closes a Ctrl + Space capture. Safe to call when there is nothing open. */
  const endCapture = useRef(() => {
    if (oneShotTimer.current) clearTimeout(oneShotTimer.current)
    oneShotTimer.current = null
    oneShot.current?.stop()
    oneShot.current = null
  })

  /**
   * Speech synthesis.
   *
   * The detector is *not* paused for the utterance: "stop" can only interrupt her
   * if the microphone is still listening while she talks. Instead the listener is
   * told it is her own voice, and `utterance` below throws away everything heard
   * in that state except an interruption -- so she can be cut off, but she can
   * never take her own words as an instruction.
   */
  const speak = useRef((text: string) => {
    const settings = useApp.getState().settings
    const clean = text.replace(/```[\s\S]*?```/g, ' code block ').trim()
    if (!clean || !window.speechSynthesis) return
    const utterance = new SpeechSynthesisUtterance(clean.slice(0, 700))
    const chosen = window.speechSynthesis.getVoices().find((v) => v.name === settings?.voice.voiceName)
    if (chosen) utterance.voice = chosen
    utterance.rate = settings?.voice.rate ?? 1
    utterance.volume = settings?.voice.volume ?? 1
    listener.current?.speaking(true)
    // Released on end, on error, and on cancel -- Chromium fires `end` for a
    // cancelled utterance, and `hush` clears the flag itself in case it does not.
    const release = () => listener.current?.speaking(false)
    utterance.onend = release
    utterance.onerror = release
    window.speechSynthesis.speak(utterance)
  })

  const phase = useRef((next: WakePhase, detail?: string) => {
    useApp.getState().setWake({
      phase: next,
      armed: next !== 'off' && next !== 'error',
      ...(detail === undefined ? {} : { detail })
    })
  })

  /** One captured utterance: transcribe locally, match the name, dispatch or discard. */
  const utterance = useRef(async (wav: Blob, opts: { requireName?: boolean } = {}) => {
    const app = useApp.getState()
    const phrase = app.settings?.voice.wakeWord?.trim() || 'hey akansha'
    const base64 = await toBase64(wav)
    const result = await call(() => window.akansha.voice.transcribe({ base64, mimeType: 'audio/wav' }))

    if (result.engine !== 'local') {
      // Belt and braces. The main process refuses cloud transcription while the
      // listener is armed, but if a clip ever came back from an API the
      // microphone closes rather than keep streaming the room to it.
      app.setWake({ detail: 'Stopped: that clip was not transcribed on this machine.' })
      listener.current?.stop()
      endCapture.current()
      return
    }

    // Heard while she was talking. The only thing such a clip is allowed to mean
    // is "be quiet" -- everything else is her own voice returning through the
    // microphone, and is dropped without being read any further.
    if (listener.current?.talking) {
      if (!isStopCommand(result.text, phrase)) return
      hush.current()
      awaitUntil.current = 0
      app.setWake({ heard: result.text.trim(), spoken: '', awaiting: false, detail: 'Stopped speaking.' })
      return
    }

    const hit = matchWake(result.text, phrase)
    const inWindow = Date.now() < awaitUntil.current
    const named = opts.requireName === false
    if (!hit.hit && !inWindow && !named) return // Not addressed to Akansha. Dropped here and nowhere else.

    const command = hit.hit ? hit.command : followUp(result.text, phrase)

    if (!command) {
      // Nothing to act on. A Ctrl + Space capture gets no second window: the
      // microphone it opened closes rather than staying open on a false start.
      if (named) {
        endCapture.current()
        app.setWake({ detail: 'Nothing was said, so the microphone closed again.' })
        return
      }
      awaitUntil.current = Date.now() + FOLLOW_UP_MS
      app.setWake({ heard: hit.heard || phrase, awaiting: true })
      speak.current('Yes?')
      setTimeout(() => {
        if (Date.now() >= awaitUntil.current) useApp.getState().setWake({ awaiting: false })
      }, FOLLOW_UP_MS + 200)
      return
    }

    awaitUntil.current = 0
    app.setWake({ heard: hit.heard || phrase, spoken: command, awaiting: false })
    endCapture.current()
    try {
      await useChat.getState().send(command, [])
      const runId = useChat.getState().runId
      if (runId) voiceRuns.current.add(runId)
      useApp.getState().go('chat')
    } catch (e) {
      speak.current('I could not start that.')
      useApp.getState().toast({ kind: 'bad', title: 'Voice command not sent', body: errorText(e) })
    }
  })

  // Replies are read back when the question arrived by voice, and for typed
  // questions too when "speak replies out loud" is on -- which is what finally
  // makes that setting do something.
  useAkanshaEvent('ai:done', (event) => {
    const byVoice = voiceRuns.current.delete(event.runId)
    if (byVoice || useApp.getState().settings?.voice.autoSpeak) speak.current(event.message)
  })

  /**
   * Opens the microphone for a single instruction and closes it again, used when
   * the always-on listener is not running. The badge is driven by the same phase
   * handler, so an open device still shows on screen for as long as it is open.
   */
  const openCapture = useRef(async () => {
    const instance = new WakeListener({
      phase: (next, detail) => phase.current(next, detail),
      utterance: (wav) => utterance.current(wav, { requireName: false })
    })
    oneShot.current = instance
    try {
      await instance.start()
    } catch (e) {
      endCapture.current()
      useApp.getState().setWake({ armed: false, phase: 'error', detail: errorText(e) })
      return
    }
    useApp.getState().setWake({
      heard: 'Ctrl + Space',
      spoken: '',
      awaiting: true,
      detail: 'Listening for one instruction — no wake word needed.'
    })
    const arm = () => {
      oneShotTimer.current = setTimeout(() => {
        const state = oneShot.current?.state
        // Mid-sentence or mid-transcription: give it the time to finish rather
        // than closing the device on a half-spoken instruction.
        if (state === 'hearing' || state === 'thinking') {
          arm()
          return
        }
        endCapture.current()
        useApp.getState().setWake({ awaiting: false, detail: 'Nothing was said, so the microphone closed again.' })
      }, CAPTURE_MS)
    }
    arm()
  })

  /**
   * One instruction, taken now, with no wake word required.
   *
   * When the always-on listener is already running the device is open, so this
   * only opens the follow-up window -- the same state a bare "Akansha" leaves it
   * in. When it is not running (switched off, no whisper model, a microphone that
   * was refused) the keypress opens the device for a single clip and closes it
   * again. Nothing here turns the always-on listener on: that stays the user's
   * setting, and one keypress is not consent for permanent monitoring.
   */
  const startCapture = useRef(async () => {
    const app = useApp.getState()
    // Asking for something new is also a request to stop the last answer.
    if (window.speechSynthesis?.speaking) hush.current()
    if (app.settings?.privacy.privacyMode) {
      app.toast({
        kind: 'info',
        title: 'Privacy mode is on',
        body: 'The microphone stays closed until you turn privacy mode off in Settings > Privacy.'
      })
      return
    }
    if (listener.current?.running) {
      awaitUntil.current = Date.now() + FOLLOW_UP_MS
      app.setWake({ heard: 'Ctrl + Space', awaiting: true, detail: 'Listening for your instruction.' })
      setTimeout(() => {
        if (Date.now() >= awaitUntil.current) useApp.getState().setWake({ awaiting: false })
      }, FOLLOW_UP_MS + 200)
      return
    }
    if (oneShot.current) return // Already capturing; a second press is not a second microphone.

    // Same rule as the always-on path: the clip is transcribed on this machine or
    // not at all, so with no local engine the honest answer is to open nothing.
    const caps = await call(() => window.akansha.voice.capabilities()).catch(() => null)
    if (!caps?.local.ready) {
      useApp.getState().toast({
        kind: 'bad',
        title: 'Speech recognition is not ready',
        body: caps?.local.detail ?? 'whisper.cpp is not configured, so nothing was recorded. Type the command instead.'
      })
      return
    }
    await openCapture.current()
  })

  // Ctrl + Space, forwarded by the main process. `stop` is the keyboard twin of
  // saying "stop": it silences her and closes any capture she opened.
  useAkanshaEvent('voice:command', (event) => {
    if (event.action === 'stop') {
      hush.current()
      endCapture.current()
      useApp.getState().setWake({ awaiting: false })
      return
    }
    void startCapture.current()
  })

  useEffect(() => {
    if (!wanted) {
      listener.current?.stop()
      listener.current = null
      awaitUntil.current = 0
      // A Ctrl + Space capture is not covered by the setting, but it must not
      // survive privacy mode being switched on either.
      if (privacyMode) endCapture.current()
      useApp.getState().setWake({ armed: false, phase: 'off', awaiting: false, detail: '' })
      return
    }
    let cancelled = false
    void (async () => {
      // Re-checked on every arm, so moving the whisper model out from under it
      // closes the microphone instead of silently falling back to the cloud.
      const caps = await call(() => window.akansha.voice.capabilities()).catch(() => null)
      if (cancelled) return
      if (!caps?.local.ready) {
        useApp.getState().setWake({
          armed: false,
          phase: 'error',
          detail: caps?.local.detail ?? 'whisper.cpp is not configured, so continuous listening stays off.'
        })
        return
      }
      // The always-on listener takes over from any one-shot capture, so there is
      // never a second device open behind the first.
      endCapture.current()
      const instance = new WakeListener({
        phase: (next, detail) => phase.current(next, detail),
        utterance: (wav) => utterance.current(wav)
      })
      listener.current = instance
      try {
        await instance.start()
        if (cancelled) instance.stop()
      } catch (e) {
        useApp.getState().setWake({ armed: false, phase: 'error', detail: errorText(e) })
      }
    })()
    return () => {
      cancelled = true
      listener.current?.stop()
      listener.current = null
    }
  }, [wanted, privacyMode])

  // Nothing stays open past the last render of the app.
  useEffect(() => {
    closeCapture = () => {
      endCapture.current()
      useApp.getState().setWake({ awaiting: false, detail: '' })
    }
    return () => {
      closeCapture = null
      endCapture.current()
    }
  }, [])

  return wake
}
