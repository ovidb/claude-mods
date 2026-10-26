export type AgentState = 'running' | 'done' | 'failed' | 'stopped'

// One subagent's run, as far as this session has seen it.
export type AgentRun = {
  id: string
  description: string
  type: string
  model: string
  state: AgentState
  batch: string
  startedAt: number
  endedAt: number | null
  steps: number
  tools: number
  lastTool: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  contextTokens: number
  costUsd: number
}

// The main loop's own spend, kept so the panel can show the split.
export type MainSpend = { steps: number; costUsd: number; model: string }

declare module 'claude-code' {
  interface PluginState {
    'savvy-progress': {
      agents: AgentRun[]
      main: MainSpend
      batch: string
      isBandHidden: boolean
    }
  }
}
