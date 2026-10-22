import { beforeEach, describe, expect, it } from 'vitest'
import { dismissJob, dropFinishedJob, dropJob, dropRepoJobs, finishJob, onJobReady, openJob, parkJob, registerJob, stopJob, sweepJobs, useAiJobs, type AiJob, type JobSpec } from './aiJobs'

const jobs = () => useAiJobs.getState().jobs
let announced: AiJob[] = []
let opened: string[] = []
let stopped: string[] = []

function spec(id: string, extra: Partial<JobSpec> = {}): JobSpec {
  return { id, repoId: 'r', title: `job ${id}`, open: () => opened.push(id), stop: () => stopped.push(id), ...extra }
}

beforeEach(() => {
  useAiJobs.setState({ jobs: [] })
  announced = []
  opened = []
  stopped = []
  onJobReady((j) => announced.push(j))
})

describe('AI jobs', () => {
  it('registers a running job; a newer one with the same key replaces it', () => {
    registerJob(spec('a', { key: 'fix' }))
    registerJob(spec('b'))
    expect(jobs().map((j) => [j.id, j.status])).toEqual([['a', 'running'], ['b', 'running']])
    registerJob(spec('c', { key: 'fix' }))
    expect(jobs().map((j) => j.id)).toEqual(['b', 'c'])
  })

  it('a finished job whose view is not showing stays, and is announced once', () => {
    registerJob(spec('a', { showing: () => false }))
    finishJob('a')
    expect(jobs()).toMatchObject([{ id: 'a', status: 'done' }])
    expect(announced.map((j) => j.id)).toEqual(['a'])
    finishJob('b') // unknown: nothing happens
    expect(announced).toHaveLength(1)
  })

  it('a failure is kept with its message', () => {
    registerJob(spec('a'))
    finishJob('a', 'The agent stopped')
    expect(jobs()).toMatchObject([{ id: 'a', status: 'error', error: 'The agent stopped' }])
  })

  it('finishing while its view is on screen needs no announcement: the job goes', () => {
    registerJob(spec('a', { showing: () => true }))
    finishJob('a')
    expect(jobs()).toEqual([])
    expect(announced).toEqual([])
  })

  it('opening a finished job shows it and removes it; opening a running one keeps it', () => {
    registerJob(spec('a'))
    registerJob(spec('b'))
    openJob('a')
    expect(opened).toEqual(['a'])
    expect(jobs().map((j) => j.id)).toEqual(['a', 'b'])
    finishJob('b')
    openJob('b')
    expect(opened).toEqual(['a', 'b'])
    expect(jobs().map((j) => j.id)).toEqual(['a'])
  })

  it('dismiss removes a job; stop asks the feature to cancel (the request ending drops it)', () => {
    registerJob(spec('a'))
    registerJob(spec('b'))
    finishJob('a')
    dismissJob('a')
    expect(jobs().map((j) => j.id)).toEqual(['b'])
    stopJob('b')
    expect(stopped).toEqual(['b'])
    expect(jobs().map((j) => j.id)).toEqual(['b'])
    dropJob('b')
    expect(jobs()).toEqual([])
  })

  it('a finished answer put aside (its dialog closed) goes back on the list, unannounced', () => {
    registerJob(spec('a', { key: 'fix', showing: () => true }))
    finishJob('a')
    expect(jobs()).toEqual([])
    parkJob(spec('a2', { key: 'fix' }))
    expect(jobs()).toMatchObject([{ id: 'a2', status: 'done' }])
    expect(announced).toEqual([])
    openJob('a2')
    expect(opened).toEqual(['a2'])
    expect(jobs()).toEqual([])
  })

  it('a finished answer the user came to by themselves leaves the list; running ones stay', () => {
    let onScreen = false
    registerJob(spec('a', { showing: () => onScreen }))
    registerJob(spec('b', { showing: () => onScreen }))
    finishJob('a')
    sweepJobs()
    expect(jobs().map((j) => j.id)).toEqual(['a', 'b'])
    onScreen = true
    sweepJobs()
    expect(jobs().map((j) => j.id)).toEqual(['b'])
  })

  it('an answer used or discarded where it is shown takes its finished job along, not a running one', () => {
    parkJob(spec('a', { key: 'recompose' }))
    registerJob(spec('b', { key: 'fix' }))
    dropFinishedJob('recompose')
    dropFinishedJob('fix')
    expect(jobs().map((j) => j.id)).toEqual(['b'])
  })

  it('closing a repository drops its jobs only', () => {
    registerJob(spec('a'))
    registerJob(spec('b', { repoId: 'other' }))
    dropRepoJobs('r')
    expect(jobs().map((j) => j.id)).toEqual(['b'])
  })
})
