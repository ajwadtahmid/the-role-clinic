import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SubmissionForm } from './tracker-page.js'
import { AppHeader, PageHeader } from './layout.js'
import { Icon } from './icons.js'
import { api } from './api.js'
import { AddJobDialog, Quickstart } from './add-job.js'
import { Toast } from './toast.js'
import { FitMeter, JobFit, useFitBatch } from './fit-check.js'
import { JobHeader, JobOverview, RunStrip, latestRun, JobResume, JobTabs, type Analysis, type Detail, type Estimate, type Job, type JobTab } from './job-detail.js'
import { nextAction, splitChoice, stageLabels, statusText, type NextActionId } from './stages.js'

type Counts = { new: number; saved: number; triage: number; active: number; applied: number; tracker: number; skipped: number; all: number }
type Readiness = { capturedJob: boolean; hasMaster: boolean; hasProfile: boolean; configuredModels: boolean; triedTracker: boolean }
// Jobs holds the jobs not applied to yet, one stage at a time. From applied onward a job is in the Tracker.
type JobStage = 'new' | 'saved' | 'skipped'
const stageOptions: Array<[JobStage, string]> = [['new', stageLabels.review], ['saved', stageLabels.saved], ['skipped', stageLabels.skipped]]
const emptyText: Record<JobStage, string> = { new: 'Nothing is waiting for your review.', saved: 'No saved jobs yet.', skipped: 'No skipped jobs.' }
const pageSize = 50
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
  return <>{job.postingState === 'maybe_closed' && <span className="tag tag-warn">May be closed</span>}{(job.postingState === 'summary' || job.postingState === 'summary_only') && <span className="tag">Summary only</span>}{!!job.flagCount && <span className="tag">Flags ({job.flagCount})</span>}</>
}
// The finder's own priority as four bars and its own word. Role Clinic has not checked it, so it is named a priority, not a fit.
const priorityBars: Record<string, number> = { high: 4, 'medium-high': 3, medium: 2, low: 1 }
function PriorityMeter({ job }: { job: Job }) {
  const bars = priorityBars[(job.finderPriority ?? '').trim().toLowerCase()]
  if (!bars) return null
  return <span className="fit"><span className="meter" aria-hidden="true">{[1, 2, 3, 4].map((i) => <i key={i} className={i <= bars ? 'on' : ''} />)}</span>{job.finderPriority} priority</span>
}
// Gates the fit check found that need a look: not met, or the posting does not say.
function warningCount(job: Job) { return job.knockouts?.filter((gate) => gate.assessment !== 'met').length ?? 0 }
// The Jobs stage a status belongs to, or null once the job is in the Tracker.
function stageOfStatus(status: string): JobStage | null { return status === 'new' ? 'new' : status === 'saved' ? 'saved' : status === 'skipped' ? 'skipped' : null }

