import { useEffect, useState } from 'react'
import { calendarDate, type FollowUpPreferences, type TrackerJob, type TrackerSummary } from '../../../packages/shared/src/index.js'
import { AnswerLibrary, JobAnswers, localApi } from './answers.js'
import { AppHeader, JobsViews, PageHeader } from './layout.js'
import { Icon } from './icons.js'
import { Skeleton } from './ui/skeleton.js'
import { AddJobDialog } from './add-job.js'
import { ImportDialog } from './import-dialog.js'
import { Toast } from './toast.js'
import { Toggle } from './ui/toggle.js'
import { choiceOf, splitChoice, stageClass, stageLabel, stageLabels, statusChoices, statusText } from './stages.js'

type Artifact = { id: string; filename: string; revision: number | null }
export function SubmissionForm({ jobId, onSaved, onCancel }: { jobId: string; onSaved: () => void | Promise<void>; onCancel: () => void }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]), [artifactId, setArtifactId] = useState(''), [text, setText] = useState(''), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  async function load() { const result = await localApi<{ artifacts: Artifact[] }>(`/api/jobs/${jobId}/artifacts`); setArtifacts(result.artifacts) }
  useEffect(() => { void load().catch((e) => setNotice(e.message)) }, [jobId])
  async function upload(file?: File) {
    if (!file) return
    setBusy(true); setNotice('')
    try { const form = new FormData(); form.set('file', file); const result = await localApi<{ id: string }>(`/api/jobs/${jobId}/submitted-resume`, { method: 'POST', body: form, headers: {} }); await load(); setArtifactId(result.id); setConfirmed(false); setNotice('Attached locally. Confirm only after you submit this copy.') } catch (e) { setNotice((e as Error).message) } finally { setBusy(false) }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!confirmed) return
    setBusy(true)
    try { await localApi(`/api/jobs/${jobId}/status`, { method: 'PUT', body: JSON.stringify({ status: 'applied', ...(artifactId ? { submittedArtifactId: artifactId } : { submittedText: text }) }) }); await onSaved() } catch (e) { setNotice((e as Error).message) } finally { setBusy(false) }
  }
  return <form className="submission-confirm panel" onSubmit={save}><h3>Record what you submitted</h3><p className="subtle">Select an export, attach the actual sent copy (including a base résumé or a file edited outside this app), or record its text. Current answers and this job description will be frozen when you confirm.</p><label>Submitted résumé file<select value={artifactId} disabled={busy} onChange={(e) => { setArtifactId(e.target.value); setConfirmed(false) }}><option value="">No file: I used my master résumé</option>{artifacts.map((a) => <option key={a.id} value={a.id}>{a.filename}{a.revision ? ` · revision ${a.revision}` : ' · attached copy'}</option>)}</select></label><label>Attach sent PDF or DOCX<input type="file" accept=".pdf,.docx" disabled={busy} onChange={(e) => void upload(e.target.files?.[0])} /></label>{!artifactId && <label>Submitted résumé text (optional)<textarea rows={5} maxLength={100000} value={text} onChange={(e) => { setText(e.target.value); setConfirmed(false) }} /></label>}<label className="confirm-submission"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I confirm this résumé and the current answers were submitted.</label>{!artifactId && !text.trim() && <p className="subtle">No résumé file will be recorded. The job description and your current answers are still kept with the application.</p>}<div className="button-row"><button className="button primary" disabled={busy || !confirmed}>Confirm application submitted</button><button className="text-button" type="button" disabled={busy} onClick={onCancel}>Cancel submission</button></div>{notice && <p role="status">{notice}</p>}</form>
}
export function SubmittedRecord({ jobId }: { jobId: string }) {
  const [record, setRecord] = useState<{ company: string; title: string; appliedAt: string | null; submittedText: string | null; artifactId: string | null; filename: string | null; jobText: string; answers: Array<{ id: string; question: string; answer: string }> } | null>(null), [error, setError] = useState('')
  useEffect(() => { let active = true; void localApi<NonNullable<typeof record>>(`/api/jobs/${jobId}/submitted`).then((r) => { if (active) setRecord(r) }).catch((e) => { if (active) setError(e.message) }); return () => { active = false } }, [jobId])
  return <section className="submitted-record">{error && <p role="alert">{error}</p>}{record && (record.appliedAt ? <><p className="subtle">Sent and recorded · {new Date(record.appliedAt).toLocaleString()}</p>{record.artifactId && <a href={`/api/jobs/${jobId}/artifacts/${record.artifactId}`} download>Download submitted résumé · {record.filename}</a>}{record.submittedText ? <pre className="job-text">{record.submittedText}</pre> : <p className="subtle">No résumé file recorded for this application.</p>}<details><summary>Submitted job description</summary><pre className="job-text">{record.jobText}</pre></details><h4>Submitted answers</h4>{record.answers.map((a) => <article className="answer-card" key={a.id}><strong>{a.question}</strong><p className="answer-text">{a.answer}</p></article>)}{!record.answers.length && <p className="subtle">No answers were recorded at submission time.</p>}</> : <p className="subtle">This job has not been recorded as applied.</p>)}</section>
}
const plusDays = (days: number) => { const d = new Date(`${calendarDate()}T12:00:00`); d.setDate(d.getDate() + days); return calendarDate(d.toISOString()) }
// Follow-up, last contact, contacts and notes for one application. Reminders for it can be silenced, or the date added to a calendar.
export function JobTrackerDetails({ job, onSaved, preferences }: { job: TrackerJob; onSaved: () => void | Promise<void>; preferences?: FollowUpPreferences }) {
  const [followUp, setFollowUp] = useState(job.followUpDate ?? ''), [lastContact, setLastContact] = useState(job.lastContactAt ? calendarDate(job.lastContactAt) : ''), [contacts, setContacts] = useState(job.contacts), [notes, setNotes] = useState(job.notes), [remindOff, setRemindOff] = useState(job.remindOff), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const remindersOn = preferences?.remindersOn ?? true
  // "done" records today as the last contact and sets the next date from the apply rule (or none); "wait" moves the date out by the snooze length.
  async function save(event?: React.FormEvent, action: 'done' | 'wait' | null = null) {
    event?.preventDefault(); setBusy(true)
    const contact = action === 'done' ? calendarDate() : lastContact
    const date = action === 'done' ? (preferences?.remindersOn && preferences.applyOn ? plusDays(preferences.applyDays) : '') : action === 'wait' ? plusDays(preferences?.snoozeDays ?? 3) : followUp
    try { await localApi(`/api/jobs/${job.id}/tracker`, { method: 'PUT', body: JSON.stringify({ followUpDate: date || null, lastContactAt: contact || null, contacts, notes, remindOff }) }); setFollowUp(date); setLastContact(contact); await onSaved(); setNotice(action === 'done' ? `Follow-up done; last contact recorded today${date ? `, next one ${date}` : ''}.` : action === 'wait' ? `Keeping on waiting until ${date}.` : 'Tracker details saved.') } catch (e) { setNotice((e as Error).message) } finally { setBusy(false) }
  }
  return <details className="tracker-details" open><summary>Follow-up, contacts & notes</summary><form onSubmit={save}><div className="form-pair"><label>Follow-up date<input type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} /></label><label>Last contact date<input type="date" max={calendarDate()} value={lastContact} onChange={(e) => setLastContact(e.target.value)} /></label></div><label>Contacts<textarea rows={2} maxLength={5000} value={contacts} onChange={(e) => setContacts(e.target.value)} placeholder="Recruiter, hiring manager, contact details" /></label><label>Application notes<textarea rows={4} maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
    <Toggle checked={remindOff} onChange={setRemindOff}>Don’t remind me about this one</Toggle>
    <div className="button-row"><button className="button secondary" disabled={busy}>Save tracker details</button><button className="text-button" type="button" disabled={busy} onClick={() => void save(undefined, 'done')}>Mark follow-up done today</button><button className="text-button" type="button" disabled={busy} onClick={() => void save(undefined, 'wait')}>Keep waiting {preferences?.snoozeDays ?? 3} more days</button>{remindersOn && job.followUpDate && <a className="text-button" href={`/api/jobs/${job.id}/follow-up.ics`} download>Add to calendar (.ics)</a>}</div></form>{notice && <p role="status">{notice}</p>}</details>
}
type JobRecord = { answers: Array<{ id: string; question: string; answer: string; submittedAnswer: string | null; category: string; charLimit: number | null }>; events: Array<{ status: string; outcome?: string | null; createdAt: string }> }
// One job's questions and answers (add, edit, copy) and its status history, opened from the Q&A column.
export function TrackerJobRecord({ jobId, onChanged }: { jobId: string; onChanged: () => void | Promise<void> }) {
  const [record, setRecord] = useState<JobRecord | null>(null), [error, setError] = useState('')
  async function load() { setRecord(await localApi<JobRecord>(`/api/jobs/${jobId}`)) }
  useEffect(() => { void load().catch((e) => setError(e.message)) }, [jobId])
  if (error) return <p role="alert" className="review-flag">{error}</p>
  if (!record) return <Skeleton lines={3} label="Loading questions and answers…" />
  return <>
    <details className="record-answers" open><summary>Q&A ({record.answers.length})</summary><JobAnswers jobId={jobId} answers={record.answers} onSaved={async () => { await load(); await onChanged() }} /></details>
    <details className="record-history"><summary>Status history</summary>{record.events.length ? <ol className="history-list">{record.events.map((event, i) => <li key={i}><strong>{statusText(event.status, event.outcome)}</strong> <span className="subtle">· {new Date(event.createdAt).toLocaleDateString()}</span></li>)}</ol> : <p className="subtle">No status changes yet.</p>}</details>
  </>
}
// Everything kept about one application: the facts, what was sent, follow-up and notes, questions and answers, and the history.
// It is shown beside the Tracker table and on the job's own page, so an application looks the same wherever it is opened.
export function ApplicationDetails({ job: chosen, preferences, onSaved }: { job: TrackerJob; preferences: FollowUpPreferences; onSaved: () => void | Promise<void> }) {
  const todayKey = calendarDate(), load = onSaved
  return <><dl className="track-facts"><div><dt>Stage</dt><dd>{statusText(chosen.status, chosen.outcome)}</dd></div><div><dt>Applied</dt><dd>{chosen.appliedAt ? calendarDate(chosen.appliedAt) : '—'}</dd></div><div><dt>Résumé sent</dt><dd>{chosen.appliedAt ? (chosen.submittedFilename || (chosen.hasSubmittedText ? 'Recorded résumé text' : 'No file kept')) : '—'}</dd></div><div><dt>Next follow-up</dt><dd>{chosen.followUpDate ? <span className={chosen.followUpDate <= todayKey ? 'due' : undefined}>{chosen.followUpDate}</span> : 'None'}</dd></div></dl>{chosen.appliedAt && <details className="submitted-panel" open><summary>What you sent</summary><SubmittedRecord key={chosen.id} jobId={chosen.id} /></details>}<JobTrackerDetails key={chosen.id} job={chosen} onSaved={load} preferences={preferences} /><TrackerJobRecord key={`record-${chosen.id}`} jobId={chosen.id} onChanged={load} /></>
}
// The same details for a job opened from Jobs. It asks for that one application only.
export function ApplicationPanel({ jobId }: { jobId: string }) {
  const [data, setData] = useState<{ job: TrackerJob; preferences: FollowUpPreferences } | null>(null), [error, setError] = useState('')
  async function load() { setData(await localApi<{ job: TrackerJob; preferences: FollowUpPreferences }>(`/api/tracker/jobs/${jobId}`)) }
  useEffect(() => { void load().catch((e) => setError(e.message)) }, [jobId])
  if (error) return <p role="alert" className="review-flag">{error}</p>
  if (!data) return <Skeleton lines={4} label="Loading application…" />
  return <section className="application-panel" aria-label="Application"><h3>Application</h3><ApplicationDetails job={data.job} preferences={data.preferences} onSaved={load} /></section>
}
const pageRows = 50
// The Tracker holds every job from applied onward; Saved and Skipped jobs stay in Jobs.
const isTracked = (job: TrackerJob) => !['new', 'saved', 'skipped'].includes(job.status)
// The strip counts jobs that ever reached a stage; the chips below count jobs in it now, so the words differ.
const funnelWords: Record<string, string> = { applied: 'applied', interviewing: 'got to an interview', offer: 'got an offer', accepted: 'accepted' }
const stageTabs: Array<[string, string]> = [['all', 'All'], ['applied', stageLabels.applied], ['interviewing', stageLabels.interviewing], ['offer', stageLabels.offer], ['closed', stageLabels.closed]]
// The Tracker is a view inside Jobs (embedded): no page frame of its own, only the table, reminders and details.
function Shell({ embedded, detailOpen, children }: { embedded: boolean; detailOpen: boolean; children: React.ReactNode }) {
  return embedded ? <div className={`tracker-embedded tracker-shell${detailOpen ? ' detail-open' : ''}`}>{children}</div>
    : <main className={`shell tracker-shell${detailOpen ? ' detail-open' : ''}`} id="main" tabIndex={-1}><AppHeader current="jobs" />{children}</main>
}
function EmbeddedHead({ actions, children }: { title: string; actions?: React.ReactNode; children?: React.ReactNode }) {
  return <div className="embedded-head"><p className="page-note">{children}</p>{actions && <div className="page-actions">{actions}</div>}</div>
}
export function TrackerPage({ gapsOnly = false, embedded = false }: { gapsOnly?: boolean; embedded?: boolean }) {
  const [data, setData] = useState<TrackerSummary | null>(null), [query, setQuery] = useState(''), [stage, setStage] = useState('all'), [company, setCompany] = useState(''), [after, setAfter] = useState(''), [before, setBefore] = useState(''), [sort, setSort] = useState('captured'), [notice, setNotice] = useState(''), [selected, setSelected] = useState(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('job') ?? ''), [submitId, setSubmitId] = useState(''), [busy, setBusy] = useState(false), [page, setPage] = useState(1), [activeRow, setActiveRow] = useState(''), [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null)
  const [showAdd, setShowAdd] = useState(false), [showImport, setShowImport] = useState(false)
  async function load() { setData(await localApi<TrackerSummary>('/api/tracker')) }
  useEffect(() => { void load().catch((e) => setNotice(e.message)) }, [])
  const matching = (jobs: TrackerJob[]) => jobs.filter((j) => isTracked(j) && (stage === 'all' || j.status === stage) && (!query || `${j.company} ${j.title} ${j.notes} ${j.contacts}`.toLowerCase().includes(query.toLowerCase())) && (!company || j.company === company) && (!after || calendarDate(j.capturedAt) >= after) && (!before || calendarDate(j.capturedAt) <= before)).sort((a, b) => sort === 'company' ? a.company.localeCompare(b.company) : sort === 'followup' ? (a.followUpDate ?? '9999').localeCompare(b.followUpDate ?? '9999') : sort === 'applied' ? (b.appliedAt ?? '').localeCompare(a.appliedAt ?? '') : b.capturedAt.localeCompare(a.capturedAt))
  useEffect(() => { setPage(1) }, [query, stage, company, after, before, sort])
  // A job chosen from a reminder or an address may be on a later page of the table; show that page.
  useEffect(() => { if (!selected || !data) return; const index = matching(data.jobs).findIndex((j) => j.id === selected); if (index >= 0) setPage(Math.floor(index / pageRows) + 1) }, [selected, Boolean(data)])
  // Escape closes the details beside the table.
  useEffect(() => { if (!selected) return; const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected('') }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) }, [selected])
  // Keeping on waiting moves the follow-up date out, which also takes the application off the no-reply suggestions until then.
  async function keepWaiting(job: TrackerJob) {
    const date = plusDays(data!.preferences.snoozeDays)
    try { await localApi(`/api/jobs/${job.id}/tracker`, { method: 'PUT', body: JSON.stringify({ followUpDate: date, lastContactAt: job.lastContactAt ? calendarDate(job.lastContactAt) : null, contacts: job.contacts, notes: job.notes }) }); await load(); setToast({ text: `Waiting on ${job.company} until ${date}.` }) } catch (e) { setNotice((e as Error).message) }
  }
  async function changeStatus(job: TrackerJob, choice: string, undoable = true) {
    const { status: next, outcome } = splitChoice(choice)
    if (next === 'applied' && !job.appliedAt) { setSubmitId(job.id); return }
    setBusy(true)
    try { await localApi(`/api/jobs/${job.id}/status`, { method: 'PUT', body: JSON.stringify({ status: next, ...(outcome ? { outcome } : {}) }) }); await load(); setToast({ text: `Status updated to ${statusText(next, outcome).toLowerCase()}.`, ...(undoable ? { undo: () => void changeStatus({ ...job, status: next, outcome: outcome ?? null }, choiceOf(job.status, job.outcome), false) } : {}) }) } catch (e) { setNotice((e as Error).message) } finally { setBusy(false) }
  }
  if (!data) { const waiting = notice ? <p role="status">{notice}</p> : <Skeleton lines={6} label="Loading tracker…" />; return embedded ? <div>{waiting}</div> : <main className="shell">{waiting}</main> }
  const tracked = data.jobs.filter(isTracked), filtered = matching(data.jobs), pages = Math.max(1, Math.ceil(filtered.length / pageRows)), pageNo = Math.min(page, pages), rows = filtered.slice((pageNo - 1) * pageRows, pageNo * pageRows)
  const chosen = data.jobs.find((j) => j.id === selected), exportQuery = new URLSearchParams({ q: query, status: stage === 'all' ? 'tracker' : stage, company, ...(after ? { after } : {}), ...(before ? { before } : {}) }).toString()
  // The table is one Tab stop: only the active row's controls are tabbable, and Up and Down move between rows.
  const stopId = rows.some((job) => job.id === activeRow) ? activeRow : rows.some((job) => job.id === selected) ? selected : rows[0]?.id
  const rowTab = (job: TrackerJob): 0 | -1 => job.id === stopId ? 0 : -1
  const moveRow = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const target = event.target as HTMLElement
    if (target.tagName === 'SELECT') return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.table-job')], index = buttons.indexOf(target as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    buttons[Math.min(buttons.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }
  const statusSelect = (job: TrackerJob) => <select tabIndex={rowTab(job)} value={choiceOf(job.status, job.outcome)} disabled={busy} onChange={(e) => void changeStatus(job, e.target.value)}>{statusChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
  const showRecord = (job: TrackerJob) => setSelected(job.id)
  const todayKey = new Date().toISOString().slice(0, 10), place = (job: TrackerJob) => [job.company, job.location].filter(Boolean).join(' · ')
  const Head = embedded ? EmbeddedHead : PageHeader
  return <Shell embedded={embedded} detailOpen={Boolean(chosen)}><Head title={gapsOnly ? 'Evidence gaps' : 'Tracker'} actions={gapsOnly ? undefined : <><button className="button primary" onClick={() => setShowAdd(true)}><Icon name="plus" />Add a job I already applied to</button><button className="button secondary" onClick={() => setShowImport(true)}>Import from a spreadsheet</button><details className="more-menu export-menu"><summary>Export</summary><div className="more-panel"><a className="external-link" href={`/api/tracker/export/xlsx?${exportQuery}`} download>Export XLSX</a><a className="external-link" href={`/api/tracker/export/applications.csv?${exportQuery}`} download>Applications CSV</a><a className="external-link" href={`/api/tracker/export/qa.csv?${exportQuery}`} download>Q&A CSV</a></div></details></>}>{gapsOnly ? 'Gaps from the latest tailored draft for each tracked job. They reflect recorded evidence, not a judgment of your abilities.' : <>Jobs you have applied to. Find new ones in <a href="#jobs">Jobs</a>.</>}</Head>{notice && <Toast error onClose={() => setNotice('')}>{notice}</Toast>}{toast && <Toast onUndo={toast.undo} onClose={() => setToast(null)}>{toast.text}</Toast>}
    {!gapsOnly && <>{(data.followUps.length > 0 || data.ghostedSuggestions.length > 0) && <section className="panel tracker-reminders" aria-label="Follow-ups">{data.followUps.length > 0 && <><h2>Needs follow-up <span className="count">{data.followUps.length}</span></h2>{data.followUps.map((job) => <div className="reminder-line" key={job.id}><button className="reminder-row" onClick={() => setSelected(job.id)}>{job.company} · {job.title} <strong>{job.followUpDate! < calendarDate() ? 'Overdue' : 'Due'} {job.followUpDate}</strong></button><button className="text-button" disabled={busy} onClick={() => void keepWaiting(job)}>Snooze {data.preferences.snoozeDays} days</button></div>)}</>}{data.ghostedSuggestions.length > 0 && <details><summary>No reply in {data.preferences.ghostedDays} days · {data.ghostedSuggestions.length === 1 ? '1 suggestion' : `${data.ghostedSuggestions.length} suggestions`}</summary><p className="subtle">Change the number of days, or turn this off, under Settings, Follow-up reminders.</p>{data.ghostedSuggestions.map((job) => <article className="quiet-row" key={job.id}><span>{job.company} · {job.title} · last activity {calendarDate(job.lastActivityAt)}</span><button className="text-button" disabled={busy} onClick={() => void keepWaiting(job)}>Keep waiting</button><button className="text-button" disabled={busy} onClick={() => { if (window.confirm(`Mark ${job.title} at ${job.company} as closed with no reply? No status changes until you confirm.`)) void changeStatus(job, 'closed:no_reply') }}>Close as no reply</button></article>)}</details>}</section>}
    {submitId && <SubmissionForm key={submitId} jobId={submitId} onSaved={async () => { setSubmitId(''); await load(); setToast({ text: 'Application submitted record saved.' }) }} onCancel={() => setSubmitId('')} />}
    {tracked.length > 0 && <>
    <div className="toolbar"><label className="search"><Icon name="search" /><input aria-label="Search applications" placeholder="Search title or company" value={query} onChange={(e) => setQuery(e.target.value)} /></label><label className="select"><span aria-hidden="true">Sort</span><select aria-label="Sort applications" value={sort} onChange={(e) => setSort(e.target.value)}><option value="captured">Newest captured</option><option value="company">Company</option><option value="applied">Recently applied</option><option value="followup">Follow-up date</option></select></label>
      <p className="strip" aria-label="Application funnel: jobs that reached each stage or later, counted over all time"><span>All time</span>{data.funnel.filter((step) => !['new', 'saved', 'skipped'].includes(step.status)).map((step) => <span key={step.status}><strong>{step.count}</strong> {funnelWords[step.status] ?? stageLabel(step.status)}</span>)}<a href="#gaps">Gap trends →</a></p></div>
    <div className="chips" role="group" aria-label="Show applications">{stageTabs.map(([value, label]) => <button key={value} type="button" className="chip" aria-pressed={stage === value} onClick={() => setStage(value)}><Icon name="check" />{label}<span className="n">{value === 'all' ? tracked.length : tracked.filter((j) => j.status === value).length}</span></button>)}<span className="spacer" /><details className="more-filters"><summary>More filters</summary><div className="form-pair"><label>Filter company<select value={company} onChange={(e) => setCompany(e.target.value)}><option value="">All companies</option>{[...new Set(tracked.map((j) => j.company))].sort().map((c) => <option key={c}>{c}</option>)}</select></label><label>Captured from<input type="date" value={after} onChange={(e) => setAfter(e.target.value)} /></label><label>Captured through<input type="date" value={before} onChange={(e) => setBefore(e.target.value)} /></label></div></details></div></>}
    <div className={`tracker-layout ${chosen ? 'with-panel' : ''}`}>
    <section className="panel tracker-table-panel" aria-label="Applications">
      {filtered.length > 0 && <table className="applications-table"><caption className="sr-only">Applications and next steps</caption><thead><tr><th scope="col">Job</th><th scope="col">Stage</th><th scope="col" className="col-applied">Applied</th><th scope="col" className="col-next">Follow-up</th><th scope="col" className="col-sent">Résumé sent</th></tr></thead><tbody onKeyDown={moveRow}>{rows.map((job) => <tr key={job.id} className={job.id === selected ? 'selected' : undefined} onFocus={() => setActiveRow(job.id)}><td className="job-cell"><button className="table-job" tabIndex={rowTab(job)} aria-current={job.id === selected ? 'true' : undefined} onClick={() => setSelected(job.id)}><strong>{job.title}</strong><span>{place(job)}</span></button></td><td data-label="Stage"><label><span className="sr-only">Status for {job.company} {job.title}</span>{statusSelect(job)}</label></td><td className="num col-applied" data-label="Applied">{job.appliedAt ? calendarDate(job.appliedAt) : <span className="muted">—</span>}</td><td className="num col-next" data-label="Follow-up">{job.followUpDate ? <span className={job.followUpDate <= todayKey ? 'due' : undefined}>{job.followUpDate <= todayKey ? `Follow up now (${job.followUpDate})` : job.followUpDate}</span> : <span className="muted">None</span>}</td><td className="col-sent" data-label="Résumé sent">{job.appliedAt ? <button className="text-button" tabIndex={rowTab(job)} onClick={() => showRecord(job)}>{job.submittedFilename || (job.hasSubmittedText ? 'Recorded résumé text' : 'No file kept')}</button> : <span className="muted">—</span>}</td></tr>)}</tbody></table>}
      {!filtered.length && <div className="empty-note"><strong>{tracked.length ? 'No applications match' : 'No applications yet'}</strong>{tracked.length ? 'Try fewer words or another stage.' : <>When you mark a job applied, it appears here with the résumé you sent. <a href="#jobs">Go to Jobs</a></>}</div>}
      {filtered.length > pageRows && <div className="pager"><span className="num">{(pageNo - 1) * pageRows + 1} to {Math.min(pageNo * pageRows, filtered.length)} of {filtered.length}</span><span className="spacer" /><button className="button small" disabled={pageNo === 1} onClick={() => setPage(pageNo - 1)}>Previous</button><span className="num">Page {pageNo} of {pages}</span><button className="button small" disabled={pageNo === pages} onClick={() => setPage(pageNo + 1)}>Next</button></div>}</section>
    {chosen && <aside className="panel tracker-job-details" aria-label={`Details for ${chosen.company}`}><button className="text-button back-button" onClick={() => setSelected('')}>← All applications</button><div className="job-header-row details-head"><div className="job-title-block"><h2>{chosen.title}</h2><p>{place(chosen)}{chosen.appliedAt ? ` · Applied ${calendarDate(chosen.appliedAt)}` : ''}</p></div><span className={stageClass(chosen.status)}>{statusText(chosen.status, chosen.outcome)}</span><button className="text-button" aria-label="Close details" onClick={() => setSelected('')}><Icon name="x" /></button></div><div className="button-row"><a href={`#jobs/${chosen.id}`}>Open job and résumé</a>{chosen.sourceUrl && <a href={chosen.sourceUrl} target="_blank" rel="noreferrer">Original posting ↗</a>}</div><ApplicationDetails job={chosen} preferences={data.preferences} onSaved={load} /></aside>}
    </div>
    <details className="panel answer-library-panel"><summary>Question and Answer Bank · search every saved answer and reuse one for another job</summary><AnswerLibrary /></details></>}
    {gapsOnly && <section className="panel gap-trends"><p className="subtle">{data.analyzedJobs} tracked job(s) with a tailored draft. Each job counts once per gap; previous runs are excluded.</p>{data.gaps.map((gap) => <details key={gap.key}><summary>{gap.label} · {gap.count} job(s)</summary>{gap.jobs.map((job) => <article key={job.id}><a href={`#jobs/${job.id}`}>{job.company} · {job.title}</a><p>{job.reason}</p></article>)}</details>)}{!data.gaps.length && <p className="empty-state">No recorded evidence gaps yet. Tailor tracked jobs to build this view.</p>}</section>}
    {showAdd && <AddJobDialog alreadyApplied onClose={() => setShowAdd(false)} onOpenExisting={(id) => { setShowAdd(false); showRecord({ id } as TrackerJob) }} onAdded={() => load()} onSaved={async (id) => { setShowAdd(false); await load(); setSelected(id) }} />}
    {showImport && <ImportDialog onClose={() => setShowImport(false)} onImported={load} />}
  </Shell>
}

// Jobs, Tracker view: the same page frame and heading as the list, with the applications table inside.
export function JobsTrackerView() {
  return <main className="shell" id="main" tabIndex={-1}><AppHeader current="jobs" /><PageHeader title="Jobs" actions={<JobsViews current="tracker" />}>Everything you have applied to, with follow-ups and what you sent.</PageHeader><TrackerPage embedded /></main>
}
