import { secrets } from '../services/secrets'
import { settings } from '../services/settings'
import { ollamaVerdict, probeOllama } from './ollama'
import type { ProviderId } from '../../shared/types'

export interface LlmToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface LlmImage {
  mimeType: string
  base64: string
}

export type LlmMessage =
  | { role: 'user'; content: string; images?: LlmImage[] }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; callId: string; name: string; content: string; ok: boolean }

export interface LlmTool {
  name: string
  description: string
  schema: Record<string, unknown>
}

export interface LlmRequest {
  model: string
  system: string
  messages: LlmMessage[]
  tools: LlmTool[]
  temperature: number
  maxTokens: number
  stream: boolean
  signal?: AbortSignal
}

export interface LlmResponse {
  text: string
  toolCalls: LlmToolCall[]
  inputTokens: number
  outputTokens: number
  stopReason: string
}

export interface Provider {
  id: ProviderId
  /** Human-readable reason the provider cannot be used, or null when ready. */
  unavailable(): string | null
  chat(req: LlmRequest, onDelta?: (text: string) => void): Promise<LlmResponse>
  test(): Promise<string>
}

export const DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  openrouter: 'https://openrouter.ai/api',
  ollama: 'http://127.0.0.1:11434'
}

const REQUEST_TIMEOUT = 180_000

function baseUrl(id: ProviderId): string {
  return (process.env[`AKANSHA_${id.toUpperCase()}_BASE_URL`] || DEFAULT_BASE_URLS[id]).replace(/\/$/, '')
}

/** Combines the caller's cancellation with a hard ceiling on request time. */
function signalFor(req: LlmRequest): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT)
  return req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
}

async function readError(res: Response, provider: string): Promise<never> {
  const body = await res.text().catch(() => '')
  let detail = body.slice(0, 500)
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    const err = parsed.error
    detail = (typeof err === 'string' ? err : err?.message) ?? parsed.message ?? detail
  } catch {
    /* plain-text error body */
  }
  const hint =
    res.status === 401 || res.status === 403
      ? ' Check the API key in Settings > AI Providers.'
      : res.status === 429
        ? ' The provider is rate-limiting; wait a moment and retry.'
        : ''
  throw new Error(`${provider} returned HTTP ${res.status}: ${detail}${hint}`)
}

/** Yields decoded chunks from a streaming body, split on a delimiter. */
async function* lines(res: Response, delimiter: string): AsyncGenerator<string> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('The provider returned an empty stream.')
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf(delimiter)
    while (index !== -1) {
      const piece = buffer.slice(0, index)
      buffer = buffer.slice(index + delimiter.length)
      if (piece.trim()) yield piece
      index = buffer.indexOf(delimiter)
    }
  }
  if (buffer.trim()) yield buffer
}

const sseData = (event: string): string | null => {
  const payload = event
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('')
  return payload || null
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

/** Anthropic wants tool results as user turns, so consecutive results merge. */
function toAnthropicMessages(messages: LlmMessage[]) {
  const out: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: m.callId,
        content: m.content,
        ...(m.ok ? {} : { is_error: true })
      }
      const last = out[out.length - 1]
      if (last?.role === 'user' && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }
    if (m.role === 'user') {
      const content: AnthropicBlock[] = []
      for (const img of m.images ?? []) {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.base64 } })
      }
      if (m.content) content.push({ type: 'text', text: m.content })
      out.push({ role: 'user', content: content.length ? content : [{ type: 'text', text: '(no content)' }] })
      continue
    }
    const content: AnthropicBlock[] = []
    if (m.content) content.push({ type: 'text', text: m.content })
    for (const call of m.toolCalls ?? []) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
    }
    if (content.length) out.push({ role: 'assistant', content })
  }
  return out
}

