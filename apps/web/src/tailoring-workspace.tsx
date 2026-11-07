import { PdfProof } from './pdf-proof.js'
import { writeClipboard, isDesktop } from './desktop.js'
import { useEffect, useRef, useState } from 'react'
import { AnswerEditor } from './answers.js'
import type { ReviewLine, ReviewWorkspace } from '../../../packages/shared/src/index.js'

type Action = { kind: 'decision'; outId: string; decision: ReviewLine['decision'] } | { kind: 'edit'; outId: string; text: string } | { kind: 'replace'; outId: string; bulletId: string } | { kind: 'summary'; summaryId: string | null } | { kind: 'skills'; skills: string[] } | { kind: 'add-to-master'; outId: string; sectionId: string }
type Proof = { revision: number; pages: number; lastPagePercent: number; parseCheck: { ok: boolean; missing: string[] }; pdfBase64: string }
type Artifact = { id: string; filename: string; createdAt: string; revision: number }
type Answer = { id: string; question: string; answer: string; submittedAnswer: string | null; charLimit: number | null; category: string; reusedFrom: string | null }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
  return data
}

function LineCard({ line, workspace, busy, active, onFocus, onAction, onCopy }: { line: ReviewLine; workspace: ReviewWorkspace; busy: boolean; active: boolean; onFocus: () => void; onAction: (action: Action) => Promise<boolean>; onCopy: (text: string) => void }) {
  const [editing, setEditing] = useState(false), [text, setText] = useState(line.text), [section, setSection] = useState(line.sectionId)
  useEffect(() => { setText(line.text) }, [line.text])
  const sourceRows = [...workspace.review.master.roles, ...workspace.review.master.projects].flatMap((s) => s.bullets).filter((b) => line.sourceIds.includes(b.id))
  const replacements = workspace.replacements.filter((r) => r.sectionId === line.sectionId)
  async function save() { if (await onAction({ kind: 'edit', outId: line.outId, text })) setEditing(false) }
  return <article id={`review-card-${line.outId}`} className={`review-card ${active ? 'active' : ''} decision-${line.decision}`} tabIndex={0} onFocus={onFocus} onKeyDown={(event) => {
    if (event.target !== event.currentTarget || busy) return
    const key = event.key.toLowerCase()
    if (['a', 'r', 'e', 'c'].includes(key)) event.preventDefault()
    if (key === 'a') void onAction({ kind: 'decision', outId: line.outId, decision: 'accepted' })
    if (key === 'r') void onAction({ kind: 'decision', outId: line.outId, decision: 'rejected' })
    if (key === 'e') setEditing(true)
    if (key === 'c') onCopy(line.text)
  }} aria-label={`Review line: ${line.text}`}>
    <div className="review-card-status"><span className={`gate gate-${line.verdict}`}>{line.verdict}</span><span>{line.decision} · {line.author === 'user' ? 'your wording' : 'suggested wording'}{line.verification !== 'checked' ? ` · verification ${line.verification}` : ''}</span></div>
    {editing ? <div><label>Edit résumé line<textarea autoFocus maxLength={4000} rows={5} value={text} onChange={(e) => setText(e.target.value)} /></label><div className="button-row"><button className="button secondary" disabled={busy || !text.trim()} onClick={() => void save()}>Save wording</button><button className="text-button" disabled={busy} onClick={() => { setEditing(false); setText(line.text) }}>Cancel edit</button></div></div> : <p className="review-wording">{line.text}</p>}
    {line.text !== line.originalText && <details><summary>Original suggestion</summary><p>{line.originalText}</p></details>}
    <details><summary>Source evidence · {sourceRows.length} citation(s)</summary>{sourceRows.map((b) => <blockquote key={b.id}>{b.text}<small>Revision {b.rev} · {b.id.slice(0, 8)}</small></blockquote>)}</details>
    {line.rationale && <p className="subtle">Why this evidence: {line.rationale}</p>}
    <p className="subtle">{line.layer2Reason}</p>
    {[...line.layer1Flags, ...line.slopFlags].map((flag, i) => <p className="review-flag" key={i}>{flag}</p>)}
    {line.author === 'user' && (line.verdict !== 'grounded' || line.layer1Flags.length > 0) && <p className="subtle">Your wording can be exported after acceptance. Review these warnings and add the claim to your master only if it is true.</p>}
    <div className="review-actions"><button className="button secondary" disabled={busy || line.decision === 'accepted'} onClick={() => void onAction({ kind: 'decision', outId: line.outId, decision: 'accepted' })}>Accept</button><button className="button secondary" disabled={busy || line.decision === 'rejected'} onClick={() => void onAction({ kind: 'decision', outId: line.outId, decision: 'rejected' })}>Reject</button><button className="text-button" disabled={busy} onClick={() => setEditing(true)}>Edit</button><button className="text-button" onClick={() => onCopy(line.text)}>Copy line</button>{line.decision !== 'pending' && <button className="text-button" disabled={busy} onClick={() => void onAction({ kind: 'decision', outId: line.outId, decision: 'pending' })}>Reset decision</button>}</div>
    {line.decision === 'rejected' && <div className="replacement-picker"><p className="subtle">Next source bullets for this role or project</p>{replacements.slice(0, 3).map((item) => <div key={item.id}><p>{item.text}</p><small>{item.rationale}</small><button className="text-button" disabled={busy} onClick={() => void onAction({ kind: 'replace', outId: line.outId, bulletId: item.id })}>Use this source bullet</button></div>)}{!replacements.length && <p className="subtle">No unused source bullets remain in this section.</p>}</div>}
    {line.author === 'user' && <details><summary>Add this claim to the master</summary><p className="subtle">Confirm this wording is true and choose where it belongs. This adds a new evidence bullet.</p><label>Role or project<select value={section} onChange={(e) => setSection(e.target.value)}>{workspace.sections.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label><button className="button secondary" disabled={busy || !workspace.sections.some((s) => s.id === section)} onClick={() => void onAction({ kind: 'add-to-master', outId: line.outId, sectionId: section })}>Confirm and add to master</button></details>}
  </article>
}

export function TailoringWorkspace({ jobId, company, title, onApplied, onExported }: { jobId: string; company: string; title: string; onApplied: () => void; onExported?: () => void }) {
  const [data, setData] = useState<ReviewWorkspace | null>(null), [runId, setRunId] = useState(''), [versions, setVersions] = useState<Array<{ runId: string; createdAt: string }>>([])
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [active, setActive] = useState(''), [proof, setProof] = useState<Proof | null>(null), [proofError, setProofError] = useState(''), [showPdf, setShowPdf] = useState(false)
  const [artifacts, setArtifacts] = useState<Artifact[]>([]), [artifactId, setArtifactId] = useState(''), [confirmed, setConfirmed] = useState(false), [download, setDownload] = useState<{ filename: string; downloadUrl: string } | null>(null)
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
  function focus(id: string, card = false) { setActive(id); document.getElementById(`${card ? 'review-card' : 'resume-line'}-${id}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); if (card) document.getElementById(`review-card-${id}`)?.focus({ preventScroll: true }) }
  async function copy(text: string) { try { await writeClipboard(text); setNotice('Copied as plain text.') } catch { setNotice('Clipboard access failed. Select and copy the text manually.') } }
  async function act(action: Action) {
    if (!data || busy) return false
    setBusy(true); setNotice('')
    try { const result = await request<ReviewWorkspace>(base, { method: 'PUT', body: JSON.stringify({ runId: data.review.runId, revision: data.review.revision, action }) }); setData(result); setConfirmed(false); setNotice(result.verificationError || 'Review saved locally.'); return true }
    catch (e) { setNotice((e as Error).message); return false }
    finally { setBusy(false) }
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
  if (!data) return <section className="tailoring-workspace"><h3>Review and export</h3><p role="status">{notice || 'Loading saved review…'}</p><button className="text-button" onClick={() => { void request<ReviewWorkspace>(url).then(setData).catch((e) => setNotice(e.message)) }}>Reload review</button></section>
  const { review, profile } = data, accepted = review.lines.filter((line) => line.decision === 'accepted'), currentProof = proof?.revision === review.revision
  return <section className="tailoring-workspace" aria-label="Résumé review workspace">
    <div className="panel-heading"><div><h3>{company} · {title}</h3><p className="subtle">Revision {review.revision} · {accepted.length}/{review.lines.length} lines accepted · shortcuts on a focused card: A / R / E / C</p></div><label>Draft version<select value={review.runId} disabled={busy} onChange={(e) => { setRunId(e.target.value); setConfirmed(false) }}>{versions.map((v) => <option key={v.runId} value={v.runId}>{new Date(v.createdAt).toLocaleString()} · {v.runId.slice(0, 8)}</option>)}</select></label></div>
    {notice && <p className="notice neutral" role="status">{notice}</p>}
    <div className="review-toolbar"><p className="subtle">Edits run local checks immediately and queue semantic verification.{data.verificationEstimate ? ` Estimated API cost per verification: $${data.verificationEstimate.estimatedUsd.toFixed(4)} (cap $${data.verificationEstimate.capUsd.toFixed(2)}).` : ''}</p><button className="button secondary" disabled={busy} onClick={() => void reverify()}>Reverify edited lines</button><button className="text-button" disabled={busy} onClick={() => { void request<ReviewWorkspace>(url).then(setData).catch((e) => setNotice(e.message)) }}>Reload review</button></div>
    {data.verificationError && <p className="review-flag">{data.verificationError}</p>}
    <div className="review-layout"><div className="review-cards">
      <div className="review-options"><label>Summary variant<select value={review.summaryId ?? ''} disabled={busy} onChange={(e) => void act({ kind: 'summary', summaryId: e.target.value || null })}><option value="">No summary</option>{review.master.summaries.map((summary) => <option key={summary.id} value={summary.id}>{summary.label}</option>)}</select></label>{review.summaryId && <div><p>{review.master.summaries.find((s) => s.id === review.summaryId)?.text}</p><button className="text-button" onClick={() => void copy(review.master.summaries.find((s) => s.id === review.summaryId)?.text ?? '')}>Copy summary</button>{data.summaryWarnings.map((flag, i) => <p className="review-flag" key={i}>{flag}</p>)}<p className="subtle">Your master summary wording. Review its claims against the selected evidence.</p></div>}<details><summary>Skills · {review.skills.length} selected</summary><div className="skills-picker">{review.master.skills.map((skill) => <label key={skill.name}><input type="checkbox" disabled={busy} checked={review.skills.includes(skill.name)} onChange={(e) => void act({ kind: 'skills', skills: e.target.checked ? [...review.skills, skill.name] : review.skills.filter((s) => s !== skill.name) })} />{skill.name}</label>)}</div><button className="text-button" onClick={() => void copy(review.skills.join(' · '))}>Copy skills</button></details></div>
      {[...review.master.roles, ...review.master.projects].map((section) => { const lines = review.lines.filter((line) => line.sectionId === section.id); if (!lines.length) return null; return <div key={section.id}><div className="review-group-heading"><h4>{'company' in section ? `${section.title} · ${section.company}` : `Project · ${section.name}`}</h4><button className="text-button" onClick={() => void copy(lines.filter((line) => line.decision === 'accepted').map((line) => line.text).join('\n'))}>Copy accepted section</button></div>{lines.map((line) => <LineCard key={line.outId} line={line} workspace={data} busy={busy} active={active === line.outId} onFocus={() => focus(line.outId)} onAction={act} onCopy={(text) => void copy(text)} />)}</div> })}
    </div><aside className="resume-preview-pane"><div className="preview-heading"><h4>Document preview</h4><button className="text-button" disabled={!currentProof} onClick={() => setShowPdf(!showPdf)}>{showPdf ? 'Interactive preview' : 'View rendered PDF'}</button></div><p className="page-meter" aria-live="polite">{proofError || (currentProof ? `${proof.pages} page${proof.pages === 1 ? '' : 's'} · last page ${proof.lastPagePercent}% used · ${proof.parseCheck.ok ? 'text check passed' : 'text check needs review'}` : 'Rendering PDF to measure pages…')}</p>{currentProof && proof.pages > 1 && <p className="review-flag">Content extends beyond one page.{proof.lastPagePercent < 25 ? ' A few lines spill onto the last page; reject or shorten a line.' : ' Review the page budget.'}</p>}{showPdf && currentProof ? (isDesktop() ? <PdfProof base64={proof.pdfBase64} /> : <iframe title="Rendered résumé PDF" className="pdf-proof" src={`data:application/pdf;base64,${proof.pdfBase64}`} />) : <div className="resume-paper" aria-label="Accepted résumé preview">{data.blocks.map((block) => { const line = accepted.some((l) => l.outId === block.id); return <div key={block.id} id={`resume-line-${block.id}`} className={`resume-${block.kind} ${active === block.id ? 'active' : ''}`} tabIndex={line ? 0 : undefined} role={line ? 'button' : undefined} onClick={line ? () => focus(block.id, true) : undefined} onKeyDown={line ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focus(block.id, true) } } : undefined}>{block.kind === 'bullet' ? '• ' : ''}{block.text}</div> })}{!accepted.length && <p className="subtle">Accept lines to add them to your résumé.</p>}</div>}
      <div className="export-controls"><button className="button primary" disabled={busy || !data.exportReady} onClick={() => void exportFile('docx')}>Export DOCX</button><button className="button secondary" disabled={busy || !data.exportReady} onClick={() => void exportFile('pdf')}>Export PDF</button><button className="text-button" disabled={!data.exportReady} onClick={() => void copy(data.blocks.map((b) => b.text).join('\n'))}>Copy résumé</button></div>{data.blockers.map((blocker, i) => <p className="review-flag" key={i}>{blocker}</p>)}{download && <a className="download-artifact" href={download.downloadUrl} download={download.filename}>Download {download.filename}</a>}
    </aside></div>
    <details className="profile-drawer"><summary>Profile & application answers · copy into application forms</summary><div className="drawer-columns"><div><h4>Private profile</h4>{Object.entries(profile).map(([field, value]) => { const text = Array.isArray(value) ? value.join('\n') : value; return text ? <div className="profile-copy-field" key={field}><strong>{field.replace(/([A-Z])/g, ' $1')}</strong><p>{text}</p><button className="text-button" onClick={() => void copy(text)}>Copy {field.replace(/([A-Z])/g, ' $1').toLowerCase()}</button></div> : null })}<a href="#profile">Edit profile</a></div><div><h4>Answers for this job</h4>{answers.map((answer) => <article className="answer-card" key={answer.id}><strong>{answer.question}</strong><p>{answer.answer}</p><button className="text-button" onClick={() => void copy(answer.answer)}>Copy current answer</button><button className="text-button" onClick={() => { setAnswerId(answer.id) }}>Edit answer</button>{answer.submittedAnswer !== null && <button className="text-button" onClick={() => void copy(answer.submittedAnswer!)}>Copy submitted answer</button>}</article>)}<AnswerEditor key={answerId ?? 'new'} jobId={jobId} prefix="Application " initial={answers.find((a) => a.id === answerId)} onSaved={async () => { setAnswerId(null); await loadAnswers(); setNotice('Answer saved.') }} onCancel={answerId ? () => setAnswerId(null) : undefined} /></div></div></details>
    <details className="submission-panel"><summary>Export history & mark as applied</summary><p className="subtle">Exporting creates a file on this device. Confirm the file you actually submitted to freeze its exact text and the current answers.</p>{artifacts.map((artifact) => <p key={artifact.id}><a href={`/api/jobs/${jobId}/artifacts/${artifact.id}`} download>{artifact.filename}</a> · revision {artifact.revision} · {new Date(artifact.createdAt).toLocaleString()}</p>)}<label>Submitted export<select value={artifactId} onChange={(e) => { setArtifactId(e.target.value); setConfirmed(false) }}><option value="">Choose an exported file</option>{artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.filename} · revision {artifact.revision}</option>)}</select></label><label className="confirm-submission"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I submitted this exported version.</label><button className="button primary" disabled={busy || !artifactId || !confirmed} onClick={() => void markApplied()}>Mark as applied with this export</button></details>
  </section>
}
