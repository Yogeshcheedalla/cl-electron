import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  LIGHTER_MODEL,
  RECOMMENDED_MODEL,
  detectOllamaExe,
  hasModel,
  ollamaAdvice,
  ollamaLastStatus,
  ollamaVerdict,
  probeOllama,
  resetOllamaStatus
} from '../electron/ai/ollama'
import { isLocalProvider, resolveChain, resolveModel } from '../electron/ai/router'
import { provider } from '../electron/ai/providers'
import { DEFAULT_SETTINGS, initSettings, settings } from '../electron/services/settings'
import type { FallbackMode } from '../shared/types'

/**
 * The local route is the default one, so "is Ollama there?" has to be answered
 * with facts rather than optimism, and the fallback chain has to be provably
 * ordered -- LOCAL_ONLY in particular is a privacy promise, not a preference:
 * its chain must contain no network provider at all.
 */

beforeAll(() => {
  initSettings(mkdtempSync(join(tmpdir(), 'akansha-local-ai-')))
})

beforeEach(() => {
  settings.resetSection('ai')
  resetOllamaStatus()
})

afterEach(() => {
  resetOllamaStatus()
})

const setFallback = (fallback: FallbackMode) => settings.update({ ai: { ...settings.get().ai, fallback } })

describe('shipped local defaults', () => {
  it('defaults to the local provider, so no cloud key is required to start', () => {
    expect(DEFAULT_SETTINGS.ai.provider).toBe('ollama')
    expect(DEFAULT_SETTINGS.ai.routing.LOCAL.provider).toBe('ollama')
  })

  it('defaults to LOCAL FIRST', () => {
    expect(DEFAULT_SETTINGS.ai.fallback).toBe('LOCAL_FIRST')
  })

  it('recommends an open-weight model and names a lighter one', () => {
    expect(RECOMMENDED_MODEL).toBe('gpt-oss:20b')
    expect(LIGHTER_MODEL).toBe('qwen3.5:9b')
  })
})

describe('model tag matching', () => {
  it('treats a bare name and its :latest tag as the same model', () => {
    expect(hasModel(['llama3.2:latest'], 'llama3.2')).toBe(true)
    expect(hasModel(['llama3.2'], 'llama3.2:latest')).toBe(true)
    expect(hasModel(['GPT-OSS:20B'], 'gpt-oss:20b')).toBe(true)
  })

  it('does not confuse one size for another', () => {
    expect(hasModel(['qwen3.5:4b'], 'qwen3.5:9b')).toBe(false)
    expect(hasModel([], 'anything')).toBe(false)
    expect(hasModel(['qwen3.5:9b'], '')).toBe(false)
  })
})

describe('ollama advice', () => {
  const base = { installed: true, running: true, models: ['qwen3.5:9b'], selected: 'qwen3.5:9b', selectedInstalled: true, baseUrl: 'http://127.0.0.1:11434' }

  it('tells an uninstalled machine where to get it', () => {
    const out = ollamaAdvice({ ...base, installed: false, running: false })
    expect(out.detail).toMatch(/not installed/i)
    expect(out.hint).toContain('ollama.com/download')
    expect(out.hint).toContain(RECOMMENDED_MODEL)
  })

  it('distinguishes installed-but-stopped from missing, and says how to start it', () => {
    const out = ollamaAdvice({ ...base, running: false })
    expect(out.detail).toMatch(/installed but not answering/i)
    expect(out.detail).toContain('http://127.0.0.1:11434')
    expect(out.hint).toContain('ollama serve')
  })

  it('asks for a pull when the daemon is empty', () => {
    const out = ollamaAdvice({ ...base, models: [], selectedInstalled: false })
    expect(out.detail).toMatch(/no models pulled/i)
    expect(out.hint).toContain(`ollama pull ${RECOMMENDED_MODEL}`)
    expect(out.hint).toContain(LIGHTER_MODEL)
  })

  it('names the missing model, and what is there instead', () => {
    const out = ollamaAdvice({ ...base, selected: 'gpt-oss:20b', selectedInstalled: false })
    expect(out.detail).toContain('gpt-oss:20b')
    expect(out.detail).toContain('qwen3.5:9b')
    expect(out.hint).toBe('Run `ollama pull gpt-oss:20b`, or pick one of the pulled models in Settings > AI.')
  })

  it('has no next step to offer when everything is ready', () => {
    const out = ollamaAdvice(base)
    expect(out.detail).toMatch(/ready/i)
    expect(out.hint).toBeUndefined()
  })
})

