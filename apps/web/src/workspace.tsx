import { useEffect, useRef, useState } from 'react'
import { SubmissionForm } from './tracker-page.js'
import { AppHeader, PageHeader } from './layout.js'
import { api } from './api.js'
import { AddJobDialog, Quickstart, quickstartHiddenKey } from './add-job.js'
import { JobHeader, JobOverview, RunStrip, latestRun, JobResume, JobTabs, type Analysis, type Detail, type Estimate, type Job, type JobTab } from './job-detail.js'
import { nextAction, stageLabel, type NextActionId } from './stages.js'

type Counts = { new: number; triage: number; active: number; applied: number; tracker: number; skipped: number; all: number }
type Readiness = { capturedJob: boolean; hasMaster: boolean; hasProfile: boolean; configuredModels: boolean; triedTracker: boolean }
// Active is what is still being worked on; Applied is everything from applied onward, which the Tracker follows.
const viewOptions: Array<[string, string, keyof Counts]> = [['triage', 'Triage', 'triage'], ['active', 'Active', 'active'], ['applied', 'Applied', 'applied'], ['skipped', 'Skipped', 'skipped'], ['', 'All', 'all']]
// A short note on a job card while its fit check or tailoring is waiting, running or has failed.
function runBadge(job: Job) {
  const run = job.latestRun
  if (!run) return null
  const name = run.kind === 'extract' ? 'Check' : 'Tailoring'
  if (run.status === 'queued' || run.status === 'running') return <span className="run-badge run-badge-active">{name === 'Check' ? 'Checking…' : 'Tailoring…'}</span>
  if (run.status === 'failed') return <span className="run-badge run-badge-failed">{name} failed</span>
  return null
}
type FeedStatus = { configured: boolean; lastCheckedAt: string | null }
function ago(date?: string | null) {
  if (!date) return ''
  const days = Math.floor((Date.now() - Date.parse(date.length === 10 ? `${date}T12:00:00` : date)) / 86_400_000)
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
}
// Small notes on a card for a job a feed brought in.
function feedBadges(job: Job) {
  if (job.origin !== 'feed') return null
  return <span className="card-badges">{job.finderPriority && <span className="badge">{job.finderPriority}</span>}{job.postingState === 'maybe_closed' && <span className="badge badge-warn">May be closed</span>}{(job.postingState === 'summary' || job.postingState === 'summary_only') && <span className="badge">Summary only</span>}{!!job.flagCount && <span className="badge">Flags ({job.flagCount})</span>}</span>
}
function viewOf(status: string, origin?: string) { return status === 'new' && origin === 'feed' ? 'triage' : status === 'new' || status === 'saved' ? 'active' : status === 'skipped' ? 'skipped' : 'applied' }

