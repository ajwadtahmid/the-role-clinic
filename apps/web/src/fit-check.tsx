import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from './api.js'
import { Icon } from './icons.js'
import type { Analysis, Estimate, Requirement } from './job-detail.js'

export type FitScore = { pct: number; label: string }
export type FitDetail = FitScore & { hardCovered: number; hardTotal: number; niceCovered: number; niceTotal: number }
export type FitMatch = { requirementId: string; bulletId: string; text: string; context: string }
const tone = (pct: number) => pct >= 55 ? '' : pct >= 40 ? ' partial' : ' weak'
// Four bars on a job card: the stronger the fit the more are filled.
const bars = (pct: number) => pct >= 75 ? 4 : pct >= 55 ? 3 : pct >= 40 ? 2 : 1

// The fit on a job card in the list.
export function FitMeter({ fit, pending }: { fit?: FitScore | null; pending: boolean }) {
  if (fit) return <span className="fit"><span className="meter" aria-hidden="true">{[1, 2, 3, 4].map((i) => <i key={i} className={i <= bars(fit.pct) ? 'on' : ''} />)}</span>{fit.label}<span className="pc">{fit.pct}%</span></span>
  return pending ? null : <span className="fit muted">Not checked</span>
}

const running = (analysis: Analysis | null) => analysis?.runs.find((run) => run.kind === 'extract' && (run.status === 'queued' || run.status === 'running')) ?? null

// The text on the Fit check tab.
export function fitTabLabel(analysis: Analysis | null) {
  if (running(analysis)) return 'Fit check · checking…'
  return analysis?.fit ? `Fit check · ${analysis.fit.pct}%` : 'Fit check'
}

// A slim line at the top of Overview: ask for the check, or say how it came out and open it.
export function FitStrip({ analysis, busy, onCheck, onView }: { analysis: Analysis | null; busy: boolean; onCheck: () => void; onView: () => void }) {
  if (!analysis) return null
  const active = running(analysis), failed = analysis.runs.find((run) => run.kind === 'extract')?.status === 'failed'
  let inner: ReactNode
  if (active) inner = <><span><b>Checking the fit…</b> {active.status === 'queued' ? 'Waiting in the queue.' : active.step && active.step !== 'starting' ? active.step : 'Reading the posting.'}</span><button className="button small" onClick={onView}>View progress</button></>
  else if (analysis.fit) inner = <><span className="fs-score">{analysis.fit.pct}%</span><span><b>{analysis.fit.label}</b> · {analysis.fit.hardCovered} of {analysis.fit.hardTotal} key requirements covered</span><button className="button small" onClick={onView}>View fit check</button></>
  else if (analysis.extraction) inner = <><span><b>No requirements to score.</b> The posting did not state any you can compare with your résumé.</span><button className="button small" onClick={onView}>View fit check</button></>
  else inner = <><span><b>{failed ? 'The last check did not finish.' : 'How well do you fit?'}</b> {failed ? 'Nothing was changed.' : 'Compare this posting with your résumé before you decide.'}</span><button className="button" disabled={busy} onClick={onCheck}>{failed ? 'Try again' : 'Check fit'}</button></>
  return <div className="fit-strip">{inner}</div>
}

function Row({ requirement, covered, match }: { requirement: Requirement; covered: boolean; match?: FitMatch }) {
  return <div className="req"><strong>{requirement.quote}</strong>
    {covered ? <span className="ev">{match ? `${match.text}${match.context ? ` (${match.context})` : ''}` : 'Covered by your résumé.'}</span> : <span className="ev none">No strong matching bullet in your master résumé.</span>}
    {!covered && requirement.category === 'skill' && <a href={`#resume?skill=${encodeURIComponent(requirement.skill || requirement.quote)}`}>Add real evidence ↗</a>}</div>
}

