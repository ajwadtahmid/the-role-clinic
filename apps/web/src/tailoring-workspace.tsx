import { PdfProof } from './pdf-proof.js'
import { writeClipboard, isDesktop } from './desktop.js'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnswerEditor } from './answers.js'
import { Icon, type IconName } from './icons.js'
import { Toast } from './toast.js'
import { wordDiff, type Part } from './review-diff.js'
import type { ReviewLine, ReviewWorkspace } from '../../../packages/shared/src/index.js'

type Action = { kind: 'decision'; outId: string; decision: ReviewLine['decision'] } | { kind: 'edit'; outId: string; text: string } | { kind: 'replace'; outId: string; bulletId: string } | { kind: 'summary'; summaryId: string | null } | { kind: 'skills'; skills: string[] } | { kind: 'add-to-master'; outId: string; sectionId: string }
type Proof = { revision: number; pages: number; lastPagePercent: number; parseCheck: { ok: boolean; missing: string[] }; pdfBase64: string }
type Artifact = { id: string; filename: string; createdAt: string; revision: number }
type Answer = { id: string; question: string; answer: string; submittedAnswer: string | null; charLimit: number | null; category: string; reusedFrom: string | null }
type Filter = 'all' | 'todo' | 'accepted' | 'rejected'
type PreviewMode = 'text' | 'changes' | 'pdf'
const saved = 'Review saved locally.'
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
  return data
}
// What each verdict means in plain words. A model-written line that is not in the résumé cannot be exported.
const verdictWords: Record<ReviewLine['verdict'], [string, IconName]> = { grounded: ['Backed by your résumé', 'check'], stretch: ['Stretches your résumé', 'warn'], unsupported: ['Not in your résumé', 'cross'] }
const shown = (parts: Part[]): ReactNode => parts.map((part, i) => <span key={i}>{i > 0 ? ' ' : ''}{part.kind === 'add' ? <ins>{part.text}</ins> : part.kind === 'del' ? <del>{part.text}</del> : part.text}</span>)