// Up and Down move between jobs in the list, so it can be scanned without tabbing through every card.
function moveFocus(event: React.KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const cards = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.job-card')], index = cards.indexOf(document.activeElement as HTMLButtonElement)
  if (index < 0) return
  event.preventDefault()
  cards[Math.min(cards.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
}

// `#jobs/<id>` is the address of a job; `#job/<id>` is the older form and still works. A job's answers now live in the Tracker, so `?answers` goes there.
function jobFromHash(): { id: string | null } {
  const match = location.hash.match(/^#jobs?\/([^?]+)(?:\?(.*))?$/)
  if (match?.[2] === 'answers') { location.replace(`#tracker?job=${match[1]}`); return { id: null } }
  return { id: match ? match[1] : null }
}

export function Workspace() {
  const start = jobFromHash()
  const [jobs, setJobs] = useState<Job[]>([]), [selected, setSelected] = useState<string | null>(start.id), [detail, setDetail] = useState<Detail | null>(null), [tab, setTab] = useState<JobTab>('overview')
  const [query, setQuery] = useState(''), [statusFilter, setStatusFilter] = useState('active'), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [sort, setSort] = useState<'newest' | 'company'>('newest'), [counts, setCounts] = useState<Counts | null>(null)
  const [feed, setFeed] = useState<FeedStatus | null>(null), [checking, setChecking] = useState(false), lastCheck = useRef(0), chosenView = useRef(start.id !== null), [showSubmit, setShowSubmit] = useState(false), [showAdd, setShowAdd] = useState(false), [reveal, setReveal] = useState<'review' | 'apply' | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null), [estimate, setEstimate] = useState<Estimate | null>(null), [estimateError, setEstimateError] = useState(''), [hasExport, setHasExport] = useState(false)
  const [readiness, setReadiness] = useState<Readiness | null>(null), [dismissedRun, setDismissedRun] = useState<string | null>(null), [hideQuickstart, setHideQuickstart] = useState(() => { try { return localStorage.getItem(quickstartHiddenKey) === '1' } catch { return false } })
  async function loadReadiness() { setReadiness(await api<Readiness>('/api/onboarding')) }
  async function loadJobs(filter = statusFilter) { const [result, summary] = await Promise.all([api<{ jobs: Job[] }>(`/api/jobs?q=${encodeURIComponent(query)}&status=${encodeURIComponent(filter)}`), api<Counts>('/api/jobs/counts')]); setJobs(result.jobs); setCounts(summary) }
  const priorityRank = (value?: string | null) => { const rank = ['high', 'medium-high', 'medium', 'low'].indexOf((value ?? '').trim().toLowerCase()); return rank < 0 ? 9 : rank }
  const sortedJobs = statusFilter === 'triage' && sort === 'newest' ? [...jobs].sort((a, b) => priorityRank(a.finderPriority) - priorityRank(b.finderPriority) || (b.postedAt ?? b.foundAt ?? b.capturedAt).localeCompare(a.postedAt ?? a.foundAt ?? a.capturedAt)) : sort === 'company' ? [...jobs].sort((a, b) => (a.company || '').localeCompare(b.company || '') || (a.title || '').localeCompare(b.title || '')) : jobs
  async function loadExports(id: string) { const result = await api<{ artifacts: unknown[] }>(`/api/jobs/${id}/artifacts`); setHasExport(result.artifacts.length > 0) }
  async function loadAnalysis(id: string) {
    const result = await api<Analysis>(`/api/jobs/${id}/analysis`); setAnalysis(result)
    if (result.extraction) { try { setEstimate(await api<Estimate>(`/api/jobs/${id}/estimate?kind=tailor`)); setEstimateError('') } catch (error) { setEstimate(null); setEstimateError((error as Error).message) } } else { setEstimate(null); setEstimateError('') }
    await loadExports(id)
  }
  async function loadDetail(id: string) {
    const loaded = await api<Detail>(`/api/jobs/${id}`); setDetail(loaded)
    // A job opened from an address or another page may belong to a different view than the list is showing; switch so it is listed.
    const view = viewOf(loaded.job.status ?? 'new', loaded.job.origin)
    setStatusFilter((current) => current === '' || current === view ? current : view)
    await loadAnalysis(id)
  }
  async function checkFeed(manual: boolean) {
    if (checking) return
    lastCheck.current = Date.now(); setChecking(true)
    try {
      const result = await api<{ imported: number; invalid: number; notice: string | null }>('/api/feed/refresh', { method: 'POST', body: '{}' })
      setFeed(await api<FeedStatus>('/api/feed/status'))
      if (result.imported || manual) setNotice(`${result.imported ? `${result.imported} new job${result.imported === 1 ? '' : 's'} added to Triage.` : 'No new jobs.'}${result.invalid ? ` ${result.invalid} row${result.invalid === 1 ? ' was' : 's were'} skipped for missing details.` : ''}${result.notice ? ` ${result.notice}` : ''}`)
      if (result.imported) await loadJobs()
    } catch (error) { if (manual) setNotice((error as Error).message) } finally { setChecking(false) }
  }
  function selectJob(id: string) { setSelected(id); setTab('overview'); setShowSubmit(false); if (location.hash !== `#jobs/${id}`) location.hash = `#jobs/${id}` }
  function backToList() { setSelected(null); if (location.hash !== '#jobs') location.hash = '#jobs' }

  useEffect(() => { if (location.hash.startsWith('#job/')) history.replaceState(null, '', location.hash.replace('#job/', '#jobs/')) }, [])
  useEffect(() => {
    const sync = () => { const next = jobFromHash(); setSelected(next.id); if (next.id) setTab('overview') }
    window.addEventListener('hashchange', sync); return () => window.removeEventListener('hashchange', sync)
  }, [])
  useEffect(() => { void api<FeedStatus>('/api/feed/status').then(setFeed).catch(() => undefined) }, [])
  // When the window comes back into focus, look for new jobs at most every 30 seconds.
  useEffect(() => {
    if (!feed?.configured) return
    const onFocus = () => { if (Date.now() - lastCheck.current > 30_000) void checkFeed(false) }
    window.addEventListener('focus', onFocus); return () => window.removeEventListener('focus', onFocus)
  }, [feed?.configured, checking])
  // Open on Triage the first time, when jobs are waiting there and nothing else is in progress.
  useEffect(() => { if (counts && !chosenView.current) { chosenView.current = true; if (counts.triage > 0 && counts.active === 0) setStatusFilter('triage') } }, [counts])
  useEffect(() => { void loadReadiness().catch((error) => setNotice(error.message)) }, [])
  useEffect(() => { const timer = window.setTimeout(() => { void loadJobs().catch((error) => setNotice(error.message)) }, 220); return () => window.clearTimeout(timer) }, [query, statusFilter])
  useEffect(() => {
    setAnalysis(null); setEstimate(null); setHasExport(false)
    if (!selected) { setDetail(null); return }
    void loadDetail(selected).catch((error) => setNotice(error.message))
  }, [selected])
  // Run events refresh the list (for the badges on job cards) and, when a job is open, its analysis.
  useEffect(() => { if (typeof EventSource === 'undefined') return; const events = new EventSource('/api/runs/events'); let timer = 0
    // A reconnect replays earlier events in a burst; refresh once after it settles.
    events.addEventListener('run', () => { window.clearTimeout(timer); timer = window.setTimeout(() => { if (selected) void loadAnalysis(selected).catch((error) => setNotice(error.message)); void loadJobs().catch((error) => setNotice(error.message)) }, 150) })
    return () => { window.clearTimeout(timer); events.close() } }, [selected, statusFilter, query])
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
    try { await api(`/api/jobs/${selected}/status`, { method: 'PUT', body: JSON.stringify({ status, submittedText: '' }) }); const nextFilter = viewOf(status); setStatusFilter(nextFilter); await loadDetail(selected); await loadJobs(nextFilter); await loadReadiness(); setNotice(status === 'saved' ? 'Job added to the Tracker.' : `Status updated to ${status}.`) }
    catch (error) { setNotice((error as Error).message) }
  }
  function runNextAction(id: NextActionId) {
    if (id === 'extract' || id === 'tailor') void startRun(id)
    else if (id === 'track') void updateStatus('saved')
    else if (id === 'review' || id === 'apply') { setTab('resume'); setReveal(id) }
  }

  const active = latestRun(analysis), activeLabel = active && (active.status === 'queued' || active.status === 'running') ? (active.kind === 'extract' ? 'Checking…' : 'Tailoring…') : undefined
  const action = detail ? nextAction({ status: detail.job.status ?? 'new', hasExtraction: !!analysis?.extraction, hasDraft: !!analysis?.tailored, hasExport }) : null
  return <main className="shell workspace-shell" id="main" tabIndex={-1}>
    <AppHeader current="jobs" />
    <PageHeader title="Jobs">Add a posting, check how well it fits, and tailor a résumé for it. Jobs you commit to move to the Tracker.</PageHeader>
    {notice && <div className="notice neutral" role="status">{notice}</div>}
    {counts && counts.all > 0 && readiness && !hideQuickstart && !(readiness.hasMaster && readiness.configuredModels && readiness.capturedJob) && <Quickstart readiness={readiness} onAdd={() => setShowAdd(true)} onHide={() => { setHideQuickstart(true); try { localStorage.setItem(quickstartHiddenKey, '1') } catch { /* storage may be unavailable */ } }} />}
    <div className={`jobs-layout ${selected ? 'has-selection' : ''}`}>
      <section className="panel jobs-panel" aria-label="Job list"><div className="panel-heading"><div><h2>Jobs <span className="count">{jobs.length}</span></h2></div><div className="panel-actions">{feed?.configured && <button className="button secondary" disabled={checking} onClick={() => void checkFeed(true)}>{checking ? 'Checking…' : 'Check for new jobs'}</button>}<button className="button primary" onClick={() => setShowAdd(true)}>Add job</button></div></div>
        {feed?.configured && feed.lastCheckedAt && <p className="subtle feed-checked">Last checked {new Date(feed.lastCheckedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>}
        <div className="view-chips" role="group" aria-label="Show jobs">{viewOptions.filter(([value]) => value !== 'triage' || feed?.configured || (counts?.triage ?? 0) > 0).map(([value, label, key]) => <button key={label} type="button" className={`chip ${statusFilter === value ? 'active' : ''}`} aria-pressed={statusFilter === value} onClick={() => { chosenView.current = true; setStatusFilter(value) }}>{label}{counts && <span className="chip-count">{counts[key]}</span>}</button>)}</div>
        <div className="list-tools"><input className="search-input" aria-label="Search jobs" value={query} placeholder="Search company, role, or description" onChange={(e) => setQuery(e.target.value)} /><label className="sort-select">Sort<select value={sort} onChange={(event) => setSort(event.target.value as 'newest' | 'company')}><option value="newest">Newest first</option><option value="company">Company A–Z</option></select></label></div>
        <div className="job-list" onKeyDown={moveFocus}>{sortedJobs.map((job) => <button className={`job-card ${selected === job.id ? 'selected' : ''}`} key={job.id} aria-current={selected === job.id ? 'true' : undefined} onClick={() => selectJob(job.id)}><span className="job-card-heading"><strong>{job.title || '(Untitled role)'}</strong><span className={`status status-${job.status}`}>{stageLabel(job.status ?? 'new')}</span></span><span>{job.company || 'Company not set'}{job.location ? ` · ${job.location}` : ''}</span>{runBadge(job)}{feedBadges(job)}<small>{job.origin === 'feed' ? `Found ${ago(job.postedAt ?? job.foundAt ?? job.capturedAt)}` : new Date(job.capturedAt).toLocaleDateString()} · {job.summary ?? ''}</small>{!!job.knockouts?.length && <span className="knockout-mini">{job.knockouts.map((gate, i) => <span key={i} className={`gate gate-${gate.assessment}`}>{gate.assessment}: {gate.quote.slice(0, 50)}</span>)}</span>}</button>)}{jobs.length === 0 && <p className="empty-state">{statusFilter === 'triage' ? 'Nothing is waiting for a decision.' : statusFilter === 'active' ? 'No jobs in progress here.' : 'No jobs in this view.'}</p>}</div>
      </section>
      <section className="job-pane" aria-label="Selected job">
        {detail && action ? <div className="panel job-detail">
          <JobHeader detail={detail} action={action} estimate={estimate} estimateError={estimateError} busy={busy || !analysis} activeLabel={activeLabel} onAction={() => runNextAction(action.id)} onStatus={(status) => void updateStatus(status)} onBack={backToList} />
          {showSubmit && <SubmissionForm key={selected} jobId={selected!} onSaved={async () => { setShowSubmit(false); setStatusFilter('applied'); await loadDetail(selected!); await loadJobs('applied'); await loadReadiness(); setNotice('Status updated to applied.') }} onCancel={() => setShowSubmit(false)} />}
          <RunStrip analysis={analysis} dismissed={dismissedRun} onDismiss={setDismissedRun} onRetry={(id) => void retryRun(id)} busy={busy} />
          <JobTabs tab={tab} onTab={setTab} />
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="job-tab-panel">
            {tab === 'overview' && <JobOverview job={detail.job} text={detail.job.text} analysis={analysis} busy={busy} canExtract={action.id !== 'extract'} onExtract={() => void startRun('extract')} />}
            {tab === 'resume' && <JobResume jobId={selected!} detail={detail} analysis={analysis} busy={busy} onRetry={(id) => void retryRun(id)} onApplied={() => { void loadDetail(selected!); void loadJobs(); void loadReadiness() }} onExported={() => void loadExports(selected!)} />}
          </div>
        </div> : selected ? <p className="loading panel job-detail" role="status">Loading job…</p> : counts?.all === 0 ? <Quickstart readiness={readiness} onAdd={() => setShowAdd(true)} /> : <div className="panel job-empty"><h2>Select a job</h2><p className="subtle">Pick a job from the list to see its requirements, résumé, answers and history. Use Add job to save a new posting.</p></div>}
      </section>
    </div>
    {showAdd && <AddJobDialog onClose={() => setShowAdd(false)} onOpenExisting={(id) => { setShowAdd(false); selectJob(id) }} onSaved={async (id) => { setShowAdd(false); setStatusFilter('active'); await loadJobs('active'); selectJob(id); await loadReadiness(); setNotice('Job saved.') }} />}
    <footer><span>THE ROLE CLINIC</span><span>Saved on this device · job capture and tracking work without a model.</span></footer>
  </main>
}
