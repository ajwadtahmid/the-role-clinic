import { isDesktop, quitDesktop } from './desktop.js'
import { useEffect, useState } from 'react'
import { localApi } from './answers.js'

interface Status { version: string; platform: string; arch: string; nodeVersion: string; schemaVersion: number; dataDirectory: string; instanceId: string | null; managed: boolean; canShutdown: boolean; welcomeComplete: boolean; activeRuns: number }
const welcomeSteps: Array<{ title: string; body: string[]; action: string; target: string }> = [
  { title: 'Add your résumé', body: ['Tailoring writes only from facts you have confirmed in your master résumé, so start there. Import a PDF or DOCX, review the draft, and save it.', 'You can skip this and still save and track jobs.'], action: 'Open the Résumé page', target: '#resume' },
  { title: 'Choose a model', body: ['Ollama runs a model on this computer and is a separate optional install. Claude uses your own API key, sends the relevant résumé evidence and job text to its service, and bills you directly.', 'Your private profile and your application answers never go to a model. Review every generated line before using it.'], action: 'Open Settings', target: '#settings' },
  { title: 'Add your first job', body: ['Paste a job description or fetch it from a link. Check the fit, tailor a résumé, then track the job. The Tracker keeps what you sent, your answers and your follow-ups.', 'Your data is stored outside the app folder, so replacing the app keeps it. Make a full backup before moving to another computer.'], action: 'Go to Jobs', target: '#jobs' },
]
// A short walkthrough of the three things to set up. Every step can be skipped, and it can be shown again at `#welcome`.
export function Welcome({ busy, error, onFinish }: { busy: boolean; error: string; onFinish: (target: string) => void }) {
  const [step, setStep] = useState(0), current = welcomeSteps[step], last = step === welcomeSteps.length - 1
  return <main className="shell welcome-shell" id="main" tabIndex={-1}>
    <header className="topbar"><span className="wordmark">The Role Clinic</span><span className="local-chip">On this device</span></header>
    <section className="page-header"><h1>Welcome</h1><p className="page-note">Save jobs, tailor a résumé for each one, and keep what you sent together. Everything stays on this device unless you choose Claude.</p></section>
    <section className="panel welcome-panel" aria-labelledby="welcome-step-title">
      <p className="subtle" aria-live="polite">Step {step + 1} of {welcomeSteps.length}</p>
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
  const [status, setStatus] = useState<Status | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [hash, setHash] = useState(location.hash)
  useEffect(() => { let alive = true; void localApi<Status>('/api/app/status').then((value) => { if (alive) setStatus(value) }).catch((error) => { if (alive) setError(error.message) }); return () => { alive = false } }, [])
  useEffect(() => { const update = () => setHash(location.hash); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update) }, [])
  async function finish(target: string) {
    setBusy(true)
    try { await localApi('/api/app/welcome', { method: 'POST', body: JSON.stringify({ acknowledged: true }) }); setStatus((s) => s ? { ...s, welcomeComplete: true } : s); try { localStorage.removeItem('rc-quickstart-hidden') } catch { /* storage may be unavailable */ } location.hash = target } catch (error) { setError((error as Error).message) } finally { setBusy(false) }
  }
  if (error && !status) return <main className="shell"><p role="alert" className="notice error">{error}</p><button className="button secondary" onClick={() => location.reload()}>Reconnect to local app</button></main>
  if (!status) return <main className="shell"><p className="loading">Connecting to your local workspace…</p></main>
  if (status.welcomeComplete && hash !== '#welcome') return <>{children}</>
  return <Welcome busy={busy} error={error} onFinish={(target) => void finish(target)} />
}
export function MaintenancePanel() {
  const [status, setStatus] = useState<Status | null>(null), [backups, setBackups] = useState<Array<{ filename: string; bytes: number; createdAt: string }>>([]), [notice, setNotice] = useState(''), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false)
  async function reload() { const [info, result] = await Promise.all([localApi<Status>('/api/app/status'), localApi<{ backups: Array<{ filename: string; bytes: number; createdAt: string }> }>('/api/backups')]); setStatus(info); setBackups(result.backups) }
  useEffect(() => { void reload().catch((e) => setNotice(e.message)) }, [])
  useEffect(() => {
    if (!status?.activeRuns) return
    const timer = window.setInterval(() => { void localApi<Status>('/api/app/status').then(setStatus).catch((e) => setNotice(e.message)) }, 1500)
    return () => window.clearInterval(timer)
  }, [status?.activeRuns])
  async function backup() { setBusy(true); try { const result = await localApi<{ filename: string }>('/api/backups', { method: 'POST', body: '{}' }); await reload(); setNotice(`Database backup created: ${result.filename}`) } catch (e) { setNotice((e as Error).message) } finally { setBusy(false) } }
  async function quit() {
    if (!status || !confirmed) return
    setBusy(true)
    try { if (isDesktop()) { await quitDesktop(); return }; await localApi('/api/app/quit', { method: 'POST', body: JSON.stringify({ confirm: true, instanceId: status.instanceId }) }); setNotice('The local app is stopping. You can close this tab.'); setStatus({ ...status, canShutdown: false }) } catch (e) { setNotice((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="panel maintenance-panel"><h2>Backups and app status</h2>{status && <><p className="subtle">{status.version} · {status.platform} {status.arch} · database version {status.schemaVersion}</p><label>Data folder<input readOnly value={status.dataDirectory} onFocus={(e) => e.target.select()} /></label></>}<p className="subtle">Database backups preserve tracker and résumé records. A full backup also includes exported files, attachments and settings. Stop the app, then use the launcher’s backup command for a full backup or restore.</p><div className="button-row"><button className="button secondary" disabled={busy} onClick={() => void backup()}>Create database backup</button><a href="/guide.html#backups" target="_blank" rel="noreferrer">Backup, restore & update guide ↗</a></div><details><summary>Database backup history · {backups.length}</summary>{backups.map((b) => <div className="backup-row" key={b.filename}><a href={`/api/backups/${encodeURIComponent(b.filename)}`} download>{b.filename}</a><small>{new Date(b.createdAt).toLocaleString()} · {Math.ceil(b.bytes / 1024)} KB</small></div>)}{!backups.length && <p className="subtle">No database backups yet.</p>}</details>{status?.canShutdown && <div className="quit-app"><p>{isDesktop() ? 'Closing this window or choosing Quit stops the desktop app and its local backend. An active run requires confirmation before it is interrupted.' : <>Closing a browser tab leaves the local server running. Stop it here when you’re finished, or use <code>./role-clinic stop</code>.</>}</p>{status.activeRuns > 0 && <p className="review-flag">A model run is active. Wait for it to finish before stopping.</p>}<label className="confirm-submission"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I’m ready to stop the local app.</label><button className="button secondary" disabled={busy || !confirmed || status.activeRuns > 0} onClick={() => void quit()}>{isDesktop() ? 'Quit app' : 'Stop local app'}</button></div>}{notice && <p role="status" className="notice neutral">{notice}</p>}</section>
}
