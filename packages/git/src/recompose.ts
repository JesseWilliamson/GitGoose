/**
 * Recompose: rebuild a run of commits as a different set of commits with the same end result.
 *
 * The combined change (`git diff base newest`) is cut into units: each hunk of a text file, or a
 * whole file when it has no hunks (binary, mode change, empty file). A plan assigns every unit to
 * exactly one new commit. Building commit N applies the units of commits 1..N to the base, so the
 * last one always reproduces the newest original tree, which is what makes the rewrite safe.
 *
 * Pure text functions here; Repo.recompose does the git work.
 */

export interface RecomposeUnit {
  /** "U1", "U2", … in diff order; stable for the same diff. */
  id: string
  path: string
  /** The file's header lines (diff --git, mode lines, ---/+++). */
  header: string
  /** One hunk ("@@ …" and its lines), or '' when the header is the whole change. */
  body: string
  /** Everything after the header for a binary patch ("GIT binary patch" …). */
  binary: boolean
  added: number
  removed: number
}

/** Split `git diff --binary` output (no rename detection) into units. */
export function splitUnits(diffText: string): RecomposeUnit[] {
  const units: RecomposeUnit[] = []
  const sections = diffText.split(/^(?=diff --git )/m).filter((s) => s.startsWith('diff --git '))
  for (const section of sections) {
    const lines = section.replace(/\n$/, '').split('\n')
    const path = pathOf(lines)
    const firstHunk = lines.findIndex((l) => l.startsWith('@@'))
    const binaryAt = lines.findIndex((l) => l === 'GIT binary patch' || l.startsWith('Binary files '))
    if (firstHunk < 0 || (binaryAt >= 0 && binaryAt < firstHunk)) {
      units.push({ id: '', path, header: lines.join('\n'), body: '', binary: binaryAt >= 0, added: 0, removed: 0 })
      continue
    }
    const header = lines.slice(0, firstHunk).join('\n')
    let start = firstHunk
    for (let i = firstHunk + 1; i <= lines.length; i++) {
      if (i === lines.length || lines[i]!.startsWith('@@')) {
        const hunk = lines.slice(start, i)
        units.push({
          id: '', path, header, body: hunk.join('\n'), binary: false,
          added: hunk.filter((l) => l.startsWith('+')).length,
          removed: hunk.filter((l) => l.startsWith('-')).length,
        })
        start = i
      }
    }
  }
  units.forEach((u, i) => (u.id = `U${i + 1}`))
  return units
}

/**
 * The path from a file's header. Without rename detection both sides name the same file, so
 * "diff --git a/<p> b/<p>" is "a/" + p + " b/" + p: p is the first (length - 5) / 2 characters
 * after "diff --git a/", whatever spaces it contains.
 */
function pathOf(lines: string[]): string {
  const rest = lines[0]!.slice('diff --git a/'.length)
  const unquoted = rest.startsWith('"') ? null : rest
  if (unquoted) return unquoted.slice(0, (unquoted.length - 3) / 2)
  const plus = lines.find((l) => l.startsWith('+++ b/'))
  const minus = lines.find((l) => l.startsWith('--- a/'))
  return (plus ?? minus ?? rest).replace(/^(\+\+\+ b\/|--- a\/)/, '')
}

/**
 * A patch with just these units, for `git apply --cached`. Units of one file share its header
 * and keep their diff order; hunk positions are those of the base, and git apply finds each
 * hunk by its context when earlier commits have shifted the lines.
 */
export function patchFor(units: RecomposeUnit[]): string {
  const byFile = new Map<string, RecomposeUnit[]>()
  for (const u of [...units].sort((a, b) => num(a.id) - num(b.id))) {
    const key = u.header
    byFile.set(key, [...(byFile.get(key) ?? []), u])
  }
  let out = ''
  for (const [header, us] of byFile) {
    out += header + '\n'
    for (const u of us) if (u.body) out += u.body + '\n'
  }
  return out
}

const num = (id: string) => Number(id.slice(1))

export interface PlannedCommit {
  message: string
  units: string[]
}

/**
 * Check a plan against the units: every unit used exactly once, no empty commits, no empty
 * messages. Returns the problems (empty when the plan is sound).
 */
export function checkPlan(units: RecomposeUnit[], plan: PlannedCommit[]): string[] {
  const problems: string[] = []
  const known = new Set(units.map((u) => u.id))
  const seen = new Set<string>()
  if (!plan.length) problems.push('The plan has no commits.')
  plan.forEach((c, i) => {
    if (!c.message.trim()) problems.push(`Commit ${i + 1} has no message.`)
    if (!c.units.length) problems.push(`Commit ${i + 1} has no changes.`)
    for (const id of c.units) {
      if (!known.has(id)) problems.push(`Commit ${i + 1} names an unknown change ${id}.`)
      else if (seen.has(id)) problems.push(`Change ${id} is in more than one commit.`)
      seen.add(id)
    }
  })
  const missing = units.filter((u) => !seen.has(u.id)).map((u) => u.id)
  if (missing.length) problems.push(`Changes not in any commit: ${missing.join(', ')}.`)
  return problems
}

/**
 * Turn whatever the model answered into a sound plan: unknown ids dropped, a unit claimed twice
 * kept where it first appeared, empty commits removed, and units it forgot added to the last
 * commit (reported, so the UI can say so).
 */
export function repairPlan(units: RecomposeUnit[], raw: unknown): { commits: PlannedCommit[]; unplaced: string[] } {
  const known = new Set(units.map((u) => u.id))
  const seen = new Set<string>()
  const list = Array.isArray((raw as { commits?: unknown })?.commits) ? (raw as { commits: unknown[] }).commits : []
  const commits: PlannedCommit[] = []
  for (const c of list) {
    const message = typeof (c as { message?: unknown }).message === 'string' ? (c as { message: string }).message.trim() : ''
    const ids = Array.isArray((c as { units?: unknown }).units) ? (c as { units: unknown[] }).units : []
    const mine = ids.map(String).filter((id) => known.has(id) && !seen.has(id))
    mine.forEach((id) => seen.add(id))
    if (mine.length) commits.push({ message: message || 'Changes', units: mine.sort((a, b) => num(a) - num(b)) })
  }
  const unplaced = units.filter((u) => !seen.has(u.id)).map((u) => u.id)
  if (unplaced.length) {
    if (commits.length) commits[commits.length - 1]!.units.push(...unplaced)
    else commits.push({ message: 'Changes', units: unplaced })
  }
  return { commits, unplaced }
}

/** The first JSON object in a model's reply (it may wrap it in a code fence or prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = fenced ? fenced[1]! : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}
