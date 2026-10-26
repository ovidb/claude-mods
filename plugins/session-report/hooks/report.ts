// Turns the session's journal into a self-contained HTML page and a short
// Markdown summary. Pure: no `$`, so the tests can run it directly.

import type { Journal, NoteRow, ToolRow } from '../types'
import { dollars, shortModel } from './pricing'

export type Meta = {
  project: string
  branch: string | null
  sessionId: string
  model: string
  generatedAt: number
  engineCostUsd: number | null
  home: string
}

export type FileChange = { path: string; edits: number; added: number; removed: number; isCreated: boolean }

export type Totals = {
  durationMs: number
  costUsd: number
  helperCostUsd: number
  mainCostUsd: number
  toolCalls: number
  files: FileChange[]
  commands: ToolRow[]
  denied: ToolRow[]
  errors: ToolRow[]
}

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

export function totals(journal: Journal, meta: Meta): Totals {
  const mainCostUsd = journal.turns.reduce((n, t) => n + t.costUsd, 0)
  const helperCostUsd = journal.helpers.reduce((n, h) => n + h.costUsd, 0)
  const byPath = new Map<string, FileChange>()

  for (const row of journal.tools) {
    if (row.file === null || !EDITS.has(row.tool) || row.outcome !== 'ok') continue
    const known = byPath.get(row.file) ?? { path: row.file, edits: 0, added: 0, removed: 0, isCreated: false }
    byPath.set(row.file, {
      ...known,
      edits: known.edits + 1,
      added: known.added + row.added,
      removed: known.removed + row.removed,
      isCreated: known.isCreated || (known.edits === 0 && row.tool === 'Write'),
    })
  }

  return {
    durationMs: Math.max(0, meta.generatedAt - journal.startedAt),
    costUsd: meta.engineCostUsd ?? mainCostUsd + helperCostUsd,
    helperCostUsd,
    mainCostUsd,
    toolCalls: journal.tools.length,
    files: [...byPath.values()].sort((a, b) => b.added + b.removed - (a.added + a.removed)),
    commands: journal.tools.filter(t => t.tool === 'Bash'),
    denied: journal.tools.filter(t => t.outcome === 'denied'),
    errors: journal.tools.filter(t => t.outcome === 'error'),
  }
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 10) return `${m}m ${s % 60}s`
  if (m < 60) return `${m}m`

  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function esc(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function tidy(path: string, home: string): string {
  return home !== '' && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}

function clock(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function day(ms: number): string {
  const d = new Date(ms)

  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

export function fileStem(meta: Meta): string {
  const d = new Date(meta.generatedAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  const slug = meta.project.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'session'

  return `${date}-${slug}-${meta.sessionId.slice(0, 8)}`
}

function tile(label: string, value: string, sub = ''): string {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div>${sub ? `<div class="tile-sub">${esc(sub)}</div>` : ''}</div>`
}

const CHARTED = 80

function costChart(journal: Journal): string {
  const skipped = Math.max(0, journal.turns.length - CHARTED)
  const turns = journal.turns.slice(skipped)
  if (turns.length === 0) return ''
  const peak = Math.max(...turns.map(t => t.costUsd + t.helperCostUsd), 0.000001)

  const bars = turns
    .map((t, i) => {
      const total = t.costUsd + t.helperCostUsd
      const main = (t.costUsd / peak) * 100
      const helpers = (t.helperCostUsd / peak) * 100
      const tip = `Turn ${skipped + i + 1}: ${dollars(total)} (main ${dollars(t.costUsd)}, helpers ${dollars(t.helperCostUsd)})`

      return `<div class="bar" tabindex="0" aria-label="${esc(tip)}">
  <div class="tip" role="tooltip"><strong>Turn ${skipped + i + 1}</strong><br>${esc(t.prompt.slice(0, 80))}<br>Main ${esc(dollars(t.costUsd))} · Helpers ${esc(dollars(t.helperCostUsd))}</div>
  ${helpers > 0 ? `<div class="seg seg-2 top" style="height:${helpers.toFixed(2)}%"></div>` : ''}
  <div class="seg seg-1${helpers > 0 ? '' : ' top'}" style="height:${Math.max(main, total > 0 ? 1 : 0).toFixed(2)}%"></div>
</div>`
    })
    .join('\n')

  return `<figure class="chart">
  <figcaption><span>Estimated cost per turn${skipped > 0 ? `, last ${CHARTED}` : ''}</span><span class="legend"><i class="key key-1"></i>Main thread <i class="key key-2"></i>Helpers</span></figcaption>
  <div class="plot"><div class="axis-top">${esc(dollars(peak))}</div><div class="bars">${bars}</div></div>
  <div class="axis-x"><span>Turn ${skipped + 1}</span><span>Turn ${skipped + turns.length}</span></div>
</figure>`
}

function split(t: Totals): string {
  const sum = t.mainCostUsd + t.helperCostUsd
  if (sum <= 0) return ''
  const main = (t.mainCostUsd / sum) * 100

  return `<div class="split" aria-label="Main thread ${esc(dollars(t.mainCostUsd))}, helpers ${esc(dollars(t.helperCostUsd))}">
  <div class="split-bar"><div class="seg-1" style="width:${main.toFixed(1)}%"></div><div class="seg-2" style="width:${(100 - main).toFixed(1)}%"></div></div>
  <div class="split-labels"><span><i class="key key-1"></i>Main thread ${esc(dollars(t.mainCostUsd))} (${main.toFixed(0)}%)</span><span><i class="key key-2"></i>Helpers ${esc(dollars(t.helperCostUsd))} (${(100 - main).toFixed(0)}%)</span></div>
</div>`
}

// `text` names the one column whose cells may wrap; numbers never do.
function table(head: string[], rows: string[][], empty: string, text: number): string {
  if (rows.length === 0) return `<p class="empty">${esc(empty)}</p>`

  return `<div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map(r => `<tr>${r.map((c, i) => `<td${i === text ? ' class="text"' : ''}>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`
}

const OUTCOME: Record<string, string> = {
  ok: '<span class="ok">ran</span>',
  error: '<span class="bad">failed</span>',
  denied: '<span class="warn">stopped</span>',
  running: '<span class="muted">running</span>',
}

export function html(journal: Journal, meta: Meta): string {
  const t = totals(journal, meta)
  const title = `${meta.project} session report`
  const added = t.files.reduce((n, f) => n + f.added, 0)
  const removed = t.files.reduce((n, f) => n + f.removed, 0)
  const costNote = meta.engineCostUsd === null ? 'estimate from list prices' : 'as /cost counts it'

  const turns = table(
    ['#', 'Started', 'Prompt', 'Took', 'Tools', 'Cost'],
    journal.turns.map((turn, i) => [
      String(i + 1),
      clock(turn.startedAt),
      `${esc(turn.prompt)}${turn.isAborted ? ' <span class="warn">(interrupted)</span>' : ''}`,
      turn.durationMs === null ? '' : duration(turn.durationMs),
      String(turn.tools),
      esc(dollars(turn.costUsd + turn.helperCostUsd)),
    ]),
    'No turns yet.',
    2,
  )
  const files = table(
    ['File', 'Edits', 'Lines'],
    t.files.map(f => [
      `<code>${esc(tidy(f.path, meta.home))}</code>${f.isCreated ? ' <span class="muted">new</span>' : ''}`,
      String(f.edits),
      `<span class="ok">+${f.added}</span> <span class="bad">-${f.removed}</span>`,
    ]),
    'No files were changed through Claude’s edit tools.',
    0,
  )
  const commands = table(
    ['Time', 'Command', 'Result'],
    t.commands.map(c => [
      clock(c.at),
      `<code>${esc(c.summary)}</code>${c.reason ? `<div class="reason">${esc(c.reason)}</div>` : ''}`,
      OUTCOME[c.outcome] ?? '',
    ]),
    'No shell commands ran.',
    1,
  )
  const helpers = table(
    ['Helper', 'Type', 'Model', 'Steps', 'Took', 'Cost'],
    journal.helpers.map(h => [
      esc(h.description),
      esc(h.type),
      esc(shortModel(h.model)),
      String(h.steps),
      h.endedAt === null ? 'running' : duration(h.endedAt - h.startedAt),
      esc(dollars(h.costUsd)),
    ]),
    'No subagents ran.',
    0,
  )
  const notes =
    journal.notes.length === 0
      ? '<p class="empty">No notes were raised.</p>'
      : `<ul class="notes">${journal.notes.map(n => `<li><span class="muted">${clock(n.at)} · ${esc(n.source)}</span><br>${esc(n.text)}</li>`).join('')}</ul>`
  const stopped =
    t.denied.length === 0
      ? ''
      : `<section><h2>Stopped before running</h2>${table(
          ['Time', 'Tool', 'What', 'Why'],
          t.denied.map(d => [clock(d.at), esc(d.tool), `<code>${esc(d.summary)}</code>`, esc(d.reason ?? '')]),
          '',
          2,
        )}</section>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,0.10);
  --series-1: #2a78d6; --series-2: #eb6834;
  --good: #006300; --bad: #d03b3b; --warn: #a66a00;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
    --series-1: #3987e5; --series-2: #d95926;
    --good: #0ca30c; --bad: #e66767; --warn: #fab219;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
  --series-1: #3987e5; --series-2: #d95926;
  --good: #0ca30c; --bad: #e66767; --warn: #fab219;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 32px 16px 64px; }
header h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
header p { margin: 0; color: var(--ink-2); }
h2 { font-size: 17px; margin: 0 0 12px; }
section { background: var(--surface); border: 1px solid var(--ring); border-radius: 12px; padding: 18px; margin-top: 16px; }
.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 24px; }
.tile { background: var(--surface); border: 1px solid var(--ring); border-radius: 12px; padding: 14px 16px; }
.tile-label { color: var(--ink-2); font-size: 13px; }
.tile-value { font-size: 26px; font-weight: 600; margin-top: 2px; }
.tile-sub { color: var(--muted); font-size: 12px; }
.chart { margin: 0; }
.chart figcaption { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; font-weight: 600; margin-bottom: 10px; }
.legend { font-weight: 400; color: var(--ink-2); font-size: 13px; display: inline-flex; gap: 6px; align-items: center; }
.key { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-left: 8px; }
.key-1, .seg-1 { background: var(--series-1); }
.key-2, .seg-2 { background: var(--series-2); }
.plot { position: relative; border-bottom: 1px solid var(--axis); background: linear-gradient(var(--grid), var(--grid)) top / 100% 1px no-repeat; padding-top: 18px; }
.axis-top { position: absolute; top: 0; left: 0; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.bars { display: flex; align-items: flex-end; gap: 2px; height: 160px; }
.bar { position: relative; flex: 1 1 0; min-width: 2px; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; gap: 2px; outline: none; cursor: default; }
.seg { width: 100%; }
.seg.top { border-radius: 4px 4px 0 0; }
.bar:hover .seg, .bar:focus .seg { filter: brightness(1.12); }
.tip { display: none; position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); width: max-content; max-width: 240px; background: var(--ink); color: var(--page); font-size: 12px; padding: 6px 8px; border-radius: 6px; z-index: 2; pointer-events: none; }
.bar:hover .tip, .bar:focus .tip { display: block; }
.axis-x { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; margin-top: 4px; }
.split { margin-top: 18px; }
.split-bar { display: flex; gap: 2px; height: 12px; }
.split-bar > div:first-child { border-radius: 4px 0 0 4px; }
.split-bar > div:last-child { border-radius: 0 4px 4px 0; }
.split-labels { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; color: var(--ink-2); font-size: 13px; margin-top: 6px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; color: var(--ink-2); font-weight: 500; border-bottom: 1px solid var(--axis); padding: 6px 8px; white-space: nowrap; }
td { border-bottom: 1px solid var(--grid); padding: 7px 8px; vertical-align: top; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.text { white-space: normal; width: 100%; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.reason { color: var(--ink-2); font-size: 13px; margin-top: 2px; }
.ok { color: var(--good); } .bad { color: var(--bad); } .warn { color: var(--warn); } .muted, .empty { color: var(--muted); }
.notes { margin: 0; padding-left: 18px; } .notes li { margin-bottom: 10px; }
footer { color: var(--muted); font-size: 12px; margin-top: 24px; }
@media (max-width: 560px) { .tiles { grid-template-columns: repeat(2, 1fr); gap: 8px; } .tile { padding: 10px 12px; } .tile-value { font-size: 21px; } .bars { height: 120px; } section { padding: 14px; } }
</style>
</head>
<body>
<main>
<header>
  <h1>${esc(meta.project)}</h1>
  <p>${esc(day(journal.startedAt))}, ${clock(journal.startedAt)} to ${clock(meta.generatedAt)}${meta.branch ? ` · branch <code>${esc(meta.branch)}</code>` : ''} · ${esc(shortModel(meta.model))}</p>
</header>
<div class="tiles">
  ${tile('Duration', duration(t.durationMs))}
  ${tile('Cost', dollars(t.costUsd), costNote)}
  ${tile('Turns', String(journal.turns.length))}
  ${tile('Tool calls', String(t.toolCalls), t.errors.length > 0 ? `${t.errors.length} failed` : '')}
  ${tile('Files changed', String(t.files.length), t.files.length > 0 ? `+${added} -${removed} lines` : '')}
  ${tile('Helpers', String(journal.helpers.length), t.helperCostUsd > 0 ? dollars(t.helperCostUsd) : '')}
  ${tile('Stopped', String(t.denied.length), 'held or declined')}
  ${tile('Notes', String(journal.notes.length))}
</div>
${journal.turns.length > 0 ? `<section>${costChart(journal)}${split(t)}</section>` : ''}
<section><h2>Turns</h2>${turns}</section>
<section><h2>Files changed</h2>${files}</section>
${stopped}
<section><h2>Commands</h2>${commands}</section>
<section><h2>Helpers</h2>${helpers}</section>
<section><h2>Notes</h2>${notes}</section>
<footer>Costs are estimates from token counts and list prices, not your bill. Session ${esc(meta.sessionId)}. Written by Session Report.</footer>
</main>
</body>
</html>
`
}

// The text of a notice row another mod appended (You Should Know's notes,
// for one), or null for any other row.
export function noticeFrom(
  message: { type: string; content: readonly { type: string; text?: unknown }[] },
  origin: unknown,
): { source: string; text: string } | null {
  const from = origin as { kind?: unknown; name?: unknown } | undefined
  if (message.type !== 'system' || from?.kind !== 'plugin' || typeof from.name !== 'string' || from.name === 'session-report') {
    return null
  }
  const text = message.content
    .map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join(' ')
    .trim()

  return text === '' ? null : { source: from.name, text: text.slice(0, 600) }
}

// You Should Know keeps its notes in its own state; this reads them as rows.
export function notesOf(value: unknown): NoteRow[] {
  if (!Array.isArray(value)) return []

  return value.flatMap(n => {
    const note = n as { title?: unknown; detail?: unknown; at?: unknown }
    if (typeof note.title !== 'string') return []
    const detail = typeof note.detail === 'string' && note.detail !== '' ? ` ${note.detail}` : ''

    return [{ at: typeof note.at === 'number' ? note.at : 0, source: 'you-should-know', text: `${note.title}${detail}` }]
  })
}

// Notes from both roads, each once, oldest first.
export function mergeNotes(seen: readonly NoteRow[], read: readonly NoteRow[]): NoteRow[] {
  const key = (n: NoteRow) => n.text.replace(/^You should know:\s*/, '').trim()
  const known = new Set(seen.map(key))

  return [...seen, ...read.filter(n => !known.has(key(n)))].sort((a, b) => a.at - b.at)
}

export function markdown(journal: Journal, meta: Meta, path: string): string {
  const t = totals(journal, meta)
  const lines = [
    `**${meta.project}**: ${duration(t.durationMs)}, ${journal.turns.length} turns, about ${dollars(t.costUsd)}`,
    `${t.files.length} files changed, ${t.commands.length} commands, ${journal.helpers.length} helpers, ${t.denied.length} stopped, ${journal.notes.length} notes`,
  ]
  if (t.files.length > 0) {
    lines.push('', ...t.files.slice(0, 5).map(f => `- \`${tidy(f.path, meta.home)}\` +${f.added} -${f.removed}`))
  }
  lines.push('', `Report: ${tidy(path, meta.home)}`)

  return lines.join('\n')
}
