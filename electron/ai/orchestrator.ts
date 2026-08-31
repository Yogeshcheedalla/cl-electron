import { audit } from '../core/audit'
import { bus } from '../core/bus'
import { logger } from '../core/logger'
import { describeError, id, now, truncate } from '../core/util'
import { conversations, messages } from '../db/chat.repo'
import { invokeTool, toolSchemas } from '../agents/tools'
import { notify } from '../services/notify'
import { settings } from '../services/settings'
import { provider, type LlmImage, type LlmMessage, type LlmToolCall } from './providers'
import { buildSystemPrompt } from './context'
import { pickRole, recordUsage, resolveChain, resolveModel, type Target } from './router'
import type { SendPayload } from '../../shared/api'
import type { PlanStep } from '../../shared/records'

/** How many model -> tool -> model round trips a single request may take. */
const MAX_ROUNDS = 8
const HISTORY_LIMIT = 24
const MAX_TOOL_RESULT = 6000
const SLOW_RUN_MS = 25_000

const runs = new Map<string, AbortController>()

const isAbort = (e: unknown) =>
  e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError' || /abort/i.test(e.message))

const titleFrom = (text: string) => {
  const line = text.trim().split('\n')[0] ?? ''
  if (!line) return 'New conversation'
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}

const summarize = (call: LlmToolCall) => {
  const first = Object.entries(call.input)[0]
  const value = first ? truncate(String(first[1] ?? ''), 60) : ''
  return value ? `${call.name} - ${value}` : call.name
}

/** Images go to the model as image blocks; readable text is inlined; anything else is declared unreadable. */
function splitAttachments(list: SendPayload['attachments']) {
  const images: LlmImage[] = []
  const notes: string[] = []
  for (const a of list ?? []) {
    if (a.mimeType.startsWith('image/')) {
      images.push({ mimeType: a.mimeType, base64: a.base64 })
    } else if (/^(text\/|application\/(json|xml|javascript|x-yaml))/.test(a.mimeType)) {
      notes.push(`--- attached file: ${a.name}\n${truncate(Buffer.from(a.base64, 'base64').toString('utf8'), 20_000)}`)
    } else {
      notes.push(
        `--- attached file: ${a.name} (${a.mimeType}) could not be read inline. Save it to disk and ask me to open that path with document.read.`
      )
    }
  }
  return { images, notes }
}

/** Prior turns only: tool traffic lives in message metadata, never replayed as dangling tool ids. */
function historyFor(cid: string): LlmMessage[] {
  const out: LlmMessage[] = []
  for (const m of messages.recent(cid, HISTORY_LIMIT)) {
    if (!m.content.trim()) continue
    if (m.role === 'user') out.push({ role: 'user', content: m.content })
    else if (m.role === 'assistant') out.push({ role: 'assistant', content: m.content })
  }
  return out
}

/**
 * One chat turn: build context, stream the model, run whatever tools it asks
 * for, feed the real results back, and repeat until it stops calling tools.
 * Every tool result the model sees is the actual result -- failures included.
 */
export const orchestrator = {
  send(payload: SendPayload): { runId: string; conversationId: string } {
    const text = String(payload.text ?? '').trim()
    if (!text && !payload.attachments?.length) throw new Error('There is nothing to send.')
    const existing = payload.conversationId ? conversations.get(payload.conversationId) : undefined
    const conversationId = existing?.id ?? conversations.create(titleFrom(text)).id
    const runId = id()
    const controller = new AbortController()
    runs.set(runId, controller)
    void execute(runId, conversationId, { ...payload, text }, controller).finally(() => runs.delete(runId))
    return { runId, conversationId }
  },

  cancel(runId: string): boolean {
    const controller = runs.get(runId)
    if (!controller) return false
    controller.abort()
    logger.info('ai.cancel', { runId })
    return true
  },

  activeRuns: () => [...runs.keys()]
}

