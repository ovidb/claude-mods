import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import { changesSomething, digest, lastTurn, parseFinding } from '../hooks/digest'

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'add retries to the charge call', toolUses: [] },
  {
    role: 'assistant',
    text: 'Adding retries.',
    toolUses: [
      {
        tool_use_id: 'u1',
        tool: 'Edit',
        input: { file_path: 'pay.ts', old_string: 'await charge(card)', new_string: 'await retry(() => charge(card), 3)' },
      },
    ],
  },
  { role: 'assistant', text: 'Done: charge now retries three times.', toolUses: [] },
]

const BAND = {
  plugin: 'you-should-know',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 90,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const FINDING =
  '{"title": "A retried charge can bill the customer twice", "detail": "charge() is not idempotent; pass an idempotency key.", "topic": "non-idempotent payment retry"}'

function world(on: On, answer: string, prompts: string[] = []) {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'ysk' } }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('model.complete', (_, e) => {
    prompts.push(e.prompt)

    return {
      value: {
        isAnswered: true,
        text: answer,
        usage: { input_tokens: 900, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  return clock
}

test('reads the last turn and its answer', () => {
  const turn = lastTurn(MESSAGES)
  expect(turn.request).toBe('add retries to the charge call')
  expect(changesSomething(turn)).toBe(true)
  expect(digest(turn, ['old topic'])).toContain('retry(() => charge(card), 3)')
  expect(parseFinding('NONE')).toBeNull()
  expect(parseFinding(`Here you go: ${FINDING}`)?.topic).toBe('non-idempotent payment retry')
})

test('a finding shows above the prompt on every surface, and can be put away', async ($, on) => {
  const prompts: string[] = []
  const clock = world(on, FINDING, prompts)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: 'Done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1)
  await clock.settle()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /bill the customer twice/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'more' })
  expect(await ui.find({ type: 'Text', text: /idempotency key/ })).toBeDefined()
  await ui.press({ key: 'known' })
  expect(await ui.find({ type: 'Text', text: /bill the customer twice/ })).toBeUndefined()
  await ui.unmount()

  // The next review is told the person already knows.
  await $.turn.complete({ answer: 'Done', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(1)
  await clock.settle()
  expect(prompts.at(-1)).toContain('never raise them again: non-idempotent payment retry')
})

test('a quiet reviewer leaves the band empty', async ($, on) => {
  const clock = world(on, 'NONE')
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: 'Done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1)
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'mobile' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})
