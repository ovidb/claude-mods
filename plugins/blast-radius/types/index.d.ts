export type BlastKind =
  | 'rm'
  | 'git-clean'
  | 'git-reset'
  | 'git-discard'
  | 'git-push-force'
  | 'git-branch-delete'
  | 'git-stash'
  | 'find-delete'
  | 'unmeasurable'

// What one risky part of a command would remove, measured before it runs.
export type Blast = {
  kind: BlastKind
  text: string
  dir: string
  count: number
  kb: number | null
  items: string[]
  commits: number
  added: number
  removed: number
  refs: string[]
  notes: string[]
  isPartial: boolean
  error?: string
}

export type HoldStatus = 'held' | 'proceeded' | 'cancelled'

// One command Blast Radius stopped for a look.
export type Hold = {
  id: string
  command: string
  headline: string
  blasts: Blast[]
  status: HoldStatus
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'blast-radius': { holds: Hold[] }
  }
}
