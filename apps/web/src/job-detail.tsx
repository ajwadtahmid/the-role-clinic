import { JobAnswers } from './answers.js'
import { TailoringWorkspace } from './tailoring-workspace.js'
import { stageLabel, type NextAction } from './stages.js'

export type Job = { id: string; company: string; title: string; capturedAt: string; status: string; location: string; summary: string; sourceUrl?: string; applyUrl?: string; knockouts?: Array<{ quote: string; assessment: 'met' | 'gap' | 'unknown' }> }
export type Answer = { id: string; question: string; answer: string; submittedAnswer: string | null; category: string; charLimit: number | null }
export type Detail = { job: Job & { text: string; notes?: string; submittedText?: string; appliedAt?: string }; answers: Answer[]; events: { status: string; createdAt: string }[] }
export type Requirement = { id: string; quote: string; kind: 'knockout' | 'hard' | 'nice'; category: string; skill: string; start: number; end: number; assessment: 'met' | 'gap' | 'unknown'; basis: string }
export type Gap = { requirementId: string; quote: string; reason: string }
export type Analysis = { extraction: { requirements: Requirement[]; seniority: string; vocabulary: string[]; partial: boolean } | null; preliminaryGaps: Gap[]; tailored: { runId: string; summary: { text: string; verdict: string; flags: string[] } | null; skillsLine: string[]; lines: Array<{ outId: string; text: string; sourceIds: string[]; verdict: string; layer1Flags: string[]; layer2Reason: string; slopFlags: string[] }>; gaps: Gap[]; exportReady: boolean } | null; runs: Array<{ id: string; kind: string; status: string; step: string; error: string | null; usage: string | null; costEstimate: number | null }> }
export type Estimate = { estimatedUsd: number; capUsd: number; monthlyCapUsd: number; spentThisMonthUsd: number; allowed: boolean; note: string }

