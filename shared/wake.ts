/**
 * Wake-phrase matching. Pure string work with no DOM and no Node, so the audio
 * pipeline in the renderer and the tests both use exactly the same rules.
 *
 * The input is whatever whisper.cpp returned for a short clip, which is noisier
 * than typed text: it annotates non-speech as `[BLANK_AUDIO]` or `(wind)`, it
 * punctuates freely, and on the small `base.en` model it renders "Akansha" as
 * "Akuncha", "Akansa" or "A Kansha". A literal `includes()` would miss all of
 * those, so the name is compared with a bounded edit distance instead. Two edits
 * is the ceiling; a reading three edits out ("Aconcha") is let go rather than
 * widening the net far enough to catch ordinary speech with it.
 */

/** Non-speech markers whisper emits instead of words. */
const NOISE = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|<[^>]*>/g

/** Greetings that may precede the name and are not part of the command. */
const GREETINGS = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'hai', 'hay', 'a', 'ay', 'eh'])

export interface Token {
  /** Letters and digits only, lower case. */
  norm: string
  /** Offset of the token in the original string, so a command can be sliced out verbatim. */
  start: number
  end: number
}

/** Splits text into comparable tokens while remembering where each one came from. */
export function tokenize(text: string): Token[] {
  // Blanked out one space per character so every offset below still points at
  // the same place in the caller's original string.
  const cleaned = text.replace(NOISE, (m) => ' '.repeat(m.length))
  const out: Token[] = []
  let norm = ''
  let start = -1
  const flush = (end: number) => {
    if (norm) out.push({ norm, start, end })
    norm = ''
    start = -1
  }
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    // Apostrophes inside a word are dropped rather than split on, so "what's"
    // stays one token and does not look like a two-word command.
    if (ch === "'" || ch === '’') continue
    const lower = ch.toLowerCase()
    if ((lower >= 'a' && lower <= 'z') || (ch >= '0' && ch <= '9')) {
      if (start < 0) start = i
      norm += lower
    } else {
      flush(i)
    }
  }
  flush(cleaned.length)
  return out
}

/** Levenshtein distance, capped: it stops early once every cell exceeds `max`. */
export function distance(a: string, b: string, max = 3): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      row[j] = value
      if (value < best) best = value
    }
    if (best > max) return max + 1
    prev = row
  }
  return prev[b.length]
}

/** How much misrecognition a name of this length may absorb. */
export function tolerance(name: string): number {
  if (name.length <= 4) return 0
  if (name.length <= 6) return 1
  return 2
}

/**
 * True when `candidate` is the name, allowing for whisper's mishearings. The
 * first letter must survive: without that anchor a seven-letter name matches
 * far too many ordinary words at distance two. `max` is lowered by the caller
 * when a match is being attempted across a word boundary.
 */
export function soundsLike(candidate: string, name: string, max = tolerance(name)): boolean {
  if (!candidate || !name) return false
  if (candidate === name) return true
  if (candidate[0] !== name[0]) return false
  return max > 0 && distance(candidate, name, max) <= max
}

export interface WakeResult {
  /** The wake name was heard. */
  hit: boolean
  /** What was said after the name, verbatim from the original text. Empty when the name stood alone. */
  command: string
  /** The token that matched, so the UI can show what it actually heard. */
  heard: string
}

const MISS: WakeResult = { hit: false, command: '', heard: '' }

/**
 * The name Akansha answers to, taken from the configured phrase. "hey akansha"
 * and "akansha" are the same trigger: the greeting is optional, which is what
 * makes "Akansha, what time is it?" work without a preamble.
 */
export function wakeName(phrase: string): string {
  const tokens = tokenize(phrase || 'akansha')
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]
    if (token && !GREETINGS.has(token.norm)) return token.norm
  }
  return 'akansha'
}

/** True when the clip held no words at all, only whisper's non-speech markers. */
export function isSilence(text: string): boolean {
  return tokenize(text).length === 0
}

/**
 * Looks for the wake name anywhere in a transcript and returns the command that
 * followed it. Only the first occurrence counts, so "Akansha, ask Akansha" is
 * one wake with the rest treated as the instruction.
 */
export function matchWake(text: string, phrase = 'hey akansha'): WakeResult {
  const name = wakeName(phrase)
  const tokens = tokenize(text)

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const next = tokens[i + 1]
    // A pause inside the name splits it in two ("A Kansha"), so an adjacent
    // pair is tried as one word before the pair is given up on. Joining is held
    // to a tighter tolerance than a single token: any two adjacent words can be
    // glued together, and at two edits that turned "a cancha" into a wake.
    const joined = next ? token.norm + next.norm : ''
    const span = soundsLike(token.norm, name)
      ? 1
      : joined && soundsLike(joined, name, Math.min(1, tolerance(name)))
        ? 2
        : 0
    if (!span) continue
    const matched = tokens[i + span - 1]
    const rest = tokens[i + span]
    return {
      hit: true,
      heard: text.slice(token.start, matched.end),
      command: rest ? text.slice(rest.start).trim().replace(/^[,.;:!?\s-]+/, '') : ''
    }
  }
  return MISS
}

/**
 * A follow-up utterance, spoken while Akansha is already awake. The name is
 * allowed but not required, and a bare greeting is not a command.
 */
export function followUp(text: string, phrase = 'hey akansha'): string {
  const withWake = matchWake(text, phrase)
  if (withWake.hit) return withWake.command
  const tokens = tokenize(text)
  if (!tokens.length) return ''
  if (tokens.length === 1 && GREETINGS.has(tokens[0].norm)) return ''
  return text.slice(tokens[0].start).trim()
}

/** The ways of saying "be quiet" that are recognised while Akansha is talking. */
const STOP_PHRASES = new Set([
  'stop',
  'stop it',
  'stop that',
  'stop talking',
  'stop speaking',
  'stop please',
  'please stop',
  'be quiet',
  'quiet',
  'quiet please',
  'silence',
  'shut up',
  'shush',
  'cancel',
  'cancel that',
  'enough',
  'thats enough',
  'never mind',
  'nevermind'
])

/**
 * True for "stop", "Akansha stop" and the handful of near-synonyms above.
 *
 * Kept to an exact list rather than "contains the word stop": while Akansha is
 * speaking this is the only thing a clip is allowed to mean, and a sentence like
 * "stop by the shop tomorrow" must not silence her. The name is optional, so it
 * works both as an interruption and as a wake-plus-command.
 */
export function isStopCommand(text: string, phrase = 'hey akansha'): boolean {
  const hit = matchWake(text, phrase)
  const body = hit.hit ? hit.command : text
  const words = tokenize(body).map((t) => t.norm)
  if (!words.length || words.length > 3) return false
  return STOP_PHRASES.has(words.join(' '))
}
