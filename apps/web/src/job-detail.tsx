import { choiceOf, stageClass, statusChoices, statusText, type NextAction } from './stages.js'

export type LatestRun = { kind: string; status: string; step: string }
export type Job = { id: string; latestRun?: LatestRun | null; company: string; title: string; capturedAt: string; status: string; outcome?: string | null; location: string; summary: string; sourceUrl?: string; applyUrl?: string; knockouts?: Array<{ quote: string; assessment: 'met' | 'gap' | 'unknown' }>; origin?: 'manual' | 'feed'; foundAt?: string | null; postedAt?: string | null; finderPriority?: string | null; postingState?: 'summary' | 'summary_only' | 'full' | 'maybe_closed' | null; flagCount?: number; finder?: Finder | null }
export type Finder = { flags: string; whyItFits: string; source: string; similarTo: string | null }
export type Answer = { id: string; question: string; answer: string; submittedAnswer: string | null; category: string; charLimit: number | null }
export type Detail = { job: Job & { text: string; notes?: string; submittedText?: string; appliedAt?: string }; answers: Answer[]; events: { status: string; createdAt: string }[] }
export type Requirement = { id: string; quote: string; kind: 'knockout' | 'hard' | 'nice'; category: string; skill: string; start: number; end: number; assessment: 'met' | 'gap' | 'unknown'; basis: string }
export type Gap = { requirementId: string; quote: string; reason: string }
export type Analysis = { extraction: { requirements: Requirement[]; seniority: string; vocabulary: string[]; partial: boolean } | null; preliminaryGaps: Gap[]; tailored: { runId: string; summary: { text: string; verdict: string; flags: string[] } | null; skillsLine: string[]; lines: Array<{ outId: string; text: string; sourceIds: string[]; verdict: string; layer1Flags: string[]; layer2Reason: string; slopFlags: string[] }>; gaps: Gap[]; exportReady: boolean } | null; runs: Array<{ id: string; kind: string; status: string; step: string; error: string | null; usage: string | null; costEstimate: number | null; finishedAt?: string | null }> }
export type Estimate = { estimatedUsd: number; capUsd: number; monthlyCapUsd: number; spentThisMonthUsd: number; allowed: boolean; note: string }

export type JobTab = 'overview' | 'resume'
const tabLabels: Record<JobTab, string> = { overview: 'Overview', resume: 'Résumé' }

function highlighted(text: string, requirements: Requirement[]) {
  const ordered = [...requirements].sort((a, b) => a.start - b.start || b.end - a.end)
  const parts: React.ReactNode[] = []; let cursor = 0
  for (const item of ordered) {
    if (item.start < cursor || item.end > text.length || item.end <= item.start) continue
    parts.push(text.slice(cursor, item.start))
    parts.push(<mark key={item.id} className={`jd-mark jd-${item.assessment}`}>{text.slice(item.start, item.end)}</mark>)
    cursor = item.end
  }
  parts.push(text.slice(cursor))
  return parts
}

