import { describe, expect, it } from 'vitest'
import { distance, followUp, isSilence, isStopCommand, matchWake, soundsLike, tokenize, wakeName } from '../shared/wake'
import { DEFAULT_SETTINGS } from '../electron/services/settings'

/**
 * The matcher is the only thing standing between an open microphone and Akansha
 * acting on a room's worth of conversation, so both directions are tested: the
 * mishearings that must still wake her, and the ordinary sentences that must not.
 */

describe('wake tokenizer', () => {
  it('keeps offsets pointing into the original string', () => {
    const text = '  Akansha, what time is it?'
    const tokens = tokenize(text)
    expect(tokens.map((t) => t.norm)).toEqual(['akansha', 'what', 'time', 'is', 'it'])
    expect(text.slice(tokens[0].start, tokens[0].end)).toBe('Akansha')
  })

  it('drops whisper non-speech markers without shifting later offsets', () => {
    const text = '[BLANK_AUDIO] Akansha stop'
    const tokens = tokenize(text)
    expect(tokens.map((t) => t.norm)).toEqual(['akansha', 'stop'])
    expect(text.slice(tokens[0].start, tokens[0].end)).toBe('Akansha')
  })

  it('treats a clip of only markers as silence', () => {
    expect(isSilence('[BLANK_AUDIO]')).toBe(true)
    expect(isSilence(' (wind) *coughs* ')).toBe(true)
    expect(isSilence('akansha')).toBe(false)
  })

  it('keeps a contraction as one word', () => {
    expect(tokenize("what's up").map((t) => t.norm)).toEqual(['whats', 'up'])
  })
})

describe('bounded edit distance', () => {
  it('measures real edits and gives up past the cap', () => {
    expect(distance('akansha', 'akansha')).toBe(0)
    expect(distance('akuncha', 'akansha', 2)).toBe(2)
    expect(distance('television', 'akansha', 2)).toBeGreaterThan(2)
  })

  it('scales tolerance with the length of the name, and anchors the first letter', () => {
    expect(soundsLike('akuncha', 'akansha')).toBe(true)
    expect(soundsLike('akansa', 'akansha')).toBe(true)
    // Three edits out: deliberately not matched, because the tolerance needed to
    // catch it also catches ordinary words.
    expect(soundsLike('aconcha', 'akansha')).toBe(false)
    // Same distance as a hit, wrong first letter: refused, because a loose first
    // letter is what turns ordinary speech into false wakes.
    expect(soundsLike('okansha', 'akansha')).toBe(false)
    // A six-letter name absorbs one edit; a four-letter one absorbs none, because
    // at that length almost every neighbouring word is one edit away.
    expect(soundsLike('jarvos', 'jarvis')).toBe(true)
    expect(soundsLike('jarvos', 'jarvis', 0)).toBe(false)
    expect(soundsLike('novo', 'nova')).toBe(false)
    expect(soundsLike('nova', 'nova')).toBe(true)
  })
})

describe('wake name', () => {
  it('answers to the bare name as well as the greeting form', () => {
    expect(wakeName('hey akansha')).toBe('akansha')
    expect(wakeName('akansha')).toBe('akansha')
    expect(wakeName('  ')).toBe('akansha')
  })
})

