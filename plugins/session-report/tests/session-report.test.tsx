import { expect, mock, test } from 'claude-code/testing'
import type { HookStream, On, TurnStepResult } from 'claude-code'

import { fileStem, html, mergeNotes, noticeFrom, notesOf, totals } from '../hooks/report'

const STEP: TurnStepResult = {
  turnId: 't1',
  index: 0,
  answer: '',
  toolUses: [],
  stopReason: 'end_turn',
  usage: {
    model: 'claude-opus-5-5',
    input_tokens: 10_000,
    output_tokens: 2_000,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
}

// Reads a streamed event to its end, as the engine does.
async function drain<C, R>(stream: HookStream<C, R>): Promise<R> {
  for await (const _ of stream) {
    // the chunks are not needed here
  }

  return stream.result
}

function world(on: On, written: { path: string; text: string }[]) {
  mock.clock(on, { now: Date.UTC(2026, 9, 26, 9, 0) })
  mock.env(on, { HOME: '/Users/me' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'report' } }))
  on('session.cwd', () => ({ value: '/Users/me/code/shop' }))
  on('session.repo', () => ({ value: { root: '/Users/me/code/shop', remote: null, internal: false, name: 'shop' } }))
  on('session.id', () => ({ value: 'abcdef1234567890' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.surface', () => ({ value: 'terminal' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {} as never, rateLimits: [], cost: { usd: 0.42 } } }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === 'git' ? 'main\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('fs.write', (_, e) => {
    written.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* () {
    return STEP
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('tool.call', (_, e) =>
    e.tool === 'Bash' && e.command.startsWith('rm')
      ? { deny: 'Blast Radius: `rm -rf dist` would delete 40 files' }
      : { result: {} },
  )
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

test('names report files by date, project and session', () => {
  const stem = fileStem({
    project: 'My Shop',
    branch: null,
    sessionId: 'abcdef1234567890',
    model: '',
    generatedAt: new Date(2026, 9, 26, 9, 5).getTime(),
    engineCostUsd: null,
    home: '',
  })
  expect(stem).toBe('2026-10-26-0905-my-shop-abcdef12')
})

test('a session becomes a report with turns, files, commands and helpers', async ($, on) => {
  const written: { path: string; text: string }[] = []
  world(on, written)

  await $.session.start({ cwd: '/Users/me/code/shop', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'add retries to checkout', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'add retries to checkout', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
  await $.tool.call({ tool: 'Edit', file_path: '/Users/me/code/shop/pay.ts', old_string: 'a', new_string: 'a\nb\nc' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf dist' })
  await $.agent.spawn({ prompt: 'look', description: 'Check callers', subagentType: 'Explore' } as never)
  await $.turn.complete({ answer: 'done', durationMs: 65_000, isAborted: false, turnId: 't1', reason: 'answer' })

  const out = await $.command.run({
    command: 'report',
    args: 'quiet',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

  expect(out.text).toContain('**shop**')
  expect(out.text).toContain('1 files changed, 2 commands, 1 helpers, 1 stopped')
  expect(written).toHaveLength(1)
  expect(written[0]?.path).toMatch(/^\/Users\/me\/\.claude\/session-reports\/2026-10-26-\d{4}-shop-abcdef12\.html$/)

  const page = written[0]?.text ?? ''
  expect(page).toContain('add retries to checkout')
  expect(page).toContain('~/code/shop/pay.ts')
  expect(page).toContain('+3')
  expect(page).toContain('would delete 40 files')
  expect(page).toContain('Check callers')
  expect(page).toContain('<td>$0.08</td>')
  expect(page).toContain('$0.42')
})

test('the page escapes what it shows and stays whole when empty', () => {
  const meta = { project: '<shop>', branch: null, sessionId: 'x', model: 'claude-opus-5-5', generatedAt: 1, engineCostUsd: null, home: '' }
  const empty = { startedAt: 0, turns: [], tools: [], helpers: [], notes: [] }
  const page = html(empty, meta)

  expect(page).toContain('&lt;shop&gt;')
  expect(page).not.toContain('<shop>')
  expect(totals(empty, meta).files).toHaveLength(0)
})

test('keeps notices other mods append, and nothing else', () => {
  const notice = { type: 'system', content: [{ type: 'text', text: 'You should know: retries can charge twice' }] }

  expect(noticeFrom(notice, { kind: 'plugin', name: 'you-should-know' })).toEqual({
    source: 'you-should-know',
    text: 'You should know: retries can charge twice',
  })
  expect(noticeFrom(notice, { kind: 'composer' })).toBeNull()
  expect(noticeFrom(notice, undefined)).toBeNull()
  expect(noticeFrom({ ...notice, type: 'user' }, { kind: 'plugin', name: 'you-should-know' })).toBeNull()
})

test('reads You Should Know notes and keeps each once', () => {
  const read = notesOf([{ title: 'Retries can charge twice.', detail: 'Add a key.', at: 5, status: 'known' }, { nope: 1 }])
  const seen = [{ at: 4, source: 'you-should-know', text: 'You should know: Retries can charge twice. Add a key.' }]

  expect(read).toEqual([{ at: 5, source: 'you-should-know', text: 'Retries can charge twice. Add a key.' }])
  expect(mergeNotes(seen, read)).toHaveLength(1)
  expect(mergeNotes([], read)).toHaveLength(1)
  expect(notesOf(undefined)).toEqual([])
})
