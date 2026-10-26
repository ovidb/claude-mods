import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Note, NoteStatus } from '../types'
import { SYSTEM, changesSomething, digest, lastTurn, parseFinding } from './digest'

const notes = atom({ plugin: 'you-should-know', key: 'notes' } as const, [])
const expanded = atom({ plugin: 'you-should-know', key: 'expanded' } as const, '')
const spend = atom({ plugin: 'you-should-know', key: 'spend' } as const, {
  reviews: 0,
  notes: 0,
  inputTokens: 0,
  outputTokens: 0,
})
const isReviewing = atom({ plugin: 'you-should-know', key: 'isReviewing' } as const, false)

const KNOWN = 'known-topics'
const ENABLED = 'enabled'

async function knownTopics($: EngineInterface): Promise<string[]> {
  const value = await $.store.get(KNOWN)

  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : []
}

async function isEnabled($: EngineInterface): Promise<boolean> {
  return (await $.store.get(ENABLED)) !== false
}

function mark($: EngineInterface, id: string, status: NoteStatus) {
  return update($, notes, list => list.map(n => (n.id === id ? { ...n, status } : n)))
}

type Settings = { model: string; isEveryTurn: boolean; shouldNotify: boolean }

async function review($: EngineInterface, settings: Settings, turnId: string, isAsked: boolean): Promise<string> {
  const turn = lastTurn(await $.session.messages())

  if (turn.messages.length === 0) {
    return 'There is no finished turn to review yet.'
  }
  if (!isAsked && !settings.isEveryTurn && !changesSomething(turn)) {
    return 'That turn changed nothing, so it was not reviewed.'
  }

  await update($, isReviewing, () => true)
  try {
    const answer = await $.model.complete({
      model: settings.model,
      system: SYSTEM,
      prompt: digest(turn, await knownTopics($)),
      maxTokens: 400,
      timeoutMs: 45_000,
    })
    await update($, spend, s => ({
      ...s,
      reviews: s.reviews + 1,
      inputTokens: s.inputTokens + (answer.usage?.input_tokens ?? 0),
      outputTokens: s.outputTokens + (answer.usage?.output_tokens ?? 0),
    }))

    if (!answer.isAnswered) {
      return `The reviewer did not answer (${answer.reason}).`
    }

    const finding = parseFinding(answer.text)
    if (finding === null) {
      return 'Nothing worth flagging in that turn.'
    }

    const at = await $.clock.now()
    const note: Note = { id: `${turnId}:${at.toString(36)}`, turnId, ...finding, status: 'new', at }
    await update($, notes, list => [...list, note].slice(-40))
    await update($, spend, s => ({ ...s, notes: s.notes + 1 }))

    // A notice row keeps the note in the transcript (the model never reads
    // one), so it is still there when you scroll back or open the session
    // on another device.
    await $.session
      .append({
        message: {
          type: 'system',
          content: [{ type: 'text', text: `You should know: ${note.title}${note.detail ? ` ${note.detail}` : ''}` }],
        },
      })
      .catch(() => undefined)
    if (settings.shouldNotify) {
      await $.ui.notify(note.title, { title: 'You should know' }).catch(() => undefined)
    }

    return `You should know: ${note.title}`
  } finally {
    await update($, isReviewing, () => false)
  }
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    model: typeof options.model === 'string' ? options.model : 'haiku',
    isEveryTurn: options.reviewWhen === 'every-turn',
    shouldNotify: options.notify !== false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ysk',
      description: 'You Should Know: on, off, now (review the last turn), or history',
      argumentHint: 'on | off | now | history',
    })

    return next(e)
  })

  on('command.run', { command: 'ysk' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'on' || arg === 'off') {
      await $.store.set(ENABLED, arg === 'on')
      return { text: `You Should Know is ${arg}.` }
    }
    if (arg === 'now') {
      return { text: await review($, settings, 'asked', true) }
    }
    if (arg === 'forget') {
      await $.store.set(KNOWN, [])
      return { text: 'Forgot every topic marked as known.' }
    }

    const list = await read($, notes)
    const s = await read($, spend)
    const state = (await isEnabled($)) ? 'on' : 'off'
    const head = `You Should Know is ${state}, reviewing with ${settings.model}. ${s.reviews} reviews this session, ${s.notes} notes, ${s.inputTokens + s.outputTokens} tokens.`

    if (arg !== 'history' || list.length === 0) {
      return { text: list.length === 0 ? `${head} No notes yet.` : `${head} Type /ysk history to list them.` }
    }

    return {
      text: [head, '', ...list.map(n => `- ${n.title}${n.detail ? `: ${n.detail}` : ''}${n.status === 'known' ? ' (knew it)' : ''}`)].join('\n'),
    }
  })

  // Reviews run on a timer so the turn ends at once; the note lands a few
  // seconds later.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer' && (await isEnabled($))) {
      const turnId = e.turnId
      $.clock.after(0, () => {
        void review($, settings, turnId, false).catch(() => update($, isReviewing, () => false))
      })
    }

    return next(e)
  })

  // A new prompt means the person moved on: old notes leave the band.
  on('prompt.submit', async ($, e, next) => {
    await update($, notes, list => list.map(n => (n.status === 'new' ? { ...n, status: 'dismissed' } : n)))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, notes)
    const note = [...list].reverse().find(n => n.status === 'new')
    const isBusy = await read($, isReviewing)

    if (e.props.hasSurvey || (note === undefined && !isBusy)) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)

    if (note === undefined) {
      return <Text dimColor>You Should Know is reading that turn…</Text>
    }

    const isOpen = (await read($, expanded)) === note.id
    const isNarrow = e.surface === 'mobile' || e.props.bodyColumns < 60

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
        <Text wrap="wrap">
          <Text color="warning" bold>
            You should know:
          </Text>{' '}
          {note.title}
        </Text>
        {isOpen && note.detail !== '' && <Text wrap="wrap">{note.detail}</Text>}
        <Box flexDirection="row" gap={isNarrow ? 1 : 2} flexWrap="wrap">
          {!isOpen && note.detail !== '' && (
            <Button key="more" label={isNarrow ? 'More' : 'Learn more'} onPress={() => void update($, expanded, () => note.id)} />
          )}
          {isOpen && (
            <Button
              key="ask"
              label={isNarrow ? 'Ask Claude' : 'Ask Claude about it'}
              onPress={() => {
                void mark($, note.id, 'dismissed')
                void $.prompt.submit({ text: `About this: ${note.title} ${note.detail} Is it a real problem here, and what should we do?`, asUser: true })
              }}
            />
          )}
          <Button
            key="known"
            label={isNarrow ? 'Knew it' : 'Knew this already'}
            onPress={() => {
              void mark($, note.id, 'known')
              void knownTopics($).then(t => $.store.set(KNOWN, [...t.filter(x => x !== note.topic), note.topic].slice(-50)))
            }}
          />
          <Button key="dismiss" role="dismiss" label="Dismiss" onPress={() => void mark($, note.id, 'dismissed')} />
        </Box>
      </Box>
    )
  })
}