describe('matchWake', () => {
  it('wakes on the greeting form and returns the command that followed', () => {
    const r = matchWake('Hey Akansha, what is the time?')
    expect(r.hit).toBe(true)
    expect(r.heard).toBe('Akansha')
    expect(r.command).toBe('what is the time?')
  })

  it('wakes on the bare name, which is the whole point of the feature', () => {
    expect(matchWake('Akansha open notepad')).toMatchObject({ hit: true, command: 'open notepad' })
  })

  it('survives whisper mishearing the name', () => {
    expect(matchWake('Hey Akuncha, lock the screen').hit).toBe(true)
    expect(matchWake('Akansa what is my battery').hit).toBe(true)
    // Split across a pause: two tokens joined back into one word.
    expect(matchWake('A Kansha, mute the volume')).toMatchObject({ hit: true, command: 'mute the volume' })
  })

  it('reports an empty command when the name stood alone, so a prompt can follow', () => {
    expect(matchWake('Akansha?')).toMatchObject({ hit: true, command: '' })
    expect(matchWake('hey akansha')).toMatchObject({ hit: true, command: '' })
  })

  it('ignores ordinary conversation, which is what keeps an open mic tolerable', () => {
    for (const line of [
      'I was talking to my sister about the weather',
      'can you pass me the remote',
      'the answer is somewhere in the second chapter',
      'a cancha is a court in Spanish',
      '[BLANK_AUDIO]',
      'okay so anyway I said no'
    ]) {
      expect(matchWake(line).hit, line).toBe(false)
    }
  })

  it('takes only the first wake in a clip', () => {
    expect(matchWake('Akansha ask Akansha later').command).toBe('ask Akansha later')
  })

  it('honours a custom phrase', () => {
    expect(matchWake('computer, status report', 'hey computer')).toMatchObject({
      hit: true,
      command: 'status report'
    })
    expect(matchWake('akansha status', 'hey computer').hit).toBe(false)
  })
})

describe('followUp', () => {
  it('accepts a command without the name while the window is open', () => {
    expect(followUp('what is the time?')).toBe('what is the time?')
  })

  it('still strips the name when it is repeated', () => {
    expect(followUp('Akansha what is the time?')).toBe('what is the time?')
  })

  it('does not treat a bare greeting or silence as a command', () => {
    expect(followUp('hey')).toBe('')
    expect(followUp('[BLANK_AUDIO]')).toBe('')
    expect(followUp('   ')).toBe('')
  })
})

/**
 * While Akansha is talking the microphone stays open so she can be interrupted,
 * which means every clip of her own voice is passed through this. It has to say
 * yes to the handful of ways people say "be quiet" and no to everything else,
 * including ordinary sentences with the word "stop" in them.
 */
describe('isStopCommand', () => {
  it('accepts a bare stop and its near-synonyms', () => {
    for (const said of ['stop', 'Stop.', 'stop it', 'stop talking', 'be quiet', 'shut up', 'cancel', 'never mind']) {
      expect(isStopCommand(said), said).toBe(true)
    }
  })

  it('accepts the name in front of it', () => {
    expect(isStopCommand('Akansha, stop')).toBe(true)
    expect(isStopCommand('hey Akansha stop talking')).toBe(true)
    // A mishearing of the name still counts: the command is what matters.
    expect(isStopCommand('Akansa stop')).toBe(true)
  })

  it('ignores whisper noise markers around it', () => {
    expect(isStopCommand('[BLANK_AUDIO] stop (wind)')).toBe(true)
  })

  it('refuses a sentence that merely contains the word', () => {
    for (const said of [
      'stop by the shop tomorrow',
      'when does the bus stop running',
      'do not stop the download',
      'tell me about the stop sign'
    ]) {
      expect(isStopCommand(said), said).toBe(false)
    }
  })

  it('refuses silence and anything unrelated', () => {
    expect(isStopCommand('')).toBe(false)
    expect(isStopCommand('[BLANK_AUDIO]')).toBe(false)
    expect(isStopCommand('what is the weather')).toBe(false)
    expect(isStopCommand('Akansha what is the time')).toBe(false)
  })

  it('works with a custom wake phrase', () => {
    expect(isStopCommand('computer stop', 'hey computer')).toBe(true)
  })
})

describe('shipped defaults', () => {
  it('never arms the microphone for a new install', () => {
    expect(DEFAULT_SETTINGS.voice.wakeWordEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.privacy.screenAccess).toBe(false)
    expect(DEFAULT_SETTINGS.general.startWithWindows).toBe(false)
  })

  it('ships the phrase the user asked for', () => {
    expect(wakeName(DEFAULT_SETTINGS.voice.wakeWord)).toBe('akansha')
  })
})
