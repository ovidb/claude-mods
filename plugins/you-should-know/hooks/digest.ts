// Builds what the reviewer reads about one turn, and reads its answer back.
// Pure, so the tests can run it directly.

import type { SessionMessage } from 'claude-code'

const CHANGING = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'])
const BUDGET = 14_000

export const SYSTEM = `You review the work of a coding agent, sitting beside the person who asked for it.
They skim long turns. Your one job: catch a consequence of what the agent just did that the person would want to know and could easily miss.

Flag only things like: data loss or irreversible operations, charging or messaging users twice, retries that are not idempotent, security holes or leaked secrets, auth or permission changes, breaking a public API or a database schema, migrations, behaviour that silently changes for existing users, large cost or performance regressions, a risky change with no test, or a mismatch between what was asked and what was done.

Do not repeat what the agent already told the person. Do not nitpick style, naming or formatting. Do not flag anything you are unsure is real.

If nothing clears that bar, answer exactly: NONE
Otherwise answer with one JSON object and nothing else:
{"title": "<one sentence, at most 90 characters>", "detail": "<why it matters and what to check, at most 350 characters>", "topic": "<3 to 6 words naming the issue>"}`

export type Turn = { request: string; messages: SessionMessage[] }

// The messages since the person's last prompt: the turn the agent just ran.
export function lastTurn(messages: readonly SessionMessage[]): Turn {
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!
    if (m.role === 'user' && m.text.trim() !== '' && (m.toolResults ?? []).length === 0) {
      start = i
      break
    }
  }

  return { request: messages[start]?.text ?? '', messages: messages.slice(start + 1) }
}

export function changesSomething(turn: Turn): boolean {
  return turn.messages.some(m => m.toolUses.some(t => CHANGING.has(t.tool)))
}

function cut(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text : JSON.stringify(text ?? '')

  return s.length <= max ? s : `${s.slice(0, max)}\n[... ${s.length - max} more characters]`
}

function describeTool(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Edit':
      return `Edit ${input.file_path}\n--- removed\n${cut(input.old_string, 1200)}\n+++ added\n${cut(input.new_string, 1200)}`
    case 'MultiEdit':
      return `MultiEdit ${input.file_path}\n${cut(input.edits, 2400)}`
    case 'Write':
      return `Write ${input.file_path}\n${cut(input.content, 1500)}`
    case 'NotebookEdit':
      return `NotebookEdit ${input.notebook_path}\n${cut(input.new_source, 1200)}`
    case 'Bash':
      return `Bash: ${cut(input.command, 400)}`
    default:
      return `${tool} ${cut(input, 200)}`
  }
}

export function digest(turn: Turn, known: readonly string[]): string {
  const parts: string[] = [`The person asked:\n${cut(turn.request, 1500)}`]

  for (const m of turn.messages) {
    if (m.role === 'assistant' && m.text.trim() !== '') {
      parts.push(`The agent said:\n${cut(m.text, 1500)}`)
    }
    for (const t of m.toolUses) {
      parts.push(describeTool(t.tool, t.input))
    }
  }
  if (known.length > 0) {
    parts.push(`The person already knows about these, so never raise them again: ${known.join('; ')}`)
  }

  const text = parts.join('\n\n')

  return text.length <= BUDGET ? text : `${text.slice(0, BUDGET / 2)}\n[...]\n${text.slice(-BUDGET / 2)}`
}

export type Finding = { title: string; detail: string; topic: string }

export function parseFinding(answer: string): Finding | null {
  const trimmed = answer.trim()
  if (trimmed === '' || /^NONE\b/i.test(trimmed)) {
    return null
  }

  const json = /\{[\s\S]*\}/.exec(trimmed)?.[0]
  if (json === undefined) {
    return null
  }
  try {
    const value = JSON.parse(json) as Partial<Finding>
    if (typeof value.title !== 'string' || value.title.trim() === '') {
      return null
    }

    return {
      title: value.title.trim().slice(0, 140),
      detail: typeof value.detail === 'string' ? value.detail.trim().slice(0, 600) : '',
      topic: typeof value.topic === 'string' ? value.topic.trim().slice(0, 60) : value.title.slice(0, 40),
    }
  } catch {
    return null
  }
}
