import { useEffect, useState } from 'react'
import { AppHeader } from './layout.js'
import { Icon } from './icons.js'
import { api } from './api.js'
import { TailoringWorkspace } from './tailoring-workspace.js'

// The review is its own page: the suggested lines beside a live preview, with nothing else competing for the screen.
export function ReviewPage({ jobId, startWithApply }: { jobId: string; startWithApply: boolean }) {
  const [job, setJob] = useState<{ title: string; company: string } | null>(null), [error, setError] = useState('')
  useEffect(() => { void api<{ job: { title: string; company: string } }>(`/api/jobs/${jobId}`).then((result) => setJob(result.job)).catch((e: Error) => setError(e.message)) }, [jobId])
  return <main className="shell review-shell" id="main" tabIndex={-1}>
    <AppHeader current="jobs" />
    <header className="rv-head"><div><a className="rv-back" href={`#jobs/${jobId}`}><Icon name="back" />{job ? `Back to ${job.company || 'the job'}` : 'Back to the job'}</a><h1>Tailor résumé</h1>{job && <p>{job.title || 'Untitled role'} at {job.company || 'a company'}</p>}</div></header>
    {error && <p role="alert" className="notice error">{error}</p>}
    {job && <TailoringWorkspace jobId={jobId} company={job.company} title={job.title} startWithApply={startWithApply} onApplied={() => { location.hash = `#tracker?job=${jobId}` }} />}
  </main>
}
