// Measures a risky part of a command without running it: read-only find, du
// and git queries, each word passed as an argument and never as shell text.

import type { EngineInterface } from 'claude-code'

import type { Blast } from '../types'
import type { Risk } from './detect'

const SAMPLE = 200
const TIMEOUT_MS = 8000

const REPORT = `
report() {
  if [ -d "$1" ] && [ ! -L "$1" ]; then
    find "$1" \\( -type f -o -type l \\) -print 2>/dev/null | head -n ${SAMPLE} | awk '{print "F\\t" $0}'
    printf 'C\\t%s\\n' "$(find "$1" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d ' ')"
  else
    printf 'F\\t%s\\nC\\t1\\n' "$1"
  fi
  printf 'K\\t%s\\n' "$(du -sk "$1" 2>/dev/null | cut -f1)"
}
enter() { cd -- "$1" 2>/dev/null || { printf 'E\\tthe folder %s does not exist\\n' "$1"; exit 0; }; }
`

const SCRIPTS = {
  rm: `${REPORT}
IFS=
shopt -s nullglob
enter "$1"; shift
for pat in "$@"; do
  case $pat in "~") pat=$HOME;; "~/"*) pat=$HOME/\${pat#"~/"};; esac
  found=0
  for p in $pat; do
    if [ -e "$p" ] || [ -L "$p" ]; then found=1; report "$p"; fi
  done
  [ "$found" = 0 ] && printf 'M\\t%s\\n' "$pat"
done
exit 0`,
  clean: `${REPORT}
enter "$1"; shift
git clean -n "$@" 2>&1 | while IFS= read -r line; do
  case $line in
    "Would remove "*) report "\${line#Would remove }";;
    *) printf 'E\\t%s\\n' "$line";;
  esac
done
exit 0`,
  diff: `${REPORT}
enter "$1"; shift
ref=$1; shift
if [ -n "$ref" ] && ! git rev-parse --verify -q "$ref^{commit}" >/dev/null; then
  printf 'E\\t%s is not a commit git knows\\n' "$ref"; exit 0
fi
git diff --numstat \${ref:+"$ref"} -- "$@" 2>&1 | awk -F'\\t' 'NF>=3 {print "D\\t" $1 "\\t" $2 "\\t" $3; next} {print "E\\t" $0}'
if [ -n "$ref" ] && [ "$ref" != HEAD ]; then
  git log --oneline "$ref..HEAD" 2>/dev/null | awk '{print "L\\t" $0}'
fi
exit 0`,
  push: `
enter() { cd -- "$1" 2>/dev/null || { printf 'E\\tthe folder %s does not exist\\n' "$1"; exit 0; }; }
enter "$1"; shift
while [ $# -ge 2 ]; do
  src=$1; rr=$2; shift 2
  case $rr in *"@CURRENT") rr="\${rr%@CURRENT}$(git rev-parse --abbrev-ref HEAD)";; esac
  if ! git rev-parse --verify -q "$rr" >/dev/null; then
    printf 'N\\t%s is not known here, so nothing to compare (fetch first to be sure)\\n' "$rr"; continue
  fi
  case $rr in "@{u}") shown=$(git rev-parse --abbrev-ref --symbolic-full-name @{u});; *) shown=$rr;; esac
  printf 'R\\t%s\\n' "$shown"
  if [ -z "$src" ]; then git log --oneline "$rr" --not --branches; else git log --oneline "$src..$rr"; fi 2>/dev/null | awk '{print "L\\t" $0}'
done
exit 0`,
  branch: `
enter() { cd -- "$1" 2>/dev/null || { printf 'E\\tthe folder %s does not exist\\n' "$1"; exit 0; }; }
enter "$1"; shift
for b in "$@"; do
  if ! git rev-parse --verify -q "refs/heads/$b" >/dev/null; then printf 'N\\tno branch named %s\\n' "$b"; continue; fi
  printf 'R\\t%s\\n' "$b"
  git log --oneline "refs/heads/$b" --not $(git for-each-ref --format='%(refname)' refs/heads refs/remotes | grep -vx "refs/heads/$b") 2>/dev/null | awk '{print "L\\t" $0}'
done
exit 0`,
  stash: `
enter() { cd -- "$1" 2>/dev/null || { printf 'E\\tthe folder %s does not exist\\n' "$1"; exit 0; }; }
enter "$1"; shift
if [ "$1" = clear ]; then
  git stash list 2>/dev/null | awk '{print "L\\t" $0}'
else
  ref=\${2:-stash@\\{0\\}}
  git rev-parse --verify -q "$ref" >/dev/null || { printf 'E\\tno stash %s\\n' "$ref"; exit 0; }
  printf 'R\\t%s: %s\\n' "$ref" "$(git log -1 --format=%s "$ref")"
  git stash show --numstat "$ref" 2>/dev/null | awk -F'\\t' '{print "D\\t" $1 "\\t" $2 "\\t" $3}'
fi
exit 0`,
} as const

type Parsed = {
  files: string[]
  count: number
  kb: number
  missing: string[]
  changes: { added: number; removed: number; path: string }[]
  commits: string[]
  refs: string[]
  notes: string[]
  errors: string[]
}

