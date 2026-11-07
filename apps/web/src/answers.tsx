import { writeClipboard } from './desktop.js'
import { useEffect, useState } from 'react'
import { answerCategories, suggestAnswerCategory, type LibraryAnswer, type TrackerJob } from '../../../packages/shared/src/index.js'

export async function localApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(typeof init?.body === 'string' ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
  return data as T
}
export async function copyText(text: string, onNotice: (text: string) => void) {
  try { await writeClipboard(text); onNotice('Answer copied to clipboard.') } catch { onNotice('Clipboard access failed. Select and copy the text manually.') }
}
type EditableAnswer = { id?: string; question: string; answer: string; category: string; charLimit: number | null; reusedFrom?: string | null }
export function AnswerEditor({ jobId, initial, onSaved, onCancel, prefix = '' }: { jobId: string; initial?: EditableAnswer; onSaved: () => void | Promise<void>; onCancel?: () => void; prefix?: string }) {
  const [question, setQuestion] = useState(initial?.question ?? ''), [answer, setAnswer] = useState(initial?.answer ?? ''), [category, setCategory] = useState(initial?.category ?? 'other'), [manualCategory, setManualCategory] = useState(Boolean(initial))
  const [limit, setLimit] = useState(initial?.charLimit?.toString() ?? ''), [reusedFrom, setReusedFrom] = useState(initial?.reusedFrom ?? null), [suggestions, setSuggestions] = useState<LibraryAnswer[]>([]), [warnings, setWarnings] = useState<string[]>([]), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => { if (!question.trim()) { setSuggestions([]); return }; void localApi<{ answers: LibraryAnswer[] }>(`/api/answers/similar?jobId=${encodeURIComponent(jobId)}&question=${encodeURIComponent(question)}&category=${encodeURIComponent(category)}`, { signal: controller.signal }).then((result) => setSuggestions(result.answers)).catch((e) => { if (e.name !== 'AbortError') setNotice(e.message) }) }, 250)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [jobId, question, category])
  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => { void localApi<{ warnings: string[] }>('/api/answers/reuse-check', { method: 'POST', body: JSON.stringify({ jobId, answer }), signal: controller.signal }).then((result) => setWarnings(result.warnings)).catch((e) => { if (e.name !== 'AbortError') setNotice(e.message) }) }, 120)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [jobId, answer])
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setNotice('')
    try {
      await localApi(`/api/jobs/${jobId}/answers${initial?.id ? `/${initial.id}` : ''}`, { method: initial?.id ? 'PUT' : 'POST', body: JSON.stringify({ question, answer, category, charLimit: limit ? Number(limit) : null, ...(reusedFrom ? { reusedFrom } : {}) }) })
      if (!initial?.id) { setQuestion(''); setAnswer(''); setCategory('other'); setManualCategory(false); setLimit(''); setReusedFrom(null) }
      await onSaved(); setNotice('Answer saved for this job.')
    } catch (error) { setNotice((error as Error).message) } finally { setBusy(false) }
  }
  return <div className="answer-editor">
    <form className="qa-form" onSubmit={save}>
      <div className="form-pair"><label>Category<input list={`categories-${jobId}`} maxLength={80} value={category} onChange={(e) => { setManualCategory(true); setCategory(e.target.value) }} /><datalist id={`categories-${jobId}`}>{answerCategories.map((value) => <option key={value}>{value}</option>)}</datalist></label><label>Character limit (optional)<input type="number" min={1} max={100000} value={limit} onChange={(e) => setLimit(e.target.value)} /></label></div>
      <label>{prefix ? `${prefix}question` : 'Question'}<input required maxLength={2000} value={question} onChange={(e) => { setQuestion(e.target.value); if (!manualCategory) setCategory(suggestAnswerCategory(e.target.value)) }} /></label>
      <label>{prefix ? `${prefix}answer` : 'Answer'}<textarea required maxLength={20000} rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} /></label>
      <p className={limit && answer.length > Number(limit) ? 'review-flag' : 'subtle'}>{answer.length}{limit ? `/${limit}` : ''} characters</p>
      {reusedFrom && <p className="subtle">Adapted from a saved answer. Review the company name and question before saving.</p>}
      {warnings.map((warning) => <p role="alert" className="review-flag" key={warning}>{warning}</p>)}
      <div className="button-row"><button className="button secondary" disabled={busy || Boolean(limit && answer.length > Number(limit))}>{initial?.id ? 'Save changes' : prefix ? 'Add application answer' : 'Save answer'}</button>{onCancel && <button className="text-button" type="button" onClick={onCancel}>Cancel edit</button>}</div>
    </form>
    {notice && <p role="status" className="subtle">{notice}</p>}
    {suggestions.length > 0 && <details className="similar-answers" open><summary>Similar past answers</summary>{suggestions.map((item) => <article key={item.id} className="answer-card"><span className="eyebrow">{item.company} · {item.title} → {item.status}</span><small>{item.category} · {new Date(item.createdAt).toLocaleDateString()}</small><strong>{item.question}</strong><p>{item.answer}</p><button className="text-button" type="button" disabled={busy} onClick={() => { setAnswer(item.answer); setReusedFrom(item.id); if (!manualCategory) setCategory(item.category) }}>Insert answer from {item.company}</button></article>)}</details>}
  </div>
}
export function JobAnswers({ jobId, answers, onSaved }: { jobId: string; answers: Array<EditableAnswer & { id: string; submittedAnswer: string | null }>; onSaved: () => void | Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null), [notice, setNotice] = useState('')
  return <div className="qa-section"><h3>Answers for this job</h3><AnswerEditor key={`${jobId}-${editing ?? 'new'}`} jobId={jobId} initial={answers.find((a) => a.id === editing)} onSaved={async () => { setEditing(null); await onSaved() }} onCancel={editing ? () => setEditing(null) : undefined} />
    {notice && <p role="status">{notice}</p>}<div className="answer-list">{answers.map((answer) => <article className="answer-card" key={answer.id}><span className="eyebrow">{answer.category}{answer.charLimit ? ` · ${answer.answer.length}/${answer.charLimit}` : ''}{answer.submittedAnswer !== null ? ' · submitted snapshot saved' : ''}</span><h4>{answer.question}</h4><p>{answer.answer}</p>{answer.submittedAnswer !== null && <details><summary>Submitted answer snapshot</summary><p>{answer.submittedAnswer}</p></details>}<button className="text-button" onClick={() => setEditing(answer.id)}>Edit</button><button className="text-button" onClick={() => void copyText(answer.answer, setNotice)}>Copy answer</button>{answer.submittedAnswer !== null && <button className="text-button" onClick={() => void copyText(answer.submittedAnswer!, setNotice)}>Copy submitted</button>}</article>)}{!answers.length && <p className="subtle">No answers saved yet.</p>}</div></div>
}