// Up and Down move between jobs in the list, so it can be scanned without tabbing through every card.
function moveFocus(event: React.KeyboardEvent<HTMLElement>) {
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
  const [activeRow, setActiveRow] = useState('')
  const [query, setQuery] = useState(''),[statusFilter, setStatusFilter] = useState<JobStage>('new'), [feedOnly, setFeedOnly] = useState(false), [limit, setLimit] = useState(pageSize), [notice, setNotice] = useState<ReactNode>(''), [toast, setToast] = useState<{ text: ReactNode; undo?: () => void } | null>(null), [busy, setBusy] = useState(false)
  const [sort, setSort] = useState<'newest' | 'company'>('newest'), [counts, setCounts] = useState<Counts | null>(null)
  const [feed, setFeed] = useState<FeedStatus | null>(null), [checking, setChecking] = useState(false), lastCheck = useRef(0), chainTailor = useRef<string | null>(null), [showSubmit, setShowSubmit] = useState(false), [showAdd, setShowAdd] = useState(false)
  const [analysis, setAnalysis] = useState<Analysis | null>(null), [estimate, setEstimate] = useState<Estimate | null>(null), [estimateError, setEstimateError] = useState(''), [hasExport, setHasExport] = useState(false)
  const [readiness, setReadiness] = useState<Readiness | null>(null), [dismissedRun, setDismissedRun] = useState<string | null>(null)
  const batch = useFitBatch(() => { void loadJobs().catch(() => undefined) }, (text) => flash(text))
  async function loadReadiness() { setReadiness(await api<Readiness>('/api/onboarding')) }
  // The feed filter only applies to To review; the server names that view `triage`.
  async function loadJobs(filter = statusFilter, onlyFeed = feedOnly) { const view = onlyFeed && filter === 'new' ? 'triage' : filter; const [result, summary] = await Promise.all([api<{ jobs: Job[] }>(`/api/jobs?q=${encodeURIComponent(query)}&status=${encodeURIComponent(view)}`), api<Counts>('/api/jobs/counts')]); setJobs(result.jobs); setCounts(summary) }
  const priorityRank = (value?: string | null) => { const rank = ['high', 'medium-high', 'medium', 'low'].indexOf((value ?? '').trim().toLowerCase()); return rank < 0 ? 9 : rank }
  const sortedJobs = feedOnly && statusFilter === 'new' && sort === 'newest' ? [...jobs].sort((a, b) => priorityRank(a.finderPriority) - priorityRank(b.finderPriority) || (b.postedAt ?? b.foundAt ?? b.capturedAt).localeCompare(a.postedAt ?? a.foundAt ?? a.capturedAt)) : sort === 'company' ? [...jobs].sort((a, b) => (a.company || '').localeCompare(b.company || '') || (a.title || '').localeCompare(b.title || '')) : jobs
  async function loadExports(id: string) { const result = await api<{ artifacts: unknown[] }>(`/api/jobs/${id}/artifacts`); setHasExport(result.artifacts.length > 0) }
  async function loadAnalysis(id: string) {
    const result = await api<Analysis>(`/api/jobs/${id}/analysis`); setAnalysis(result)
    if (result.extraction) { try { setEstimate(await api<Estimate>(`/api/jobs/${id}/estimate?kind=tailor`)); setEstimateError('') } catch (error) { setEstimate(null); setEstimateError((error as Error).message) } } else { setEstimate(null); setEstimateError('') }
    await loadExports(id)
  }
  async function loadDetail(id: string) {
    const loaded = await api<Detail>(`/api/jobs/${id}`); setDetail(loaded)
    // A job opened from an address or another page may belong to a different stage than the list is showing; switch so it is listed.
    const stage = stageOfStatus(loaded.job.status ?? 'new')
    if (stage && stage !== statusFilter) { setStatusFilter(stage); setFeedOnly(false) }
    await loadAnalysis(id)
  }
  async function checkFeed(manual: boolean) {
    if (checking) return
    lastCheck.current = Date.now(); setChecking(true)
    try {
      const result = await api<{ imported: number; invalid: number; notice: string | null }>('/api/feed/refresh', { method: 'POST', body: '{}' })
      setFeed(await api<FeedStatus>('/api/feed/status'))
      if (result.imported || manual) flash(`${result.imported ? `${result.imported} new job${result.imported === 1 ? '' : 's'} added to To review.` : 'No new jobs.'}${result.invalid ? ` ${result.invalid} row${result.invalid === 1 ? ' was' : 's were'} skipped for missing details.` : ''}${result.notice ? ` ${result.notice}` : ''}`)
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
  useEffect(() => { void loadReadiness().catch((error) => setNotice(error.message)) }, [])
  useEffect(() => { const timer = window.setTimeout(() => { void loadJobs().catch((error) => setNotice(error.message)) }, 220); return () => window.clearTimeout(timer) }, [query, statusFilter, feedOnly])
  useEffect(() => { setLimit(pageSize) }, [query, statusFilter, feedOnly])
  // With many jobs the open one can be far down the list; keep it in view.
  useEffect(() => { document.querySelector('.job-card.selected')?.scrollIntoView?.({ block: 'nearest' }) }, [selected, jobs])
  useEffect(() => {
    setAnalysis(null); setEstimate(null); setHasExport(false)
    if (!selected) { setDetail(null); return }
    void loadDetail(selected).catch((error) => setNotice(error.message))
  }, [selected])
  // Run events refresh the list (for the badges on job cards) and, when a job is open, its analysis.
  useEffect(() => { if (typeof EventSource === 'undefined') return; const events = new EventSource('/api/runs/events'); let timer = 0
    // A reconnect replays earlier events in a burst; refresh once after it settles.
    events.addEventListener('run', () => { window.clearTimeout(timer); timer = window.setTimeout(() => { if (selected) void loadAnalysis(selected).catch((error) => setNotice(error.message)); void loadJobs().catch((error) => setNotice(error.message)) }, 150) })
    return () => { window.clearTimeout(timer); events.close() } }, [selected, statusFilter, feedOnly, query])

  async function startRun(kind: 'extract' | 'tailor') { if (!selected) return; setBusy(true); try { const result = await api<{ run: { id: string } }>(`/api/jobs/${selected}/${kind}`, { method: 'POST', body: '{}' }); setNotice(`${kind === 'extract' ? 'Fit check' : 'Tailoring'} queued. Run ${result.run.id.slice(0, 8)}.`); await loadAnalysis(selected) } catch (error) { setNotice((error as Error).message) } finally { setBusy(false) } }
  // Tailor résumé needs the posting's requirements, so a job with no fit check yet gets one first and then goes straight on to tailoring.
  async function tailorFirst() {
    if (!selected) return
    if (analysis?.extraction) { await startRun('tailor'); return }
    chainTailor.current = selected; setTab('fit'); await startRun('extract')
  }
  async function retryRun(id: string) { if (!selected) return; setBusy(true); try { await api(`/api/runs/${id}/retry`, { method: 'POST', body: '{}' }); flash('Retry queued from the last saved step.'); await loadAnalysis(selected) } catch (error) { setNotice((error as Error).message) } finally { setBusy(false) } }
  // After a status change: a job that has left the list being shown is followed by the next one in it, so a run of decisions needs no extra clicks.
  // Confirmations are toasts, so the page does not move; mistakes and failures stay as a banner until they are dealt with.
  function flash(text: ReactNode, undo?: () => void) { setToast({ text, undo }) }
  // Puts a job back where it was; used by the Undo on a confirmation.
  function undoTo(jobId: string, previous: string) {
    return () => { void (async () => { try { await api(`/api/jobs/${jobId}/status`, { method: 'PUT', body: JSON.stringify({ status: previous, submittedText: '' }) }); await afterStatusChange(jobId, previous) } catch (error) { setNotice((error as Error).message) } })() }
  }
  async function afterStatusChange(jobId: string, status: string, outcome?: string, undo?: () => void) {
    const stage = stageOfStatus(status), index = sortedJobs.findIndex((job) => job.id === jobId), neighbour = sortedJobs[index + 1] ?? sortedJobs[index - 1]
    const leaving = !detailOnly && stage !== statusFilter && jobId === selected
    await loadReadiness()
    flash(stage === null ? <>Status updated to {statusText(status, outcome).toLowerCase()}. <a href={`#tracker?job=${jobId}`}>View in Tracker</a></> : status === 'saved' ? 'Job saved.' : status === 'skipped' ? 'Job skipped.' : status === 'new' ? 'Moved back to To review.' : `Status updated to ${statusText(status, outcome).toLowerCase()}.`, undo)
    if (leaving) { await loadJobs(); if (neighbour) selectJob(neighbour.id); else backToList() } else { if (jobId === selected) await loadDetail(jobId); await loadJobs() }
  }
  // Save, Skip and Restore on a row act on that job without opening it.
  async function changeStatus(job: Job, status: string) {
    try { await api(`/api/jobs/${job.id}/status`, { method: 'PUT', body: JSON.stringify({ status, submittedText: '' }) }); await afterStatusChange(job.id, status, undefined, undoTo(job.id, job.status ?? 'new')) }
    catch (error) { setNotice((error as Error).message) }
  }
  // The list is one Tab stop: only the active row's buttons are tabbable, and the arrow keys move between rows.
  function rowActions(job: Job, tab: 0 | -1) {
    const stage = stageOfStatus(job.status ?? 'new'), name = `${job.title || 'Untitled role'} at ${job.company || 'a company'}`
    if (stage === 'new') return <><button className="button small" tabIndex={tab} aria-label={`Save ${name}`} onClick={() => void changeStatus(job, 'saved')}>Save</button><button className="text-button small" tabIndex={tab} aria-label={`Skip ${name}`} onClick={() => void changeStatus(job, 'skipped')}>Skip</button></>
    if (stage === 'saved') return <button className="text-button small" tabIndex={tab} aria-label={`Skip ${name}`} onClick={() => void changeStatus(job, 'skipped')}>Skip</button>
    if (stage === 'skipped') return <button className="button small" tabIndex={tab} aria-label={`Restore ${name} to To review`} onClick={() => void changeStatus(job, 'new')}>Restore</button>
    return null
  }
  async function updateStatus(choice: string) {
    if (!selected) return
    const { status, outcome } = splitChoice(choice)
    if (status === 'applied' && !detail?.job.appliedAt) { setShowSubmit(true); return }
    const before = detail?.job.status ?? 'new'
    try { await api(`/api/jobs/${selected}/status`, { method: 'PUT', body: JSON.stringify({ status, ...(outcome ? { outcome } : {}), submittedText: '' }) }); await afterStatusChange(selected, status, outcome, stageOfStatus(before) && stageOfStatus(status) ? undoTo(selected, before) : undefined) }
    catch (error) { setNotice((error as Error).message) }
  }
  function runNextAction(id: NextActionId) {
    if (id === 'extract' || id === 'tailor') void startRun(id)
    else if (id === 'track') void updateStatus('saved')
    else if (id === 'review' || id === 'apply') location.hash = `#jobs/${selected}/review${id === 'apply' ? '?apply' : ''}`
  }

  // When the fit check that Tailor résumé asked for has finished, start tailoring; if it failed, stop waiting.
  useEffect(() => {
    if (!chainTailor.current || chainTailor.current !== selected || !analysis) return
    const extractRun = analysis.runs.find((run) => run.kind === 'extract')
    if (analysis.extraction) { chainTailor.current = null; void startRun('tailor') }
    else if (extractRun?.status === 'failed') chainTailor.current = null
  }, [analysis])
  const detailOnly = !!detail && stageOfStatus(detail.job.status ?? 'new') === null
  const shownJobs = sortedJobs.slice(0, limit)
  const stopId = shownJobs.some((job) => job.id === activeRow) ? activeRow : shownJobs.some((job) => job.id === selected) ? selected : shownJobs[0]?.id
  const active = latestRun(analysis), activeLabel = active && (active.status === 'queued' || active.status === 'running') ? (active.kind === 'extract' ? 'Checking…' : 'Tailoring…') : undefined
  const action = detail ? nextAction({ status: detail.job.status ?? 'new', hasExtraction: !!analysis?.extraction, hasDraft: !!analysis?.tailored, hasExport }) : null
  const noJobs = counts?.all === 0 && !selected
  const listing = !noJobs && !detailOnly
  // On a wide screen the first job opens by itself, so the pane beside the list is never empty. Phones start at the list.
  // Only while the address is the Jobs list: the page is still mounted for a moment when another tab is chosen, and must not pull the address back.
  const firstId = sortedJobs[0]?.id
  useEffect(() => { if (selected || noJobs || !firstId || !window.matchMedia?.('(min-width: 881px)').matches) return; if (!/^(#jobs?)?$/.test(location.hash)) return; location.replace(`#jobs/${firstId}`) }, [selected, noJobs, firstId])
  return <main className={`shell${selected ? ' detail-open' : ''}`} id="main" tabIndex={-1}>
    <AppHeader current="jobs" />
    <PageHeader title="Jobs" actions={<>{feed?.configured && <>{feed.lastCheckedAt && <span className="subtle feed-checked">Last checked {new Date(feed.lastCheckedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}<button className="button secondary" disabled={checking} onClick={() => void checkFeed(true)}>{checking ? 'Checking…' : 'Check for new jobs'}</button></>}{batch.button}<button className="button primary" onClick={() => setShowAdd(true)}><Icon name="plus" />Add job</button></>}>Jobs you have not applied to yet. Applied jobs are in the <a href="#tracker">Tracker</a>{counts && counts.applied > 0 ? ` (${counts.applied})` : ''}.</PageHeader>
    {notice && <Toast error onClose={() => setNotice('')}>{notice}</Toast>}
    {toast && <Toast onUndo={toast.undo} onClose={() => setToast(null)}>{toast.text}</Toast>}
    {batch.panel}
    {listing && <>
      <div className="toolbar"><label className="search"><Icon name="search" /><input aria-label="Search jobs" value={query} placeholder="Search title or company" onChange={(e) => setQuery(e.target.value)} /></label><label className="select">Sort<select value={sort} onChange={(event) => setSort(event.target.value as 'newest' | 'company')}><option value="newest">Newest first</option><option value="company">Company A–Z</option></select></label></div>
      <div className="chips" role="group" aria-label="Show jobs">{stageOptions.map(([value, label]) => <button key={value} type="button" className="chip" aria-pressed={statusFilter === value} onClick={() => setStatusFilter(value)}><Icon name="check" />{label}{counts && <span className="n">{counts[value]}</span>}</button>)}<span className="spacer" />{(feed?.configured || (counts?.triage ?? 0) > 0) && <label className="toggle"><input type="checkbox" checked={feedOnly && statusFilter === 'new'} disabled={statusFilter !== 'new'} onChange={(event) => setFeedOnly(event.target.checked)} />Only from the job feed{counts ? ` (${counts.triage})` : ''}</label>}</div>
    </>}
    {noJobs ? <Quickstart readiness={readiness} onAdd={() => setShowAdd(true)} /> : <div className={`jobs-layout ${selected ? 'has-selection' : ''} ${detailOnly ? 'detail-only' : ''}`}>
      <div className={`list-col ${feedOnly && statusFilter === 'new' ? 'feed-only' : ''}`}><div className="list-scroll" aria-label="Job list">
        {shownJobs.length > 1 && <p className="list-hint" id="list-hint">Use the up and down arrow keys to move between jobs.</p>}
        {shownJobs.length > 0 && <ul className="job-list" aria-describedby={shownJobs.length > 1 ? 'list-hint' : undefined} aria-label={`${stageOptions.find(([value]) => value === statusFilter)?.[1]} jobs`} onKeyDown={moveFocus}>{shownJobs.map((job) => { const tab = job.id === stopId ? 0 : -1; return <li key={job.id} className={`job-row ${selected === job.id ? 'sel' : ''}`} onFocus={() => setActiveRow(job.id)}><button className={`job-card job-main ${selected === job.id ? 'selected' : ''}`} tabIndex={tab} aria-current={selected === job.id ? 'true' : undefined} onClick={() => selectJob(job.id)}><span className="job-card-heading"><strong className="jr-title">{job.title || '(Untitled role)'}</strong></span><span className="jr-sub">{job.company || 'Company not set'}{job.location ? ` · ${job.location}` : ''}</span><span className="jr-meta">{job.status !== 'skipped' && <FitMeter fit={job.fit} pending={job.latestRun?.kind === 'extract' && job.latestRun.status !== 'done' && job.latestRun.status !== 'failed'} />}<PriorityMeter job={job} /><small>{job.origin === 'feed' ? `Found ${ago(job.postedAt ?? job.foundAt ?? job.capturedAt)}` : `Added ${ago(job.capturedAt)}`}</small>{runBadge(job)}{feedBadges(job)}{warningCount(job) > 0 && <span className="tag tag-warn">{warningCount(job)} to check</span>}</span></button><span className="jr-actions">{rowActions(job, tab)}</span></li> })}</ul>}
        {jobs.length === 0 && <div className="empty-note"><strong>{feedOnly && statusFilter === 'new' ? 'Nothing from the job feed is waiting for you.' : query ? 'No jobs match your search.' : emptyText[statusFilter]}</strong></div>}
        {sortedJobs.length > limit && <button className="button more-jobs" onClick={() => setLimit(limit + pageSize)}>Show {Math.min(pageSize, sortedJobs.length - limit)} more ({sortedJobs.length - limit} left)</button>}
      </div></div>
      <section className="job-pane" aria-label="Selected job">
        {detail && action ? <div className="panel job-detail">
          <JobHeader detail={detail} action={action} estimate={estimate} estimateError={estimateError} busy={busy || !analysis} activeLabel={activeLabel} inTracker={detailOnly} onAction={() => runNextAction(action.id)} onTailor={() => void tailorFirst()} onStatus={(status) => void updateStatus(status)} onBack={backToList} />
          {showSubmit && <SubmissionForm key={selected} jobId={selected!} onSaved={async () => { setShowSubmit(false); await afterStatusChange(selected!, 'applied') }} onCancel={() => setShowSubmit(false)} />}
          <RunStrip analysis={analysis} dismissed={dismissedRun} onDismiss={setDismissedRun} onRetry={(id) => void retryRun(id)} busy={busy} />
          <JobTabs tab={tab} onTab={setTab} analysis={analysis} />
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="job-tab-panel">
            {tab === 'overview' && <JobOverview job={detail.job} text={detail.job.text} analysis={analysis} busy={busy} onCheck={() => { setTab('fit'); void startRun('extract') }} onViewFit={() => setTab('fit')} />}
            {tab === 'fit' && <JobFit jobId={selected!} analysis={analysis} busy={busy} onCheck={() => void startRun('extract')} />}
            {tab === 'resume' && <JobResume jobId={selected!} analysis={analysis} busy={busy} onRetry={(id) => void retryRun(id)} />}
          </div>
        </div> : selected ? <p className="loading panel job-detail" role="status">Loading job…</p> : <div className="panel job-empty"><h2>Select a job</h2><p className="subtle">Pick a job from the list to see its requirements, résumé and history. Use Add job to save a new posting.</p></div>}
      </section>
    </div>}
    {showAdd && <AddJobDialog onClose={() => setShowAdd(false)} onOpenExisting={(id) => { setShowAdd(false); selectJob(id) }} onSaved={async (id) => { setShowAdd(false); setStatusFilter('new'); setFeedOnly(false); await loadJobs('new', false); selectJob(id); await loadReadiness(); flash('Job saved.') }} />}
  </main>
}
