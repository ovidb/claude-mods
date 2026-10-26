import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HelperRow, Journal, Outcome, ToolRow, TurnRow } from '../types'
import { costOf } from './pricing'
import { fileStem, html, markdown, mergeNotes, noticeFrom, notesOf } from './report'
import type { Meta } from './report'

const EMPTY: Journal = { startedAt: 0, turns: [], tools: [], helpers: [], notes: [] }
const journal = atom({ plugin: 'session-report', key: 'journal' } as const, EMPTY)
const pending = atom({ plugin: 'session-report', key: 'pending' } as const, '')
const lastReport = atom({ plugin: 'session-report', key: 'lastReport' } as const, '')

type Settings = { autoSave: boolean; folder: string }

function lines(text: unknown): number {
  return typeof text === 'string' && text !== '' ? text.split('\n').length : 0
}

// What a tool call did, in a line, and the lines it added and removed.
function describeCall(tool: string, input: Record<string, unknown>) {
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
  const short = (v: unknown) => String(v ?? '').slice(0, 300)

  switch (tool) {
    case 'Bash':
      return { summary: short(input.command), file: null, added: 0, removed: 0 }
    case 'Edit':
      return { summary: short(file), file, added: lines(input.new_string), removed: lines(input.old_string) }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []
      return {
        summary: short(file),
        file,
        added: edits.reduce((n, x) => n + lines(x.new_string), 0),
        removed: edits.reduce((n, x) => n + lines(x.old_string), 0),
      }
    }
    case 'Write':
      return { summary: short(file), file, added: lines(input.content), removed: 0 }
    case 'NotebookEdit':
      return { summary: short(file), file, added: lines(input.new_source), removed: 0 }
    default: {
      const hint = input.pattern ?? input.url ?? input.query ?? input.description ?? file ?? ''
      return { summary: short(hint), file: null, added: 0, removed: 0 }
    }
  }
}

function currentTurn(j: Journal): TurnRow | undefined {
  return j.turns.at(-1)
}

async function startJournal($: EngineInterface) {
  const now = await $.clock.now()
  await update($, journal, j => (j.startedAt === 0 ? { ...j, startedAt: now } : j))
}

async function meta($: EngineInterface): Promise<Meta> {
  const [cwd, repo, id, model, usage, home, now] = await Promise.all([
    $.session.cwd(),
    $.session.repo(),
    $.session.id(),
    $.session.model(),
    $.session.usage(),
    $.env.get('HOME'),
    $.clock.now(),
  ])
  const branch = await $.process
    .run(['git', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 3000 })
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : null))
    .catch(() => null)

  return {
    project: repo?.name ?? (cwd.split('/').filter(Boolean).at(-1) || 'session'),
    branch,
    sessionId: id,
    model,
    generatedAt: now,
    engineCostUsd: usage.cost?.usd ?? null,
    home: home ?? '',
  }
}

// Any mod may read another's values. You Should Know's notes are read
// straight from its state, since a plugin running above this one can pass
// transcript notices on before session.append sees them.
async function youShouldKnowNotes($: EngineInterface) {
  const held = (await $.state.get({ plugin: 'you-should-know', key: 'notes' } as never)) as { value?: unknown }

  return notesOf(held.value)
}

async function writeReport($: EngineInterface, settings: Settings): Promise<{ path: string; summary: string }> {
  const kept = await read($, journal)
  const j = { ...kept, notes: mergeNotes(kept.notes, await youShouldKnowNotes($)) }
  const m = await meta($)
  const folder = settings.folder.replace(/^~(?=$|\/)/, m.home).replace(/\/+$/, '')
  const path = `${folder}/${fileStem(m)}.html`

  await $.process.run(['mkdir', '-p', folder], { timeoutMs: 3000 })
  await $.fs.write(path, html(j, m))
  await update($, lastReport, () => path)

  return { path, summary: markdown(j, m, path) }
}

