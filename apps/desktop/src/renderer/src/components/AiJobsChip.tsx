import clsx from 'clsx'
import { CircleAlert, Sparkles } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useState } from 'react'
import { dismissJob, openJob, stopJob, useAiJobs, type AiJob } from '../lib/aiJobs'
import { useStore } from '../lib/store'
import { Button, Spinner } from './ui'

/**
 * The status bar's AI chip: what the AI is working on, and answers waiting to be looked at,
 * across all open repositories. Nothing shows when there is neither. Its popover lists each
 * job with Open (go to where the answer is), Stop (while it runs) and Dismiss (once it is done).
 */
export function AiJobsChip() {
  const jobs = useAiJobs((s) => s.jobs)
  const [open, setOpen] = useState(false)
  if (!jobs.length) return null
  const running = jobs.filter((j) => j.status === 'running')
  const ready = jobs.length - running.length
  const label = running.length
    ? `AI: ${running.at(-1)!.title}${running.length > 1 ? ` (+${running.length - 1})` : ''}`
    : `${ready} ${ready === 1 ? 'answer' : 'answers'} ready`
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className={clsx('flex max-w-72 min-w-0 items-center gap-1 rounded px-1 hover:bg-accent hover:text-foreground', !running.length && 'text-primary')}
          data-testid="ai-jobs" title="AI requests and answers">
          <Sparkles size={11} className="shrink-0" />
          {running.length ? <Spinner className="shrink-0" /> : null}
          <span className="truncate">{label}</span>
          {running.length && ready ? <span className="shrink-0 text-primary">· {ready} ready</span> : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="end" sideOffset={6} data-testid="ai-jobs-list"
          className="z-50 w-96 max-w-[94vw] rounded-md border border-border bg-popover p-1 text-sm shadow-xl shadow-black/30">
          {[...jobs].reverse().map((j) => <JobRow key={j.id} job={j} close={() => setOpen(false)} />)}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function JobRow({ job, close }: { job: AiJob; close: () => void }) {
  const repoName = useStore((s) => (s.tabs.length > 1 ? s.repos[job.repoId]?.snapshot.name : undefined))
  return (
    <div className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent" data-testid="ai-job" data-status={job.status}>
      <span className="flex w-4 shrink-0 justify-center">
        {job.status === 'running' ? <Spinner /> : job.status === 'error' ? <CircleAlert size={13} className="text-destructive" /> : <Sparkles size={13} className="text-primary" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate">{job.title}</div>
        <div className="truncate text-2xs text-muted-foreground/70" title={job.error}>
          {job.status === 'running' ? 'Working on it…' : job.status === 'error' ? job.error ?? 'Failed' : 'Ready'}
          {repoName ? ` · ${repoName}` : ''}
        </div>
      </div>
      <Button size="sm" onClick={() => { close(); openJob(job.id) }} data-testid="ai-job-open">Open</Button>
      {job.status === 'running'
        ? job.stop && <Button size="sm" variant="ghost" onClick={() => stopJob(job.id)} data-testid="ai-job-stop">Stop</Button>
        : <Button size="sm" variant="ghost" onClick={() => dismissJob(job.id)} data-testid="ai-job-dismiss">Dismiss</Button>}
    </div>
  )
}
