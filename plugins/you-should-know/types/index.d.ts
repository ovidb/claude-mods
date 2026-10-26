export type NoteStatus = 'new' | 'known' | 'dismissed'

// One thing the reviewer thinks the person should know about a turn.
export type Note = {
  id: string
  turnId: string
  title: string
  detail: string
  topic: string
  status: NoteStatus
  at: number
}

// What the reviewer has cost this session.
export type Spend = { reviews: number; notes: number; inputTokens: number; outputTokens: number }

declare module 'claude-code' {
  interface PluginState {
    'you-should-know': {
      notes: Note[]
      expanded: string
      spend: Spend
      isReviewing: boolean
    }
  }
}
