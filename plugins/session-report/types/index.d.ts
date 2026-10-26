export type Outcome = 'ok' | 'error' | 'denied'

export type TurnRow = {
  id: string
  prompt: string
  startedAt: number
  durationMs: number | null
  model: string
  steps: number
  tools: number
  costUsd: number
  helperCostUsd: number
  isAborted: boolean
}

export type ToolRow = {
  id: string
  turn: string
  tool: string
  summary: string
  file: string | null
  added: number
  removed: number
  agentId: string | null
  at: number
  outcome: Outcome | 'running'
  reason: string | null
}

export type HelperRow = {
  id: string
  turn: string
  description: string
  type: string
  model: string
  steps: number
  costUsd: number
  startedAt: number
  endedAt: number | null
}

export type NoteRow = { at: number; source: string; text: string }

export type Journal = {
  startedAt: number
  turns: TurnRow[]
  tools: ToolRow[]
  helpers: HelperRow[]
  notes: NoteRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-report': { journal: Journal; pending: string; lastReport: string }
  }
}
