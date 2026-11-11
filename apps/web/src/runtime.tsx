import { isDesktop, quitDesktop } from './desktop.js'
import { useEffect, useState } from 'react'
import { localApi } from './answers.js'
import { useToast } from './toast.js'
import { loadAiFeatures, setAiFeatures, useAiFeatures } from './ai-features.js'

interface Status { version: string; platform: string; arch: string; nodeVersion: string; schemaVersion: number; dataDirectory: string; instanceId: string | null; managed: boolean; canShutdown: boolean; welcomeComplete: boolean; activeRuns: number }
const welcomeSteps: Array<{ title: string; body: string[]; action: string; target: string }> = [
  { title: 'Add your résumé', body: ['Tailoring writes only from facts you have confirmed in your master résumé, so start there. Import a PDF or DOCX, review the draft, and save it.', 'You can skip this and still save and track jobs.'], action: 'Open the Résumé page', target: '#resume' },
  { title: 'Choose a model', body: ['Ollama runs a model on this computer and is a separate optional install. Claude uses your own API key, sends the relevant résumé evidence and job text to its service, and bills you directly.', 'Your private profile and your application answers never go to a model. Review every generated line before using it.'], action: 'Open Settings', target: '#settings' },
  { title: 'Add your first job', body: ['Paste a job description or fetch it from a link. Check the fit, tailor a résumé, then track the job. The Tracker keeps what you sent, your answers and your follow-ups.', 'Your data is stored outside the app folder, so replacing the app keeps it. Make a full backup before moving to another computer.'], action: 'Go to Jobs', target: '#jobs' },
]
// A short walkthrough of the three things to set up. Every step can be skipped, and it can be shown again at `#welcome`.
export function Welcome({ busy, error, onFinish }: { busy: boolean; error: string; onFinish: (target: string) => void }) {
  const { features } = useAiFeatures(), [choosing, setChoosing] = useState(false), [problem, setProblem] = useState('')
  const [step, setStep] = useState(0)
  // Without AI features the walkthrough is just the last step.
  const steps = features.enabled ? welcomeSteps : [{ ...welcomeSteps[2], body: [welcomeSteps[2].body[0], 'AI features are off. You can turn them on at any time in Settings.'] }]
  const current = steps[step], last = step === steps.length - 1
  async function choose(withAi: boolean) {
    setChoosing(true); setProblem('')
    try { await setAiFeatures({ enabled: false }); onFinish(withAi ? '#settings?setup' : '#jobs') } catch (issue) { setProblem((issue as Error).message) } finally { setChoosing(false) }
  }
  if (!features.chosen) return <main className="shell welcome-shell" id="main" tabIndex={-1}>
    <header className="topbar"><span className="wordmark"><img className="mark" src="/logo.svg" alt="" /><span>The Role Clinic</span></span><span className="local-chip"><svg className="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>Private · on this device</span></header>
    <section className="page-header"><h1>How do you want to start?</h1><p className="page-note">Everything stays on this device either way. You can change this at any time in Settings.</p></section>
    <section className="panel welcome-panel" aria-label="Choose how to start">
      <div className="start-choices">
        <button className="start-choice" disabled={busy || choosing} onClick={() => void choose(false)}><strong>Just track my applications</strong><span>Save jobs, record what you applied to, set follow-ups and keep notes. Nothing else to set up.</span><span className="pill-note">Ready in a minute</span></button>
        <button className="start-choice" disabled={busy || choosing} onClick={() => void choose(true)}><strong>Also tailor résumés with AI</strong><span>Check how well you fit a job and write a tailored résumé from your own facts. Needs a local AI model; we will walk you through it.</span><span className="pill-note">Takes a few minutes the first time</span></button>
      </div>
      <p className="subtle">Not sure? Start with tracking. Setting up AI later does not change anything you have saved.</p>
      {(problem || error) && <p role="alert" className="notice error">{problem || error}</p>}
    </section>
  </main>
  return <main className="shell welcome-shell" id="main" tabIndex={-1}>
    <header className="topbar"><span className="wordmark"><img className="mark" src="/logo.svg" alt="" /><span>The Role Clinic</span></span><span className="local-chip"><svg className="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>Private · on this device</span></header>
    <section className="page-header"><h1>Welcome</h1><p className="page-note">Save jobs, tailor a résumé for each one, and keep what you sent together. Everything stays on this device unless you choose Claude.</p></section>
    <section className="panel welcome-panel" aria-labelledby="welcome-step-title">
      <p className="subtle" aria-live="polite">Step {step + 1} of {steps.length}</p>
      <h2 id="welcome-step-title">{current.title}</h2>
      {current.body.map((text) => <p key={text}>{text}</p>)}
      <div className="button-row">
        <button className="button primary" disabled={busy} onClick={() => onFinish(current.target)}>{current.action}</button>
        {last ? <button className="button secondary" disabled={busy} onClick={() => onFinish('#jobs')}>Finish</button> : <button className="button secondary" onClick={() => setStep(step + 1)}>Next</button>}
        {step > 0 && <button className="text-button" onClick={() => setStep(step - 1)}>Back</button>}
        <button className="text-button" disabled={busy} onClick={() => onFinish('#jobs')}>Skip for now</button>
      </div>
      <p className="subtle"><a href="/guide.html" target="_blank" rel="noreferrer">Read the Linux user guide ↗</a></p>
      {error && <p role="alert">{error}</p>}
    </section>
  </main>
}
export function FirstRun({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [hash, setHash] = useState(location.hash), [featuresReady, setFeaturesReady] = useState(false)
  useEffect(() => { void loadAiFeatures().then(() => setFeaturesReady(true)) }, [])
  useEffect(() => { let alive = true; void localApi<Status>('/api/app/status').then((value) => { if (alive) setStatus(value) }).catch((error) => { if (alive) setError(error.message) }); return () => { alive = false } }, [])
  useEffect(() => { const update = () => setHash(location.hash); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update) }, [])
  async function finish(target: string) {
    setBusy(true)
    try { await localApi('/api/app/welcome', { method: 'POST', body: JSON.stringify({ acknowledged: true }) }); setStatus((s) => s ? { ...s, welcomeComplete: true } : s); try { localStorage.removeItem('rc-quickstart-hidden') } catch { /* storage may be unavailable */ } location.hash = target } catch (error) { setError((error as Error).message) } finally { setBusy(false) }
  }
  if (error && !status) return <main className="shell"><p role="alert" className="notice error">{error}</p><button className="button secondary" onClick={() => location.reload()}>Reconnect to local app</button></main>
  if (!status || !featuresReady) return <main className="shell"><p className="loading">Connecting to your local workspace…</p></main>
  if (status.welcomeComplete && hash !== '#welcome') return <>{children}</>
  return <Welcome busy={busy} error={error} onFinish={(target) => void finish(target)} />
}
type Backup = { filename: string; bytes: number; createdAt: string }
// Automatic daily copies, copies made by hand, and the one kept before an update all share the folder.
const backupKind = (filename: string) => filename.startsWith('auto-') ? 'Automatic' : filename.startsWith('pre-migration-') ? 'Before an update' : 'Manual'
const shownBackups = 3
const sizeText = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`

// Two separate confirmations: a first screen that lists what is lost, then typing DELETE. Nothing can be undone.
export function ClearDataPanel() {
  const [step, setStep] = useState<0 | 1 | 2>(0), [typed, setTyped] = useState(''), [busy, setBusy] = useState(false), { fail, node: toastNode } = useToast()
  const close = () => { setStep(0); setTyped('') }
  async function clear() {
    setBusy(true)
    try { await localApi('/api/app/clear-data', { method: 'POST', body: JSON.stringify({ confirm: typed }) }); try { localStorage.clear() } catch { /* storage may be unavailable */ } location.hash = ''; location.reload() } catch (e) { fail(e); setBusy(false) }
  }
  return <section className="panel block editor-panel" aria-labelledby="clear-heading">
    <div className="block-head"><h2 id="clear-heading">Clear data</h2>{step === 0 && <button className="button small quiet danger" onClick={() => setStep(1)}>Clear all data…</button>}</div>
    <p className="note">Deletes everything saved in your data folder and puts the app back to how it was when you first opened it. This cannot be undone.</p>
    {step === 1 && <div className="confirm on" role="alertdialog" aria-label="Clear all data">
      <span><b>This permanently deletes</b> your jobs, tracker, résumé, answers, exported files, settings and every backup kept in the data folder. Download a backup first if you might want anything back. Your job search files are not touched.</span>
      <button className="button small danger" onClick={() => setStep(2)}>Continue</button><button className="button small quiet" onClick={close}>Cancel</button>
    </div>}
    {step === 2 && <div className="confirm on" role="alertdialog" aria-label="Type DELETE to clear all data">
      <span>Last step. Type <b>DELETE</b> to erase everything now.</span>
      <input className="confirm-input" aria-label="Type DELETE to confirm" value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus autoComplete="off" spellCheck={false} />
      <button className="button small danger" disabled={busy || typed !== 'DELETE'} onClick={() => void clear()}>Erase everything</button><button className="button small quiet" disabled={busy} onClick={close}>Cancel</button>
    </div>}
    {toastNode}
  </section>
}

export function BackupsPanel() {
  const [status, setStatus] = useState<Status | null>(null), [backups, setBackups] = useState<Backup[]>([]), [all, setAll] = useState(false), [busy, setBusy] = useState(false), { say: setNotice, fail, node: toastNode } = useToast()
  async function reload() { const [info, result] = await Promise.all([localApi<Status>('/api/app/status'), localApi<{ backups: Backup[] }>('/api/backups')]); setStatus(info); setBackups(result.backups) }
  useEffect(() => { void reload().catch((e) => fail(e)) }, [])
  async function backup() { setBusy(true); try { const result = await localApi<{ filename: string }>('/api/backups', { method: 'POST', body: '{}' }); await reload(); setNotice(`Backup made: ${result.filename}`) } catch (e) { fail(e) } finally { setBusy(false) } }
  async function copyFolder() { try { await navigator.clipboard.writeText(status?.dataDirectory ?? ''); setNotice('Path copied.') } catch { setNotice('Select the path and copy it.') } }
  const visible = all ? backups : backups.slice(0, shownBackups)
  return <section className="panel block editor-panel" aria-labelledby="backups-heading">
    <div className="block-head"><h2 id="backups-heading">Backups</h2><button className="button small" disabled={busy} onClick={() => void backup()}>Back up now</button></div>
    <p className="note">A backup keeps your tracker, résumé and answers. A copy is also made automatically once a day. A full backup, with exported files, attachments and settings, is made from the launcher while the app is stopped.</p>
    {status && <div className="row first"><div className="grow"><b>Your data folder</b><br /><code>{status.dataDirectory}</code></div><button className="button small" onClick={() => void copyFolder()}>Copy path</button></div>}
    <div className="backup-list">{visible.map((b) => <div className="row" key={b.filename}><div className="grow"><b>{backupKind(b.filename)} backup</b> <span className="muted">· {new Date(b.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · {sizeText(b.bytes)}</span></div><a className="button small quiet" href={`/api/backups/${encodeURIComponent(b.filename)}`} download aria-label={`Download ${b.filename}`}>Download</a></div>)}</div>
    {backups.length > shownBackups && <div className="actions"><button className="button small quiet" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show ${backups.length - shownBackups} more`}</button></div>}
    {!backups.length && <p className="note">No backups yet. Back up now makes the first one.</p>}
    <div className="actions"><a className="button small quiet" href="/guide.html#backups" target="_blank" rel="noreferrer">Backup, restore and update guide ↗</a></div>
    {toastNode}
  </section>
}

