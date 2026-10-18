import type { ChangeKind, ChangedFile, DiffLine, FileDiff, Hunk } from '@gitgoose/shared'

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/**
 * Parse `git diff` unified output (one or more files).
 *
 * The header lines before the first hunk are kept verbatim because building a patch for
 * `git apply` needs them (see patch.ts). Paths come from the caller when it knows them,
 * because header paths can be quoted or ambiguous (spaces, " b/" inside a name).
 */
export function parseDiff(output: string, knownPath?: string): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | null = null
  let hunk: Hunk | null = null
  let oldNo = 0
  let newNo = 0
  const lines = output.split('\n')
  // A trailing newline produces one empty final element that is not a diff line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop()

  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ')) {
      file = { path: knownPath ?? pathFromDiffGit(line), change: 'modified', binary: false, header: [line], hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    if (!hunk) {
      // Still in the header.
      const m = HUNK_RE.exec(line)
      if (!m) {
        file.header.push(line)
        if (line.startsWith('new file mode')) file.change = 'added'
        else if (line.startsWith('deleted file mode')) file.change = 'deleted'
        else if (line.startsWith('rename from ')) { file.oldPath = line.slice(12); file.change = 'renamed' }
        else if (line.startsWith('rename to ')) { if (!knownPath) file.path = line.slice(10) }
        else if (line.startsWith('copy from ')) { file.oldPath = line.slice(10); file.change = 'copied' }
        else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true
        else if (line.startsWith('+++ ') && !knownPath && line !== '+++ /dev/null') file.path = stripPrefix(line.slice(4))
        continue
      }
    }
    const m = HUNK_RE.exec(line)
    if (m) {
      hunk = {
        oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5] ?? '', lines: [],
      }
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    const c = line[0]
    const text = line.slice(1)
    if (c === ' ') hunk.lines.push({ kind: ' ', text, oldNo: oldNo++, newNo: newNo++ })
    else if (c === '-') hunk.lines.push({ kind: '-', text, oldNo: oldNo++ })
    else if (c === '+') hunk.lines.push({ kind: '+', text, newNo: newNo++ })
    else if (c === '\\') {
      const last = hunk.lines[hunk.lines.length - 1]
      if (last) last.noNewline = true
    } else if (line === '') {
      // Some tools strip the space from empty context lines; treat as context.
      hunk.lines.push({ kind: ' ', text: '', oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return files
}

function stripPrefix(p: string): string {
  return p.replace(/^[abciow]\//, '')
}

function pathFromDiffGit(line: string): string {
  // "diff --git a/x b/x": for the common unrenamed case both halves are equal.
  const rest = line.replace(/^diff --(git|cc) /, '')
  const half = rest.length / 2
  if (rest.length % 2 === 1 && rest[Math.floor(half)] === ' ') {
    const a = rest.slice(0, Math.floor(half))
    const b = rest.slice(Math.floor(half) + 1)
    if (stripPrefix(a) === stripPrefix(b)) return stripPrefix(b)
  }
  const i = rest.lastIndexOf(' b/')
  return i >= 0 ? rest.slice(i + 3) : stripPrefix(rest)
}

/** Build a diff for a file that git does not track yet: every line is an addition. */
export function untrackedDiff(path: string, content: Buffer): FileDiff {
  const header = [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`]
  if (isBinary(content)) return { path, change: 'added', binary: true, header, hunks: [] }
  const text = content.toString('utf8')
  if (text === '') return { path, change: 'added', binary: false, header, hunks: [] }
  const noNewline = !text.endsWith('\n')
  const raw = (noNewline ? text : text.slice(0, -1)).split('\n')
  const lines: DiffLine[] = raw.map((t, i) => ({ kind: '+', text: t, newNo: i + 1 }))
  if (noNewline) lines[lines.length - 1]!.noNewline = true
  return {
    path, change: 'added', binary: false, header,
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, section: '', lines }],
  }
}

/** git's own heuristic: a NUL byte in the first 8000 bytes means binary. */
export function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0)
}

const NAME_STATUS: Record<string, ChangeKind> = {
  A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', U: 'unmerged',
}

/**
 * Combine `--name-status -z` and `--numstat -z` output for the same diff into one file list.
 * name-status -z: "M\0path\0" or "R100\0old\0new\0"
 * numstat -z:     "3\t1\tpath\0" or "3\t1\t\0old\0new\0" (renames), "-\t-\t..." for binary
 */
export function parseChangedFiles(nameStatus: string, numstat: string): ChangedFile[] {
  const files: ChangedFile[] = []
  const byPath = new Map<string, ChangedFile>()
  const ns = nameStatus.split('\x00')
  for (let i = 0; i < ns.length; i++) {
    const code = ns[i]
    if (!code) continue
    const kind = NAME_STATUS[code[0]!] ?? 'modified'
    let file: ChangedFile
    if (kind === 'renamed' || kind === 'copied') {
      const oldPath = ns[++i]!
      const path = ns[++i]!
      file = { path, oldPath, change: kind, additions: 0, deletions: 0, binary: false }
    } else {
      file = { path: ns[++i]!, change: kind, additions: 0, deletions: 0, binary: false }
    }
    files.push(file)
    byPath.set(file.path, file)
  }
  const nm = numstat.split('\x00')
  for (let i = 0; i < nm.length; i++) {
    const rec = nm[i]
    if (!rec) continue
    const [a, d, p] = rec.split('\t')
    let path = p ?? ''
    if (path === '') {
      i++ // old path
      path = nm[++i] ?? ''
    }
    const f = byPath.get(path)
    if (!f) continue
    if (a === '-') f.binary = true
    else {
      f.additions = Number(a)
      f.deletions = Number(d)
    }
  }
  return files
}
