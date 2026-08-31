import { bus } from '../core/bus'
import { logger } from '../core/logger'
import { truncate } from '../core/util'
import { audit } from '../core/audit'
import { automations } from '../db/state.repo'
import { getTool, invokeTool } from '../agents/tools'
import { notify } from './notify'
import { decide, effectiveLevel } from './permissions'
import type { Automation, DryRun, DryRunStep } from '../../shared/records'

/**
 * A workflow is a list of tool invocations. Steps run in order and each one goes
 * through the normal permission gate, so an automation can never do something
 * the user has not allowed a tool to do.
 *
 * ponytail: no branching, loops or variable interpolation between steps. That
 * covers "open these apps and start my dev server"; anything conditional is
 * better expressed as a chat request where the model can react to results.
 */
export const automationEngine = {
  list: () => automations.list(),

  save(automation: Automation): Automation {
    if (!automation?.name?.trim()) throw new Error('An automation needs a name.')
    if (!Array.isArray(automation.steps) || !automation.steps.length) {
      throw new Error('An automation needs at least one step.')
    }
    return automations.save(automation)
  },

  remove(id: string): null {
    automations.remove(id)
    return null
  },

  async run(id: string): Promise<{ ok: boolean; log: string[] }> {
    const automation = automations.get(id)
    if (!automation) throw new Error(`No automation with id ${id}.`)
    if (!automation.enabled) throw new Error(`"${automation.name}" is disabled.`)

    const log: string[] = []
    let ok = true
    let lastOk = true
    const started = Date.now()
    bus.emitToUi({ type: 'state', state: 'EXECUTING' })

    for (const [index, step] of automation.steps.entries()) {
      const label = `${index + 1}. ${step.tool}`
      if (step.requiresPrevious !== false && !lastOk) {
        log.push(`${label}: skipped (previous step failed)`)
        continue
      }
      try {
        const data = await invokeTool(step.tool, step.input, { source: `automation:${automation.name}` })
        lastOk = true
        log.push(`${label}: ok ${truncate(JSON.stringify(data ?? null), 200)}`)
      } catch (e) {
        lastOk = false
        ok = false
        log.push(`${label}: failed -- ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    automations.markRun(automation.id, ok ? 'ok' : 'failed')
    audit({
      kind: 'agent',
      label: `Automation "${automation.name}"`,
      detail: truncate(log.join('\n'), 1000),
      ok,
      durationMs: Date.now() - started
    })
    notify({
      category: 'AUTOMATION',
      title: `${ok ? 'Completed' : 'Failed'}: ${automation.name}`,
      body: log[log.length - 1] ?? 'No steps ran.',
      silent: ok
    })
    logger.info('automation.run', { name: automation.name, ok, steps: automation.steps.length })
    bus.emitToUi({ type: 'state', state: 'IDLE' })
    return { ok, log }
  },

  /**
   * What `run` would do, without doing it. Every step is resolved against the
   * tool registry, validated against the tool's own zod schema and put through
   * the same permission decision -- but `authorize` is never called, so nothing
   * prompts and nothing executes. `requiresPrevious` is honoured pessimistically:
   * a step that cannot run marks the ones depending on it as skipped, which is
   * the worst case rather than the hoped-for one.
   */
  dryRun(id: string): DryRun {
    const automation = automations.get(id)
    if (!automation) throw new Error(`No automation with id ${id}.`)

    const steps: DryRunStep[] = []
    const log: string[] = []
    let ok = true
    let lastWillRun = true

    if (!automation.enabled) {
      log.push(`"${automation.name}" is disabled, so run would refuse before any step.`)
      ok = false
    }

    for (const [index, step] of automation.steps.entries()) {
      const label = `${index + 1}. ${step.tool}`
      const base = { index: index + 1, tool: step.tool }

      if (step.requiresPrevious !== false && !lastWillRun) {
        steps.push({ ...base, verdict: 'skipped', summary: 'skipped', detail: 'The previous step would not run.' })
        log.push(`${label}: skipped (depends on a step that would not run)`)
        continue
      }

      const tool = getTool(step.tool)
      if (!tool) {
        ok = false
        lastWillRun = false
        steps.push({
          ...base,
          verdict: 'unknown-tool',
          summary: 'no such tool',
          detail: `There is no tool called "${step.tool}". Edit the step or remove it.`
        })
        log.push(`${label}: unknown tool`)
        continue
      }

      const parsed = tool.schema.safeParse(step.input)
      const level = effectiveLevel(step.tool, tool.level)
      const shared = { declaredLevel: tool.level, effectiveLevel: level }

      if (!parsed.success) {
        ok = false
        lastWillRun = false
        const why = parsed.error.issues
          .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
          .slice(0, 4)
          .join('; ')
        steps.push({ ...base, ...shared, verdict: 'invalid', summary: 'invalid input', detail: why })
        log.push(`${label}: invalid input -- ${why}`)
        continue
      }

      const call = `${step.tool}(${truncate(JSON.stringify(parsed.data ?? {}), 300)})`
      const verdict = decide(step.tool, tool.level)
      if (verdict.decision === 'deny') {
        ok = false
        lastWillRun = false
        steps.push({ ...base, ...shared, verdict: 'deny', summary: call, detail: verdict.reason })
        log.push(`${label}: denied -- ${verdict.reason}`)
        continue
      }

      lastWillRun = true
      const asks = verdict.decision === 'confirm' || tool.selfGuarded === true
      const detail = tool.selfGuarded
        ? `${step.tool} classifies each request itself and may ask for approval when it runs.`
        : verdict.reason
      steps.push({ ...base, ...shared, verdict: asks ? 'ask' : 'run', summary: call, detail })
      log.push(`${label}: would ${asks ? 'ask for approval, then call' : 'call'} ${call}`)
    }

    if (!steps.length) log.push('This automation has no steps.')
    logger.info('automation.dryRun', { name: automation.name, steps: steps.length, ok })
    return { ok, automation: automation.name, steps, log }
  }
}