// Facts about the app, the guide, and the control that stops it. Last on the Settings page.
export function AboutPanel() {
  const [status, setStatus] = useState<Status | null>(null), [asking, setAsking] = useState(false), [busy, setBusy] = useState(false), { say: setNotice, fail, node: toastNode } = useToast()
  useEffect(() => { void localApi<Status>('/api/app/status').then(setStatus).catch((e) => fail(e)) }, [])
  useEffect(() => {
    if (!status?.activeRuns) return
    const timer = window.setInterval(() => { void localApi<Status>('/api/app/status').then(setStatus).catch((e) => fail(e)) }, 1500)
    return () => window.clearInterval(timer)
  }, [status?.activeRuns])
  async function quit() {
    if (!status) return
    setBusy(true)
    try { if (isDesktop()) { await quitDesktop(); return }; await localApi('/api/app/quit', { method: 'POST', body: JSON.stringify({ confirm: true, instanceId: status.instanceId }) }); setNotice('The local app is stopping. You can close this tab.'); setAsking(false); setStatus({ ...status, canShutdown: false }) } catch (e) { fail(e) } finally { setBusy(false) }
  }
  return <section className="panel block editor-panel" aria-labelledby="about-heading">
    <div className="block-head"><h2 id="about-heading">About</h2></div>
    {status && <dl className="facts"><dt>Version</dt><dd>{status.version} · {status.platform} {status.arch}</dd><dt>Database</dt><dd>Version {status.schemaVersion}</dd><dt>Privacy</dt><dd>Saved on this computer. Your contact details and saved answers are never sent to a model.</dd></dl>}
    <div className="actions"><a className="button small" href="/guide.html" target="_blank" rel="noreferrer">User guide ↗</a><a className="button small" href="#welcome" onClick={() => { try { localStorage.removeItem('rc-quickstart-hidden') } catch { /* storage may be unavailable */ } }}>Show the welcome guide again</a></div>
    {status?.canShutdown && <div className="row stop-row"><div className="grow"><b>{isDesktop() ? 'Quit the app' : 'Stop the app'}</b><br /><span className="muted">{isDesktop() ? 'Closing this window or choosing Quit stops the desktop app and its local backend.' : <>Closing a browser tab leaves the local server running. Stop it here when you’re finished, or use <code>./role-clinic stop</code>.</>}</span></div><button className="button small" disabled={busy || status.activeRuns > 0} onClick={() => setAsking(true)}>{isDesktop() ? 'Quit app…' : 'Stop local app…'}</button></div>}
    {status && status.activeRuns > 0 && <p className="review-flag">A model run is active. Wait for it to finish before stopping.</p>}
    {asking && <div className="confirm on" role="alertdialog" aria-label="Stop Role Clinic"><span>Stop the local app now? Anything open will stop updating.</span><button className="button small primary" disabled={busy || (status?.activeRuns ?? 0) > 0} onClick={() => void quit()}>Yes, stop it</button><button className="button small quiet" onClick={() => setAsking(false)}>Keep running</button></div>}
    {toastNode}
  </section>
}