function parse(stdout: string): Parsed {
  const out: Parsed = {
    files: [],
    count: 0,
    kb: 0,
    missing: [],
    changes: [],
    commits: [],
    refs: [],
    notes: [],
    errors: [],
  }

  for (const line of stdout.split('\n')) {
    const [tag, ...rest] = line.split('\t')
    const value = rest.join('\t')

    switch (tag) {
      case 'F':
        if (out.files.length < SAMPLE) out.files.push(value)
        break
      case 'C':
        out.count += Number(value) || 0
        break
      case 'K':
        out.kb += Number(value) || 0
        break
      case 'M':
        out.missing.push(value)
        break
      case 'D': {
        const [added = '0', removed = '0', ...path] = rest
        out.changes.push({ added: Number(added) || 0, removed: Number(removed) || 0, path: path.join('\t') })
        break
      }
      case 'L':
        out.commits.push(value)
        break
      case 'R':
        out.refs.push(value)
        break
      case 'N':
        out.notes.push(value)
        break
      case 'E':
        if (value.trim() !== '') out.errors.push(value)
        break
    }
  }

  out.files.sort()

  return out
}

export function resolveDir(dir: string | null, root: string, home: string): string {
  if (dir === null) return root
  if (dir === '~') return home
  if (dir.startsWith('~/')) return `${home}/${dir.slice(2)}`
  if (dir.startsWith('/')) return dir

  return `${root}/${dir}`
}

async function bash($: EngineInterface, script: string, args: string[]) {
  return $.process.run(['bash', '-c', script, 'blast-radius', ...args], { timeoutMs: TIMEOUT_MS })
}

export async function measure($: EngineInterface, risk: Risk, root: string, home: string): Promise<Blast> {
  const dir = resolveDir(risk.dir, root, home)
  const blast: Blast = {
    kind: risk.kind,
    text: risk.text,
    dir,
    count: 0,
    kb: null,
    items: [],
    commits: 0,
    added: 0,
    removed: 0,
    refs: [],
    notes: [],
    isPartial: false,
  }

  if (risk.kind === 'unmeasurable') {
    return { ...blast, error: `could not measure it: ${risk.reason}` }
  }

  let ran
  try {
    switch (risk.kind) {
      case 'rm':
        ran = await bash($, SCRIPTS.rm, [dir, ...risk.targets.map(t => t.text)])
        break
      case 'git-clean':
        ran = await bash($, SCRIPTS.clean, [dir, ...risk.args])
        break
      case 'git-reset':
        ran = await bash($, SCRIPTS.diff, [dir, risk.ref ?? 'HEAD'])
        break
      case 'git-discard':
        ran = await bash($, SCRIPTS.diff, [dir, risk.source ?? '', ...risk.paths])
        break
      case 'git-push-force': {
        const pairs = risk.refspecs.length === 0
          ? ['HEAD', risk.remote === null ? '@{u}' : `${risk.remote}/@CURRENT`]
          : risk.refspecs.flatMap(spec => {
              const clean = spec.replace(/^\+/, '')
              const [src = '', dst = src] = clean.includes(':') ? clean.split(':') : [clean, clean]
              return [src, `${risk.remote ?? 'origin'}/${dst.replace(/^refs\/heads\//, '')}`]
            })
        ran = await bash($, SCRIPTS.push, [dir, ...pairs])
        break
      }
      case 'git-branch-delete':
        ran = await bash($, SCRIPTS.branch, [dir, ...risk.branches])
        break
      case 'git-stash':
        ran = await bash($, SCRIPTS.stash, [dir, risk.action, ...(risk.ref === null ? [] : [risk.ref])])
        break
      case 'find-delete':
        ran = await $.process.run(['find', ...risk.args], { cwd: dir, timeoutMs: TIMEOUT_MS })
        ran = { ...ran, stdout: ran.stdout.split('\n').filter(Boolean).map(l => `F\t${l}\nC\t1`).join('\n') }
        break
    }
  } catch (error) {
    return { ...blast, error: `could not measure it: ${error instanceof Error ? error.message : String(error)}` }
  }

  const got = parse(ran.stdout)
  const isPartial = ran.isStdoutTruncated || (ran.exitCode !== 0 && got.count + got.changes.length + got.commits.length > 0)

  if (got.errors.length > 0 && got.count + got.changes.length + got.commits.length === 0) {
    return { ...blast, error: got.errors[0], notes: got.notes }
  }

  const hasDiff = risk.kind === 'git-reset' || risk.kind === 'git-discard' || (risk.kind === 'git-stash' && risk.action === 'drop')

  return {
    ...blast,
    count: hasDiff ? got.changes.length : got.count + got.commits.length,
    kb: got.kb > 0 ? got.kb : null,
    items: hasDiff ? got.changes.map(c => c.path).slice(0, SAMPLE) : [...got.files, ...got.commits].slice(0, SAMPLE),
    commits: got.commits.length,
    added: got.changes.reduce((n, c) => n + c.added, 0),
    removed: got.changes.reduce((n, c) => n + c.removed, 0),
    refs: got.refs,
    notes: [...got.notes, ...(got.missing.length > 0 ? [`not found: ${got.missing.join(', ')}`] : [])],
    isPartial,
  }
}