function LineRow({ line, workspace, busy, focused, open, rejecting, onFocus, onToggle, onReject, send, onCopy }: { line: ReviewLine; workspace: ReviewWorkspace; busy: boolean; focused: boolean; open: boolean; rejecting: boolean; onFocus: () => void; onToggle: () => void; onReject: (on: boolean) => void; send: (steps: Action[]) => Promise<boolean>; onCopy: (text: string) => void }) {
  const [editing, setEditing] = useState(false), [text, setText] = useState(line.text), [section, setSection] = useState(line.sectionId), [picking, setPicking] = useState(false)
  useEffect(() => { setText(line.text) }, [line.text])
  const sources = [...workspace.review.master.roles, ...workspace.review.master.projects].flatMap((s) => s.bullets).filter((b) => line.sourceIds.includes(b.id))
  const source = sources[0], diff = source ? wordDiff(source.text, line.text) : null, marked = diff && diff.similarity >= 0.4 ? diff : null
  const replacements = workspace.replacements.filter((r) => r.sectionId === line.sectionId && r.id !== source?.id)
  const blocked = line.verdict === 'unsupported' && line.author === 'model', [verdict, icon] = verdictWords[line.verdict]
  const decide = (decision: ReviewLine['decision']) => send([{ kind: 'decision', outId: line.outId, decision }])
  const keepOriginal = () => { if (source) void send([{ kind: 'edit', outId: line.outId, text: source.text }, { kind: 'decision', outId: line.outId, decision: 'accepted' }]).then((ok) => ok && onReject(false)) }
  const useBullet = (bulletId: string) => void send([{ kind: 'decision', outId: line.outId, decision: 'rejected' }, { kind: 'replace', outId: line.outId, bulletId }, { kind: 'decision', outId: line.outId, decision: 'accepted' }]).then((ok) => { if (ok) { onReject(false); setPicking(false) } })
  async function saveWording() { if (await send([{ kind: 'edit', outId: line.outId, text }, { kind: 'decision', outId: line.outId, decision: 'accepted' }])) setEditing(false) }
  function keys(event: React.KeyboardEvent) {
    if (event.target !== event.currentTarget || busy) return
    const key = event.key.toLowerCase()
    if (key === 'escape') { if (rejecting) onReject(false); else if (open) onToggle(); return }
    if (!['a', 'r', 'e', 'c', 'enter'].includes(key)) return
    event.preventDefault()
    if (line.decision !== 'pending' && key !== 'e' && key !== 'c') return
    if (key === 'a' && !blocked) void decide('accepted')
    if (key === 'r') onReject(true)
    if (key === 'e') setEditing(true)
    if (key === 'c') onCopy(line.text)
    if (key === 'enter') onToggle()
  }
  const common = { id: `review-card-${line.outId}`, 'data-line': line.outId, tabIndex: focused ? 0 : -1, onFocus, onKeyDown: keys }
  if (line.decision !== 'pending' && !editing) return <li className={`rv-line done ${focused ? 'focus' : ''}`} {...common} aria-label={`Review line: ${line.text}. ${line.decision === 'rejected' ? 'Left out' : 'Accepted'}.`}>
    <span className={`rv-state ${line.decision === 'rejected' ? 'rej' : 'acc'}`}>{line.decision === 'rejected' ? 'Left out' : line.author === 'user' ? 'Your wording' : 'Accepted'}</span><p className="rv-text">{line.text}</p><button className="text-button small" disabled={busy} onClick={() => void decide('pending')}>Change</button></li>
  if (editing) return <li className={`rv-line rv-edit ${focused ? 'focus' : ''}`} {...common} aria-label={`Review line: ${line.text}`}>
    <label className="field">Edit résumé line<textarea autoFocus maxLength={4000} rows={4} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setEditing(false); setText(line.text) } }} /></label>
    {source && <p className="rv-orig full"><span className="lbl">Your résumé says:</span> {source.text}</p>}
    <p className="rv-note">Your own wording is allowed. Check every claim in it is true. It stays off your master résumé unless you add it there.</p>
    <div className="rv-actions"><button className="button primary small" disabled={busy || !text.trim()} onClick={() => void saveWording()}>Save wording</button><button className="text-button small" disabled={busy} onClick={() => { setEditing(false); setText(line.text) }}>Cancel edit</button></div></li>
  return <li className={`rv-line ${focused ? 'focus' : ''}`} {...common} aria-label={`Review line: ${line.text}`}>
    <span className={`rv-verdict v-${line.verdict}`}><Icon name={icon} />{verdict}{line.verification !== 'checked' ? <span className="muted"> · verification {line.verification}</span> : null}</span>
    <p className="rv-text">{marked && !marked.same && line.author === 'model' ? shown(marked.suggested) : line.text}</p>
    {diff?.same ? <p className="rv-orig"><span className="lbl">Same as your résumé.</span></p> : diff ? (line.verdict === 'grounded' && !open ? <p className="rv-orig one"><span className="lbl">Your résumé says:</span><span className="clip">{marked ? shown(marked.original) : source?.text}</span></p> : <p className="rv-orig full"><span className="lbl">Your résumé says:</span> {marked ? shown(marked.original) : source?.text}</p>) : <p className="rv-orig full"><span className="lbl">No bullet in your résumé supports this line.</span></p>}
    {blocked && <p className="rv-blocked">Cannot be exported: {line.layer2Reason ? line.layer2Reason.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()) : 'this wording is not in your résumé'}.</p>}
    {line.author === 'user' && (line.verdict !== 'grounded' || line.layer1Flags.length > 0) && <p className="rv-note">Your wording can be exported after acceptance. Review these warnings and add the claim to your master only if it is true.</p>}
    {rejecting ? <div className="rv-reject" role="group" aria-label="Instead of this line"><p><b>Instead of this line:</b></p>
      <div className="rv-actions">{source && !diff?.same && <button className="button primary small" autoFocus disabled={busy} onClick={keepOriginal}>Keep my original bullet</button>}<button className="button small" aria-expanded={picking} disabled={busy || !replacements.length} onClick={() => setPicking(!picking)}>Pick another of my bullets</button><button className="button small" disabled={busy} onClick={() => void decide('rejected').then((ok) => ok && onReject(false))}>Reject: leave it out</button><button className="text-button small" onClick={() => { onReject(false); setPicking(false) }}>Cancel</button></div>
      {!replacements.length && <p className="rv-note">No other bullets from this role or project are left to use.</p>}
      {picking && <div className="rv-own">{replacements.slice(0, 4).map((item) => <p className="quote" key={item.id}><span>{item.text}</span><button className="button small" disabled={busy} onClick={() => useBullet(item.id)}>Use this bullet</button></p>)}</div>}</div>
      : <div className="rv-actions">{!blocked && <button className="button primary small" disabled={busy} aria-keyshortcuts="A" onClick={() => void decide('accepted')}>Accept <kbd aria-hidden="true">A</kbd></button>}<button className="button small" disabled={busy} aria-keyshortcuts="R" onClick={() => onReject(true)}>Reject <kbd aria-hidden="true">R</kbd></button><button className="text-button small" disabled={busy} aria-keyshortcuts="E" onClick={() => setEditing(true)}>Edit <kbd aria-hidden="true">E</kbd></button><button className="text-button small" aria-keyshortcuts="C" onClick={() => onCopy(line.text)}>Copy <kbd aria-hidden="true">C</kbd></button><button className="linkish" aria-expanded={open} onClick={onToggle}>{open ? 'Hide details' : 'Details'}</button></div>}
    {open && <div className="rv-more">
      {line.rationale && <p><b>Why this evidence:</b> {line.rationale}</p>}{line.layer2Reason && <p><b>Check:</b> {line.layer2Reason}</p>}
      {[...line.layer1Flags, ...line.slopFlags].length > 0 && <ul>{[...line.layer1Flags, ...line.slopFlags].map((flag, i) => <li key={i}>{flag}</li>)}</ul>}
      {line.text !== line.originalText && <p><b>Original suggestion:</b> {line.originalText}</p>}
      <p><b>Source evidence · {sources.length} citation(s)</b></p>{sources.map((b) => <blockquote className="quote" key={b.id}>{b.text}<small> Revision {b.rev} · {b.id.slice(0, 8)}</small></blockquote>)}
      {line.author === 'user' && <details><summary>Add this claim to the master</summary><p className="rv-note">Confirm this wording is true and choose where it belongs. This adds a new evidence bullet.</p><label className="field">Role or project<select value={section} onChange={(e) => setSection(e.target.value)}>{workspace.sections.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label><div className="rv-actions"><button className="button small" disabled={busy || !workspace.sections.some((s) => s.id === section)} onClick={() => void send([{ kind: 'add-to-master', outId: line.outId, sectionId: section }])}>Confirm and add to master</button></div></details>}
    </div>}
  </li>
}