describe('executable detection', () => {
  it('only ever returns a path that exists', () => {
    const found = detectOllamaExe()
    if (found) expect(existsSync(found)).toBe(true)
    else expect(found).toBeNull()
  })
})

describe('probing', () => {
  it('reports an unreachable daemon instead of throwing', async () => {
    // Port 1 is reserved and never listening, so this is a refused connection
    // rather than a request to anything real.
    const status = await probeOllama('http://127.0.0.1:1', 'qwen3.5:9b')
    expect(status.running).toBe(false)
    expect(status.models).toEqual([])
    expect(status.selectedInstalled).toBe(false)
    expect(status.detail).toMatch(/not installed|not answering/i)
    expect(status.checkedMs).toBeGreaterThan(0)
    expect(ollamaLastStatus()).toEqual(status)
  })

  it('turns a failed probe into the reason the provider is unavailable', async () => {
    expect(ollamaVerdict()).toBeNull() // nothing probed yet: optimistic, not blamed
    expect(provider('ollama').unavailable()).toBeNull()
    await probeOllama('http://127.0.0.1:1', 'qwen3.5:9b')
    expect(ollamaVerdict()).toMatch(/ollama/i)
    expect(provider('ollama').unavailable()).toMatch(/ollama/i)
    resetOllamaStatus()
    expect(provider('ollama').unavailable()).toBeNull()
  })
})

describe('fallback chain', () => {
  it('puts the local model first by default, with the routed cloud model behind it', () => {
    const chain = resolveChain('GENERAL')
    expect(chain.map((t) => t.provider)).toEqual(['ollama', 'anthropic'])
    expect(chain[0]?.model).toBe(DEFAULT_SETTINGS.ai.routing.LOCAL.model)
  })

  it('reverses that order for CLOUD FIRST', () => {
    setFallback('CLOUD_FIRST')
    expect(resolveChain('CODING').map((t) => t.provider)).toEqual(['anthropic', 'ollama'])
  })

  it('offers no network provider at all in LOCAL ONLY', () => {
    setFallback('LOCAL_ONLY')
    const chain = resolveChain('REASONING')
    expect(chain.length).toBeGreaterThan(0)
    expect(chain.every((t) => isLocalProvider(t.provider))).toBe(true)
  })

  it('offers no local provider in CLOUD ONLY', () => {
    setFallback('CLOUD_ONLY')
    const chain = resolveChain('GENERAL')
    expect(chain.length).toBeGreaterThan(0)
    expect(chain.some((t) => isLocalProvider(t.provider))).toBe(false)
  })

  it('still finds a cloud stand-in when the role itself routes locally', () => {
    setFallback('CLOUD_ONLY')
    settings.update({
      ai: { ...settings.get().ai, routing: { ...settings.get().ai.routing, VISION: { provider: 'ollama', model: 'qwen3.5:9b' } } }
    })
    const chain = resolveChain('VISION')
    expect(chain.map((t) => t.provider)).toEqual(['anthropic'])
  })

  it('has an empty chain rather than a wrong one when CLOUD ONLY has nothing to reach', () => {
    setFallback('CLOUD_ONLY')
    const allLocal = Object.fromEntries(
      Object.keys(settings.get().ai.routing).map((role) => [role, { provider: 'ollama', model: 'qwen3.5:9b' }])
    ) as typeof DEFAULT_SETTINGS.ai.routing
    settings.update({ ai: { ...settings.get().ai, routing: allLocal } })
    expect(resolveChain('GENERAL')).toEqual([])
  })

  it('never lists the same provider and model twice', () => {
    settings.update({
      ai: { ...settings.get().ai, routing: { ...settings.get().ai.routing, GENERAL: { provider: 'ollama', model: 'qwen3.5:9b' } } }
    })
    const chain = resolveChain('GENERAL')
    const keys = chain.map((t) => `${t.provider}/${t.model}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('drops a target with no model name instead of asking a provider for ""', () => {
    settings.update({
      ai: { ...settings.get().ai, routing: { ...settings.get().ai.routing, LOCAL: { provider: 'ollama', model: '' } } }
    })
    expect(resolveChain('GENERAL').some((t) => t.provider === 'ollama')).toBe(false)
  })

  it('pins a model the pinned provider can actually serve when auto-routing is off', () => {
    settings.update({ ai: { ...settings.get().ai, autoRoute: false, provider: 'ollama' } })
    const target = resolveModel('CODING')
    expect(target.provider).toBe('ollama')
    expect(target.model).toBe(DEFAULT_SETTINGS.ai.routing.LOCAL.model)
  })
})
