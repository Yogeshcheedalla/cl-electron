import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { attempt, describeError, fail, ok, redact, truncate } from '../electron/core/util'
import { DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT, initSettings, settings } from '../electron/services/settings'
import { provider, providerBaseUrl, providerIds } from '../electron/ai/providers'
import { embedUnavailable } from '../electron/ai/embeddings'

let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'akansha-settings-'))
  initSettings(dir)
})

beforeEach(() => {
  for (const section of Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]) {
    settings.resetSection(section)
  }
})

describe('secret redaction', () => {
  it('strips API keys out of strings before they reach the log', () => {
    const line = redact('calling with sk-ant-api03-AbCdEf123456789012345678')
    expect(line).toContain('sk-ant-[redacted]')
    expect(line).not.toContain('AbCdEf123456789012345678')
  })

  it('redacts openai and github style tokens too', () => {
    expect(redact('sk-proj-ABCDEFGH12345678')).not.toContain('ABCDEFGH12345678')
    expect(redact('ghp_ABCDEFGH12345678')).not.toContain('ABCDEFGH12345678')
  })

  it('redacts by key name whatever the value looks like', () => {
    const out = redact({ apiKey: 'hunter2', password: 'hunter2', token: 'hunter2', note: 'fine' })
    expect(JSON.stringify(out)).not.toContain('hunter2')
    expect(out.note).toBe('fine')
  })

  it('reaches into nested objects and arrays', () => {
    const out = redact({ providers: [{ id: 'openai', apiKey: 'hunter2' }], nested: { secret: 'hunter2' } })
    expect(JSON.stringify(out)).not.toContain('hunter2')
  })

  it('leaves ordinary values untouched', () => {
    expect(redact({ path: 'C:\\Users\\me', count: 3, ok: true })).toEqual({
      path: 'C:\\Users\\me',
      count: 3,
      ok: true
    })
  })
})

describe('tool results', () => {
  it('wraps success and failure in the same envelope shape', () => {
    expect(ok({ n: 1 })).toEqual({ success: true, data: { n: 1 } })
    expect(fail('FILES', 'nope', 'try again')).toEqual({
      success: false,
      error: { code: 'FILES', message: 'nope', hint: 'try again' }
    })
  })

  it('turns any thrown value into a readable message', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
    expect(describeError('boom')).toContain('boom')
    expect(describeError({ weird: true })).not.toBe('')
    expect(describeError(undefined)).not.toBe('')
  })

  it('never lets a thrown error escape attempt()', async () => {
    const result = await attempt('FILES', () => {
      throw new Error('disk on fire')
    })
    expect(result).toMatchObject({ success: false, error: { code: 'FILES', message: 'disk on fire' } })
  })

  it('redacts secrets carried in an error message', async () => {
    const result = await attempt('AI', () => {
      throw new Error('401 from key sk-ant-api03-AbCdEf123456789012345678')
    })
    expect(JSON.stringify(result)).not.toContain('AbCdEf123456789012345678')
  })

  it('truncates long text with a marker instead of silently cutting it', () => {
    const out = truncate('a'.repeat(500), 100)
    expect(out).toMatch(/^a{100}\n\.\.\.\[truncated 400 chars\]$/)
    expect(truncate('short', 100)).toBe('short')
  })
})

