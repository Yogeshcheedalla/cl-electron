import { settings } from '../services/settings'
import { usage } from '../db/log.repo'
import type { ModelRole, ProviderId } from '../../shared/types'

/**
 * Prices are USD per million tokens and are only used for the local cost
 * estimate on the Usage screen -- they are not billing data.
 * ponytail: a static table, deliberately. Fetching live pricing would add a
 * network dependency to a cosmetic number.
 */
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-5': { in: 15, out: 75 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 }
}

const CODE = /\b(code|function|class|bug|stack ?trace|compile|typescript|python|refactor|regex|npm|git|error|exception|api|sql|test)\b/i
const HARD = /\b(why|design|architect|analy[sz]e|compare|trade[- ]?off|plan|strategy|prove|debug|root cause|optimi[sz]e|explain how)\b/i
const QUICK = /^(hi|hey|hello|thanks|thank you|ok|okay|yes|no|yep|nope|got it|cool|nice)\b/i

/**
 * Chooses a role from the request itself. Cheap heuristics beat a router model:
 * they are instant, free and predictable, and the user can always turn
 * auto-routing off and pin one model.
 */
export function pickRole(text: string, opts: { hasImages?: boolean; needsTools?: boolean } = {}): ModelRole {
  const t = String(text ?? '')
  if (opts.hasImages) return 'VISION'
  if (QUICK.test(t.trim()) && t.trim().length < 24) return 'FAST'
  if (CODE.test(t)) return 'CODING'
  if (HARD.test(t) || t.length > 900) return 'REASONING'
  return 'GENERAL'
}

export function resolveModel(role: ModelRole): { provider: ProviderId; model: string; role: ModelRole } {
  const ai = settings.get().ai
  if (!ai.autoRoute) {
    // Pinned mode: one provider, and the model has to be one that provider can
    // actually serve -- taking GENERAL's model unconditionally would ask Ollama
    // for a Claude tag when the pinned provider is the local one.
    const pinned = Object.values(ai.routing).find((r) => r.provider === ai.provider) ?? ai.routing.GENERAL
    return { provider: ai.provider, model: pinned.model, role: 'GENERAL' }
  }
  const entry = ai.routing[role] ?? ai.routing.GENERAL
  return { provider: entry.provider, model: entry.model, role }
}

export interface Target {
  provider: ProviderId
  model: string
  role: ModelRole
}

/** Only Ollama runs on the machine; every other provider is a network service. */
export const isLocalProvider = (id: ProviderId) => id === 'ollama'

/**
 * The providers a request may try, in order, under the current fallback mode.
 *
 * The chain exists so "the local model is not running" is a detour rather than a
 * dead end -- and so LOCAL ONLY is a real guarantee: its chain contains no
 * network provider at all, so there is no code path that could quietly send the
 * conversation to a cloud API.
 *
 * Duplicates are collapsed on provider+model, so a mode that names the same
 * target twice does not retry it twice.
 */
export function resolveChain(role: ModelRole): Target[] {
  const ai = settings.get().ai
  const primary = resolveModel(role)
  const localEntry = ai.routing.LOCAL
  const local: Target = { provider: localEntry.provider, model: localEntry.model, role: 'LOCAL' }

  // The cloud stand-in when the role itself resolved to a local model: the
  // GENERAL route, unless that is local too, in which case any configured cloud
  // route will do.
  const cloudFallback = (): Target | null => {
    const general = ai.routing.GENERAL
    if (!isLocalProvider(general.provider)) return { provider: general.provider, model: general.model, role: 'GENERAL' }
    for (const [key, entry] of Object.entries(ai.routing) as [ModelRole, { provider: ProviderId; model: string }][]) {
      if (!isLocalProvider(entry.provider)) return { provider: entry.provider, model: entry.model, role: key }
    }
    return null
  }

  const cloud: Target[] = []
  if (isLocalProvider(primary.provider)) {
    const stand = cloudFallback()
    if (stand) cloud.push(stand)
  } else {
    cloud.push(primary)
  }

  const locals: Target[] = isLocalProvider(primary.provider) ? [primary, local] : [local]

  const chain =
    ai.fallback === 'LOCAL_ONLY'
      ? locals
      : ai.fallback === 'CLOUD_ONLY'
        ? cloud
        : ai.fallback === 'CLOUD_FIRST'
          ? [...cloud, ...locals]
          : [...locals, ...cloud]

  const seen = new Set<string>()
  return chain.filter((t) => {
    const key = `${t.provider}/${t.model}`
    if (!t.model || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES[model]
  if (!price) return 0
  return (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out
}

export function recordUsage(entry: {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
  failed: boolean
}) {
  usage.add({
    ...entry,
    estimatedCostUsd: estimateCost(entry.model, entry.inputTokens, entry.outputTokens)
  })
}

export const knownPricedModels = Object.keys(PRICES)