// Past answers across every job: search, adapt one for another job, copy. Lives inside the Tracker.
export function AnswerLibrary() {
  const [answers, setAnswers] = useState<LibraryAnswer[]>([]), [categories, setCategories] = useState<string[]>([]), [jobs, setJobs] = useState<TrackerJob[]>([]), [query, setQuery] = useState(''), [category, setCategory] = useState(''), [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<LibraryAnswer | null>(null), [target, setTarget] = useState(''), [mode, setMode] = useState<'reuse' | 'edit'>('reuse')
  async function load() { const result = await localApi<{ answers: LibraryAnswer[]; categories: string[] }>(`/api/answers?q=${encodeURIComponent(query)}&category=${encodeURIComponent(category)}`); setAnswers(result.answers); setCategories(result.categories) }
  useEffect(() => { let active = true; const timer = window.setTimeout(() => { void localApi<{ answers: LibraryAnswer[]; categories: string[] }>(`/api/answers?q=${encodeURIComponent(query)}&category=${encodeURIComponent(category)}`).then((result) => { if (active) { setAnswers(result.answers); setCategories(result.categories) } }).catch((e) => { if (active) setNotice(e.message) }) }, 180); return () => { active = false; window.clearTimeout(timer) } }, [query, category])
  useEffect(() => { void localApi<{ jobs: TrackerJob[] }>('/api/tracker').then((r) => setJobs(r.jobs)).catch((e) => setNotice(e.message)) }, [])
  const targetJob = jobs.find((j) => j.id === target)
  return <div className="answer-library">{notice && <p role="status" className="notice neutral">{notice}</p>}
    <div className="library-filters"><label>Search answers<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Question or answer text" /></label><label>Filter category<select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All categories</option>{categories.map((c) => <option key={c}>{c}</option>)}</select></label></div>
    {selected && <section className="panel library-edit"><h2>{mode === 'edit' ? 'Edit working answer' : 'Adapt a past answer'}</h2>{mode === 'reuse' && <label>Target application<select value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Choose a saved job</option>{jobs.filter((j) => j.id !== selected.jobId).map((j) => <option key={j.id} value={j.id}>{j.company} · {j.title}</option>)}</select></label>}{(mode === 'edit' || targetJob) && <AnswerEditor key={`${selected.id}-${target}-${mode}`} jobId={mode === 'edit' ? selected.jobId : target} initial={mode === 'edit' ? selected : { question: selected.question, answer: selected.answer, category: selected.category, charLimit: null, reusedFrom: selected.id }} onSaved={async () => { setSelected(null); await load(); setNotice('Answer saved for this job.') }} onCancel={() => setSelected(null)} />}{mode === 'reuse' && !targetJob && <button className="text-button" onClick={() => setSelected(null)}>Cancel reuse</button>}</section>}
    <p className="subtle">{answers.length === 1 ? '1 saved answer' : `${answers.length} saved answers`} · answers stay on this device and are never sent to a model.</p><div className="library-grid">{answers.map((answer) => <article className="panel library-answer" key={answer.id}><p className="eyebrow">{answer.company} · {answer.title} → {answer.status}</p><p className="subtle">{answer.category} · {new Date(answer.createdAt).toLocaleDateString()}{answer.reusedFrom ? ' · adapted from a past answer' : ''}</p><h3>{answer.question}</h3><p className="answer-text">{answer.answer}</p>{answer.submittedAnswer !== null && <details><summary>What was submitted</summary><p className="answer-text">{answer.submittedAnswer}</p><button className="text-button" onClick={() => void copyText(answer.submittedAnswer!, setNotice)}>Copy submitted</button></details>}<div className="button-row"><button className="button secondary" onClick={() => { setSelected(answer); setMode('reuse'); setTarget('') }}>Reuse answer</button><button className="text-button" onClick={() => { setSelected(answer); setMode('edit') }}>Edit working answer</button><button className="text-button" onClick={() => void copyText(answer.answer, setNotice)}>Copy answer</button><a href={`#jobs/${answer.jobId}`}>Open job</a></div></article>)}</div>{!answers.length && <p className="empty-state">No saved answers match this view.</p>}</div>
}