const anthropic: Provider = {
  id: 'anthropic',

  unavailable() {
    return secrets.has('anthropic') ? null : 'No Anthropic API key is saved. Add one in Settings > AI Providers.'
  },

  async chat(req, onDelta) {
    const key = secrets.get('anthropic')
    if (!key) throw new Error(anthropic.unavailable() as string)
    const body = {
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      stream: req.stream,
      ...(req.tools.length
        ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })) }
        : {})
    }
    const res = await fetch(`${baseUrl('anthropic')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: signalFor(req)
    })
    if (!res.ok) await readError(res, 'Anthropic')

    if (!req.stream) {
      const json = (await res.json()) as {
        content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[]
        usage: { input_tokens: number; output_tokens: number }
        stop_reason: string
      }
      const text = json.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('')
      onDelta?.(text)
      return {
        text,
        toolCalls: json.content
          .filter((c) => c.type === 'tool_use')
          .map((c) => ({ id: c.id ?? '', name: c.name ?? '', input: (c.input ?? {}) as Record<string, unknown> })),
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        stopReason: json.stop_reason ?? 'end_turn'
      }
    }

    let text = ''
    let inputTokens = 0
    let outputTokens = 0
    let stopReason = 'end_turn'
    const calls = new Map<number, { id: string; name: string; json: string }>()

    for await (const event of lines(res, '\n\n')) {
      const data = sseData(event)
      if (!data) continue
      const evt = JSON.parse(data) as {
        type: string
        index?: number
        delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
        content_block?: { type: string; id?: string; name?: string }
        message?: { usage?: { input_tokens?: number; output_tokens?: number } }
        usage?: { output_tokens?: number }
        error?: { message?: string }
      }
      switch (evt.type) {
        case 'message_start':
          inputTokens = evt.message?.usage?.input_tokens ?? 0
          break
        case 'content_block_start':
          if (evt.content_block?.type === 'tool_use') {
            calls.set(evt.index ?? 0, {
              id: evt.content_block.id ?? '',
              name: evt.content_block.name ?? '',
              json: ''
            })
          }
          break
        case 'content_block_delta':
          if (evt.delta?.type === 'text_delta' && evt.delta.text) {
            text += evt.delta.text
            onDelta?.(evt.delta.text)
          } else if (evt.delta?.type === 'input_json_delta') {
            const entry = calls.get(evt.index ?? 0)
            if (entry) entry.json += evt.delta.partial_json ?? ''
          }
          break
        case 'message_delta':
          stopReason = evt.delta?.stop_reason ?? stopReason
          outputTokens = evt.usage?.output_tokens ?? outputTokens
          break
        case 'error':
          throw new Error(`Anthropic stream error: ${evt.error?.message ?? 'unknown'}`)
        default:
          break
      }
    }

    return {
      text,
      toolCalls: [...calls.values()].map((c) => ({
        id: c.id,
        name: c.name,
        input: c.json.trim() ? (JSON.parse(c.json) as Record<string, unknown>) : {}
      })),
      inputTokens,
      outputTokens,
      stopReason
    }
  },

  async test() {
    const res = await anthropic.chat({
      model: settings.get().ai.routing.FAST.model,
      system: 'Reply with the single word: ready',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [],
      temperature: 0,
      maxTokens: 16,
      stream: false
    })
    return res.text.trim() || 'Connected.'
  }
}

// ---------------------------------------------------------------------------
// OpenAI (also covers OpenAI-compatible endpoints via AKANSHA_OPENAI_BASE_URL)
// ---------------------------------------------------------------------------

function toOpenAiMessages(system: string, messages: LlmMessage[]) {
  const out: Record<string, unknown>[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.callId, content: m.content })
    } else if (m.role === 'user') {
      out.push(
        m.images?.length
          ? {
              role: 'user',
              content: [
                { type: 'text', text: m.content },
                ...m.images.map((i) => ({
                  type: 'image_url',
                  image_url: { url: `data:${i.mimeType};base64,${i.base64}` }
                }))
              ]
            }
          : { role: 'user', content: m.content }
      )
    } else {
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.input) }
              }))
            }
          : {})
      })
    }
  }
  return out
}

interface CompatConfig {
  id: ProviderId
  label: string
  /** Model `test()` sends a one-word prompt to, when the API has no free key check. */
  testModel: string
  /**
   * OpenAI renamed the cap to `max_completion_tokens`; OpenRouter normalises for
   * dozens of upstreams and takes the original `max_tokens`. Sending the wrong
   * one is a 400, so it is part of the configuration rather than a guess.
   */
  tokenParam: 'max_completion_tokens' | 'max_tokens'
  /** Extra request headers. OpenRouter reads these for attribution. */
  headers?: Record<string, string>
  /** A key check that spends nothing, when the API offers one. */
  probe?: (key: string) => Promise<string>
}

/**
 * One implementation for every OpenAI-shaped endpoint. OpenAI and OpenRouter
 * differ only in host, which key they read and how a key is verified, so they
 * share the streaming parser and the tool-call assembly rather than each keeping
 * a copy that can drift out of sync.
 */
function openAiCompatible(cfg: CompatConfig): Provider {
  const self: Provider = {
    id: cfg.id,

    unavailable() {
      return secrets.has(cfg.id) ? null : `No ${cfg.label} API key is saved. Add one in Settings > AI Providers.`
    },

    async chat(req, onDelta) {
      const key = secrets.get(cfg.id)
      if (!key) throw new Error(self.unavailable() as string)
      const body = {
        model: req.model,
        messages: toOpenAiMessages(req.system, req.messages),
        temperature: req.temperature,
        [cfg.tokenParam]: req.maxTokens,
        stream: req.stream,
        ...(req.stream ? { stream_options: { include_usage: true } } : {}),
        ...(req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.schema }
              }))
            }
          : {})
      }
      const res = await fetch(`${baseUrl(cfg.id)}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          ...(cfg.headers ?? {})
        },
        body: JSON.stringify(body),
        signal: signalFor(req)
      })
      if (!res.ok) await readError(res, cfg.label)
      type Delta = {
        content?: string | null
        tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[]
      }

      if (!req.stream) {
        const json = (await res.json()) as {
          choices: { message: Delta; finish_reason: string }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        const choice = json.choices[0]
        const text = choice?.message?.content ?? ''
        onDelta?.(text)
        return {
          text,
          toolCalls: (choice?.message?.tool_calls ?? []).map((c) => ({
            id: c.id ?? '',
            name: c.function?.name ?? '',
            input: c.function?.arguments ? (JSON.parse(c.function.arguments) as Record<string, unknown>) : {}
          })),
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
          stopReason: choice?.finish_reason ?? 'stop'
        }
      }

      let text = ''
      let inputTokens = 0
      let outputTokens = 0
      let stopReason = 'stop'
      const calls = new Map<number, { id: string; name: string; args: string }>()

      for await (const event of lines(res, '\n\n')) {
        const data = sseData(event)
        if (!data || data === '[DONE]') continue
        const evt = JSON.parse(data) as {
          choices?: { delta?: Delta; finish_reason?: string | null }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        const choice = evt.choices?.[0]
        if (choice?.delta?.content) {
          text += choice.delta.content
          onDelta?.(choice.delta.content)
        }
        for (const tc of choice?.delta?.tool_calls ?? []) {
          const entry = calls.get(tc.index) ?? { id: '', name: '', args: '' }
          if (tc.id) entry.id = tc.id
          if (tc.function?.name) entry.name = tc.function.name
          if (tc.function?.arguments) entry.args += tc.function.arguments
          calls.set(tc.index, entry)
        }
        if (choice?.finish_reason) stopReason = choice.finish_reason
        if (evt.usage) {
          inputTokens = evt.usage.prompt_tokens ?? inputTokens
          outputTokens = evt.usage.completion_tokens ?? outputTokens
        }
      }

      return {
        text,
        toolCalls: [...calls.values()].map((c) => ({
          id: c.id,
          name: c.name,
          input: c.args.trim() ? (JSON.parse(c.args) as Record<string, unknown>) : {}
        })),
        inputTokens,
        outputTokens,
        stopReason
      }
    },

    async test() {
      const key = secrets.get(cfg.id)
      if (!key) throw new Error(self.unavailable() as string)
      // Preferred when the API has one: a check that proves the key works and
      // costs nothing, so pressing Test never appears on a bill.
      if (cfg.probe) return cfg.probe(key)
      const res = await self.chat({
        model: cfg.testModel,
        system: 'Reply with the single word: ready',
        messages: [{ role: 'user', content: 'ping' }],
        tools: [],
        temperature: 0,
        maxTokens: 16,
        stream: false
      })
      return res.text.trim() || 'Connected.'
    }
  }
  return self
}

