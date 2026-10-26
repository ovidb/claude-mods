// List prices in US dollars per million tokens, from Anthropic's published
// table (cached 2026-10-06). Cache writes are priced at 1.25x input, the
// five-minute rate. Partner platforms (Bedrock, Vertex) price differently,
// so every figure here is an estimate, never a bill.

import type { ModelUsage } from 'claude-code'

type Price = { input: number; output: number; cacheRead: number }

const PRICES: [RegExp, Price][] = [
  [/fable-5-1|mythos-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 1 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-(5|4-[5-9])/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/opus/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1 }],
  [/haiku/, { input: 0.8, output: 4, cacheRead: 0.08 }],
]

const FALLBACK: Price = { input: 2, output: 10, cacheRead: 0.2 }

export function priceOf(model: string): Price {
  const id = model.toLowerCase()

  return PRICES.find(([pattern]) => pattern.test(id))?.[1] ?? FALLBACK
}

export function costOf(model: string, usage: ModelUsage): number {
  const p = priceOf(model)

  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      usage.cache_read_input_tokens * p.cacheRead +
      usage.cache_creation_input_tokens * p.input * 1.25) /
    1_000_000
  )
}

export function dollars(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 10) return `$${usd.toFixed(2)}`

  return `$${usd.toFixed(1)}`
}

// `claude-haiku-5-5` reads as `haiku 5.5`.
export function shortModel(model: string): string {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(model.toLowerCase())

  return m === null ? model : `${m[1]} ${m[2]}${m[3] !== undefined && m[3].length === 1 ? `.${m[3]}` : ''}`
}