describe('settings', () => {
  it('starts from the documented defaults', () => {
    expect(settings.get().privacy.screenAccess).toBe(false)
    expect(settings.get().privacy.proactive).toBe(false)
    expect(settings.get().privacy.telemetry).toBe(false)
    expect(settings.get().voice.wakeWordEnabled).toBe(false)
    expect(settings.get().general.startWithWindows).toBe(false)
    expect(settings.get().automation.confirmDestructive).toBe(true)
    expect(settings.get().ai.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT)
  })

  it('merges a section patch without dropping its other keys', () => {
    settings.update({ privacy: { ...settings.get().privacy, screenAccess: true } })
    expect(settings.get().privacy.screenAccess).toBe(true)
    expect(settings.get().privacy.logRetentionDays).toBe(DEFAULT_SETTINGS.privacy.logRetentionDays)
  })

  it('leaves untouched sections alone', () => {
    settings.update({ memory: { enabled: false } })
    expect(settings.get().memory.enabled).toBe(false)
    expect(settings.get().ai.provider).toBe(DEFAULT_SETTINGS.ai.provider)
  })

  it('replaces arrays wholesale rather than merging them by index', () => {
    settings.update({ automation: { ...settings.get().automation, trustedTools: ['a', 'b'] } })
    settings.update({ automation: { ...settings.get().automation, trustedTools: ['c'] } })
    expect(settings.get().automation.trustedTools).toEqual(['c'])
  })

  it('persists to disk so a restart keeps the change', () => {
    settings.update({ mode: 'DEVELOPER' })
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(onDisk.mode).toBe('DEVELOPER')
  })

  it('never writes an API key into settings.json', () => {
    const onDisk = readFileSync(join(dir, 'settings.json'), 'utf8')
    expect(onDisk.toLowerCase()).not.toContain('apikey')
    expect(onDisk).not.toMatch(/sk-/)
  })

  it('resets one section and only that section', () => {
    settings.update({
      privacy: { ...settings.get().privacy, screenAccess: true },
      memory: { enabled: false }
    })
    settings.resetSection('privacy')
    expect(settings.get().privacy.screenAccess).toBe(false)
    expect(settings.get().memory.enabled).toBe(false)
  })

  it('restores a section the user emptied out', () => {
    settings.update({ keyboard: { globalShortcut: '', commandPalette: '' } })
    settings.resetSection('keyboard')
    expect(settings.get().keyboard.globalShortcut).toBe(DEFAULT_SETTINGS.keyboard.globalShortcut)
  })

  it('recovers from a corrupt settings file instead of failing to start', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'akansha-corrupt-'))
    writeFileSync(join(fresh, 'settings.json'), '{ not json', 'utf8')
    const loaded = initSettings(fresh)
    expect(loaded.ai.provider).toBe(DEFAULT_SETTINGS.ai.provider)
    initSettings(dir) // put the shared fixture back
  })
})

describe('providers', () => {
  it('knows the four providers and rejects anything else', () => {
    expect(providerIds).toEqual(['anthropic', 'openai', 'openrouter', 'ollama'])
    expect(() => provider('gemini' as never)).toThrow(/Unknown AI provider/)
  })

  it('reports honestly that a cloud provider has no key, rather than failing later', () => {
    // safeStorage is unavailable in the test stub and no env key is set here.
    expect(provider('anthropic').unavailable()).toMatch(/key/i)
    expect(provider('openai').unavailable()).toMatch(/key/i)
    expect(provider('openrouter').unavailable()).toMatch(/OpenRouter API key/)
  })

  it('needs no key for a local model', () => {
    expect(provider('ollama').unavailable()).toBeNull()
  })

  it('talks to the documented endpoints and allows an override', () => {
    expect(providerBaseUrl('anthropic')).toBe('https://api.anthropic.com')
    expect(providerBaseUrl('openrouter')).toBe('https://openrouter.ai/api')
    expect(providerBaseUrl('ollama')).toBe('http://127.0.0.1:11434')
    process.env.AKANSHA_OLLAMA_BASE_URL = 'http://127.0.0.1:9999/'
    expect(providerBaseUrl('ollama')).toBe('http://127.0.0.1:9999')
    delete process.env.AKANSHA_OLLAMA_BASE_URL
  })

  it('keeps OpenRouter out of embeddings instead of letting it 404 mid-index', () => {
    expect(embedUnavailable({ provider: 'openrouter', model: 'anything' })).toMatch(/OpenRouter does not offer/i)
    expect(embedUnavailable({ provider: 'anthropic', model: 'anything' })).toMatch(/does not offer an embeddings API/i)
  })
})
