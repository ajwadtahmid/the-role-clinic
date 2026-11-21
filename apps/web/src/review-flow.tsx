import { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'
import { AppHeader, PageHeader } from './layout.js'
import { Skeleton } from './ui/skeleton.js'
import { Toast } from './toast.js'
import type { Job } from './job-detail.js'

// Reviews the To review list one job at a time: S saves it, X skips it, J and K move without deciding. Each decision can be undone.
export function ReviewFlow() {
  const [jobs, setJobs] = useState<Job[] | null>(null), [index, setIndex] = useState(0), [done, setDone] = useState(0), [toast, setToast] = useState<{ text: string; undo: () => void } | null>(null), [error, setError] = useState('')
  useEffect(() => { void api<{ jobs: Job[] }>('/api/jobs?status=new').then((r) => setJobs(r.jobs)).catch((e) => setError((e as Error).message)) }, [])
  const current = jobs?.[Math.min(index, Math.max(0, (jobs?.length ?? 1) - 1))]
  const decide = useCallback(async (job: Job, status: 'saved' | 'skipped') => {
    try {
      await api(`/api/jobs/${job.id}/status`, { method: 'PUT', body: JSON.stringify({ status }) })
      setJobs((list) => list?.filter((item) => item.id !== job.id) ?? null); setDone((n) => n + 1)
      setToast({ text: `${status === 'saved' ? 'Saved' : 'Skipped'} ${job.title} at ${job.company}.`, undo: () => { void api(`/api/jobs/${job.id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'new' }) }).then(() => { setJobs((list) => list ? [job, ...list] : [job]); setIndex(0); setDone((n) => Math.max(0, n - 1)) }).catch((e) => setError((e as Error).message)) } })
    } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement)?.closest('input, textarea, select')) return
      const key = event.key.toLowerCase()
      if (key === 's' && current) void decide(current, 'saved')
      else if (key === 'x' && current) void decide(current, 'skipped')
      else if (key === 'j') setIndex((n) => Math.min(n + 1, Math.max(0, (jobs?.length ?? 1) - 1)))
      else if (key === 'k') setIndex((n) => Math.max(0, n - 1))
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [current, jobs, decide])
  const total = (jobs?.length ?? 0) + done
  return <main className="shell" id="main" tabIndex={-1}>
    <AppHeader current="jobs" />
    <PageHeader title="Review jobs" actions={<a className="button secondary" href="#jobs">Back to Jobs</a>}>Save the good ones, skip the rest. Keys: <kbd>S</kbd> save, <kbd>X</kbd> skip, <kbd>J</kbd> next, <kbd>K</kbd> previous.</PageHeader>
    {error && <p role="alert" className="notice error">{error}</p>}
    {!jobs && !error && <Skeleton lines={5} label="Loading jobs to review…" />}
    {jobs && !current && <section className="panel today-card"><div><h2>{done ? 'All reviewed' : 'Nothing is waiting for your review'}</h2><p className="subtle">{done ? `You went through ${done} job${done === 1 ? '' : 's'}.` : 'New jobs will appear here.'}</p></div><a className="button primary" href="#jobs">Go to Jobs</a></section>}
    {current && <section className="panel triage-card" aria-label="Job to review">
      <p className="subtle" aria-live="polite">{done + Math.min(index, jobs!.length - 1) + 1} of {total}</p>
      <progress max={total} value={done} aria-label="Review progress" />
      <h2>{current.title}</h2><p className="subtle">{current.company}{current.location ? ` · ${current.location}` : ''}{current.finderPriority ? ` · Priority ${current.finderPriority}` : ''}</p>
      {current.fit && <p><strong>{current.fit.pct}%</strong> fit · {current.fit.label}</p>}
      <p className="review-summary">{current.summary || 'No description was saved for this job.'}</p>
      <div className="button-row"><button className="button primary" onClick={() => void decide(current, 'saved')}>Save <kbd>S</kbd></button><button className="button secondary" onClick={() => void decide(current, 'skipped')}>Skip <kbd>X</kbd></button><a className="text-button" href={`#jobs/${current.id}`}>Open full job</a></div>
    </section>}
    {toast && <Toast onUndo={toast.undo} onClose={() => setToast(null)}>{toast.text}</Toast>}
  </main>
}
