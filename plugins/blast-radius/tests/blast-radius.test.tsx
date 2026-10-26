import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { assess } from '../hooks/detect'

const MEASURED = ['F\tbuild/a.js', 'F\tbuild/b.js', 'F\tbuild/sub/c.css', 'C\t3', 'K\t12', ''].join('\n')

// `answer` stands for the person: called with each question Blast Radius asks.
function world(on: On, answer: (question: string) => Promise<string> | string = () => 'Stop it') {
  mock.env(on, { HOME: '/Users/me' })
  mock.clock(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/Users/me/proj' }))
  on('command.register', () => ({ value: { command: 'blast-radius' } }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: MEASURED, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('tool.call', async (_, e) => {
    if (e.tool !== 'AskUserQuestion') {
      return { result: {} }
    }
    const question = e.questions[0]?.question ?? ''

    return { result: { questions: e.questions, answers: { [question]: await answer(question) } } }
  })
  // Stands for the engine's own drawing when the band steps aside.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

const BAND = {
  plugin: 'blast-radius',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

describe('reading commands', () => {
  test('names the risky parts and passes the rest', () => {
    expect(assess('npm test && git status').length).toBe(0)
    expect(assess('rm notes.txt').length).toBe(0)
    expect(assess('rm -rf build')[0]?.kind).toBe('rm')
    expect(assess('cd app && rm -rf dist')[0]?.dir).toBe('app')
    expect(assess('git push --force-with-lease')[0]?.kind).toBe('git-push-force')
    expect(assess('git push origin +main')[0]?.kind).toBe('git-push-force')
    expect(assess('git push origin main').length).toBe(0)
    expect(assess('git reset --soft HEAD~1').length).toBe(0)
    expect(assess('git clean -n').length).toBe(0)
    expect(assess('rm -rf "$OUT"')[0]?.kind).toBe('unmeasurable')
    expect(assess('find . -name x -exec sh -c "rm {}" \\;').length).toBe(0)
  })
})

test('a risky command is asked about, and stopped unless the person says run it', async ($, on) => {
  const asked: string[] = []
  const seen: Record<string, string | undefined> = {}
  world(on, async question => {
    asked.push(question)
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      seen[surface] = (await ui.find({ type: 'Text', text: /would delete/ }))?.text
      await ui.unmount()
    }

    return 'Stop it'
  })

  await $.session.start({ cwd: '/Users/me/proj', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })

  expect(asked[0]).toContain('would delete 3 files (12 KB)')
  expect(asked[0]).toContain('build/a.js')
  expect(ran.deny).toContain('chose not to run it')
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile']) {
    expect(seen[surface]).toContain('would delete 3 files')
  }

  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: /would delete/ })).toBeUndefined()
  await after.unmount()
})

test('a yes runs it, and a harmless command is never asked about', async ($, on) => {
  const asked: string[] = []
  world(on, question => {
    asked.push(question)

    return 'Run it'
  })

  await $.session.start({ cwd: '/Users/me/proj', surface: 'terminal', isInteractive: true })
  const harmless = await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  const risky = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })

  expect(harmless.deny).toBeUndefined()
  expect(risky.deny).toBeUndefined()
  expect(asked).toHaveLength(1)
})
