import { useEffect, useState } from 'react'

type Job = { id: string; company: string; title: string; capturedAt: string; status: string; location: string; summary: string; sourceUrl?: string; applyUrl?: string; knockouts?: Array<{ quote: string; assessment: 'met' | 'gap' | 'unknown' }> }
type Answer = { id: string; question: string; answer: string; submittedAnswer: string | null; category: string; charLimit: number | null }
type Detail = { job: Job & { text: string; notes?: string; submittedText?: string; appliedAt?: string }; answers: Answer[]; events: { status: string; createdAt: string }[] }
type SearchAnswer = { id: string; company: string; title: string; question: string; answer: string; jobId: string }
type Requirement = { id: string; quote: string; kind: 'knockout' | 'hard' | 'nice'; category: string; skill: string; start: number; end: number; assessment: 'met' | 'gap' | 'unknown'; basis: string }
type Gap = { requirementId: string; quote: string; reason: string }
type Analysis = { extraction: { requirements: Requirement[]; seniority: string; vocabulary: string[]; partial: boolean } | null; preliminaryGaps: Gap[]; tailored: { summary: { text: string; verdict: string; flags: string[] } | null; skillsLine: string[]; lines: Array<{ outId: string; text: string; sourceIds: string[]; verdict: string; layer1Flags: string[]; layer2Reason: string; slopFlags: string[] }>; gaps: Gap[]; exportReady: boolean } | null; runs: Array<{ id: string; kind: string; status: string; step: string; error: string | null; usage: string | null; costEstimate: number | null }> }
type Estimate = { estimatedUsd: number; capUsd: number; allowed: boolean; note: string }
const statuses = ['new', 'saved', 'applied', 'screening', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn', 'ghosted', 'skipped']
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
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(data.error ?? `Request failed (${response.status})`), data)
  return data as T
}

function AnalysisPanel({ text, analysis, estimate, estimateError, busy, onExtract, onTailor, onRetry }: { text: string; analysis: Analysis | null; estimate: Estimate | null; estimateError: string; busy: boolean; onExtract: () => void; onTailor: () => void; onRetry: (id: string) => void }) {
  const requirements = analysis?.extraction?.requirements ?? []
  const active = analysis?.runs.some((run) => run.status === 'queued' || run.status === 'running') ?? false
  const gaps = analysis?.tailored?.gaps ?? analysis?.preliminaryGaps ?? []
  return <div className="analysis-section">
    <div className="panel-heading"><div><p className="eyebrow">ROLE ANALYSIS</p><h3>Requirements and evidence</h3></div><button className="button secondary" disabled={busy || active} onClick={onExtract}>{requirements.length ? 'Refresh extraction' : 'Extract requirements'}</button></div>
    {analysis?.extraction?.partial && <p className="review-flag">Extraction covered only part of this posting or skipped an unmatched quote. Review the full description.</p>}
    <details open={requirements.length > 0}><summary>Saved job description {requirements.length ? '· cited highlights' : ''}</summary><pre className="job-text">{highlighted(text, requirements)}</pre></details>
    {analysis?.extraction && <div className="requirement-grid"><div><h4>Knockout checks</h4>{requirements.filter((r) => r.kind === 'knockout').map((r) => <article className="requirement-card" key={r.id}><span className={`gate gate-${r.assessment}`}>{r.assessment}</span><strong>{r.quote}</strong><p>{r.basis}</p></article>)}{!requirements.some((r) => r.kind === 'knockout') && <p className="subtle">No explicit knockout condition was extracted.</p>}</div><div><h4>Other requirements</h4>{requirements.filter((r) => r.kind !== 'knockout').map((r) => <article className="requirement-card" key={r.id}><span className="gate gate-neutral">{r.kind}</span><strong>{r.quote}</strong><p>{r.basis}</p></article>)}{!requirements.length && <p className="subtle">No requirements were extracted. Review the source posting.</p>}</div></div>}
    {analysis?.extraction && <div className="gap-panel"><h4>Evidence gaps</h4>{gaps.length ? gaps.map((gap) => { const requirement = requirements.find((r) => r.id === gap.requirementId); return <article className="gap-row" key={gap.requirementId}><div><strong>{gap.quote}</strong><p>{gap.reason}</p></div>{requirement?.category === 'skill' && <a href={`#master?skill=${encodeURIComponent(requirement.skill || requirement.quote)}`}>Add real evidence ↗</a>}</article> }) : <p className="subtle">No clear evidence gaps found in the extracted requirements. Review the posting and master yourself.</p>}</div>}
    {analysis?.extraction && <div className="tailor-controls"><div><h4>Tailor from the master résumé</h4>{estimate ? <p className="subtle">Estimated API cost: ${estimate.estimatedUsd.toFixed(4)} · per-run cap: ${estimate.capUsd.toFixed(2)}. {estimate.note}</p> : <p className="subtle">{estimateError || 'Checking the cost estimate…'}</p>}</div><button className="button primary" disabled={busy || active || !estimate?.allowed} onClick={onTailor}>Tailor résumé</button></div>}
    {!!analysis?.runs.length && <div className="run-list"><h4>Runs</h4>{analysis.runs.slice(0, 5).map((run) => { const usage = run.usage ? JSON.parse(run.usage) as { totalUsd?: number } : null; return <div className="run-row" key={run.id}><span>{run.kind} · {run.status} · {run.step}{usage?.totalUsd ? ` · $${usage.totalUsd.toFixed(4)}` : ''}</span>{run.error && <span className="review-flag">{run.error}</span>}{run.status === 'failed' && <button className="text-button" disabled={busy || active} onClick={() => onRetry(run.id)}>Retry</button>}</div> })}</div>}
    {analysis?.tailored && <div className="tailored-review"><p className="eyebrow">DRAFT REVIEW</p><h4>Suggested content</h4>{analysis.tailored.summary && <article className="tailored-line"><span className={`gate gate-${analysis.tailored.summary.verdict}`}>Summary · {analysis.tailored.summary.verdict}</span><p>{analysis.tailored.summary.text}</p>{analysis.tailored.summary.flags.map((flag, i) => <small key={i}>{flag}</small>)}</article>}{analysis.tailored.skillsLine.length > 0 && <p className="subtle">Skills from master: {analysis.tailored.skillsLine.join(' · ')}</p>}{analysis.tailored.lines.map((line) => <article className="tailored-line" key={line.outId}><span className={`gate gate-${line.verdict}`}>{line.verdict}</span><p>{line.text}</p><small>Cites {line.sourceIds.length} master bullet(s). {line.layer2Reason}</small>{[...line.layer1Flags, ...line.slopFlags].map((flag, i) => <small className="review-flag" key={i}>{flag}</small>)}</article>)}{!analysis.tailored.exportReady && <p className="review-flag">Unsupported model-written claims need editing or removal before this draft can be exported.</p>}</div>}
  </div>
}