async function openFile($: EngineInterface, path: string): Promise<boolean> {
  for (const opener of ['open', 'xdg-open']) {
    const ran = await $.process.run([opener, path], { timeoutMs: 5000 }).catch(() => null)
    if (ran !== null && ran.exitCode === 0) return true
  }

  return false
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    autoSave: options.autoSave !== false,
    folder: typeof options.folder === 'string' && options.folder !== '' ? options.folder : '~/.claude/session-reports',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'report',
      description: 'Write an HTML report of this session and open it (add "quiet" to only save it)',
      argumentHint: '[quiet]',
    })
    await startJournal($)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command === undefined && e.isMeta !== true) {
      await update($, pending, () => e.text.slice(0, 300))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const prompt = (await read($, pending)) || e.text.slice(0, 300)
      const now = await $.clock.now()
      const row: TurnRow = {
        id: e.turnId,
        prompt,
        startedAt: now,
        durationMs: null,
        model: '',
        steps: 0,
        tools: 0,
        costUsd: 0,
        helperCostUsd: 0,
        isAborted: false,
      }
      await update($, pending, () => '')
      await update($, journal, j => ({ ...j, startedAt: j.startedAt || now, turns: [...j.turns, row].slice(-500) }))
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const model = result.usage?.model ?? e.model
    const cost = result.usage === null ? 0 : costOf(model, result.usage)
    const agentId = e.agentId

    await update($, journal, j => {
      const turn = currentTurn(j)
      if (agentId === undefined) {
        return {
          ...j,
          turns: j.turns.map(t => (t === turn ? { ...t, model, steps: t.steps + 1, costUsd: t.costUsd + cost } : t)),
        }
      }
      const known = j.helpers.find(h => h.id === agentId)
      const helper: HelperRow = {
        id: agentId,
        turn: known?.turn ?? turn?.id ?? '',
        description: known?.description ?? 'helper',
        type: known?.type ?? 'agent',
        model,
        steps: (known?.steps ?? 0) + 1,
        costUsd: (known?.costUsd ?? 0) + cost,
        startedAt: known?.startedAt ?? j.startedAt,
        endedAt: known?.endedAt ?? null,
      }
      return {
        ...j,
        helpers: [...j.helpers.filter(h => h.id !== agentId), helper].slice(-200),
        turns: j.turns.map(t => (t.id === helper.turn ? { ...t, helperCostUsd: t.helperCostUsd + cost } : t)),
      }
    })

    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)

    if (spawned.agentId !== undefined) {
      const id = spawned.agentId
      const now = await $.clock.now()
      await update($, journal, j => {
        const known = j.helpers.find(h => h.id === id)
        const helper: HelperRow = {
          id,
          turn: known?.turn ?? currentTurn(j)?.id ?? '',
          description: e.description || 'helper',
          type: e.subagentType,
          model: spawned.model,
          steps: known?.steps ?? 0,
          costUsd: known?.costUsd ?? 0,
          startedAt: known?.startedAt ?? now,
          endedAt: null,
        }
        return { ...j, helpers: [...j.helpers.filter(h => h.id !== id), helper].slice(-200) }
      })
    }

    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    const agentId = e.agentId

    await update($, journal, j =>
      agentId === undefined
        ? {
            ...j,
            turns: j.turns.map(t =>
              t.id === e.turnId || (t === currentTurn(j) && t.durationMs === null)
                ? { ...t, durationMs: e.durationMs, isAborted: e.isAborted }
                : t,
            ),
          }
        : { ...j, helpers: j.helpers.map(h => (h.id === agentId ? { ...h, endedAt: now } : h)) },
    )

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const now = await $.clock.now()
    const said = describeCall(e.tool, input)
    const id = e.tool_use_id
    const row: ToolRow = {
      id,
      turn: '',
      tool: e.tool,
      ...said,
      agentId: e.agentId ?? null,
      at: now,
      outcome: 'running',
      reason: null,
    }

    await update($, journal, j => {
      const turn = currentTurn(j)
      return {
        ...j,
        tools: [...j.tools, { ...row, turn: turn?.id ?? '' }].slice(-3000),
        turns: j.turns.map(t => (t === turn && e.agentId === undefined ? { ...t, tools: t.tools + 1 } : t)),
      }
    })

    const ran = await next(e)
    const outcome: Outcome = ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'ok'
    const failure = ran.isError === true ? (ran.text ?? '').slice(0, 300) : ''
    const reason: string | null = ran.deny ?? (failure || null)
    await update($, journal, j => ({
      ...j,
      tools: j.tools.map(t => (t.id === id ? { ...t, outcome, reason } : t)),
    }))

    return ran
  }).catch(($, e, next) => next(e))

  // Notices other mods add (You Should Know's notes, for one) are kept.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const notice = noticeFrom(e.message, e.origin)

    if (notice !== null) {
      const now = await $.clock.now()
      await update($, journal, j => ({ ...j, notes: [...j.notes, { at: now, ...notice }].slice(-200) }))
    }

    return stored
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'report' }, async ($, e) => {
    const j = await read($, journal)
    if (j.turns.length === 0) {
      return { text: 'Nothing to report yet: no turns have run in this session.' }
    }

    const { path, summary } = await writeReport($, settings)
    const surface = await $.session.surface()
    const wantsQuiet = e.args.trim().toLowerCase() === 'quiet'
    const isOpened = !wantsQuiet && surface !== 'mobile' && (await openFile($, path))

    return { text: `${summary}${isOpened ? ' (opened in your browser)' : ''}` }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'report' } }, async ($, e, next) => {
    const path = await read($, lastReport)

    if (e.props.isErrored || path === '') {
      return next(e)
    }

    const { Box, Markdown, Link } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Markdown text={e.props.text} />
        {e.surface !== 'mobile' && <Link href={`file://${path}`} label="Open the report" />}
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    const j = await read($, journal)

    if (settings.autoSave && j.turns.length > 0) {
      await writeReport($, settings).catch(() => undefined)
    }
    if (e.reason === 'clear') {
      const now = await $.clock.now()
      await update($, journal, () => ({ startedAt: now, turns: [], tools: [], helpers: [], notes: [] }))
    }

    return next(e)
  })
}
