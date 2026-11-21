import { useEffect, useState } from 'react'
import { AppHeader } from './layout.js'
import { Icon } from './icons.js'
import { api } from './api.js'
import { TailoringWorkspace } from './tailoring-workspace.js'
import { useAiFeatures } from './ai-features.js'
import { FoldCard } from './ui/fold-card.js'
import type { Analysis } from './job-detail.js'

// What the posting asks for and whether your résumé covers it, so the lines being reviewed can be judged against the need.
// A requirement is a gap when the check found one or the tailoring run listed it as unmet.
function Coverage({ jobId }: { jobId: string }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null), [open, setOpen] = useState(true)
  useEffect(() => { void api<Analysis>(`/api/jobs/${jobId}/analysis`).then(setAnalysis).catch(() => undefined) }, [jobId])
  const requirements = (analysis?.extraction?.requirements ?? []).filter((item) => item.kind !== 'knockout')
  if (!requirements.length) return null
  const gapIds = new Set((analysis?.tailored?.gaps ?? analysis?.preliminaryGaps ?? []).map((gap) => gap.requirementId))
  const state = (item: (typeof requirements)[number]) => gapIds.has(item.id) || item.assessment === 'gap' ? 'gap' : item.assessment === 'met' ? 'met' : 'unknown'
  const covered = requirements.filter((item) => state(item) === 'met').length
  return <FoldCard title="What the job asks for" open={open} onToggle={setOpen} summary={`${covered} of ${requirements.length} covered`}>
    <ul className="coverage-list">{requirements.map((item) => <li key={item.id} className={`cov-${state(item)}`}><span className="cov-state">{state(item) === 'met' ? 'Covered' : state(item) === 'gap' ? 'Gap' : 'Not checked'}</span> {item.skill || item.quote} <span className="subtle">{item.kind === 'hard' ? 'required' : 'nice to have'}</span></li>)}</ul>
  </FoldCard>
}

// The review is its own page: the suggested lines beside a live preview, with nothing else competing for the screen.
export function ReviewPage({ jobId, startWithApply }: { jobId: string; startWithApply: boolean }) {
  const { active } = useAiFeatures()
  const [job, setJob] = useState<{ title: string; company: string } | null>(null), [error, setError] = useState('')
  useEffect(() => { void api<{ job: { title: string; company: string } }>(`/api/jobs/${jobId}`).then((result) => setJob(result.job)).catch((e: Error) => setError(e.message)) }, [jobId])
  return <main className="shell review-shell" id="main" tabIndex={-1}>
    <AppHeader current="jobs" />
    <header className="rv-head"><div><a className="rv-back" href={`#jobs/${jobId}`}><Icon name="back" />{job ? `Back to ${job.company || 'the job'}` : 'Back to the job'}</a><h1>Tailor résumé</h1>{job && <p>{job.title || 'Untitled role'} at {job.company || 'a company'}</p>}</div></header>
    {error && <p role="alert" className="notice error">{error}</p>}
    {!active && <p role="status" className="notice neutral">Tailoring is off. Turn it on under <a href="#settings">Settings, Your setup</a> to review and export tailored résumés. Anything you made before is kept.</p>}
    {active && <Coverage jobId={jobId} />}
    {job && active && <TailoringWorkspace jobId={jobId} company={job.company} title={job.title} startWithApply={startWithApply} onApplied={() => { location.hash = `#tracker?job=${jobId}` }} />}
  </main>
}
