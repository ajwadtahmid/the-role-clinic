import { useEffect, useState } from 'react'
import { api } from './api.js'

// How many quiet days pass before the Tracker suggests closing an application as "no reply". The Tracker only mentions it when something is due.
export function FollowUpSettings() {
  const [days, setDays] = useState(14), [loaded, setLoaded] = useState(false), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { void api<{ ghostedDays: number }>('/api/tracker/preferences').then((value) => { setDays(value.ghostedDays); setLoaded(true) }).catch((error) => setMessage(error.message)) }, [])
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('')
    try { await api('/api/tracker/preferences', { method: 'PUT', body: JSON.stringify({ ghostedDays: days }) }); setMessage('Follow-up setting saved.') } catch (error) { setMessage((error as Error).message) } finally { setBusy(false) }
  }
  return <form className="panel block editor-panel" aria-labelledby="followup-heading" onSubmit={save}>
    <h2 id="followup-heading">Follow-ups</h2>
    <p className="subtle">The Tracker reminds you only when something is due. After this many days with no reply, it suggests closing an application as “No reply”. Nothing changes until you confirm.</p>
    <label htmlFor="followup-days">Days with no reply</label>
    <input id="followup-days" type="number" min={1} max={365} value={days} disabled={!loaded} onChange={(event) => setDays(Number(event.target.value))} />
    <div className="button-row"><button className="button primary" disabled={busy || !loaded}>Save follow-up setting</button></div>
    {message && <p role="status">{message}</p>}
  </form>
}
