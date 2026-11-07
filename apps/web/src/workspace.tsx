import { useEffect, useState } from 'react'
import { SubmissionForm } from './tracker-page.js'
import { AppHeader, PageHeader } from './layout.js'
import { api } from './api.js'
import { AddJobDialog, GetReady } from './add-job.js'
import { JobAnswersPanel, JobHeader, JobHistory, JobOverview, JobResume, JobTabs, type Analysis, type Detail, type Estimate, type Job, type JobTab } from './job-detail.js'
import { nextAction, stageLabel, type NextActionId } from './stages.js'

type Counts = { new: number; tracker: number; skipped: number; all: number }
type Readiness = { capturedJob: boolean; hasMaster: boolean; hasProfile: boolean; configuredModels: boolean; triedTracker: boolean }
const viewOptions: Array<[string, string, keyof Counts]> = [['new', 'New', 'new'], ['tracker', 'Tracker', 'tracker'], ['skipped', 'Skipped', 'skipped'], ['', 'All', 'all']]

// Up and Down move between jobs in the list, so it can be scanned without tabbing through every card.
function moveFocus(event: React.KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const cards = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.job-card')], index = cards.indexOf(document.activeElement as HTMLButtonElement)
  if (index < 0) return
  event.preventDefault()
  cards[Math.min(cards.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
}

// `#jobs/<id>` is the address of a job; `#job/<id>` is the older form and still works. `?answers` opens the Answers section.
function jobFromHash(): { id: string | null; tab: JobTab | null } {
  const match = location.hash.match(/^#jobs?\/([^?]+)(?:\?(.*))?$/)
  return match ? { id: match[1], tab: match[2] === 'answers' ? 'answers' : null } : { id: null, tab: null }
}

export function Workspace() {
  const start = jobFromHash()
  const [jobs, setJobs] = useState<Job[]>([]), [selected, setSelected] = useState<string | null>(start.id), [detail, setDetail] = useState<Detail | null>(null), [tab, setTab] = useState<JobTab>(start.tab ?? 'overview')
  const [query, setQuery] = useState(''), [statusFilter, setStatusFilter] = useState('new'), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [sort, setSort] = useState<'newest' | 'company'>('newest'), [counts, setCounts] = useState<Counts | null>(null)
  const [showSubmit, setShowSubmit] = useState(false), [showAdd, setShowAdd] = useState(false), [reveal, setReveal] = useState<'review' | 'apply' | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null), [estimate, setEstimate] = useState<Estimate | null>(null), [estimateError, setEstimateError] = useState(''), [hasExport, setHasExport] = useState(false)
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  async function loadReadiness() { setReadiness(await api<Readiness>('/api/onboarding')) }
  async function loadJobs(filter = statusFilter) { const [result, summary] = await Promise.all([api<{ jobs: Job[] }>(`/api/jobs?q=${encodeURIComponent(query)}&status=${encodeURIComponent(filter)}`), api<Counts>('/api/jobs/counts')]); setJobs(result.jobs); setCounts(summary) }
  const sortedJobs = sort === 'company' ? [...jobs].sort((a, b) => (a.company || '').localeCompare(b.company || '') || (a.title || '').localeCompare(b.title || '')) : jobs
  async function loadExports(id: string) { const result = await api<{ artifacts: unknown[] }>(`/api/jobs/${id}/artifacts`); setHasExport(result.artifacts.length > 0) }
  async function loadAnalysis(id: string) {
    const result = await api<Analysis>(`/api/jobs/${id}/analysis`); setAnalysis(result)
    if (result.extraction) { try { setEstimate(await api<Estimate>(`/api/jobs/${id}/estimate?kind=tailor`)); setEstimateError('') } catch (error) { setEstimate(null); setEstimateError((error as Error).message) } } else { setEstimate(null); setEstimateError('') }
    await loadExports(id)
  }
  async function loadDetail(id: string) {
    const loaded = await api<Detail>(`/api/jobs/${id}`); setDetail(loaded)
    // A job opened from an address or another page may belong to a different view than the list is showing; switch so it is listed.
    const view = ['new'].includes(loaded.job.status ?? 'new') ? 'new' : loaded.job.status === 'skipped' ? 'skipped' : 'tracker'
    setStatusFilter((current) => current === '' || current === view ? current : view)
    await loadAnalysis(id)
  }
  function selectJob(id: string) { setSelected(id); setTab('overview'); setShowSubmit(false); if (location.hash !== `#jobs/${id}`) location.hash = `#jobs/${id}` }
  function backToList() { setSelected(null); if (location.hash !== '#jobs') location.hash = '#jobs' }

  useEffect(() => { if (location.hash.startsWith('#job/')) history.replaceState(null, '', location.hash.replace('#job/', '#jobs/')) }, [])
  useEffect(() => {
    const sync = () => { const next = jobFromHash(); setSelected(next.id); if (next.id) setTab(next.tab ?? 'overview') }
    window.addEventListener('hashchange', sync); return () => window.removeEventListener('hashchange', sync)
  }, [])
  useEffect(() => { void loadReadiness().catch((error) => setNotice(error.message)) }, [])
  useEffect(() => { const timer = window.setTimeout(() => { void loadJobs().catch((error) => setNotice(error.message)) }, 220); return () => window.clearTimeout(timer) }, [query, statusFilter])
  useEffect(() => {
    setAnalysis(null); setEstimate(null); setHasExport(false)
    if (!selected) { setDetail(null); return }
    void loadDetail(selected).catch((error) => setNotice(error.message))
  }, [selected])
  useEffect(() => { if (!selected || typeof EventSource === 'undefined') return; const events = new EventSource('/api/runs/events'); events.addEventListener('run', () => { void loadAnalysis(selected).catch((error) => setNotice(error.message)); void loadJobs().catch((error) => setNotice(error.message)) }); return () => events.close() }, [selected])
  // "Review and export" and "Mark as applied" live inside the Résumé section; open it and bring the right part into view.
  useEffect(() => {
    if (!reveal || tab !== 'resume') return
    const target = document.querySelector<HTMLElement>(reveal === 'apply' ? '.submission-panel' : '.tailoring-workspace')
    if (!target) return
    if (reveal === 'apply') target.setAttribute('open', '')
    target.scrollIntoView?.({ block: 'start' }); setReveal(null)
  }, [reveal, tab, analysis])

  async function startRun(kind: 'extract' | 'tailor') { if (!selected) return; setBusy(true); try { const result = await api<{ run: { id: string } }>(`/api/jobs/${selected}/${kind}`, { method: 'POST', body: '{}' }); setNotice(`${kind === 'extract' ? 'Fit check' : 'Tailoring'} queued. Run ${result.run.id.slice(0, 8)}.`); await loadAnalysis(selected) } catch (error) { setNotice((error as Error).message) } finally { setBusy(false) } }
  async function retryRun(id: string) { if (!selected) return; setBusy(true); try { await api(`/api/runs/${id}/retry`, { method: 'POST', body: '{}' }); setNotice('Retry queued from the last saved step.'); await loadAnalysis(selected) } catch (error) { setNotice((error as Error).message) } finally { setBusy(false) } }
  async function updateStatus(status: string) {
    if (!selected) return
    if (status === 'applied' && !detail?.job.appliedAt) { setShowSubmit(true); return }
    try { await api(`/api/jobs/${selected}/status`, { method: 'PUT', body: JSON.stringify({ status, submittedText: '' }) }); const nextFilter = status === 'new' ? 'new' : status === 'skipped' ? 'skipped' : 'tracker'; setStatusFilter(nextFilter); await loadDetail(selected); await loadJobs(nextFilter); await loadReadiness(); setNotice(`Status updated to ${status}.`) }
    catch (error) { setNotice((error as Error).message) }
  }
  function runNextAction(id: NextActionId) {
    if (id === 'extract' || id === 'tailor') void startRun(id)
    else if (id === 'review' || id === 'apply') { setTab('resume'); setReveal(id) }
  }

  const action = detail ? nextAction({ status: detail.job.status ?? 'new', hasExtraction: !!analysis?.extraction, hasDraft: !!analysis?.tailored, hasExport }) : null
  return <main className="shell workspace-shell" id="main" tabIndex={-1}>
    <AppHeader current="jobs" />
    <PageHeader title="Jobs">Every posting you save, with its résumé, answers and status in one place on this device.</PageHeader>
    {notice && <div className="notice neutral" role="status">{notice}</div>}
    <div className={`jobs-layout ${selected ? 'has-selection' : ''}`}>
      <section className="panel jobs-panel" aria-label="Job list"><div className="panel-heading"><div><h2>Jobs <span className="count">{jobs.length}</span></h2></div><button className="button primary" onClick={() => setShowAdd(true)}>Add job</button></div>
        <div className="view-chips" role="group" aria-label="Show jobs">{viewOptions.map(([value, label, key]) => <button key={label} type="button" className={`chip ${statusFilter === value ? 'active' : ''}`} aria-pressed={statusFilter === value} onClick={() => setStatusFilter(value)}>{label}{counts && <span className="chip-count">{counts[key]}</span>}</button>)}</div>
        <div className="list-tools"><input className="search-input" aria-label="Search jobs" value={query} placeholder="Search company, role, or description" onChange={(e) => setQuery(e.target.value)} /><label className="sort-select">Sort<select value={sort} onChange={(event) => setSort(event.target.value as 'newest' | 'company')}><option value="newest">Newest first</option><option value="company">Company A–Z</option></select></label></div>
        <div className="job-list" onKeyDown={moveFocus}>{sortedJobs.map((job) => <button className={`job-card ${selected === job.id ? 'selected' : ''}`} key={job.id} aria-current={selected === job.id ? 'true' : undefined} onClick={() => selectJob(job.id)}><span className="job-card-heading"><strong>{job.title || '(Untitled role)'}</strong><span className={`status status-${job.status}`}>{stageLabel(job.status ?? 'new')}</span></span><span>{job.company || 'Company not set'}{job.location ? ` · ${job.location}` : ''}</span><small>{new Date(job.capturedAt).toLocaleDateString()} · {job.summary ?? ''}</small>{!!job.knockouts?.length && <span className="knockout-mini">{job.knockouts.map((gate, i) => <span key={i} className={`gate gate-${gate.assessment}`}>{gate.assessment}: {gate.quote.slice(0, 50)}</span>)}</span>}</button>)}{jobs.length === 0 && <p className="empty-state">{statusFilter === 'new' ? 'No new jobs here.' : 'No jobs in this view.'}</p>}</div>
      </section>
      <section className="job-pane" aria-label="Selected job">
        {detail && action ? <div className="panel job-detail">
          <JobHeader detail={detail} action={action} estimate={estimate} estimateError={estimateError} busy={busy || !analysis} onAction={() => runNextAction(action.id)} onStatus={(status) => void updateStatus(status)} onBack={backToList} />
          {showSubmit && <SubmissionForm key={selected} jobId={selected!} onSaved={async () => { setShowSubmit(false); setStatusFilter('tracker'); await loadDetail(selected!); await loadJobs('tracker'); await loadReadiness(); setNotice('Status updated to applied.') }} onCancel={() => setShowSubmit(false)} />}
          <JobTabs tab={tab} onTab={setTab} answerCount={detail.answers.length} />
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="job-tab-panel">
            {tab === 'overview' && <JobOverview text={detail.job.text} analysis={analysis} busy={busy} canExtract={action.id !== 'extract'} onExtract={() => void startRun('extract')} />}
            {tab === 'resume' && <JobResume jobId={selected!} detail={detail} analysis={analysis} busy={busy} onRetry={(id) => void retryRun(id)} onApplied={() => { void loadDetail(selected!); void loadJobs(); void loadReadiness() }} onExported={() => void loadExports(selected!)} />}
            {tab === 'answers' && <JobAnswersPanel jobId={selected!} detail={detail} onSaved={async () => { await loadDetail(selected!); setNotice('Answer saved for this job.') }} />}
            {tab === 'history' && <JobHistory detail={detail} />}
          </div>
        </div> : selected ? <p className="loading panel job-detail" role="status">Loading job…</p> : counts?.all === 0 ? <GetReady readiness={readiness} onAdd={() => setShowAdd(true)} /> : <div className="panel job-empty"><h2>Select a job</h2><p className="subtle">Pick a job from the list to see its requirements, résumé, answers and history. Use Add job to save a new posting.</p></div>}
      </section>
    </div>
    {showAdd && <AddJobDialog onClose={() => setShowAdd(false)} onOpenExisting={(id) => { setShowAdd(false); selectJob(id) }} onSaved={async (id) => { setShowAdd(false); setStatusFilter('new'); await loadJobs('new'); selectJob(id); await loadReadiness(); setNotice('Job saved.') }} />}
    <footer><span>THE ROLE CLINIC</span><span>Saved on this device · job capture and tracking work without a model.</span></footer>
  </main>
}