// The Fit check tab: how much of the posting the résumé covers, why, and what is missing.
export function JobFit({ jobId, analysis, busy, onCheck }: { jobId: string; analysis: Analysis | null; busy: boolean; onCheck: () => void }) {
  const [cost, setCost] = useState<Estimate | null>(null), checked = Boolean(analysis?.extraction)
  useEffect(() => { setCost(null); if (!checked) void api<Estimate>(`/api/jobs/${jobId}/estimate?kind=extract`).then(setCost).catch(() => undefined) }, [jobId, checked])
  if (!analysis) return <p className="loading" role="status">Loading…</p>
  const active = running(analysis), last = analysis.runs.find((run) => run.kind === 'extract')
  if (active) return <section className="fit-card" aria-labelledby="fit-h"><h3 id="fit-h">Checking the fit…</h3><div className="fit-progress" role="progressbar" aria-label="Checking the fit"><i /></div><p className="subtle" role="status">{active.status === 'queued' ? 'Waiting in the queue.' : active.step && active.step !== 'starting' ? active.step : 'Reading the posting and comparing it with your résumé.'} You can leave this page; the result will be here when you come back.</p></section>
  if (!analysis.extraction) return <section className="fit-card" aria-labelledby="fit-h"><h3 id="fit-h">Fit check</h3>
    {last?.status === 'failed' && <p className="review-flag" role="status">The last check did not finish{last.error ? `: ${last.error}` : '.'} Nothing was changed.</p>}
    <p className="subtle">Compares what this posting asks for with your master résumé and shows how much of it you already cover.{cost && cost.estimatedUsd > 0 ? ` This check uses Claude: about $${cost.estimatedUsd.toFixed(4)}. The posting and your résumé bullets are sent to Anthropic; your contact details never are.` : ' It runs on this computer.'}</p>
    <div className="actions"><button className="button primary" disabled={busy} onClick={onCheck}>{last?.status === 'failed' ? 'Try again' : 'Check fit'}</button></div></section>
  const requirements = analysis.extraction.requirements, missing = new Set(analysis.preliminaryGaps.map((gap) => gap.requirementId)), matches = new Map(analysis.matches.map((match) => [match.requirementId, match]))
  const hard = requirements.filter((r) => r.kind === 'hard'), nice = requirements.filter((r) => r.kind === 'nice'), knockouts = requirements.filter((r) => r.kind === 'knockout')
  const gaps = hard.filter((r) => missing.has(r.id)), covered = hard.filter((r) => !missing.has(r.id)), fit = analysis.fit, warn = knockouts.filter((r) => r.assessment !== 'met')
  const finished = last?.finishedAt ? new Date(last.finishedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
  return <section className="fit-card" aria-labelledby="fit-h">
    <h3 id="fit-h" className="sr-only">Fit check</h3>
    {fit ? <>
      <div className="fit-top"><span className="fit-score">{fit.pct}%</span><span className="fit-label">{fit.label}</span><span className="fit-when">{finished && `Checked ${finished} · `}<button className="text-button" disabled={busy} onClick={onCheck}>Re-check</button></span></div>
      <div className={`fit-bar${tone(fit.pct)}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fit.pct} aria-label={`Fit ${fit.pct} percent`}><i style={{ width: `${fit.pct}%` }} /></div>
      <p className="fit-counts">{fit.hardCovered} of {fit.hardTotal} key requirements covered{fit.niceTotal > 0 && ` · ${fit.niceCovered} of ${fit.niceTotal} nice-to-haves`}. Key requirements count in full, nice-to-haves a quarter.</p>
      <div className="fit-cols"><div><h4>Strongest matches</h4><ul>{covered.slice(0, 2).map((r) => <li key={r.id}>{r.quote}<span>{matches.get(r.id)?.text ?? 'Covered by your résumé.'}</span></li>)}{!covered.length && <li>None of the key requirements are covered yet.</li>}</ul></div>
        <div><h4>Biggest gaps</h4><ul>{gaps.slice(0, 2).map((r) => <li key={r.id}>{r.quote}{r.category === 'skill' && <span><a href={`#resume?skill=${encodeURIComponent(r.skill || r.quote)}`}>Add real evidence ↗</a></span>}</li>)}{!gaps.length && <li>No gaps in the key requirements.</li>}</ul></div></div>
    </> : <><p className="subtle">The posting did not state any key requirements to score.</p><div className="actions"><button className="button" disabled={busy} onClick={onCheck}>Re-check</button></div></>}
    <div className="fit-ko"><b>Knockout checks</b> <span className="subtle">They warn you; they never block anything.</span>
      {knockouts.length === 0 ? <div className="ko-row"><b>No deal-breakers</b><span className="subtle">The posting states no conditions to meet.</span></div>
        : (warn.length ? knockouts : []).map((r) => <div className={`ko-row${r.assessment !== 'met' ? ' warn' : ''}`} key={r.id}><b>{r.quote}</b><span>{r.basis}</span></div>)}
      {knockouts.length > 0 && !warn.length && <div className="ko-row"><b>No deal-breakers</b><span className="subtle">Every stated condition is met. {knockouts.length} checked.</span></div>}</div>
    <details className="req-group" open={gaps.length > 0}><summary>Not shown yet ({gaps.length})</summary>{gaps.map((r) => <Row key={r.id} requirement={r} covered={false} />)}{!gaps.length && <p className="subtle">Nothing missing.</p>}</details>
    <details className="req-group"><summary>Covered ({covered.length})</summary>{covered.map((r) => <Row key={r.id} requirement={r} covered match={matches.get(r.id)} />)}</details>
    {nice.length > 0 && <details className="req-group"><summary>Nice to have ({nice.length})</summary>{nice.map((r) => <Row key={r.id} requirement={r} covered={!missing.has(r.id)} match={matches.get(r.id)} />)}</details>}
  </section>
}

type BatchState = { running: boolean; paused: boolean; total: number; done: number; failed: number; message: string }
type BatchPreview = { count: number; provider: string; estimatedUsd: number | null; allowed: boolean }
type BatchInfo = { state: BatchState; preview: BatchPreview | null }

// "Check fits" on the Jobs page: asks first, then checks every job without a fit check, one at a time, in the background.
export function useFitBatch(onProgress: () => void, say: (text: string) => void) {
  const [info, setInfo] = useState<BatchInfo | null>(null), [asking, setAsking] = useState(false), [busy, setBusy] = useState(false)
  const wasRunning = useRef(false), askRef = useRef<HTMLButtonElement>(null)
  async function load() { try { setInfo(await api<BatchInfo>('/api/fit-batch')) } catch { /* the page works without it */ } }
  useEffect(() => { void load() }, [])
  const live = info?.state.running ?? false
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => { void load(); onProgress() }, 2000)
    return () => window.clearInterval(timer)
  }, [live])
  useEffect(() => {
    if (wasRunning.current && info && !info.state.running) { onProgress(); if (info.state.message) say(info.state.message) }
    wasRunning.current = live
  }, [live, info])
  async function start() { setBusy(true); try { await api('/api/fit-batch', { method: 'POST', body: '{}' }); setAsking(false); await load() } catch (error) { say((error as Error).message) } finally { setBusy(false) } }
  async function stop() { setBusy(true); try { await api('/api/fit-batch', { method: 'DELETE' }); await load() } finally { setBusy(false) } }
  const preview = info?.preview, state = info?.state
  const button = !live && preview && preview.count > 0 ? <button className="button" ref={askRef} onClick={() => setAsking(true)} aria-expanded={asking}><Icon name="check" />Check fits</button> : null
  let panel: ReactNode = null
  if (state?.running) panel = <div className="batch-note" role="status"><div className="grow"><b>Checking fits: {state.done + state.failed} of {state.total} done</b>{state.paused ? 'Paused while a résumé is being tailored; it carries on afterwards.' : 'One at a time on this computer. You can keep using the app.'}<div className="fit-progress done" aria-hidden="true"><i style={{ width: `${Math.round((state.done + state.failed) / Math.max(1, state.total) * 100)}%` }} /></div></div><button className="button small" disabled={busy} onClick={() => void stop()}>Stop</button></div>
  else if (asking && preview) {
    const local = preview.provider !== 'anthropic', minutes = Math.max(1, Math.round(preview.count * .5))
    panel = <div className="batch-note" role="group" aria-label="Confirm checking fits"><div className="grow"><b>Check the fit of {preview.count} job{preview.count === 1 ? '' : 's'}?</b>
      {local ? `This runs your local model one job at a time, about half a minute each, so roughly ${minutes} minute${minutes === 1 ? '' : 's'} in all. It uses your computer, so start it when you are not busy. Tailoring a résumé does not wait behind it for long, and you can stop whenever you like. Finished checks are kept.`
        : `This uses Claude, about $${(preview.estimatedUsd ?? 0).toFixed(2)} in all. The postings and your résumé bullets are sent to Anthropic; your contact details never are. It counts toward your monthly cap${preview.allowed ? '.' : ', and that would be passed, so it will stop when the cap is reached.'}`}</div>
      <button className="button primary small" disabled={busy} onClick={() => void start()}>Start checking</button><button className="button quiet small" onClick={() => { setAsking(false); askRef.current?.focus() }}>Not now</button></div>
  }
  return { button, panel }
}
