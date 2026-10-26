// Reads a shell command and names the parts that delete or discard work.
// Pure: no `$`, so the tests can run it directly.

export type Word = { text: string; isSafe: boolean }

type Base = { text: string; dir: string | null }

export type Risk = Base &
  (
    | { kind: 'rm'; targets: Word[]; isRecursive: boolean }
    | { kind: 'git-clean'; args: string[] }
    | { kind: 'git-reset'; ref: string | null }
    | { kind: 'git-discard'; paths: string[]; source: string | null }
    | { kind: 'git-push-force'; remote: string | null; refspecs: string[] }
    | { kind: 'git-branch-delete'; branches: string[] }
    | { kind: 'git-stash'; action: 'drop' | 'clear'; ref: string | null }
    | { kind: 'find-delete'; args: string[] }
    | { kind: 'unmeasurable'; reason: string }
  )

const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '\n', '(', ')']
const GLOB = /[*?[]/
const PREFIXES = new Set(['sudo', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice'])

// Splits a command into segments of words. A word is unsafe to measure when
// any of it would expand at run time ($, backticks, process substitution).
export function tokenize(command: string): Word[][] {
  const segments: Word[][] = [[]]
  let word = ''
  let hasWord = false
  let isSafe = true
  let i = 0

  const push = () => {
    if (hasWord) {
      segments[segments.length - 1]!.push({ text: word, isSafe })
    }
    word = ''
    hasWord = false
    isSafe = true
  }

  while (i < command.length) {
    const ch = command[i]!
    const isRedirect = ch === '&' && (command[i - 1] === '>' || command[i + 1] === '>')
    const op = isRedirect ? undefined : OPERATORS.find(o => command.startsWith(o, i))

    if (op !== undefined) {
      push()
      if (op !== '(' && op !== ')') {
        segments.push([])
      }
      i += op.length
      continue
    }
    if (ch === ' ' || ch === '\t') {
      push()
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') {
        word += command[i + 1]
        hasWord = true
      }
      i += 2
      continue
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end === -1 ? command.length : end
      word += command.slice(i + 1, stop)
      hasWord = true
      i = stop + 1
      continue
    }
    if (ch === '"') {
      i += 1
      hasWord = true
      while (i < command.length && command[i] !== '"') {
        const c = command[i]!
        if (c === '$' || c === '`') {
          isSafe = false
        }
        if (c === '\\' && i + 1 < command.length) {
          word += command[i + 1]
          i += 2
          continue
        }
        word += c
        i += 1
      }
      i += 1
      continue
    }
    if (ch === '$' || ch === '`' || ((ch === '<' || ch === '>') && command[i + 1] === '(')) {
      isSafe = false
    }
    word += ch
    hasWord = true
    i += 1
  }
  push()

  return segments.filter(s => s.length > 0)
}

// Drops redirections, env assignments and wrappers like `sudo`.
function commandWords(words: Word[]): Word[] {
  const out: Word[] = []
  let i = 0

  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!.text)) {
    i += 1
  }
  while (i < words.length && PREFIXES.has(words[i]!.text)) {
    i += 1
    while (i < words.length && words[i]!.text.startsWith('-')) {
      i += 1
    }
  }
  for (; i < words.length; i += 1) {
    const w = words[i]!
    if (/^\d*(>>?|<|>&|&>)$/.test(w.text)) {
      i += 1
      continue
    }
    if (/^\d*(>>?|<|&>)./.test(w.text)) {
      continue
    }
    out.push(w)
  }

  return out
}

function joinDir(dir: string | null, next: string): string {
  if (next.startsWith('/') || next.startsWith('~') || dir === null) {
    return next
  }

  return `${dir}/${next}`
}

function splitFlags(args: Word[]): { flags: string[]; rest: Word[] } {
  const flags: string[] = []
  const rest: Word[] = []
  let isPastFlags = false

  for (const a of args) {
    if (!isPastFlags && a.text === '--') {
      isPastFlags = true
    } else if (!isPastFlags && a.text.startsWith('-') && a.text.length > 1) {
      flags.push(a.text)
    } else {
      rest.push(a)
    }
  }

  return { flags, rest }
}

