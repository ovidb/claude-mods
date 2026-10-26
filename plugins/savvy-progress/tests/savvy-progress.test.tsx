import { expect, mock, test } from 'claude-code/testing'
import type { HookStream, On, TurnStepResult } from 'claude-code'

import { costOf, shortModel } from '../hooks/pricing'

const BAND = {
  plugin: 'savvy-progress',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 90,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'savvy-progress',
  component: 'Pane',
  requestId: 'savvy-progress',
  props: {
    title: 'Helpers',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const STEP: TurnStepResult = {
  turnId: 't',
  index: 0,
  answer: '',
  toolUses: [{ name: 'Grep', input: {} }],
  stopReason: 'tool_use',
  usage: {
    model: 'claude-haiku-5-5',
    input_tokens: 2000,
    output_tokens: 1000,
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

function world(on: On) {
  mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agents-info' } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: {} as never, rateLimits: [], cost: { usd: 1.25 } },
  }))
  let spawned = 0
  on('agent.spawn', () => {
    spawned += 1

    return { model: 'claude-haiku-5-5', agentId: `a${spawned}` }
  })
  on('turn.step', async function* (_, e) {
    return { ...STEP, turnId: e.turnId, index: e.index }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

test('prices and names models', () => {
  expect(shortModel('claude-opus-5-5')).toBe('opus 5.5')
  expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
  expect(shortModel('claude-sonnet-5')).toBe('sonnet 5')
  expect(costOf('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBe(4)
})

test('helpers show up, tally as they finish, on every surface', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'main-1' })
  await $.agent.spawn({ prompt: 'find auth', description: 'Find auth code', subagentType: 'Explore' } as never)
  await $.agent.spawn({ prompt: 'read tests', description: 'Read the tests', subagentType: 'Explore' } as never)
  await drain($.turn.step({ turnId: 's1', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'a1' }))
  await drain($.turn.step({ turnId: 's2', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'a2' }))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Helpers/ }))?.text).toBe('Helpers 0/2')
    expect(await ui.find({ type: 'Text', text: /Find auth code/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 's1', agentId: 'a1', reason: 'answer' })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /Helpers/ }))?.text).toBe('Helpers 1/2')
  expect(await band.find({ type: 'Text', text: /Find auth code/ })).toBeUndefined()
  await band.press({ key: 'hide' })
  expect(await band.find({ type: 'Text', text: /Helpers/ })).toBeUndefined()
  await band.unmount()

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /Read the tests/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /1 steps · 1 tools/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Session total so far \$1.25/ })).toBeDefined()
    await pane.unmount()
  }
})
