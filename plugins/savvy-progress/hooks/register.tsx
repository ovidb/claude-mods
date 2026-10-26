import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, Register, TurnStepInput, TurnStepResult } from 'claude-code'

import type { AgentRun, AgentState } from '../types'
import { costOf, dollars, shortModel } from './pricing'

const PANE = 'savvy-progress'
const agents = atom({ plugin: 'savvy-progress', key: 'agents' } as const, [])
const main = atom({ plugin: 'savvy-progress', key: 'main' } as const, { steps: 0, costUsd: 0, model: '' })
const batch = atom({ plugin: 'savvy-progress', key: 'batch' } as const, '')
const isBandHidden = atom({ plugin: 'savvy-progress', key: 'isBandHidden' } as const, false)

const FROM_STATUS: Partial<Record<AgentStatus, AgentState>> = {
  completed: 'done',
  idle: 'done',
  failed: 'failed',
  killed: 'stopped',
}

const GLYPH: Record<AgentState, string> = { running: '●', done: '✓', failed: '✗', stopped: '■' }
const COLOR: Record<AgentState, string> = { running: 'claude', done: 'success', failed: 'error', stopped: 'subtle' }

function fresh(id: string, at: number, inBatch: string, fields: Partial<AgentRun>): AgentRun {
  return {
    id,
    description: 'helper',
    type: 'agent',
    model: '',
    state: 'running',
    batch: inBatch,
    startedAt: at,
    endedAt: null,
    steps: 0,
    tools: 0,
    lastTool: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    costUsd: 0,
    ...fields,
  }
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`

  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`

  return `${(n / 1_000_000).toFixed(1)}M`
}

function bar(done: number, total: number, width: number): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)

  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

async function recordStep($: EngineInterface, e: TurnStepInput, result: TurnStepResult) {
  const model = result.usage?.model ?? e.model
  const cost = result.usage === null ? 0 : costOf(model, result.usage)

  if (e.agentId === undefined) {
    await update($, main, m => ({ steps: m.steps + 1, costUsd: m.costUsd + cost, model }))
    return
  }

  const id = e.agentId
  const now = await $.clock.now()
  const inBatch = await read($, batch)
  const lastTool = result.toolUses.at(-1)?.name ?? null
  const usage = result.usage

  await update($, agents, list => {
    const known = list.find(a => a.id === id) ?? fresh(id, now, inBatch, { model })
    const next: AgentRun = {
      ...known,
      model,
      steps: known.steps + 1,
      tools: known.tools + result.toolUses.length,
      lastTool: lastTool ?? known.lastTool,
      inputTokens: known.inputTokens + (usage?.input_tokens ?? 0),
      outputTokens: known.outputTokens + (usage?.output_tokens ?? 0),
      cacheReadTokens: known.cacheReadTokens + (usage?.cache_read_input_tokens ?? 0),
      cacheWriteTokens: known.cacheWriteTokens + (usage?.cache_creation_input_tokens ?? 0),
      contextTokens:
        usage === null
          ? known.contextTokens
          : usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens,
      costUsd: known.costUsd + cost,
    }

    return [...list.filter(a => a.id !== id), next].slice(-60)
  })
}

async function settle($: EngineInterface, id: string, state: AgentState) {
  const now = await $.clock.now()
  await update($, agents, list =>
    list.map(a => (a.id === id && a.state === 'running' ? { ...a, state, endedAt: now } : a)),
  )
}