export function TailoringWorkspace({ jobId, company, title, onApplied, onExported, startWithApply = false }: { jobId: string; company: string; title: string; onApplied: () => void; onExported?: () => void; startWithApply?: boolean }) {
  const [data, setData] = useState<ReviewWorkspace | null>(null), [runId, setRunId] = useState(''), [versions, setVersions] = useState<Array<{ runId: string; createdAt: string }>>([])
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [focusId, setFocusId] = useState(''), [proof, setProof] = useState<Proof | null>(null), [proofError, setProofError] = useState('')
  const [filter, setFilter] = useState<Filter>('all'), [open, setOpen] = useState<string | null>(null), [rejecting, setRejecting] = useState<string | null>(null), [mode, setMode] = useState<PreviewMode>('text'), [tab, setTab] = useState<'lines' | 'preview'>('lines')
  const [artifacts, setArtifacts] = useState<Artifact[]>([]), [artifactId, setArtifactId] = useState(''), [confirmed, setConfirmed] = useState(false), [download, setDownload] = useState<{ filename: string; downloadUrl: string } | null>(null), [applyOpen, setApplyOpen] = useState(startWithApply)
  const [answers, setAnswers] = useState<Answer[]>([]), [answerId, setAnswerId] = useState<string | null>(null)
  const generation = useRef(0), dataRef = useRef(data); dataRef.current = data
  const base = `/api/jobs/${jobId}/review`
  const url = `${base}${runId ? `?runId=${runId}` : ''}`
  async function loadArtifacts() { const result = await request<{ artifacts: Artifact[] }>(`/api/jobs/${jobId}/artifacts`); setArtifacts(result.artifacts) }
  async function loadAnswers() { const result = await request<{ answers: Answer[] }>(`/api/jobs/${jobId}`); setAnswers(result.answers) }
  useEffect(() => {
    let cancelled = false; setData(null); setProof(null); setNotice(''); setDownload(null)
    void Promise.all([request<ReviewWorkspace>(url), request<{ versions: typeof versions }>(`${base}/versions`)]).then(([workspace, result]) => { if (!cancelled) { setData(workspace); setVersions(result.versions) } }).catch((error) => { if (!cancelled) setNotice(error.message) })
    return () => { cancelled = true; generation.current++ }
  }, [url])
  useEffect(() => { void loadArtifacts().catch((e) => setNotice(e.message)); void loadAnswers().catch((e) => setNotice(e.message)) }, [jobId])
  useEffect(() => { if (data && !focusId) setFocusId(data.review.lines.find((line) => line.decision === 'pending')?.outId ?? data.review.lines[0]?.outId ?? '') }, [data?.review.runId])
  const pending = data?.review.lines.some((line) => line.verification === 'pending') && !data?.verificationError
  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => { void request<ReviewWorkspace>(url).then((result) => { if (dataRef.current?.review.runId === result.review.runId && dataRef.current.review.revision === result.review.revision) setData(result) }).catch((e) => setNotice(e.message)) }, 1800)
    return () => window.clearInterval(timer)
  }, [url, pending])
  useEffect(() => {
    if (!data) return
    const sequence = ++generation.current, controller = new AbortController()
    setProofError('')
    const timer = window.setTimeout(() => { void request<Proof>(`${base}/preview`, { method: 'POST', body: JSON.stringify({ runId: data.review.runId, revision: data.review.revision }), signal: controller.signal }).then((result) => { if (sequence === generation.current) setProof(result) }).catch((e) => { if (sequence === generation.current && e.name !== 'AbortError') setProofError(e.message) }) }, 450)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [data?.review.revision, data?.review.runId])
  async function copy(text: string) { try { await writeClipboard(text); setNotice('Copied as plain text.') } catch { setNotice('Clipboard access failed. Select and copy the text manually.') } }
  // Each step needs the revision the one before it produced, so steps run in order from the latest saved draft.
  async function put(action: Action, from: ReviewWorkspace) { return request<ReviewWorkspace>(base, { method: 'PUT', body: JSON.stringify({ runId: from.review.runId, revision: from.review.revision, action }) }) }
  async function send(steps: Action[]) {
    if (!data || busy) return false
    setBusy(true); setNotice('')
    let current = data
    try { for (const step of steps) current = await put(step, current); setData(current); setConfirmed(false); setNotice(current.verificationError || saved); return true }
    catch (e) { setData(current); setNotice((e as Error).message); return false }
    finally { setBusy(false) }
  }
  function advanceFrom(id: string, workspace = data) {
    const lines = workspace?.review.lines ?? [], at = lines.findIndex((line) => line.outId === id), order = [...lines.slice(at + 1), ...lines.slice(0, at + 1)], next = order.find((line) => line.decision === 'pending')?.outId ?? id
    setFocusId(next); window.setTimeout(() => document.getElementById(`review-card-${next}`)?.focus({ preventScroll: false }), 0)
  }
  async function sendAndAdvance(id: string, steps: Action[]) { const ok = await send(steps); if (ok) advanceFrom(id); return ok }
  async function acceptBacked() {
    if (!data || busy) return
    const targets = data.review.lines.filter((line) => line.verdict === 'grounded' && line.decision === 'pending')
    if (!targets.length) return
    await send(targets.map((line) => ({ kind: 'decision' as const, outId: line.outId, decision: 'accepted' as const })))
    setNotice(`Accepted ${targets.length} backed line${targets.length === 1 ? '' : 's'}. The rest need your decision.`)
  }
  async function reverify() {
    if (!data) return
    setBusy(true)
    try { const result = await request<ReviewWorkspace>(`${base}/reverify`, { method: 'POST', body: JSON.stringify({ runId: data.review.runId, revision: data.review.revision }) }); setData(result); setNotice(result.verificationError || 'Verification queued.') } catch (e) { setNotice((e as Error).message) } finally { setBusy(false) }
  }
  async function exportFile(format: 'docx' | 'pdf') {
    if (!data) return
    setBusy(true)
    try { const result = await request<{ id: string; filename: string; downloadUrl: string }>(`${base}/export`, { method: 'POST', body: JSON.stringify({ runId: data.review.runId, revision: data.review.revision, format }) }); setDownload(result); await loadArtifacts(); onExported?.(); setArtifactId(result.id); setConfirmed(false); setNotice('Export passed its text and reading-order check. Download it below.') } catch (e) { setNotice((e as Error).message) } finally { setBusy(false) }
  }
  async function markApplied() {
    if (!confirmed || !artifactId) return
    setBusy(true)
    try { await request(`/api/jobs/${jobId}/status`, { method: 'PUT', body: JSON.stringify({ status: 'applied', submittedArtifactId: artifactId }) }); setNotice('Marked applied. The selected export and current answers are frozen as the submitted record.'); onApplied() } catch (e) { setNotice((e as Error).message) } finally { setBusy(false) }
  }
  function moveFocus(event: React.KeyboardEvent<HTMLElement>) {
    if (!['ArrowDown', 'ArrowUp', 'j', 'k'].includes(event.key) || (event.target as HTMLElement).closest('textarea,input,select')) return
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('.rv-line')], index = rows.findIndex((row) => row.contains(document.activeElement))
    if (index < 0 || !(document.activeElement as HTMLElement).classList.contains('rv-line')) return
    event.preventDefault()
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' || event.key === 'j' ? 1 : -1)))]
    setFocusId(next.dataset.line ?? ''); next.focus()
  }
  if (!data) return <section className="tailoring-workspace"><h3>Review and export</h3><p role="status">{notice || 'Loading saved review…'}</p><button className="button small" onClick={() => { void request<ReviewWorkspace>(url).then(setData).catch((e) => setNotice(e.message)) }}>Reload review</button></section>
  const { review, profile } = data, accepted = review.lines.filter((line) => line.decision === 'accepted'), todo = review.lines.filter((line) => line.decision === 'pending'), rejected = review.lines.filter((line) => line.decision === 'rejected')
  const backedTodo = todo.filter((line) => line.verdict === 'grounded').length, currentProof = proof?.revision === review.revision
  const count = (verdict: ReviewLine['verdict']) => review.lines.filter((line) => line.verdict === verdict).length
  const visible = review.lines.filter((line) => filter === 'all' || (filter === 'todo' && line.decision === 'pending') || (filter === 'accepted' && line.decision === 'accepted') || (filter === 'rejected' && line.decision === 'rejected'))
  const sectionName = (id: string) => { const section = [...review.master.roles, ...review.master.projects].find((s) => s.id === id); return section ? ('company' in section ? `${section.company} · ${section.title}` : `Project · ${section.name}`) : '' }
  const chips: Array<[Filter, string, number]> = [['all', 'All', review.lines.length], ['todo', 'Needs a decision', todo.length], ['accepted', 'Accepted', accepted.length], ['rejected', 'Rejected', rejected.length]]
  const sourceText = (outId: string) => { const line = review.lines.find((l) => l.outId === outId); const source = line && [...review.master.roles, ...review.master.projects].flatMap((s) => s.bullets).find((b) => line.sourceIds.includes(b.id)); return line && source && line.author === 'model' ? { line, source: source.text, diff: wordDiff(source.text, line.text) } : null }
  let lastSection: string | null = null
  return <section className="tailoring-workspace" aria-label="Résumé review workspace">
    {notice && notice !== saved ? <Toast onClose={() => setNotice('')}>{notice}</Toast> : <p role="status" className="sr-only">{notice}</p>}
    <div className="rv-seg-m seg" role="group" aria-label="View"><button aria-pressed={tab === 'lines'} onClick={() => setTab('lines')}>Lines</button><button aria-pressed={tab === 'preview'} onClick={() => setTab('preview')}>Preview</button></div>
    <div className="rv-grid" data-tab={tab}>
      <div className="rv-lines">
        <div className="rv-bar"><div className="rv-row">{chips.map(([value, label, n]) => <button key={value} className="chip" aria-pressed={filter === value} onClick={() => setFilter(value)}><Icon name="check" />{label}<span className="n">{n}</span></button>)}<span className="count">{review.lines.length - todo.length} of {review.lines.length} decided</span></div>
          <div className="rv-row"><button className="button" disabled={busy || !backedTodo} onClick={() => void acceptBacked()}>Accept all backed lines ({backedTodo})</button><p className="rv-hint">{count('grounded')} backed · {count('stretch')} stretch · {count('unsupported')} not in your résumé. Move with <kbd aria-hidden="true">↑</kbd> <kbd aria-hidden="true">↓</kbd>, then A, R, E or C.</p></div></div>
        <details className="rv-options"><summary>Summary and skills · {review.skills.length} skills selected</summary><div className="rv-options-body"><label className="field">Summary variant<select value={review.summaryId ?? ''} disabled={busy} onChange={(e) => void send([{ kind: 'summary', summaryId: e.target.value || null }])}><option value="">No summary</option>{review.master.summaries.map((summary) => <option key={summary.id} value={summary.id}>{summary.label}</option>)}</select></label>{review.summaryId && <div><p>{review.master.summaries.find((s) => s.id === review.summaryId)?.text}</p><button className="text-button small" onClick={() => void copy(review.master.summaries.find((s) => s.id === review.summaryId)?.text ?? '')}>Copy summary</button>{data.summaryWarnings.map((flag, i) => <p className="rv-blocked" key={i}>{flag}</p>)}<p className="rv-note">Your master summary wording. Review its claims against the selected evidence.</p></div>}<fieldset className="skills-picker"><legend>Skills</legend>{review.master.skills.map((skill) => <label key={skill.name}><input type="checkbox" disabled={busy} checked={review.skills.includes(skill.name)} onChange={(e) => void send([{ kind: 'skills', skills: e.target.checked ? [...review.skills, skill.name] : review.skills.filter((s) => s !== skill.name) }])} />{skill.name}</label>)}</fieldset><button className="text-button small" onClick={() => void copy(review.skills.join(' · '))}>Copy skills</button></div></details>
        {data.verificationError && <p className="rv-blocked">{data.verificationError}</p>}
        {visible.length ? <ol className="rv-list" aria-label="Suggested lines" onKeyDown={moveFocus}>{visible.map((line) => { const heading = line.sectionId !== lastSection ? <li className="rv-sec" role="presentation" key={`h-${line.outId}`}>{sectionName(line.sectionId)}</li> : null; lastSection = line.sectionId
          return [heading, <LineRow key={line.outId} line={line} workspace={data} busy={busy} focused={focusId === line.outId} open={open === line.outId} rejecting={rejecting === line.outId} onFocus={() => setFocusId(line.outId)} onToggle={() => setOpen(open === line.outId ? null : line.outId)} onReject={(on) => setRejecting(on ? line.outId : null)} send={(steps) => sendAndAdvance(line.outId, steps)} onCopy={(text) => void copy(text)} />] })}</ol> : <div className="panel empty-note"><strong>{filter === 'todo' ? 'Every line is decided' : 'Nothing here'}</strong>{filter === 'todo' ? 'Check the preview, then export.' : ''}</div>}
      </div>
      <aside className="rv-preview" aria-label="Résumé preview">
        <div className="rv-pv-bar"><p className="meter-text" aria-live="polite">{proofError || (currentProof ? `${proof.pages} page${proof.pages === 1 ? '' : 's'} · last page ${proof.lastPagePercent}% used · ${proof.parseCheck.ok ? 'text check passed' : 'text check needs review'}` : 'Rendering PDF to measure pages…')}</p>
          <div className="seg" role="group" aria-label="Preview type"><button aria-pressed={mode === 'text'} onClick={() => setMode('text')}>Text</button><button aria-pressed={mode === 'changes'} onClick={() => setMode('changes')}>Changes</button><button aria-pressed={mode === 'pdf'} disabled={!currentProof} onClick={() => setMode('pdf')}>PDF page</button></div></div>
        {currentProof && proof.pages > 1 && <p className="rv-blocked">Content extends beyond one page.{proof.lastPagePercent < 25 ? ' A few lines spill onto the last page; reject or shorten a line.' : ' Review the page budget.'}</p>}
        {mode === 'pdf' && currentProof ? (isDesktop() ? <PdfProof base64={proof.pdfBase64} /> : <iframe title="Rendered résumé PDF" className="pdf-proof" src={`data:application/pdf;base64,${proof.pdfBase64}`} />) : <div className="rv-doc resume-paper" tabIndex={0} aria-label="Accepted résumé preview">
          {mode === 'changes' && <p className="pv-note">Changes view: not what you will send. Underlined words are new. Struck-through words are in your original but not in the suggestion.</p>}
          {data.blocks.map((block) => { const isLine = accepted.some((l) => l.outId === block.id), change = mode === 'changes' && isLine ? sourceText(block.id) : null
            return <div key={block.id} id={`resume-line-${block.id}`} className={`resume-${block.kind} ${focusId === block.id ? 'active' : ''}`} tabIndex={isLine ? 0 : undefined} role={isLine ? 'button' : undefined} onClick={isLine ? () => { setTab('lines'); setFocusId(block.id); document.getElementById(`review-card-${block.id}`)?.focus() } : undefined} onKeyDown={isLine ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab('lines'); setFocusId(block.id); document.getElementById(`review-card-${block.id}`)?.focus() } } : undefined}>{block.kind === 'bullet' ? '• ' : ''}{change && !change.diff.same && change.diff.similarity >= 0.4 ? shown(change.diff.suggested) : block.text}{change && <span className="pv-orig">{change.diff.same ? 'Same as your résumé.' : <><b>Your résumé:</b> {change.diff.similarity >= 0.4 ? shown(change.diff.original) : change.source}</>}</span>}</div> })}
          {!accepted.length && <p className="rv-note">Accept lines to add them to your résumé.</p>}</div>}
        <div className="rv-export panel"><div className="rv-row"><button className="button primary" disabled={busy || !data.exportReady} onClick={() => void exportFile('docx')}>Export DOCX</button><button className="button primary" disabled={busy || !data.exportReady} onClick={() => void exportFile('pdf')}>Export PDF</button><button className="text-button" disabled={!data.exportReady} onClick={() => void copy(data.blocks.map((b) => b.text).join('\n'))}>Copy résumé</button></div>
          {accepted.length ? <p className="rv-note">{todo.length ? `${todo.length} line${todo.length === 1 ? ' is' : 's are'} not decided yet and will be left out.` : 'Every line is decided.'}</p> : <p className="rv-note">Accept at least one line to export.</p>}
          {data.blockers.map((blocker, i) => <p className="rv-blocked" key={i}>{blocker}</p>)}{download && <a className="download-artifact" href={download.downloadUrl} download={download.filename}>Download {download.filename}</a>}{download && !applyOpen && <div className="rv-sent"><span>Sent it to the employer?</span><button className="button" onClick={() => { setApplyOpen(true); window.setTimeout(() => { const panel = window.document.getElementById('submission-panel'); panel?.scrollIntoView({ block: 'center' }); panel?.querySelector<HTMLElement>('select')?.focus() }, 0) }}>Mark as applied</button></div>}</div>
        <details className="rv-details"><summary>Draft details</summary><div className="pop"><label className="field">Draft version<select value={review.runId} disabled={busy} onChange={(e) => { setRunId(e.target.value); setConfirmed(false) }}>{versions.map((v) => <option key={v.runId} value={v.runId}>{new Date(v.createdAt).toLocaleString()} · {v.runId.slice(0, 8)}</option>)}</select></label><p className="rv-note">Revision {review.revision} · {company} · {title}. Edits run local checks immediately and queue semantic verification.{data.verificationEstimate ? ` Estimated API cost per verification: $${data.verificationEstimate.estimatedUsd.toFixed(4)} (cap $${data.verificationEstimate.capUsd.toFixed(2)}).` : ''}</p><div className="rv-actions"><button className="button small" disabled={busy} onClick={() => void reverify()}>Reverify edited lines</button><button className="text-button small" disabled={busy} onClick={() => { void request<ReviewWorkspace>(url).then(setData).catch((e) => setNotice(e.message)) }}>Reload review</button></div></div></details>
      </aside>
    </div>
    <details className="profile-drawer"><summary>Profile & application answers · copy into application forms</summary><div className="drawer-columns"><div><h4>Private profile</h4>{Object.entries(profile).map(([field, value]) => { const text = Array.isArray(value) ? value.join('\n') : value; return text ? <div className="profile-copy-field" key={field}><strong>{field.replace(/([A-Z])/g, ' $1')}</strong><p>{text}</p><button className="text-button" onClick={() => void copy(text)}>Copy {field.replace(/([A-Z])/g, ' $1').toLowerCase()}</button></div> : null })}<a href="#resume/profile">Edit profile</a></div><div><h4>Answers for this job</h4>{answers.map((answer) => <article className="answer-card" key={answer.id}><strong>{answer.question}</strong><p>{answer.answer}</p><button className="text-button" onClick={() => void copy(answer.answer)}>Copy current answer</button><button className="text-button" onClick={() => { setAnswerId(answer.id) }}>Edit answer</button>{answer.submittedAnswer !== null && <button className="text-button" onClick={() => void copy(answer.submittedAnswer!)}>Copy submitted answer</button>}</article>)}<AnswerEditor key={answerId ?? 'new'} jobId={jobId} prefix="Application " initial={answers.find((a) => a.id === answerId)} onSaved={async () => { setAnswerId(null); await loadAnswers(); setNotice('Answer saved.') }} onCancel={answerId ? () => setAnswerId(null) : undefined} /></div></div></details>
    <details className="submission-panel" id="submission-panel" open={applyOpen} onToggle={(e) => setApplyOpen(e.currentTarget.open)}><summary>Export history & mark as applied</summary><p className="subtle">Exporting creates a file on this device. Confirm the file you actually submitted to freeze its exact text and the current answers.</p>{artifacts.map((artifact) => <p key={artifact.id}><a href={`/api/jobs/${jobId}/artifacts/${artifact.id}`} download>{artifact.filename}</a> · revision {artifact.revision} · {new Date(artifact.createdAt).toLocaleString()}</p>)}<label>Submitted export<select value={artifactId} onChange={(e) => { setArtifactId(e.target.value); setConfirmed(false) }}><option value="">Choose an exported file</option>{artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.filename} · revision {artifact.revision}</option>)}</select></label><label className="confirm-submission"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I submitted this exported version.</label><button className="button primary" disabled={busy || !artifactId || !confirmed} onClick={() => void markApplied()}>Mark as applied with this export</button></details>
  </section>
}