function hasShortFlag(flags: string[], letter: string): boolean {
  return flags.some(f => !f.startsWith('--') && f.slice(1).includes(letter))
}

function assessRm(base: Base, args: Word[]): Risk | null {
  const { flags, rest } = splitFlags(args)
  const isRecursive =
    hasShortFlag(flags, 'r') || hasShortFlag(flags, 'R') || flags.includes('--recursive')
  const hasGlob = rest.some(w => GLOB.test(w.text))

  if (rest.length === 0 || (!isRecursive && !hasGlob)) {
    return null
  }

  return { ...base, kind: 'rm', targets: rest, isRecursive }
}

function assessGit(base: Base, args: Word[]): Risk | null {
  let dir = base.dir
  let i = 0

  while (i < args.length && args[i]!.text.startsWith('-')) {
    if (args[i]!.text === '-C' && i + 1 < args.length) {
      if (!args[i + 1]!.isSafe) {
        return { ...base, kind: 'unmeasurable', reason: 'its folder is only known at run time' }
      }
      dir = joinDir(dir, args[i + 1]!.text)
      i += 2
    } else if (args[i]!.text === '-c' && i + 1 < args.length) {
      i += 2
    } else {
      i += 1
    }
  }

  const sub = args[i]?.text
  const rest = args.slice(i + 1)
  const words = rest.map(w => w.text)
  const at = { ...base, dir }

  if (rest.some(w => !w.isSafe)) {
    const isRisky = assessGit(at, args.map(w => ({ ...w, isSafe: true }))) !== null

    return isRisky
      ? { ...at, kind: 'unmeasurable', reason: 'part of it is only known at run time' }
      : null
  }

  switch (sub) {
    case 'clean': {
      const { flags, rest: paths } = splitFlags(rest)
      const isForced = hasShortFlag(flags, 'f') || flags.includes('--force')
      if (!isForced) {
        return null
      }
      const short = flags.filter(f => !f.startsWith('--')).join('')
      const letters = [...new Set(short.replace(/[^dxX]/g, ''))]
      const passed = letters.length > 0 ? [`-${letters.join('')}`] : []

      return { ...at, kind: 'git-clean', args: [...passed, '--', ...paths.map(p => p.text)] }
    }
    case 'reset': {
      if (!words.includes('--hard')) {
        return null
      }
      const ref = words.find(w => !w.startsWith('-')) ?? null

      return { ...at, kind: 'git-reset', ref }
    }
    case 'checkout': {
      const dash = words.indexOf('--')
      if (dash !== -1) {
        const source = words.slice(0, dash).find(w => !w.startsWith('-')) ?? null

        return { ...at, kind: 'git-discard', paths: words.slice(dash + 1), source }
      }
      if (words.length === 1 && (words[0] === '.' || words[0] === ':/')) {
        return { ...at, kind: 'git-discard', paths: words, source: null }
      }
      if (words.includes('-f') || words.includes('--force')) {
        return { ...at, kind: 'git-reset', ref: null }
      }

      return null
    }
    case 'restore': {
      const { flags, rest: paths } = splitFlags(rest)
      const isStagedOnly =
        (flags.includes('--staged') || flags.includes('-S')) &&
        !flags.includes('--worktree') &&
        !flags.includes('-W')
      if (isStagedOnly || paths.length === 0) {
        return null
      }
      const sourceFlag = flags.find(f => f.startsWith('--source=') || f.startsWith('-s'))
      const source = sourceFlag?.replace(/^--source=|^-s/, '') || null

      return { ...at, kind: 'git-discard', paths: paths.map(p => p.text), source }
    }
    case 'push': {
      const { flags, rest: positional } = splitFlags(rest)
      const refspecs = positional.slice(1).map(p => p.text)
      const isForced =
        flags.some(f => f === '-f' || f === '--force' || f.startsWith('--force-with-lease') || f === '--mirror') ||
        hasShortFlag(flags.filter(f => !f.startsWith('--')), 'f') ||
        refspecs.some(r => r.startsWith('+'))
      if (!isForced) {
        return null
      }

      return { ...at, kind: 'git-push-force', remote: positional[0]?.text ?? null, refspecs }
    }
    case 'branch': {
      const { flags, rest: names } = splitFlags(rest)
      const isForceDelete =
        flags.includes('-D') ||
        ((flags.includes('-d') || flags.includes('--delete')) && (flags.includes('-f') || flags.includes('--force')))
      if (!isForceDelete || names.length === 0) {
        return null
      }

      return { ...at, kind: 'git-branch-delete', branches: names.map(n => n.text) }
    }
    case 'stash': {
      const action = words[0]
      if (action === 'clear') {
        return { ...at, kind: 'git-stash', action: 'clear', ref: null }
      }
      if (action === 'drop') {
        return { ...at, kind: 'git-stash', action: 'drop', ref: words.slice(1).find(w => !w.startsWith('-')) ?? null }
      }

      return null
    }
    default:
      return null
  }
}