export const statuses = ['new', 'saved', 'applied', 'screening', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn', 'ghosted', 'skipped']
export type JobTab = 'overview' | 'resume' | 'answers' | 'history'
const tabLabels: Record<JobTab, string> = { overview: 'Overview', resume: 'Résumé', answers: 'Answers', history: 'History' }

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

export function JobHeader({ detail, action, estimate, estimateError, busy, onAction, onStatus, onBack }: { detail: Detail; action: NextAction; estimate: Estimate | null; estimateError: string; busy: boolean; onAction: () => void; onStatus: (status: string) => void; onBack: () => void }) {
  const { job } = detail
  const costNote = estimate ? `Estimated API cost: $${estimate.estimatedUsd.toFixed(4)} · per-run cap: $${estimate.capUsd.toFixed(2)} · this month: $${estimate.spentThisMonthUsd.toFixed(2)} of $${estimate.monthlyCapUsd.toFixed(2)}. ${estimate.note}` : estimateError || 'Checking the cost estimate…'
  const blocked = action.id === 'tailor' && !estimate?.allowed
  return <header className="job-header">
    <button className="text-button back-button" onClick={onBack}>← All jobs</button>
    <div className="job-header-row">
      <div className="job-title-block"><h2>{job.title || '(Untitled role)'}</h2><p>{job.company || 'Company not set'}{job.location ? ` · ${job.location}` : ''} <span className={`status status-${job.status}`}>{stageLabel(job.status)}</span></p></div>
      <div className="job-actions">
        {action.id === 'followup' ? <a className="button primary" href="#tracker">{action.label}</a> : action.id !== 'none' && <button className="button primary" disabled={busy || blocked} onClick={onAction}>{action.label}</button>}
        <details className="more-menu"><summary>More</summary><div className="more-panel">
          <label className="status-select">Exact status<select value={job.status ?? 'new'} onChange={(e) => onStatus(e.target.value)}>{statuses.map((s) => <option key={s}>{s}</option>)}</select></label>
          {job.status !== 'skipped' && <button className="text-button" onClick={() => onStatus('skipped')}>Skip this job</button>}
          {job.sourceUrl && <a className="external-link" href={job.sourceUrl} target="_blank" rel="noreferrer">Open original posting ↗</a>}
          {job.applyUrl && <a className="external-link" href={job.applyUrl} target="_blank" rel="noreferrer">Continue to application ↗</a>}
          <a className="external-link" href={`/api/jobs/${job.id}/snapshot`} download="job-capture.txt">Download original capture</a>
        </div></details>
      </div>
    </div>
    <p className="subtle next-hint">{action.id === 'tailor' ? costNote : action.hint}</p>
  </header>
}

export function JobTabs({ tab, onTab, answerCount }: { tab: JobTab; onTab: (tab: JobTab) => void; answerCount: number }) {
  // Left and Right move between sections; only the current one is in the Tab order.
  function keys(event: React.KeyboardEvent<HTMLDivElement>) {
    const order = Object.keys(tabLabels) as JobTab[], step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = order[(order.indexOf(tab) + step + order.length) % order.length]
    onTab(next); document.getElementById(`tab-${next}`)?.focus()
  }
  return <div className="job-tabs" role="tablist" aria-label="Job sections" onKeyDown={keys}>{(Object.keys(tabLabels) as JobTab[]).map((key) => <button key={key} role="tab" id={`tab-${key}`} aria-selected={tab === key} aria-controls={`panel-${key}`} tabIndex={tab === key ? 0 : -1} className={`job-tab ${tab === key ? 'active' : ''}`} onClick={() => onTab(key)}>{tabLabels[key]}{key === 'answers' && answerCount > 0 ? ` (${answerCount})` : ''}</button>)}</div>
}

export function JobOverview({ text, analysis, busy, canExtract, onExtract }: { text: string; analysis: Analysis | null; busy: boolean; canExtract: boolean; onExtract: () => void }) {
  const requirements = analysis?.extraction?.requirements ?? []
  const active = analysis?.runs.some((run) => run.status === 'queued' || run.status === 'running') ?? false
  const gaps = analysis?.tailored?.gaps ?? analysis?.preliminaryGaps ?? []
  return <div className="job-overview">
    <div className="panel-heading"><div><h3>What the posting asks for</h3></div>{analysis?.extraction ? <button className="button secondary" disabled={busy || active} onClick={onExtract}>Refresh requirements</button> : canExtract && <button className="button secondary" disabled={busy || active} onClick={onExtract}>Check fit</button>}</div>
    {!analysis?.extraction && <p className="subtle">Check fit finds the requirements in this posting and compares them with your profile and résumé.</p>}
    {analysis?.extraction?.partial && <p className="review-flag">Extraction covered only part of this posting or skipped an unmatched quote. Review the full description.</p>}
    <details open={requirements.length > 0}><summary>Saved job description {requirements.length ? '· cited highlights' : ''}</summary><pre className="job-text">{highlighted(text, requirements)}</pre></details>
    {analysis?.extraction && <div className="requirement-grid"><div><h4>Knockout checks</h4><p className="subtle">Conditions the posting states outright, such as years of experience or work authorization. They warn you; they never block anything.</p>{requirements.filter((r) => r.kind === 'knockout').map((r) => <article className="requirement-card" key={r.id}><span className={`gate gate-${r.assessment}`}>{r.assessment}</span><strong>{r.quote}</strong><p>{r.basis}</p></article>)}{!requirements.some((r) => r.kind === 'knockout') && <p className="subtle">No explicit knockout condition was extracted.</p>}</div><div><h4>Other requirements</h4>{requirements.filter((r) => r.kind !== 'knockout').map((r) => <article className="requirement-card" key={r.id}><span className="gate gate-neutral">{r.kind}</span><strong>{r.quote}</strong><p>{r.basis}</p></article>)}{!requirements.length && <p className="subtle">No requirements were extracted. Review the source posting.</p>}</div></div>}
    {analysis?.extraction && <div className="gap-panel"><h4>Experience your résumé doesn’t show yet</h4>{gaps.length ? gaps.map((gap) => { const requirement = requirements.find((r) => r.id === gap.requirementId); return <article className="gap-row" key={gap.requirementId}><div><strong>{gap.quote}</strong><p>{gap.reason}</p></div>{requirement?.category === 'skill' && <a href={`#resume?skill=${encodeURIComponent(requirement.skill || requirement.quote)}`}>Add real evidence ↗</a>}</article> }) : <p className="subtle">No clear gaps found in the extracted requirements. Review the posting and your master résumé yourself.</p>}</div>}
  </div>
}

export function JobResume({ jobId, detail, analysis, busy, onRetry, onApplied, onExported }: { jobId: string; detail: Detail; analysis: Analysis | null; busy: boolean; onRetry: (id: string) => void; onApplied: () => void; onExported: () => void }) {
  const active = analysis?.runs.some((run) => run.status === 'queued' || run.status === 'running') ?? false
  return <div className="job-resume">
    {!analysis?.tailored && <p className="subtle">{analysis?.extraction ? 'No draft yet. Use Tailor résumé above to write one from your master résumé.' : 'Check the fit first; the draft is written from the requirements it finds.'}</p>}
    {!!analysis?.runs.length && <div className="run-list"><h4>Runs</h4>{analysis.runs.slice(0, 5).map((run) => { const usage = run.usage ? JSON.parse(run.usage) as { totalUsd?: number } : null; return <div className="run-row" key={run.id}><span>{run.kind} · {run.status} · {run.step}{usage?.totalUsd ? ` · $${usage.totalUsd.toFixed(4)}` : ''}</span>{run.error && <span className="review-flag">{run.error}</span>}{run.status === 'failed' && run.kind !== 'reverify' && <button className="text-button" disabled={busy || active} onClick={() => onRetry(run.id)}>Retry</button>}</div> })}</div>}
    {analysis?.tailored && <TailoringWorkspace key={`${jobId}-${analysis.tailored.runId}`} jobId={jobId} company={detail.job.company} title={detail.job.title} onApplied={onApplied} onExported={onExported} />}
  </div>
}

export function JobAnswersPanel({ jobId, detail, onSaved }: { jobId: string; detail: Detail; onSaved: () => void | Promise<void> }) {
  return <div className="job-answers-panel"><a className="external-link" href="#answers">Open answer library →</a><JobAnswers key={jobId} jobId={jobId} answers={detail.answers} onSaved={onSaved} /></div>
}

export function JobHistory({ detail }: { detail: Detail }) {
  return <div className="job-history">
    {detail.events.length > 0 ? <ol className="history-list">{detail.events.map((event, i) => <li key={i}><strong>{stageLabel(event.status)}</strong> <span className="subtle">({event.status}) · {new Date(event.createdAt).toLocaleDateString()}</span></li>)}</ol> : <p className="subtle">No status changes yet.</p>}
    {detail.job.submittedText && <details><summary>Submitted application text</summary><pre className="job-text">{detail.job.submittedText}</pre></details>}
  </div>
}