const openai = openAiCompatible({
  id: 'openai',
  label: 'OpenAI',
  testModel: 'gpt-4o-mini',
  tokenParam: 'max_completion_tokens'
})

// ---------------------------------------------------------------------------
// OpenRouter (one key, many models, OpenAI-compatible)
// ---------------------------------------------------------------------------

/**
 * OpenRouter is a single key in front of hundreds of models, including free ones
 * and the open-weight models this machine cannot run locally. Model ids carry a
 * vendor prefix -- `anthropic/claude-sonnet-4.5`, `qwen/qwen3-30b-a3b:free` --
 * and go in the model box unchanged.
 *
 * `GET /v1/key` reports the key's label and credit, so Test proves the key is
 * live without an inference call. Cost tracking is the one gap: Akansha's price
 * table is keyed on OpenAI and Anthropic model names, so OpenRouter runs are
 * recorded with real token counts and a cost of $0. OpenRouter's own dashboard
 * has the billing figure.
 */
const openrouter = openAiCompatible({
  id: 'openrouter',
  label: 'OpenRouter',
  testModel: 'openai/gpt-4o-mini',
  tokenParam: 'max_tokens',
  // Attribution only, and deliberately just the app name: no referrer, no
  // machine identifier, nothing about the user or the prompt.
  headers: { 'x-title': 'Akansha' },
  probe: async (key) => {
    const res = await fetch(`${baseUrl('openrouter')}/v1/key`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) await readError(res, 'OpenRouter')
    const json = (await res.json()) as {
      data?: { label?: string; usage?: number; limit?: number | null; is_free_tier?: boolean }
    }
    const d = json.data ?? {}
    const spent = typeof d.usage === 'number' ? `$${d.usage.toFixed(4)} used` : 'usage unknown'
    const cap = typeof d.limit === 'number' ? `, limit $${d.limit.toFixed(2)}` : ', no credit limit set'
    return `Key ${d.label || 'accepted'}: ${spent}${cap}${d.is_free_tier ? ' (free tier)' : ''}.`
  }
})

