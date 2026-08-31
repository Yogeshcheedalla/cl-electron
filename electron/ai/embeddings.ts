import { secrets } from '../services/secrets'
import { providerBaseUrl } from './providers'
import type { ProviderId } from '../../shared/types'

/**
 * Embeddings for knowledge search. Two endpoints are enough to cover both
 * cases people actually have: OpenAI-compatible `/v1/embeddings` (which also
 * covers Azure, Together, LM Studio and anything else behind
 * `AKANSHA_OPENAI_BASE_URL`) and Ollama's `/api/embed`, which runs entirely on
 * the machine.
 *
 * ponytail: no ONNX runtime is bundled. `onnxruntime-node` plus a MiniLM export
 * is ~120 MB of native binary per platform, which is a large amount of installer
 * for a feature the keyword ranker already approximates -- and Ollama already
 * gives local embeddings to anyone who wants them, without Akansha shipping the
 * model. Anthropic has no embeddings API at all, so choosing it is reported
 * rather than silently falling back to something else.
 */

const BATCH = 64
const TIMEOUT = 120_000

export interface EmbedTarget {
  provider: ProviderId
  model: string
}

/** Human-readable reason embeddings cannot run, or null when they can. */
export function embedUnavailable(target: EmbedTarget): string | null {
  if (target.provider === 'anthropic') {
    return 'Anthropic does not offer an embeddings API. Choose OpenAI, or Ollama for local embeddings, in Settings > Knowledge.'
  }
  // OpenRouter is chat-completions only; it has no /v1/embeddings route, so
  // saying so here is better than a 404 in the middle of an indexing run.
  if (target.provider === 'openrouter') {
    return 'OpenRouter does not offer an embeddings API. Choose OpenAI, or Ollama for local embeddings, in Settings > Knowledge.'
  }
  if (!target.model.trim()) return 'No embedding model is set in Settings > Knowledge.'
  if (target.provider === 'openai' && !secrets.has('openai')) {
    return 'No OpenAI API key is saved, so chunks cannot be embedded. Add one in Settings > AI Providers.'
  }
  return null
}

async function readError(res: Response, provider: string): Promise<never> {
  const body = await res.text().catch(() => '')
  let detail = body.slice(0, 300)
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string }
    const err = parsed.error
    detail = (typeof err === 'string' ? err : err?.message) ?? detail
  } catch {
    /* plain-text body */
  }
  throw new Error(`${provider} embeddings returned HTTP ${res.status}: ${detail}`)
}

async function openaiBatch(texts: string[], model: string): Promise<number[][]> {
  const key = secrets.get('openai')
  if (!key) throw new Error('No OpenAI API key is saved.')
  const res = await fetch(`${providerBaseUrl('openai')}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(TIMEOUT)
  })
  if (!res.ok) await readError(res, 'OpenAI')
  const json = (await res.json()) as { data?: { index?: number; embedding?: number[] }[] }
  const out: number[][] = []
  ;(json.data ?? []).forEach((d, i) => {
    out[d.index ?? i] = d.embedding ?? []
  })
  if (out.length !== texts.length) throw new Error('OpenAI returned fewer embeddings than chunks sent.')
  return out
}

async function ollamaBatch(texts: string[], model: string): Promise<number[][]> {
  const url = `${providerBaseUrl('ollama')}/api/embed`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(TIMEOUT)
  }).catch((e: Error) => {
    throw new Error(`Ollama is not reachable at ${providerBaseUrl('ollama')} (${e.message}). Start it with \`ollama serve\`.`)
  })
  if (!res.ok) await readError(res, 'Ollama')
  const json = (await res.json()) as { embeddings?: number[][] }
  const out = json.embeddings ?? []
  if (out.length !== texts.length) {
    throw new Error(`Ollama returned ${out.length} embeddings for ${texts.length} chunks; is "${model}" an embedding model?`)
  }
  return out
}

/** Embeds texts in batches. Throws with the provider's reason on failure. */
export async function embed(texts: string[], target: EmbedTarget): Promise<number[][]> {
  const blocked = embedUnavailable(target)
  if (blocked) throw new Error(blocked)
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH)
    const vectors =
      target.provider === 'ollama' ? await ollamaBatch(batch, target.model) : await openaiBatch(batch, target.model)
    for (const v of vectors) {
      if (!v.length) throw new Error('The provider returned an empty embedding vector.')
      out.push(v)
    }
  }
  return out
}

/** One query string, or null when embeddings are not usable right now. */
export async function embedQuery(text: string, target: EmbedTarget): Promise<number[] | null> {
  if (embedUnavailable(target)) return null
  const [vec] = await embed([text], target)
  return vec ?? null
}
