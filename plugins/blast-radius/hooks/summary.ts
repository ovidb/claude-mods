// Turns measurements into the words the permission prompt and the band show.

import type { Blast } from '../types'

export function size(kb: number | null): string {
  if (kb === null) return ''
  if (kb < 1024) return `${kb} KB`
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`

  return `${(kb / 1024 / 1024).toFixed(1)} GB`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function atLeast(blast: Blast, n: number): string {
  return blast.isPartial ? `at least ${n}` : String(n)
}

// One sentence for one part, starting with what it would do.
export function describe(blast: Blast): string {
  if (blast.error !== undefined) {
    return blast.error
  }

  const weight = blast.kb !== null ? ` (${size(blast.kb)})` : ''
  const lines = blast.added + blast.removed > 0 ? `, +${blast.added} -${blast.removed} lines` : ''

  switch (blast.kind) {
    case 'rm':
    case 'find-delete':
      return `would delete ${atLeast(blast, blast.count)} ${blast.count === 1 ? 'file' : 'files'}${weight}`
    case 'git-clean':
      return `would delete ${atLeast(blast, blast.count)} untracked ${blast.count === 1 ? 'file' : 'files'}${weight}`
    case 'git-reset': {
      const moved = blast.commits > 0 ? ` and move the branch off ${plural(blast.commits, 'commit')}` : ''
      return `would throw away uncommitted changes in ${plural(blast.count, 'file')}${lines}${moved}`
    }
    case 'git-discard':
      return `would throw away changes in ${plural(blast.count, 'file')}${lines}`
    case 'git-push-force': {
      const where = blast.refs.length > 0 ? ` on ${blast.refs.join(', ')}` : ''
      if (blast.refs.length === 0) {
        return `would force-push, but ${blast.notes[0] ?? 'there is no remote branch to compare with'}`
      }
      return blast.count === 0
        ? `would replace${where}, losing no commits you lack locally (as of your last fetch)`
        : `would overwrite ${plural(blast.count, 'commit')}${where} that you do not have locally (as of your last fetch)`
    }
    case 'git-branch-delete':
      return `would delete ${blast.refs.join(', ') || 'the branch'} with ${plural(blast.count, 'commit')} found on no other branch`
    case 'git-stash':
      return blast.refs.length > 0
        ? `would drop ${blast.refs[0]} (${plural(blast.count, 'file')}${lines})`
        : blast.count === 1
          ? 'would drop your only stash'
          : `would drop all ${blast.count} stashes`
    case 'unmeasurable':
      return blast.error ?? 'could not measure it'
  }
}

// Whether a measurement is worth stopping for. A delete of nothing is not;
// anything we could not measure is.
export function isWorthHolding(blast: Blast): boolean {
  if (blast.error !== undefined) return true
  if (blast.kind === 'git-push-force') return true

  return blast.count > 0
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

// The ask the permission prompt shows: one line per risky part, then the
// first few paths. Kept short so it reads on a phone too.
export function reason(blasts: Blast[], home: string): string {
  const shown = blasts.filter(isWorthHolding)
  const parts = shown.map(b => `\`${shorten(b.text, 60)}\` ${describe(b)}`)
  const items = shown.flatMap(b => b.items).slice(0, 4).map(p => tidyPath(p, home))
  const more = shown.reduce((n, b) => n + b.items.length, 0) - items.length
  const list = items.length > 0 ? `: ${items.join(', ')}${more > 0 ? `, and ${more} more` : ''}` : ''

  return `Blast Radius: ${parts.join('; ')}${list}.`
}

export function headline(blasts: Blast[]): string {
  return blasts.filter(isWorthHolding).map(describe).join('; ')
}

export function tidyPath(path: string, home: string): string {
  return home !== '' && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}