export function JobHeader({ detail, action, estimate, estimateError, busy, activeLabel, onAction, onTailor, onStatus, onBack, inTracker = false }: { detail: Detail; onTailor: () => void; action: NextAction; estimate: Estimate | null; estimateError: string; busy: boolean; activeLabel?: string; onAction: () => void; onStatus: (status: string) => void; onBack: () => void; inTracker?: boolean }) {
  const { job } = detail
  const costNote = estimate ? `Estimated API cost: $${estimate.estimatedUsd.toFixed(4)} · per-run cap: $${estimate.capUsd.toFixed(2)} · this month: $${estimate.spentThisMonthUsd.toFixed(2)} of $${estimate.monthlyCapUsd.toFixed(2)}. ${estimate.note}` : estimateError || 'Checking the cost estimate…'
  const blocked = action.id === 'tailor' && !estimate?.allowed
  return <header className="job-header">
    {inTracker ? <a className="back-link" href={`#tracker?job=${detail.job.id}`}>← Back to Tracker</a> : <button className="text-button back-button" onClick={onBack}>← All jobs</button>}
    <div className="job-header-row">
      <div className="job-title-block"><h2>{job.title || '(Untitled role)'}</h2><p>{job.company || 'Company not set'}{job.location ? ` · ${job.location}` : ''}</p></div>
      <span className={stageClass(job.status ?? 'new')}>{statusText(job.status, job.outcome)}</span>
    </div>
    <div className="job-actions">
      {action.id === 'extract' ? <><button className="button primary" disabled={busy || Boolean(activeLabel)} onClick={onTailor}>{activeLabel ?? 'Tailor résumé'}</button><button className="button" disabled={busy || Boolean(activeLabel)} onClick={onAction}>Check fit</button></> : action.id === 'tracker' ? <a className="button primary" href={`#tracker?job=${job.id}`}>{action.label}</a> : action.id !== 'none' && <button className="button primary" disabled={busy || blocked || Boolean(activeLabel)} onClick={onAction}>{activeLabel ?? action.label}</button>}
      {(job.status ?? 'new') === 'new' && <div className="triage-actions" role="group" aria-label="Decide about this job">{action.id !== 'tracker' && <button className="button" disabled={busy} onClick={() => onStatus('saved')}>Save job</button>}<button className="text-button" disabled={busy} onClick={() => onStatus('skipped')}>Skip</button></div>}
      {job.status === 'saved' && <button className="text-button" disabled={busy} onClick={() => onStatus('skipped')}>Skip</button>}
      <details className="more-menu"><summary>More</summary><div className="more-panel">
        <label className="status-select">Exact status<select value={choiceOf(job.status ?? 'new', job.outcome)} onChange={(e) => onStatus(e.target.value)}>{statusChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
        {['new', 'saved'].includes(job.status ?? 'new') && <button className="text-button" disabled={busy} onClick={() => onStatus('applied')}>Already applied</button>}
        {!['new', 'saved', 'skipped'].includes(job.status ?? 'new') && <button className="text-button" onClick={() => onStatus('skipped')}>Skip this job</button>}
        {job.sourceUrl && <a className="external-link" href={job.sourceUrl} target="_blank" rel="noreferrer">Open original posting ↗</a>}
        {job.applyUrl && <a className="external-link" href={job.applyUrl} target="_blank" rel="noreferrer">Continue to application ↗</a>}
        <a className="external-link" href={`/api/jobs/${job.id}/snapshot`} download="job-capture.txt">Download original capture</a>
      </div></details>
    </div>
    <p className="subtle next-hint">{action.id === 'tailor' ? costNote : action.id === 'extract' ? 'Tailor résumé checks the fit first, then writes a draft from your master résumé. Check fit only compares the posting with your profile and résumé.' : action.hint}</p>
  </header>
}

const runLabels: Record<string, string> = { extract: 'Fit check', tailor: 'Tailoring' }
type AnalysisRun = Analysis['runs'][number]
// The newest fit check or tailoring run (older ones and re-verification runs are in the Résumé section's run list).
export function latestRun(analysis: Analysis | null): AnalysisRun | null { return analysis?.runs.find((run) => run.kind === 'extract' || run.kind === 'tailor') ?? null }
// A finished run is announced only while it is recent, so opening an old job does not show a stale "finished" message.
const recentMs = 10 * 60 * 1000

// What the last fit check or tailoring run is doing, under the job header so it shows in every section.
export function RunStrip({ analysis, dismissed, onDismiss, onRetry, busy }: { analysis: Analysis | null; dismissed: string | null; onDismiss: (runId: string) => void; onRetry: (runId: string) => void; busy: boolean }) {
  const run = latestRun(analysis)
  if (!run) return null
  const label = runLabels[run.kind] ?? run.kind
  if (run.status === 'queued') return <p className="run-strip run-waiting" role="status">{label} is waiting in the queue…</p>
  if (run.status === 'running') return <p className="run-strip run-active" role="status">{label} is running{run.step && run.step !== 'starting' ? `: ${run.step}` : '…'}</p>
  if (run.status === 'failed') return <div className="run-strip run-failed" role="status"><span>{label} failed{run.error ? `: ${run.error}` : '.'}</span><button className="text-button" disabled={busy} onClick={() => onRetry(run.id)}>Retry</button></div>
  if (run.status === 'done' && dismissed !== run.id && run.finishedAt && Date.now() - Date.parse(run.finishedAt) < recentMs) {
    const requirements = analysis?.extraction?.requirements ?? []
    const result = run.kind === 'extract' ? `${requirements.length} requirement${requirements.length === 1 ? '' : 's'} found, ${requirements.filter((r) => r.kind === 'knockout').length} knockout condition${requirements.filter((r) => r.kind === 'knockout').length === 1 ? '' : 's'}.` : `${analysis?.tailored?.lines.length ?? 0} draft lines ready to review.`
    return <div className="run-strip run-done" role="status"><span>{label} finished: {result}</span><button className="text-button" onClick={() => onDismiss(run.id)}>Dismiss</button></div>
  }
  return null
}

// What the job finder said about a job. It is not checked by this app and never goes to a model.
export function FinderPanel({ job, finder }: { job: Detail['job']; finder: Finder }) {
  const flags = finder.flags.split(/[;\n]+/).map((flag) => flag.trim()).filter(Boolean)
  return <section className="finder-panel" aria-label="From your job finder"><h3>From your job finder</h3>
    <p className="subtle">Written by the tool that found this job. Role Clinic has not checked it; the fit check below is the authority.</p>
    <dl>{job.finderPriority && <><dt>Priority</dt><dd>{job.finderPriority}</dd></>}{!!flags.length && <><dt>Flags</dt><dd><ul>{flags.map((flag) => <li key={flag}>{flag}</li>)}</ul></dd></>}{finder.whyItFits && <><dt>Why it fits</dt><dd>{finder.whyItFits}</dd></>}{finder.source && <><dt>Source</dt><dd>{finder.source}</dd></>}{finder.similarTo && <><dt>Similar job</dt><dd>You already have {finder.similarTo}.</dd></>}</dl>
  </section>
}
export function PostingNotice({ job }: { job: Detail['job'] }) {
  if (job.postingState === 'maybe_closed') return <p className="review-flag" role="status">The posting page looks closed or removed. Open the original to check before you spend time on it.</p>
  if (job.origin === 'feed' && (job.postingState === 'summary' || job.postingState === 'summary_only')) return <p className="subtle posting-notice" role="status">{job.postingState === 'summary' ? 'Fetching the full posting…' : 'Only a summary was imported, because the full posting could not be fetched.'} A fit check works better on the full description: open the original and paste it with Add job, or check fit on this summary.</p>
  return null
}

export function JobTabs({ tab, onTab }: { tab: JobTab; onTab: (tab: JobTab) => void }) {
  // Left and Right move between sections; only the current one is in the Tab order.
  function keys(event: React.KeyboardEvent<HTMLDivElement>) {
    const order = Object.keys(tabLabels) as JobTab[], step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = order[(order.indexOf(tab) + step + order.length) % order.length]
    onTab(next); document.getElementById(`tab-${next}`)?.focus()
  }
  return <div className="job-tabs" role="tablist" aria-label="Job sections" onKeyDown={keys}>{(Object.keys(tabLabels) as JobTab[]).map((key) => <button key={key} role="tab" id={`tab-${key}`} aria-selected={tab === key} aria-controls={`panel-${key}`} tabIndex={tab === key ? 0 : -1} className={`job-tab ${tab === key ? 'active' : ''}`} onClick={() => onTab(key)}>{tabLabels[key]}</button>)}</div>
}

export function JobOverview({ job, text, analysis, busy, canExtract, onExtract }: { job?: Detail['job']; text: string; analysis: Analysis | null; busy: boolean; canExtract: boolean; onExtract: () => void }) {
  const requirements = analysis?.extraction?.requirements ?? []
  const active = analysis?.runs.some((run) => run.status === 'queued' || run.status === 'running') ?? false
  const gaps = analysis?.tailored?.gaps ?? analysis?.preliminaryGaps ?? []
  return <div className="job-overview">
    {job && <PostingNotice job={job} />}
    {job?.finder && <FinderPanel job={job} finder={job.finder} />}
    <div className="panel-heading"><div><h3>What the posting asks for</h3></div>{analysis?.extraction ? <button className="button secondary" disabled={busy || active} onClick={onExtract}>Refresh requirements</button> : canExtract && <button className="button secondary" disabled={busy || active} onClick={onExtract}>Check fit</button>}</div>
    {!analysis?.extraction && <p className="subtle">Check fit finds the requirements in this posting and compares them with your profile and résumé.</p>}
    {analysis?.extraction?.partial && <p className="review-flag">Extraction covered only part of this posting or skipped an unmatched quote. Review the full description.</p>}
    <details open={requirements.length > 0}><summary>Saved job description {requirements.length ? '· cited highlights' : ''}</summary><pre className="job-text">{highlighted(text, requirements)}</pre></details>
    {analysis?.extraction && <div className="requirement-grid"><div><h4>Knockout checks</h4><p className="subtle">Conditions the posting states outright, such as years of experience or work authorization. They warn you; they never block anything.</p>{requirements.filter((r) => r.kind === 'knockout').map((r) => <article className="requirement-card" key={r.id}><span className={`gate gate-${r.assessment}`}>{r.assessment}</span><strong>{r.quote}</strong><p>{r.basis}</p></article>)}{!requirements.some((r) => r.kind === 'knockout') && <p className="subtle">No explicit knockout condition was extracted.</p>}</div><div><h4>Other requirements</h4>{requirements.filter((r) => r.kind !== 'knockout').map((r) => <article className="requirement-card" key={r.id}><span className="gate gate-neutral">{r.kind}</span><strong>{r.quote}</strong><p>{r.basis}</p></article>)}{!requirements.length && <p className="subtle">No requirements were extracted. Review the source posting.</p>}</div></div>}
    {analysis?.extraction && <div className="gap-panel"><h4>Experience your résumé doesn’t show yet</h4>{gaps.length ? gaps.map((gap) => { const requirement = requirements.find((r) => r.id === gap.requirementId); return <article className="gap-row" key={gap.requirementId}><div><strong>{gap.quote}</strong><p>{gap.reason}</p></div>{requirement?.category === 'skill' && <a href={`#resume?skill=${encodeURIComponent(requirement.skill || requirement.quote)}`}>Add real evidence ↗</a>}</article> }) : <p className="subtle">No clear gaps found in the extracted requirements. Review the posting and your master résumé yourself.</p>}</div>}
  </div>
}

// Plain words for what a run was and how it ended.
const runKindWords: Record<string, string> = { extract: 'Fit check', tailor: 'Tailoring' }
const runStatusWords: Record<string, string> = { done: 'finished', failed: 'failed', running: 'running', queued: 'waiting', canceled: 'canceled' }
export function JobResume({ jobId, analysis, busy, onRetry }: { jobId: string; analysis: Analysis | null; busy: boolean; onRetry: (id: string) => void }) {
  const active = analysis?.runs.some((run) => run.status === 'queued' || run.status === 'running') ?? false, lines = analysis?.tailored?.lines.length ?? 0
  return <div className="job-resume">
    {analysis?.tailored ? <section className="review-entry"><h3>Tailor a résumé for this job</h3><p className="subtle">{lines} suggested line{lines === 1 ? ' is' : 's are'} ready. Review each one next to a live preview, then export a DOCX or PDF.</p><a className="button primary" href={`#jobs/${jobId}/review`}>Open the review</a></section>
      : <p className="subtle">{analysis?.extraction ? 'No draft yet. Use Tailor résumé above to write one from your master résumé.' : 'Check the fit first; the draft is written from the requirements it finds.'}</p>}
    {!!analysis?.runs.length && <div className="run-list"><h4>Runs</h4>{analysis.runs.slice(0, 5).map((run) => { const usage = run.usage ? JSON.parse(run.usage) as { totalUsd?: number } : null; return <div className="run-row" key={run.id}><span>{runKindWords[run.kind] ?? run.kind} · {runStatusWords[run.status] ?? run.status}{run.status === 'done' ? '' : ` · ${run.step}`}{usage?.totalUsd ? ` · $${usage.totalUsd.toFixed(4)}` : ''}</span>{run.error && <span className="review-flag">{run.error}</span>}{run.status === 'failed' && run.kind !== 'reverify' && <button className="text-button" disabled={busy || active} onClick={() => onRetry(run.id)}>Retry</button>}</div> })}</div>}
  </div>
}
