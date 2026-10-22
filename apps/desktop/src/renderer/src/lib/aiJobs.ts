import { create } from 'zustand'

/**
 * Every long AI request in flight, and every answer nobody has looked at yet. The point is that
 * waiting on the AI never holds the user up: a request keeps going whatever they do meanwhile
 * (close its dialog, select another commit, switch tabs), and this list is how they find the
 * answer again: the status bar chip lists it, and a toast says when it is ready.
 *
 * The request itself and its result live with the feature (useAi, the repository view, the
 * explanation store); a job only knows how to show them again (`open`) and how to stop.
 *
 * Kept free of the store and the IPC bridge so it can be unit-tested: the toast for a finished
 * job is plugged in from outside (onJobReady).
 */

export interface AiJob {
  /** The request id. */
  id: string
  repoId: string
  /** "Explain a1b2c3d", "Fix: Possible bug here": what the chip and the toast say. */
  title: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  error?: string
  /**
   * One slot per feature where a newer request replaces the older one (the Fix dialog, a
   * commit's explanation): registering a job with the same key drops the old job.
   */
  key?: string
  /** Show the answer (or the wait) where it belongs. */
  open(): void
  /** Cancel the request. */
  stop?(): void
  /** Is the answer on screen right now? Then finishing needs no announcement. */
  showing?(): boolean
}

export type JobSpec = Omit<AiJob, 'status' | 'startedAt' | 'error'>

export const useAiJobs = create<{ jobs: AiJob[] }>(() => ({ jobs: [] }))

let announce: (job: AiJob) => void = () => {}

/** Who tells the user that an answer is ready elsewhere (lib/ai.ts: a toast with Open). */
export function onJobReady(f: (job: AiJob) => void): void {
  announce = f
}

const set = (f: (jobs: AiJob[]) => AiJob[]) => useAiJobs.setState((s) => ({ jobs: f(s.jobs) }))

function add(job: AiJob): void {
  set((jobs) => [...jobs.filter((j) => j.id !== job.id && !(job.key && j.key === job.key)), job])
}

export function registerJob(spec: JobSpec): void {
  add({ ...spec, status: 'running', startedAt: Date.now() })
}

/**
 * The user closed a dialog holding a finished answer they have not acted on (a proposed fix, a
 * plan): it goes back on the list, without an announcement, so closing never loses it.
 */
export function parkJob(spec: JobSpec): void {
  add({ ...spec, status: 'done', startedAt: Date.now() })
}

/**
 * The request ended with an answer (or an error). When its view is on screen the user has
 * already seen it, so the job just goes; otherwise it stays (the chip counts it) and is
 * announced, until the user opens or dismisses it.
 */
export function finishJob(id: string, error?: string): void {
  const job = useAiJobs.getState().jobs.find((j) => j.id === id)
  if (!job) return
  if (job.showing?.()) return dropJob(id)
  const done: AiJob = { ...job, status: error ? 'error' : 'done', ...(error ? { error } : {}) }
  set((jobs) => jobs.map((j) => (j.id === id ? done : j)))
  announce(done)
}

/** Gone without an answer (stopped, or nothing was sent): nothing to show. */
export function dropJob(id: string): void {
  set((jobs) => jobs.filter((j) => j.id !== id))
}

/** The user dismissed a finished job (its answer stays where it is: a dialog, a thread). */
export const dismissJob = dropJob

/** Show the job's view; a finished job has then been seen, so it leaves the list. */
export function openJob(id: string): void {
  const job = useAiJobs.getState().jobs.find((j) => j.id === id)
  if (!job) return
  if (job.status !== 'running') dropJob(id)
  job.open()
}

export function stopJob(id: string): void {
  useAiJobs.getState().jobs.find((j) => j.id === id)?.stop?.()
}

/**
 * A finished answer the user came to by themselves (selected the commit, opened the review) has
 * been seen: it leaves the list. Run on every change of what is on screen (lib/ai.ts).
 */
export function sweepJobs(): void {
  const seen = (j: AiJob) => j.status !== 'running' && !!j.showing?.()
  if (useAiJobs.getState().jobs.some(seen)) set((jobs) => jobs.filter((j) => !seen(j)))
}

/** A repository closed: its requests end with it. */
export function dropRepoJobs(repoId: string): void {
  set((jobs) => jobs.filter((j) => j.repoId !== repoId))
}

/** The running job with this key, if any (a view that shows "working on it" across navigation). */
export function useRunningJob(key: string): AiJob | undefined {
  return useAiJobs((s) => s.jobs.find((j) => j.key === key && j.status === 'running'))
}