async function summaryText($: EngineInterface): Promise<string> {
  const list = await read($, agents)
  const spent = await read($, main)
  const usage = await $.session.usage()
  const helpers = list.reduce((n, a) => n + a.costUsd, 0)

  if (list.length === 0) {
    return `No helpers have run this session. Main thread so far: about ${dollars(spent.costUsd)}.`
  }

  const rows = list.map(
    a =>
      `- ${GLYPH[a.state]} **${a.description}** (${a.type}, ${shortModel(a.model)}): ${a.steps} steps, ${a.tools} tool calls, ${tokens(a.contextTokens)} context, about ${dollars(a.costUsd)}`,
  )
  const total = usage.cost === undefined ? '' : ` Session total so far: ${dollars(usage.cost.usd)}.`

  return [`Helpers: about ${dollars(helpers)}. Main thread: about ${dollars(spent.costUsd)}.${total}`, '', ...rows].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agents-info',
      description: 'Open or close the live panel of subagents, their progress and their cost',
    })

    // While anything runs, redraw every second for the clocks, and pick up
    // ends the loop events did not report (a teammate going idle, a kill).
    let ticks = 0
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(a => a.state === 'running')) {
          return
        }
        $.ui.invalidate('ui.render')
        ticks += 1
        if (ticks % 3 !== 0) {
          return
        }
        const live = await $.agent.list()
        for (const run of list.filter(a => a.state === 'running')) {
          const info = live.find(one => one.id === run.id)
          const state = info === undefined ? undefined : FROM_STATUS[info.status]
          if (state !== undefined) {
            await settle($, run.id, state)
          }
        }
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'agents-info' }, async $ => {
    const panes = await $.ui.panes()

    if (panes.some(p => p.id === PANE && p.isShown)) {
      await $.ui.close({ id: PANE })
      return { text: 'Helpers panel closed.' }
    }

    const opened = await $.ui.open({ id: PANE, title: 'Helpers' })

    return opened.isPlaced ? { text: 'Helpers panel opened.' } : { text: await summaryText($) }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, batch, () => e.turnId)
      await update($, isBandHidden, () => false)
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)

    if (spawned.agentId !== undefined) {
      const id = spawned.agentId
      const now = await $.clock.now()
      const inBatch = await read($, batch)
      await update($, agents, list => {
        const known = list.find(a => a.id === id)
        const run = fresh(id, known?.startedAt ?? now, known?.batch ?? inBatch, {
          ...known,
          description: e.description || known?.description || 'helper',
          type: e.subagentType,
          model: spawned.model,
          state: 'running',
        })

        return [...list.filter(a => a.id !== id), run].slice(-60)
      })
    }

    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    await recordStep($, e, result)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      await settle($, e.agentId, e.reason === 'error' ? 'failed' : e.reason === 'aborted' ? 'stopped' : 'done')
    }

    return next(e)
  })

  // The band: shown while this turn's helpers run, and as a one-line tally
  // once they finish, until the next prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, agents)
    const current = await read($, batch)
    const mine = list.filter(a => a.batch === current)
    const isHidden = await read($, isBandHidden)

    if (mine.length === 0 || isHidden || e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const done = mine.filter(a => a.state !== 'running').length
    const cost = mine.reduce((n, a) => n + a.costUsd, 0)
    const started = Math.min(...mine.map(a => a.startedAt))
    const ended = done === mine.length ? Math.max(...mine.map(a => a.endedAt ?? now)) : now
    const isNarrow = e.surface === 'mobile' || e.props.bodyColumns < 60
    const running = mine.filter(a => a.state === 'running')
    const room = Math.max(0, Math.min(isNarrow ? 3 : 6, e.props.maxRows - 1))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color="claude" bold>
            Helpers {done}/{mine.length}
          </Text>
          <Text color="claude">{bar(done, mine.length, isNarrow ? 6 : 12)}</Text>
          <Text>~{dollars(cost)}</Text>
          <Text dimColor>{elapsed(ended - started)}</Text>
          {!isNarrow && (
            <Button key="open" plain label="[panel]" onPress={() => void $.ui.open({ id: PANE, title: 'Helpers' })} />
          )}
          <Button key="hide" plain label="[hide]" onPress={() => void update($, isBandHidden, () => true)} />
        </Box>
        {running.slice(0, room).map(a => (
          <Text wrap="truncate-end">
            <Text color="claude">{GLYPH[a.state]}</Text> {a.description}
            <Text dimColor>
              {' '}
              {isNarrow ? '' : `${a.type} · ${shortModel(a.model)} · `}
              {a.steps} steps{a.lastTool !== null ? ` · ${a.lastTool}` : ''} · ~{dollars(a.costUsd)}
            </Text>
          </Text>
        ))}
        {running.length > room && <Text dimColor>and {running.length - room} more running</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const spent = await read($, main)
    const usage = await $.session.usage()
    const now = await $.clock.now()
    const helpers = list.reduce((n, a) => n + a.costUsd, 0)
    const isNarrow = e.surface === 'mobile' || e.props.bodyColumns < 50
    const latest = [...list].reverse()

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>
            Helpers ~{dollars(helpers)} · main thread ~{dollars(spent.costUsd)}
          </Text>
          {usage.cost !== undefined && <Text dimColor>Session total so far {dollars(usage.cost.usd)}, as /cost counts it</Text>}
        </Box>
        {latest.length === 0 && <Text dimColor>No helpers yet. They show here as soon as Claude starts one.</Text>}
        {latest.map(a => (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={COLOR[a.state]}>{GLYPH[a.state]}</Text> <Text bold>{a.description}</Text>
            </Text>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {a.type} · {shortModel(a.model)} · {elapsed((a.endedAt ?? now) - a.startedAt)}
            </Text>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {a.steps} steps · {a.tools} tools · {tokens(a.contextTokens)} context · ~{dollars(a.costUsd)}
              {!isNarrow && a.lastTool !== null ? ` · last ${a.lastTool}` : ''}
            </Text>
          </Box>
        ))}
        <Text dimColor>Costs are estimates from token counts and list prices, not your bill.</Text>
      </Box>
    )
  })
}
