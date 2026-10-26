import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Blast, Hold, HoldStatus } from '../types'
import { assess } from './detect'
import { measure } from './measure'
import { describe, headline, isWorthHolding, reason, size, tidyPath } from './summary'

const PANE = 'blast-radius'
const STOP = 'Stop it'
const RUN = 'Run it'
const holds = atom({ plugin: 'blast-radius', key: 'holds' } as const, [])

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? ''
}

function setStatus($: EngineInterface, id: string, status: HoldStatus) {
  return update($, holds, list =>
    list.map(h => (h.id === id && h.status === 'held' ? { ...h, status } : h)),
  )
}

const STATUS_WORD: Record<HoldStatus, string> = {
  held: 'waiting',
  proceeded: 'ran',
  cancelled: 'stopped',
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'blast-radius',
      description: 'Show the commands Blast Radius held this session and what each would remove',
    })

    return next(e)
  })

  on('command.run', { command: 'blast-radius' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Blast Radius' })
    const list = await read($, holds)

    if (opened.isPlaced) {
      return { text: 'Blast Radius pane opened.' }
    }
    if (list.length === 0) {
      return { text: 'Blast Radius has held no commands this session.' }
    }

    return {
      text: list
        .slice(-10)
        .map(h => `- ${STATUS_WORD[h.status]}: \`${h.command}\` ${h.headline}`)
        .join('\n'),
    }
  })

  // The guard. It runs at tool.call, ahead of every permission check, so a
  // policy plugin that answers tool.check first cannot pass it by. A command
  // that deletes or discards work is measured and put to the person; it runs
  // only on an explicit yes. It can stop a call, never allow one the
  // session's own permissions would refuse.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const risks = assess(e.command)
    if (risks.length === 0) {
      return next(e)
    }

    const [root, where] = await Promise.all([$.session.cwd(), home($)])
    const blasts: Blast[] = []
    for (const risk of risks) {
      blasts.push(await measure($, risk, root, where))
    }
    if (!blasts.some(isWorthHolding)) {
      return next(e)
    }

    const hold: Hold = {
      id: e.tool_use_id,
      command: e.command,
      headline: headline(blasts),
      blasts,
      status: 'held',
      at: await $.clock.now(),
    }
    await update($, holds, list => [...list.filter(h => h.id !== hold.id), hold].slice(-30))

    const said = reason(blasts, where)
    const answer = await $.ui
      .ask(`${said} Run it?`, { options: [STOP, RUN], header: 'Blast Radius' })
      .catch(() => STOP)

    if (answer !== RUN) {
      await setStatus($, hold.id, 'cancelled')
      return { deny: `${said} The person chose not to run it. Do not try it again without asking them.` }
    }

    await setStatus($, hold.id, 'proceeded')
    return next(e)
  }).catch(($, e, next) =>
    next.called || assess(e.command).length === 0
      ? next(e)
      : { deny: 'Blast Radius could not measure this command, so it stopped it. Ask the person before trying again.' },
  )

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const list = await read($, holds)
      for (const h of list.filter(one => one.status === 'held')) {
        await setStatus($, h.id, 'cancelled')
      }
    }

    return next(e)
  })

  // The band above the prompt while a command waits on the person. Narrow
  // surfaces (the phone) get fewer paths and shorter lines.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, holds)
    const hold = [...list].reverse().find(h => h.status === 'held')

    if (hold === undefined || e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const where = await home($)
    const isNarrow = e.surface === 'mobile' || e.props.bodyColumns < 60
    const room = Math.max(1, Math.min(isNarrow ? 3 : 8, e.props.maxRows - 4))
    const shown = hold.blasts.filter(isWorthHolding)
    const items = shown.flatMap(b => b.items)
    const total = shown.reduce((n, b) => n + Math.max(b.count, b.items.length), 0)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="error" paddingX={1}>
        <Text color="error" bold>
          Blast Radius held a command
        </Text>
        {shown.map(b => (
          <Text wrap={isNarrow ? 'wrap' : 'truncate-end'}>
            <Text bold>{b.text}</Text> {describe(b)}
            {isNarrow ? '' : ` in ${tidyPath(b.dir, where)}`}
          </Text>
        ))}
        {items.slice(0, room).map(p => (
          <Text dimColor wrap="truncate-middle">
            {'  '}
            {tidyPath(p, where)}
          </Text>
        ))}
        {total > room && items.length > 0 && (
          <Text dimColor>
            {'  '}and {total - Math.min(room, items.length)} more
          </Text>
        )}
        <Box flexDirection="row" gap={1}>
          <Text color="warning">Answer the Blast Radius question. Stop it is the safe choice.</Text>
          {!isNarrow && (
            <Button key="details" plain label="[details]" onPress={() => void $.ui.open({ id: PANE, title: 'Blast Radius' })} />
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, holds)
    const where = await home($)
    const latest = [...list].reverse()

    if (latest.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No commands held this session.</Text>
          <Text dimColor>Risky deletes, git resets, force pushes and cleans are measured here before they run.</Text>
        </Box>
      )
    }

    const [first, ...rest] = latest

    return (
      <Box flexDirection="column" gap={1}>
        {first !== undefined && (
          <Box flexDirection="column">
            <Text bold color={first.status === 'held' ? 'error' : 'text'}>
              {STATUS_WORD[first.status]}: {first.command}
            </Text>
            {first.blasts.filter(isWorthHolding).map(b => (
              <Box flexDirection="column">
                <Text>
                  {describe(b)} in {tidyPath(b.dir, where)}
                  {b.kb !== null ? `, ${size(b.kb)}` : ''}
                </Text>
                {b.items.map(p => (
                  <Text dimColor wrap="truncate-middle">
                    {'  '}
                    {tidyPath(p, where)}
                  </Text>
                ))}
                {b.count > b.items.length && <Text dimColor>{'  '}and {b.count - b.items.length} more</Text>}
                {b.notes.map(n => (
                  <Text color="warning">{n}</Text>
                ))}
              </Box>
            ))}
          </Box>
        )}
        {rest.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Earlier</Text>
            {rest.map(h => (
              <Text dimColor wrap="truncate-end">
                {STATUS_WORD[h.status]}: {h.command}, {h.headline}
              </Text>
            ))}
          </Box>
        )}
        <Button key="clear" label="Clear history" onPress={() => void update($, holds, l => l.filter(h => h.status === 'held'))} />
      </Box>
    )
  })
}