export function Workspace() {
  const [jobs, setJobs] = useState<Job[]>([]), [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(null)
  const [query, setQuery] = useState(''), [statusFilter, setStatusFilter] = useState('new'), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [similarJob, setSimilarJob] = useState<{ id: string; company: string; title: string } | null>(null)
  const [answerQuery, setAnswerQuery] = useState(''), [answerResults, setAnswerResults] = useState<SearchAnswer[]>([])
  const [form, setForm] = useState({ company: '', title: '', location: '', url: '', canonicalUrl: '', applyUrl: '', text: '', rawSnapshot: '', source: 'paste', captureMethod: 'paste' })
  const [qa, setQa] = useState({ question: '', answer: '', category: 'Other', charLimit: '' })
  const [editingAnswerId, setEditingAnswerId] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null), [estimate, setEstimate] = useState<Estimate | null>(null), [estimateError, setEstimateError] = useState('')
  const [onboarding, setOnboarding] = useState<{ capturedJob: boolean; hasMaster: boolean; hasProfile: boolean; configuredModels: boolean; triedTracker: boolean } | null>(null)
  async function loadOnboarding() { const result = await api<NonNullable<typeof onboarding>>('/api/onboarding'); setOnboarding(result) }
  async function loadJobs(filter = statusFilter) { const result = await api<{ jobs: Job[] }>(`/api/jobs?q=${encodeURIComponent(query)}&status=${encodeURIComponent(filter)}`); setJobs(result.jobs) }
  async function loadAnalysis(id: string) { const result = await api<Analysis>(`/api/jobs/${id}/analysis`); setAnalysis(result); if (result.extraction) { try { setEstimate(await api<Estimate>(`/api/jobs/${id}/estimate?kind=tailor`)); setEstimateError('') } catch (error) { setEstimate(null); setEstimateError((error as Error).message) } } else { setEstimate(null); setEstimateError('') } }
  async function loadDetail(id: string) { if (id !== selected) { setAnalysis(null); setEstimate(null) } setSelected(id); const result = await api<Detail>(`/api/jobs/${id}`); setDetail(result); await loadAnalysis(id) }
  useEffect(() => { void loadJobs().catch((error) => setNotice(error.message)) }, [])
  useEffect(() => { void loadOnboarding().catch((error) => setNotice(error.message)) }, [])
  useEffect(() => { const timer = window.setTimeout(() => { void api<{ answers: SearchAnswer[] }>(`/api/answers/search?q=${encodeURIComponent(answerQuery)}`).then((result) => setAnswerResults(result.answers)).catch((error: Error) => setNotice(error.message)) }, 220); return () => window.clearTimeout(timer) }, [answerQuery])
  useEffect(() => { const timer = window.setTimeout(() => { void loadJobs().catch((error) => setNotice(error.message)) }, 220); return () => window.clearTimeout(timer) }, [query, statusFilter])
  useEffect(() => { if (selected) void loadDetail(selected).catch((error) => setNotice(error.message)) }, [selected])
  useEffect(() => { if (!selected || typeof EventSource === 'undefined') return; const events = new EventSource('/api/runs/events'); events.addEventListener('run', () => { void loadAnalysis(selected).catch((error) => setNotice(error.message)); void loadJobs().catch((error) => setNotice(error.message)) }); return () => events.close() }, [selected])
  async function startRun(kind: 'extract' | 'tailor') { if (!selected) return; setBusy(true); try { const result = await api<{ run: { id: string } }>(`/api/jobs/${selected}/${kind}`, { method: 'POST', body: '{}' }); setNotice(`${kind === 'extract' ? 'Extraction' : 'Tailoring'} queued. Run ${result.run.id.slice(0, 8)}.`); await loadAnalysis(selected) } catch (error) { setNotice((error as Error).message) } finally { setBusy(false) } }
  async function retryRun(id: string) { if (!selected) return; setBusy(true); try { await api(`/api/runs/${id}/retry`, { method: 'POST', body: '{}' }); setNotice('Retry queued from the last saved step.'); await loadAnalysis(selected) } catch (error) { setNotice((error as Error).message) } finally { setBusy(false) } }
  async function capture(event?: React.FormEvent, allowSimilar = false) {
    event?.preventDefault(); setBusy(true); setNotice('')
    try { const result = await api<{ id: string }>('/api/jobs', { method: 'POST', body: JSON.stringify({ ...form, ...(allowSimilar ? { allowSimilar: true } : {}) }) }); setSimilarJob(null); setForm({ company: '', title: '', location: '', url: '', canonicalUrl: '', applyUrl: '', text: '', rawSnapshot: '', source: 'paste', captureMethod: 'paste' }); await loadJobs(); await loadDetail(result.id); await loadOnboarding(); setNotice('Job saved to your Inbox.') }
    catch (error) { const issue = error as Error & { duplicateId?: string; similar?: { id: string; company: string; title: string } }; setNotice(issue.message); setSimilarJob(issue.similar ?? null); if (issue.duplicateId) await loadDetail(issue.duplicateId) } finally { setBusy(false) }
  }
  async function captureUrl() {
    if (!form.url) { setNotice('Enter a job URL first.'); return }
    setBusy(true); setNotice('Fetching job details…')
    try { const captured = await api<typeof form>('/api/capture/url', { method: 'POST', body: JSON.stringify({ url: form.url }) }); setForm({ ...form, ...captured }); setNotice(`Captured via ${captured.captureMethod}. Review the fields, then save the job.`) }
    catch (error) { setNotice((error as Error).message) } finally { setBusy(false) }
  }
  async function updateStatus(status: string) {
    if (!selected) return
    const submittedText = status === 'applied' ? window.prompt('Optional: paste the résumé or application text you submitted. It will be frozen as a record.') ?? '' : ''
    try { await api(`/api/jobs/${selected}/status`, { method: 'PUT', body: JSON.stringify({ status, submittedText }) }); const nextFilter = status === 'new' ? 'new' : status === 'skipped' ? 'skipped' : 'tracker'; setStatusFilter(nextFilter); await loadDetail(selected); await loadJobs(nextFilter); await loadOnboarding(); setNotice(`Status updated to ${status}.`) }
    catch (error) { setNotice((error as Error).message) }
  }
  async function saveAnswer(event: React.FormEvent) {
    event.preventDefault(); if (!selected) return
    try { await api(`/api/jobs/${selected}/answers${editingAnswerId ? `/${editingAnswerId}` : ''}`, { method: editingAnswerId ? 'PUT' : 'POST', body: JSON.stringify({ ...qa, charLimit: qa.charLimit ? Number(qa.charLimit) : null }) }); setQa({ question: '', answer: '', category: 'Other', charLimit: '' }); setEditingAnswerId(null); await loadDetail(selected); setNotice('Answer saved for this job.') }
    catch (error) { setNotice((error as Error).message) }
  }
  return <main className="shell workspace-shell">
    <header className="topbar"><a className="wordmark" href="#top"><span className="mark">RC</span><span>The Role Clinic</span></a><nav><a href="#top">Inbox & tracker</a><a href="#master">Master résumé</a><a href="#profile">Profile</a><a href="#settings">Settings</a></nav><span className="local-chip"><span className="green-dot" /> Private · on this device</span></header>
    <section className="intro workspace-intro" id="top"><p className="eyebrow">JOB INBOX + TRACKER</p><h1>Your job search,<br /><em>in one place.</em></h1><p className="lede">Paste a posting to save it locally. Keep application status and answers with each job.</p></section>
    {notice && <div className="notice neutral" role="status">{notice}</div>}
    {onboarding && !(onboarding.capturedJob && onboarding.triedTracker) && <section className="panel checklist"><p className="eyebrow">GET STARTED</p><h2>Your first steps</h2><div><span>{onboarding.capturedJob ? '✓' : '○'} Capture a job</span><span>{onboarding.triedTracker ? '✓' : '○'} Update its tracker status</span><a href="#master">{onboarding.hasMaster ? '✓' : '○'} Add a master résumé (optional)</a><a href="#profile">{onboarding.hasProfile ? '✓' : '○'} Fill in your profile (optional)</a><a href="#settings">{onboarding.configuredModels ? '✓' : '○'} Choose models for later tailoring (optional)</a></div></section>}
    {similarJob && <div className="notice neutral">Similar saved job: <strong>{similarJob.title} at {similarJob.company}</strong>. <button className="text-button" disabled={busy} onClick={() => { void loadDetail(similarJob.id); setSimilarJob(null) }}>Open existing</button><button className="text-button" disabled={busy} onClick={() => void capture(undefined, true)}>Keep this as a separate job</button></div>}
    <div className="workspace-grid">
      <section className="panel capture-panel"><p className="eyebrow">INBOX</p><h2>Save a job posting</h2><form onSubmit={capture}>
        <label>Company<input required maxLength={200} value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></label>
        <label>Role title<input required maxLength={300} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        <div className="form-pair"><label>Location<input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></label><label>Job URL (optional)<input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" /></label></div>
        <button type="button" className="button secondary" disabled={busy} onClick={() => void captureUrl()}>Fetch from URL</button>
        <label>Job description<textarea required minLength={40} maxLength={100000} rows={9} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="Paste the full job description here…" /></label>
        <button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save to Inbox'}</button>
      </form></section>
      <section className="panel jobs-panel"><div className="panel-heading"><div><p className="eyebrow">INBOX & TRACKER</p><h2>Jobs <span className="count">{jobs.length}</span></h2></div><label className="status-select">View<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="new">Inbox · new</option><option value="tracker">Tracker</option><option value="skipped">Skipped</option><option value="">All jobs</option></select></label></div>
        <input className="search-input" value={query} placeholder="Search company, role, or description" onChange={(e) => setQuery(e.target.value)} />
        <div className="job-list">{jobs.map((job) => <button className={`job-card ${selected === job.id ? 'selected' : ''}`} key={job.id} onClick={() => setSelected(job.id)}><span className="job-card-heading"><strong>{job.title || '(Untitled role)'}</strong><span className={`status status-${job.status}`}>{job.status}</span></span><span>{job.company || 'Company not set'}{job.location ? ` · ${job.location}` : ''}</span><small>{new Date(job.capturedAt).toLocaleDateString()} · {(job.summary ?? '').slice(0, 115)}</small>{!!job.knockouts?.length && <span className="knockout-mini">{job.knockouts.map((gate, i) => <span key={i} className={`gate gate-${gate.assessment}`}>{gate.assessment}: {gate.quote.slice(0, 50)}</span>)}</span>}</button>)}{jobs.length === 0 && <p className="empty-state">{statusFilter === 'new' ? 'No new jobs. Paste a posting to start your Inbox.' : 'No jobs in this view.'}</p>}</div>
      </section>
    </div>
    {detail && <section className="panel detail-panel"><div className="panel-heading"><div><p className="eyebrow">JOB DETAILS</p><h2>{detail.job.title} <span className="detail-company">at {detail.job.company}</span></h2></div><label className="status-select">Status<select value={detail.job.status ?? 'new'} onChange={(e) => void updateStatus(e.target.value)}>{statuses.map((s) => <option key={s}>{s}</option>)}</select></label></div>
      {detail.job.sourceUrl && <a className="external-link" href={detail.job.sourceUrl} target="_blank" rel="noreferrer">Open original posting ↗</a>} {detail.job.applyUrl && <a className="external-link apply-link" href={detail.job.applyUrl} target="_blank" rel="noreferrer">Continue to application ↗</a>}
      <AnalysisPanel text={detail.job.text} analysis={analysis} estimate={estimate} estimateError={estimateError} busy={busy} onExtract={() => void startRun('extract')} onTailor={() => void startRun('tailor')} onRetry={(id) => void retryRun(id)} />
      <a className="external-link" href={`/api/jobs/${selected}/snapshot`} download="job-capture.txt">Download original capture</a>
      {detail.job.submittedText && <details><summary>Submitted application text</summary><pre className="job-text">{detail.job.submittedText}</pre></details>}
      <div className="qa-section"><div><p className="eyebrow">APPLICATION Q&A</p><h3>Answers for this job</h3></div>
        <form className="qa-form" onSubmit={saveAnswer}><div className="form-pair"><label>Category<input value={qa.category} onChange={(e) => setQa({ ...qa, category: e.target.value })} /></label><label>Character limit (optional)<input type="number" min="1" value={qa.charLimit} onChange={(e) => setQa({ ...qa, charLimit: e.target.value })} /></label></div><label>Question<input required maxLength={2000} value={qa.question} onChange={(e) => setQa({ ...qa, question: e.target.value })} /></label><label>Answer<textarea required maxLength={20000} rows={4} value={qa.answer} onChange={(e) => setQa({ ...qa, answer: e.target.value })} /></label>{qa.charLimit && <p className="subtle">{qa.answer.length}/{qa.charLimit} characters</p>}<div className="button-row"><button className="button secondary">{editingAnswerId ? 'Save changes' : 'Save answer'}</button>{editingAnswerId && <button className="text-button" type="button" onClick={() => { setEditingAnswerId(null); setQa({ question: '', answer: '', category: 'Other', charLimit: '' }) }}>Cancel edit</button>}</div></form>
        <div className="answer-list">{detail.answers.map((answer) => <article className="answer-card" key={answer.id}><span className="eyebrow">{answer.category}{answer.charLimit ? ` · ${answer.answer.length}/${answer.charLimit}` : ''}{answer.submittedAnswer !== null ? ' · submitted snapshot saved' : ''}</span><h4>{answer.question}</h4><p>{answer.answer}</p>{answer.submittedAnswer !== null && <details><summary>Submitted answer snapshot</summary><p>{answer.submittedAnswer}</p></details>}<button className="text-button" onClick={() => { setEditingAnswerId(answer.id); setQa({ question: answer.question, answer: answer.answer, category: answer.category, charLimit: answer.charLimit?.toString() ?? '' }) }}>Edit</button><button className="text-button" onClick={() => { void navigator.clipboard.writeText(answer.answer).then(() => setNotice('Answer copied to clipboard.')) }}>Copy answer</button>{answer.submittedAnswer !== null && <button className="text-button" onClick={() => { void navigator.clipboard.writeText(answer.submittedAnswer!).then(() => setNotice('Submitted answer copied to clipboard.')) }}>Copy submitted</button>}</article>)}{!detail.answers.length && <p className="subtle">No answers saved yet.</p>}</div>
      </div>
      {detail.events.length > 0 && <p className="subtle">Status history: {detail.events.map((event) => `${event.status} · ${new Date(event.createdAt).toLocaleDateString()}`).join(' → ')}</p>}
    </section>}
    <section className="panel answer-search-panel"><div className="panel-heading"><div><p className="eyebrow">ANSWER LIBRARY</p><h2>Search saved answers</h2></div></div><input className="search-input" value={answerQuery} onChange={(e) => setAnswerQuery(e.target.value)} placeholder="Search questions and answer text" />{answerResults.length > 0 && <div className="answer-search-results">{answerResults.map((answer) => <article key={answer.id} className="answer-card"><span className="eyebrow">{answer.company} · {answer.title}</span><h4>{answer.question}</h4><p>{answer.answer}</p><button className="text-button" onClick={() => { void navigator.clipboard.writeText(answer.answer).then(() => setNotice('Answer copied to clipboard.')) }}>Copy answer</button><button className="text-button" onClick={() => void loadDetail(answer.jobId)}>Open job</button></article>)}</div>}</section>
    <footer><span>THE ROLE CLINIC</span><span>Saved on this device · job capture and tracking work without a model.</span></footer>
  </main>
}
