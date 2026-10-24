import { createHash } from 'node:crypto'
import type { Repo } from '@gitgoose/git'
import { isRestorable, type ReviewScope, type ThreadAnchor, type ThreadBasis } from '@gitgoose/shared'

/**
 * What a conversation's anchor points at, right now. Recorded on the thread when it starts and
 * worked out again when the history list is drawn: the two compared (shared/src/basis.ts,
 * `staleReason`) say whether the answer still describes the repository, and so whether
 * reopening the conversation may put its review, plan, walkthrough or impact back in the middle
 * of the window.
 *
 * It has to be cheap: the history shows forty conversations and asks about all of them at once.
 * So nothing here reads a diff's contents — only `rev-parse` and `diff --raw`, which git answers
 * from the index and the object store, and `resolveAll` works each distinct anchor out once.
 *
 * What is deliberately *not* watched: where a branch forked from. `origin/main` moves on every
 * fetch, and a review of `my-feature` is about the commits on `my-feature`, so a moved base
 * would mark every branch review out of date within a day of work and teach the user to ignore
 * the mark.
 */

/** Null when the anchor cannot be resolved at all: the commits are gone, or the branch is. */
export async function basisOf(repo: Repo, anchor: ThreadAnchor): Promise<ThreadBasis | null> {
  if (!isRestorable(anchor)) return null
  try {
    if (anchor.kind === 'recompose') {
      const commits = await resolve(repo, anchor.hashes)
      if (!commits) return null
      // Recompose rewrites the current branch, so where HEAD is now is part of what it was about.
      const head = await revParse(repo, 'HEAD')
      return { commits, ...(head ? { ref: { name: 'HEAD', hash: head } } : {}) }
    }
    return await scopeBasis(repo, anchor.scope)
  } catch {
    // A repository mid-rebase, an unborn branch: not knowing is the same as not restorable.
    return null
  }
}

/** The basis for each distinct anchor, worked out once per distinct one (the key is the anchor as JSON). */
export async function resolveAll(repo: Repo, anchors: ThreadAnchor[]): Promise<Map<string, ThreadBasis | null>> {
  const out = new Map<string, ThreadBasis | null>()
  for (const anchor of anchors) {
    const key = JSON.stringify(anchor)
    if (out.has(key)) continue
    out.set(key, await basisOf(repo, anchor))
  }
  return out
}

async function scopeBasis(repo: Repo, scope: ReviewScope): Promise<ThreadBasis | null> {
  switch (scope.kind) {
    case 'commits': {
      const commits = await resolve(repo, scope.hashes)
      return commits && { commits }
    }
    case 'branch': {
      const name = `refs/heads/${scope.branch}`
      const tip = await revParse(repo, name)
      return tip ? { commits: [tip], ref: { name, hash: tip } } : null
    }
    case 'outgoing': {
      // What a push would send: the commits themselves, so a new one (or an amend) shows up.
      const out = await repo.outgoing(scope.branch)
      return { commits: out.commits.map((c) => c.hash) }
    }
    case 'staged': {
      const head = await revParse(repo, 'HEAD')
      return { commits: head ? [head] : [], dirty: await digestRaw(repo, ['diff', '--cached', '--raw', '-z']) }
    }
    case 'working': {
      const head = await revParse(repo, 'HEAD')
      // The working tree is the one side git has no blob ids for (`--raw` prints zeros for a
      // file it has not hashed), so here the patch itself is what is digested. It is one diff,
      // and `resolveAll` asks for it once however many conversations are about the working
      // tree. Untracked files count too — a review of the working tree reads them — and
      // hash-object does all of them in one process.
      const tracked = digest((await repo.runner.run(head ? ['diff', 'HEAD', '--no-color', '--no-ext-diff'] : ['diff', '--no-color', '--no-ext-diff'], { readOnly: true, okCodes: [1, 128] })).stdout)
      return { commits: head ? [head] : [], dirty: `${tracked}:${await untrackedDigest(repo)}` }
    }
  }
}

/** The hashes as git knows them now, in order; null when any of them has gone. */
async function resolve(repo: Repo, hashes: string[]): Promise<string[] | null> {
  const out: string[] = []
  for (const h of hashes) {
    const full = await revParse(repo, `${h}^{commit}`)
    if (!full) return null
    out.push(full)
  }
  return out
}

async function revParse(repo: Repo, rev: string): Promise<string> {
  const r = await repo.runner.run(['rev-parse', '--verify', '--quiet', rev], { readOnly: true, okCodes: [1, 128] })
  return r.stdout.trim()
}

/**
 * A digest of `git diff --raw`: one line per changed path with the blob ids on both sides, so
 * any edit that would change the diff changes this, and nothing else does.
 */
async function digestRaw(repo: Repo, args: string[]): Promise<string> {
  const r = await repo.runner.run(args, { readOnly: true, okCodes: [1, 128] })
  return digest(r.stdout)
}

const MAX_UNTRACKED = 50

async function untrackedDigest(repo: Repo): Promise<string> {
  const listed = await repo.runner.run(['ls-files', '--others', '--exclude-standard', '-z'], { readOnly: true, okCodes: [1, 128] })
  const paths = listed.stdout.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED)
  if (!paths.length) return ''
  // hash-object reads the files itself and writes nothing; one process for all of them.
  const hashed = await repo.runner.run(['hash-object', '--', ...paths], { readOnly: true, okCodes: [1, 128] })
  return digest(paths.join('\0') + hashed.stdout)
}

function digest(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}
