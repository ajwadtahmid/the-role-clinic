import { useEffect, useState } from 'react'
import { api } from './api.js'
import { useToast } from './toast.js'
import { useContext } from 'react'
import { RestoreAnnouncer, useSaveSection } from './settings-save.js'
import { readDraft, useDraft } from './unsaved.js'

// How many quiet days pass before the Tracker suggests closing an application as "no reply". The Tracker only mentions it when something is due.
// The number saves with the rest of the page, from the Settings save bar.
export function FollowUpSettings() {
  const [days, setDays] = useState(14), [saved, setSaved] = useState(14), [loaded, setLoaded] = useState(false), { fail, node: toastNode } = useToast(), announceRestored = useContext(RestoreAnnouncer)
  useEffect(() => { void api<{ ghostedDays: number }>('/api/tracker/preferences').then((value) => { const draft = readDraft<number>('followups', String(value.ghostedDays)); setDays(draft ?? value.ghostedDays); setSaved(value.ghostedDays); setLoaded(true); if (draft !== null) announceRestored() }).catch(fail) }, [])
  useDraft('followups', String(saved), days, loaded && days !== saved, loaded)
  useSaveSection('followups', loaded && days !== saved, async () => { await api('/api/tracker/preferences', { method: 'PUT', body: JSON.stringify({ ghostedDays: days }) }); setSaved(days) }, () => setDays(saved))
  return <section className="panel block editor-panel" aria-labelledby="followup-heading">
    <div className="block-head"><h2 id="followup-heading">Follow-ups</h2></div>
    <p className="note">The Tracker reminds you only when something is due. After this many days with no reply, it suggests closing an application as “No reply”. Nothing changes until you confirm.</p>
    <label htmlFor="followup-days" className="narrow-field">Days with no reply
      <input id="followup-days" type="number" min={1} max={365} value={days} disabled={!loaded} onChange={(event) => setDays(Number(event.target.value))} />
    </label>
    {toastNode}
  </section>
}
