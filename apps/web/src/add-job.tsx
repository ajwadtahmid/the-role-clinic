import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { Icon } from './icons.js'

const blank = { company: '', title: '', location: '', url: '', canonicalUrl: '', applyUrl: '', text: '', rawSnapshot: '', source: 'paste', captureMethod: 'paste' }
type Similar = { id: string; company: string; title: string }

// A dialog with two ways in: paste the description, or fetch it from a link and review it before saving.
export function AddJobDialog({ onClose, onSaved, onOpenExisting }: { onClose: () => void; onSaved: (id: string) => void | Promise<void>; onOpenExisting: (id: string) => void }) {
  const [path, setPath] = useState<'paste' | 'link'>('paste'), [form, setForm] = useState(blank), [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(''), [similar, setSimilar] = useState<Similar | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLElement>('input, textarea')?.focus()
    return () => opener?.focus()
  }, [])
  function keys(event: React.KeyboardEvent) {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return }
    if (event.key !== 'Tab') return
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href]') ?? [])].filter((item) => !(item as HTMLButtonElement).disabled)
    if (!items.length) return
    const first = items[0], last = items[items.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  async function save(event?: React.FormEvent, allowSimilar = false) {
    event?.preventDefault(); setBusy(true); setNotice('')
    try {
      const result = await api<{ id: string }>('/api/jobs', { method: 'POST', body: JSON.stringify({ ...form, ...(allowSimilar ? { allowSimilar: true } : {}) }) })
      await onSaved(result.id)
    } catch (error) {
      const issue = error as Error & { duplicateId?: string; similar?: Similar }
      setNotice(issue.message); setSimilar(issue.similar ?? null)
      if (issue.duplicateId) onOpenExisting(issue.duplicateId)
    } finally { setBusy(false) }
  }
  async function fetchLink() {
    if (!form.url) { setNotice('Enter a job link first.'); return }
    setBusy(true); setNotice('Fetching job details…')
    try { const captured = await api<typeof form>('/api/capture/url', { method: 'POST', body: JSON.stringify({ url: form.url }) }); setForm({ ...form, ...captured }); setNotice(`Captured via ${captured.captureMethod}. Review the fields, then save the job.`) }
    catch (error) { setNotice((error as Error).message) } finally { setBusy(false) }
  }
  return <div className="dialog-backdrop"><div className="dialog panel" role="dialog" aria-modal="true" aria-labelledby="add-job-title" ref={dialog} onKeyDown={keys}>
    <div className="panel-heading"><h2 id="add-job-title">Add a job</h2><button type="button" className="text-button" onClick={onClose}>Close</button></div>
    <div className="view-chips" role="group" aria-label="How to add the job">
      <button type="button" className={`chip ${path === 'paste' ? 'active' : ''}`} aria-pressed={path === 'paste'} onClick={() => setPath('paste')}>Paste the description</button>
      <button type="button" className={`chip ${path === 'link' ? 'active' : ''}`} aria-pressed={path === 'link'} onClick={() => setPath('link')}>From a link</button>
    </div>
    {notice && <p className="notice neutral" role="status">{notice}</p>}
    {similar && <p className="notice neutral">Similar saved job: <strong>{similar.title} at {similar.company}</strong>. <button type="button" className="text-button" disabled={busy} onClick={() => onOpenExisting(similar.id)}>Open existing</button><button type="button" className="text-button" disabled={busy} onClick={() => void save(undefined, true)}>Keep this as a separate job</button></p>}
    <form className="capture-panel dialog-form" onSubmit={save}>
      {path === 'link' && <div className="link-row"><label>Job link<input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" /></label><button type="button" className="button secondary" disabled={busy} onClick={() => void fetchLink()}>Fetch details</button></div>}
      {path === 'link' && <p className="subtle">LinkedIn, Indeed and Glassdoor links can’t be fetched. Paste the description instead.</p>}
      <div className="form-pair"><label>Company<input required maxLength={200} value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></label><label>Role title<input required maxLength={300} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label></div>
      <label>Location (optional)<input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></label>
      <label>Job description<textarea required minLength={40} maxLength={100000} rows={9} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="Paste the full job description here…" /></label>
      <div className="button-row"><button className="button primary" disabled={busy}>{busy ? 'Working…' : 'Save job'}</button><button type="button" className="button secondary" onClick={onClose}>Cancel</button></div>
    </form>
  </div></div>
}

type Readiness = { capturedJob: boolean; hasMaster: boolean; hasProfile: boolean; configuredModels: boolean; triedTracker: boolean }
// What to set up and where things go. It fills the job pane while there are no jobs yet.
export function Quickstart({ readiness, onAdd }: { readiness: Readiness | null; onAdd: () => void }) {
  const steps: Array<{ done: boolean; title: string; note: string; href?: string; optional?: boolean }> = [
    { done: !!readiness?.hasMaster, title: 'Add your résumé', note: 'Tailoring writes only from facts you have confirmed here.', href: '#resume' },
    { done: !!readiness?.configuredModels, title: 'Choose a model', note: 'A local Ollama model or an Anthropic key. Saving jobs works without one.', href: '#settings' },
    { done: !!readiness?.capturedJob, title: 'Add a job', note: 'Paste a posting or fetch it from a link.' },
    { done: false, title: 'Connect a job feed', note: 'If a search tool saves jobs to a CSV file, they can arrive in To review on their own.', href: '#settings', optional: true },
  ]
  return <section className="panel get-ready" aria-labelledby="quickstart-title"><h2 id="quickstart-title">Quickstart</h2>
    <p className="subtle">Add a job, check the fit, tailor a résumé, then track it. Everything stays on this device.</p>
    <ol className="start-steps">
      {steps.map((step, index) => <li key={step.title} className={step.done ? 'done' : undefined}><span className="step-n" aria-hidden="true">{step.done ? <Icon name="check" /> : index + 1}</span><div>{step.href ? <a href={step.href}>{step.title}</a> : <strong>{step.title}</strong>}{step.optional && <span className="subtle"> (optional)</span>}{step.done && <span className="sr-only"> (done)</span>}<p>{step.note}</p></div></li>)}
    </ol>
    <div className="actions"><button className="button primary" onClick={onAdd}>Add your first job</button><span className="subtle">Jobs you apply to move to the <a href="#tracker">Tracker</a>.</span></div>
  </section>
}