async function execute(runId: string, cid: string, payload: SendPayload, controller: AbortController) {
  const cfg = settings.get()
  const started = now()
  const { images, notes } = splitAttachments(payload.attachments)
  const userText = [payload.text, ...notes].filter(Boolean).join('\n\n')
  const history = historyFor(cid)

  messages.add({
    conversationId: cid,
    role: 'user',
    content: userText,
    ...(images.length ? { meta: JSON.stringify({ images: images.length }) } : {})
  })
  audit({ kind: 'request', label: truncate(payload.text || '(attachment only)', 120), ok: true })

  const convo: LlmMessage[] = [
    ...history,
    { role: 'user', content: userText, ...(images.length ? { images } : {}) }
  ]
  const tools = payload.mode === 'answer' ? [] : toolSchemas()
  const role = pickRole(userText, { hasImages: images.length > 0, needsTools: tools.length > 0 })
  const chain = resolveChain(role)
  // `target` is provisional until a provider actually answers; it is what the
  // saved message records, so it must be the one that did the work.
  let target: Target = chain[0] ?? { ...resolveModel(role) }
  const trace: { tool: string; ok: boolean; detail: string }[] = []
  const steps: PlanStep[] = []
  const emitPlan = () => bus.emitToUi({ type: 'ai:plan', runId, steps: steps.map((s) => ({ ...s })) })

  let answer = ''
  let inputTokens = 0
  let outputTokens = 0
  let cancelled = false
  let cursor = 0
  const skipped: string[] = []

  /**
   * Sends one round to the first provider in the chain that can take it.
   *
   * A provider that reports itself unavailable is skipped without a request; one
   * that fails on the first round hands over to the next. Once a provider has
   * answered, the rest of the conversation stays with it -- switching models
   * halfway through a tool sequence would mean the second model inheriting tool
   * calls it never made.
   */
  const callChat = async (system: string, onDelta: (text: string) => void) => {
    const started = now()
    for (; cursor < chain.length; cursor++) {
      const candidate = chain[cursor] as Target
      const p = provider(candidate.provider)
      const why = p.unavailable()
      if (why) {
        skipped.push(`${candidate.provider}: ${why}`)
        continue
      }
      const roundStart = now()
      try {
        const response = await p.chat(
          {
            model: candidate.model,
            system,
            messages: convo,
            tools,
            temperature: cfg.ai.temperature,
            maxTokens: cfg.ai.maxTokens,
            stream: cfg.ai.streaming,
            signal: controller.signal
          },
          onDelta
        )
        target = candidate
        recordUsage({
          provider: candidate.provider,
          model: candidate.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          latencyMs: now() - roundStart,
          failed: false
        })
        return response
      } catch (e) {
        recordUsage({
          provider: candidate.provider,
          model: candidate.model,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: now() - roundStart,
          failed: true
        })
        // The user pressing Stop is not a provider failure, and neither is a
        // failure once this provider has already produced part of the answer.
        if (isAbort(e) || controller.signal.aborted) throw e
        const last = cursor === chain.length - 1
        if (last || answer.trim() || trace.length) throw e
        skipped.push(`${candidate.provider}: ${describeError(e)}`)
        logger.warn('ai.providerFallback', {
          from: candidate.provider,
          to: chain[cursor + 1]?.provider ?? 'none',
          message: describeError(e)
        })
      }
    }
    const detail = skipped.length ? ` Tried: ${skipped.join(' | ')}` : ''
    const mode = cfg.ai.fallback
    throw new Error(
      mode === 'LOCAL_ONLY'
        ? `No local model could answer, and ${mode} forbids using a cloud provider.${detail}`
        : `No AI provider could answer this request (${mode}, ${now() - started}ms).${detail}`
    )
  }

  try {
    bus.emitToUi({ type: 'state', state: 'THINKING' })
    if (!chain.length) {
      throw new Error(
        `No model is configured for ${cfg.ai.fallback} mode. Pick a provider and model in Settings > AI Providers.`
      )
    }

    const system =
      (await buildSystemPrompt(userText)) +
      (payload.mode === 'research'
        ? '\n\nResearch mode: gather evidence with web.search / web.fetch (and knowledge.search when the answer may be in an indexed folder), then answer citing the URLs or file paths you actually opened.'
        : '')

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (controller.signal.aborted) {
        cancelled = true
        break
      }
      bus.emitToUi({ type: 'state', state: 'THINKING' })
      const response = await callChat(system, (text) => bus.emitToUi({ type: 'ai:delta', runId, text }))
      inputTokens += response.inputTokens
      outputTokens += response.outputTokens

      if (response.text.trim()) {
        if (answer) {
          answer += '\n\n'
          bus.emitToUi({ type: 'ai:delta', runId, text: '\n\n' })
        }
        answer += response.text
      }

      if (!response.toolCalls.length) break
      if (round === MAX_ROUNDS) {
        answer += `\n\n[Akansha] I stopped after ${MAX_ROUNDS} tool rounds to avoid looping. Tell me to continue if that was too early.`
        break
      }

      convo.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls })
      const planned = response.toolCalls.map((call) => ({
        call,
        step: { id: call.id || id(), label: summarize(call), tool: call.name, status: 'pending' } as PlanStep
      }))
      steps.push(...planned.map((x) => x.step))
      emitPlan()

      const captured: LlmImage[] = []
      for (const { call, step } of planned) {
        if (controller.signal.aborted) {
          step.status = 'skipped'
          continue
        }
        bus.emitToUi({ type: 'state', state: 'EXECUTING' })
        bus.emitToUi({ type: 'ai:tool', runId, tool: call.name, phase: 'start' })
        step.status = 'running'
        emitPlan()
        try {
          const result = await invokeTool(call.name, call.input, { source: `chat:${runId}` })
          const shot = result as { base64?: string; width?: number; height?: number } | null
          let content: string
          if (shot?.base64 && typeof shot.width === 'number') {
            captured.push({ mimeType: 'image/png', base64: shot.base64 })
            content = `Screen captured at ${shot.width}x${shot.height}. The image is attached in the next message.`
          } else {
            content = truncate(typeof result === 'string' ? result : JSON.stringify(result ?? null), MAX_TOOL_RESULT)
          }
          convo.push({ role: 'tool', callId: call.id, name: call.name, content, ok: true })
          step.status = 'done'
          step.detail = truncate(content, 160)
          trace.push({ tool: call.name, ok: true, detail: truncate(content, 300) })
          bus.emitToUi({ type: 'ai:tool', runId, tool: call.name, phase: 'end', ok: true, detail: step.detail })
        } catch (e) {
          if (isAbort(e)) throw e
          const message = describeError(e)
          convo.push({ role: 'tool', callId: call.id, name: call.name, content: `Failed: ${message}`, ok: false })
          step.status = 'failed'
          step.detail = truncate(message, 160)
          trace.push({ tool: call.name, ok: false, detail: truncate(message, 300) })
          bus.emitToUi({ type: 'ai:tool', runId, tool: call.name, phase: 'end', ok: false, detail: step.detail })
        }
        emitPlan()
      }
      if (captured.length) convo.push({ role: 'user', content: 'Here is the captured screen.', images: captured })
    }

    if (!answer.trim()) {
      answer = trace.length
        ? 'I ran the tools listed above, but the model returned no closing message.'
        : 'The model returned an empty response. Try rephrasing, or check the provider in Settings > AI.'
    }

    const meta = {
      provider: target.provider,
      model: target.model,
      role: target.role,
      inputTokens,
      outputTokens,
      ms: now() - started,
      tools: trace,
      ...(cancelled ? { cancelled: true } : {})
    }
    messages.add({ conversationId: cid, role: 'assistant', content: answer, meta: JSON.stringify(meta) })
    audit({
      kind: 'response',
      label: `${target.model} replied`,
      detail: truncate(answer, 300),
      ok: true,
      durationMs: now() - started
    })
    bus.emitToUi({ type: 'ai:done', runId, message: answer, meta })
    if (now() - started > SLOW_RUN_MS) {
      notify({ category: 'AI', title: 'Akansha finished', body: truncate(answer, 160), silent: true })
    }
  } catch (e) {
    const stopped = cancelled || isAbort(e) || controller.signal.aborted
    const message = stopped ? 'Cancelled.' : describeError(e)
    if (answer.trim()) {
      messages.add({
        conversationId: cid,
        role: 'assistant',
        content: answer,
        meta: JSON.stringify({ provider: target.provider, model: target.model, tools: trace, cancelled: stopped })
      })
    }
    audit({
      kind: 'error',
      label: stopped ? 'Response cancelled' : 'Response failed',
      detail: message,
      ok: false,
      durationMs: now() - started
    })
    logger.error('ai.runFailed', { runId, model: target.model, message })
    for (const step of steps) if (step.status === 'pending' || step.status === 'running') step.status = 'skipped'
    emitPlan()
    if (stopped) bus.emitToUi({ type: 'ai:done', runId, message: answer, meta: { cancelled: true } })
    else {
      bus.emitToUi({ type: 'ai:error', runId, message })
      notify({ category: 'ERROR', title: 'Akansha could not answer', body: truncate(message, 200) })
    }
  } finally {
    bus.emitToUi({ type: 'state', state: 'IDLE' })
  }
}