function assessFind(base: Base, args: Word[]): Risk | null {
  const words = args.map(w => w.text)
  const execAt = words.findIndex(
    (w, i) => (w === '-exec' || w === '-execdir') && /^(\/bin\/)?rm$/.test(words[i + 1] ?? ''),
  )
  const isDeleting = words.includes('-delete') || execAt !== -1

  if (!isDeleting) {
    return null
  }
  if (args.some(w => !w.isSafe)) {
    return { ...base, kind: 'unmeasurable', reason: 'part of it is only known at run time' }
  }

  const kept: string[] = []
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!
    if (w === '-delete') {
      kept.push('-print')
      continue
    }
    if ((w === '-exec' || w === '-execdir') && i === execAt) {
      let end = i + 1
      while (end < words.length && words[end] !== ';' && words[end] !== '+') {
        end += 1
      }
      kept.push('-print')
      i = end
      continue
    }
    kept.push(w)
  }

  const runsOther = kept.some(w => /^-(exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(w))
  if (runsOther) {
    return { ...base, kind: 'unmeasurable', reason: 'it runs other commands on what it finds' }
  }

  return { ...base, kind: 'find-delete', args: kept }
}

// Every risky part of `command`, in order. `cd` steps carry over to the parts
// after them, so `cd app && rm -rf dist` is measured in `app`.
export function assess(command: string): Risk[] {
  const risks: Risk[] = []
  let dir: string | null = null
  let isDirKnown = true

  for (const segment of tokenize(command)) {
    const words = commandWords(segment)
    const name = words[0]?.text.replace(/^.*\//, '')
    const args = words.slice(1)
    const text = segment.map(w => w.text).join(' ')

    if (name === 'cd' || name === 'pushd') {
      const target = args.find(a => !a.text.startsWith('-'))
      if (target === undefined || !target.isSafe || target.text === '-') {
        isDirKnown = false
      } else {
        dir = joinDir(dir, target.text)
      }
      continue
    }

    const base: Base = { text, dir }
    let risk: Risk | null = null

    if (name === 'rm') {
      risk = assessRm(base, args)
      if (risk?.kind === 'rm' && risk.targets.some(t => !t.isSafe)) {
        risk = { ...base, kind: 'unmeasurable', reason: 'what it deletes is only known at run time' }
      }
    } else if (name === 'git') {
      risk = assessGit(base, args)
    } else if (name === 'find') {
      risk = assessFind(base, args)
    } else if (name === 'xargs' && args.some(a => /^(\/bin\/)?rm$/.test(a.text))) {
      risk = { ...base, kind: 'unmeasurable', reason: 'xargs decides what to delete at run time' }
    } else if (name === 'rsync' && args.some(a => a.text.startsWith('--delete'))) {
      risk = { ...base, kind: 'unmeasurable', reason: 'rsync --delete removes whatever the source lacks' }
    }

    if (risk !== null) {
      risks.push(
        !isDirKnown && risk.kind !== 'unmeasurable'
          ? { ...base, kind: 'unmeasurable', reason: 'the folder it runs in is only known at run time' }
          : risk,
      )
    }
  }

  return risks
}