// ---------------------------------------------------------------------------
// Ollama (local, no key)
// ---------------------------------------------------------------------------

const ollama: Provider = {
  id: 'ollama',

  // No key, but "no key needed" is not the same as "ready": the daemon may not
  // be installed, may not be running, or may not have the model pulled. The
  // verdict comes from the background probe in ./ollama.ts, and is null until
  // the first probe has run.
  unavailable() {
    return ollamaVerdict()
  },

  async chat(req, onDelta) {
    const messages: Record<string, unknown>[] = [{ role: 'system', content: req.system }]
    for (const m of req.messages) {
      if (m.role === 'tool') messages.push({ role: 'tool', content: m.content })
      else if (m.role === 'user')
        messages.push({
          role: 'user',
          content: m.content,
          ...(m.images?.length ? { images: m.images.map((i) => i.base64) } : {})
        })
      else
        messages.push({
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls?.length
            ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.input } })) }
            : {})
        })
    }

    const res = await fetch(`${baseUrl('ollama')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages,
        stream: req.stream,
        options: { temperature: req.temperature, num_predict: req.maxTokens },
        ...(req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.schema }
              }))
            }
          : {})
      }),
      signal: signalFor(req)
    }).catch((e: Error) => {
      // Refresh the cached verdict on the way out, so the next request skips
      // the local route instead of waiting for the same refusal again.
      void probeOllama(baseUrl('ollama'), req.model)
      throw new Error(
        `Ollama is not reachable at ${baseUrl('ollama')} (${e.message}). Start it with \`ollama serve\` or switch provider in Settings > AI.`
      )
    })
    if (!res.ok) await readError(res, 'Ollama')

    type Chunk = {
      message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] }
      done?: boolean
      done_reason?: string
      prompt_eval_count?: number
      eval_count?: number
    }

    const collect = (chunk: Chunk) =>
      (chunk.message?.tool_calls ?? []).map((c, i) => ({
        id: `ollama-${Date.now()}-${i}`,
        name: c.function?.name ?? '',
        input: (typeof c.function?.arguments === 'string'
          ? JSON.parse(c.function.arguments)
          : (c.function?.arguments ?? {})) as Record<string, unknown>
      }))

    if (!req.stream) {
      const json = (await res.json()) as Chunk
      const text = json.message?.content ?? ''
      onDelta?.(text)
      return {
        text,
        toolCalls: collect(json),
        inputTokens: json.prompt_eval_count ?? 0,
        outputTokens: json.eval_count ?? 0,
        stopReason: json.done_reason ?? 'stop'
      }
    }

    let text = ''
    let inputTokens = 0
    let outputTokens = 0
    let stopReason = 'stop'
    let toolCalls: LlmToolCall[] = []
    for await (const line of lines(res, '\n')) {
      const chunk = JSON.parse(line) as Chunk
      if (chunk.message?.content) {
        text += chunk.message.content
        onDelta?.(chunk.message.content)
      }
      const found = collect(chunk)
      if (found.length) toolCalls = found
      if (chunk.done) {
        inputTokens = chunk.prompt_eval_count ?? inputTokens
        outputTokens = chunk.eval_count ?? outputTokens
        stopReason = chunk.done_reason ?? stopReason
      }
    }
    return { text, toolCalls, inputTokens, outputTokens, stopReason }
  },

  // Reports the whole local picture -- installed, running, model pulled -- and
  // refreshes the cached verdict as a side effect, so pressing Test in Settings
  // is also how a user un-sticks a stale "not running".
  async test() {
    const status = await probeOllama(baseUrl('ollama'), settings.get().ai.routing.LOCAL.model)
    if (!status.running) throw new Error([status.detail, status.hint].filter(Boolean).join(' '))
    return [status.detail, status.hint].filter(Boolean).join(' ')
  }
}

const REGISTRY: Record<ProviderId, Provider> = { anthropic, openai, openrouter, ollama }

export function provider(id: ProviderId): Provider {
  const found = REGISTRY[id]
  if (!found) throw new Error(`Unknown AI provider "${id}".`)
  return found
}

export const providerIds = Object.keys(REGISTRY) as ProviderId[]
export { baseUrl as providerBaseUrl }
