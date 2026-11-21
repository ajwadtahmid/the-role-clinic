import { useContext, useEffect, useState } from 'react'
import type { FollowUpPreferences } from '../../../packages/shared/src/index.js'
import { api } from './api.js'
import { useToast } from './toast.js'
import { RestoreAnnouncer, useSaveSection } from './settings-save.js'
import { readDraft, useDraft } from './unsaved.js'
import { FoldCard } from './ui/fold-card.js'
import { Toggle } from './ui/toggle.js'
import { desktopNotifyOn, isDesktop, setDesktopNotify } from './desktop.js'

const defaults: FollowUpPreferences = { remindersOn: true, applyOn: true, applyDays: 7, interviewOn: true, interviewDays: 2, noReplyOn: true, ghostedDays: 14, snoozeDays: 3 }

// A rule is a switch and a number: "N days after …". The number stays visible when the switch is off, so turning it back on needs no retyping.
function Rule({ id, label, on, days, disabled, onOn, onDays }: { id: string; label: string; on: boolean; days: number; disabled: boolean; onOn: (on: boolean) => void; onDays: (days: number) => void }) {
  return <div className="rule-row">
    <Toggle checked={on} disabled={disabled} onChange={onOn}>{label}</Toggle>
    <label htmlFor={id} className="rule-days"><input id={id} aria-label={`${label} (days)`} type="number" min={1} max={365} value={days} disabled={disabled || !on} onChange={(event) => onDays(Number(event.target.value))} /> days</label>
  </div>
}

// Follow-up reminders. Everything here is a default the person can change or turn off; dates already set are never touched by turning a rule off.
// The numbers save with the rest of the page, from the Settings save bar.
export function FollowUpSettings() {
  const [prefs, setPrefs] = useState(defaults), [saved, setSaved] = useState(defaults), [loaded, setLoaded] = useState(false), [open, setOpen] = useState(true)
  const { fail, node: toastNode } = useToast(), announceRestored = useContext(RestoreAnnouncer)
  const dirty = loaded && JSON.stringify(prefs) !== JSON.stringify(saved)
  useEffect(() => {
    void api<FollowUpPreferences>('/api/tracker/preferences').then((value) => {
      const draft = readDraft<FollowUpPreferences>('followups', JSON.stringify(value))
      setPrefs(draft ?? value); setSaved(value); setOpen((draft ?? value).remindersOn); setLoaded(true); if (draft !== null) announceRestored()
    }).catch(fail)
  }, [])
  useDraft('followups', JSON.stringify(saved), prefs, dirty, loaded)
  useSaveSection('followups', dirty, async () => { const next = await api<FollowUpPreferences>('/api/tracker/preferences', { method: 'PUT', body: JSON.stringify(prefs) }); setSaved(next); setPrefs(next) }, () => setPrefs(saved))
  const set = (change: Partial<FollowUpPreferences>) => setPrefs((current) => ({ ...current, ...change }))
  const off = !prefs.remindersOn
  const [notify, setNotify] = useState(desktopNotifyOn())
  return <div id="followups-card">
    <FoldCard title="Follow-up reminders" open={open} onToggle={setOpen} summary={off ? 'Off' : `${[prefs.applyOn, prefs.interviewOn, prefs.noReplyOn].filter(Boolean).length} of 3 rules on`}>
      <Toggle checked={prefs.remindersOn} disabled={!loaded} onChange={(on) => { set({ remindersOn: on }); setOpen(on) }}>Remind me to follow up</Toggle>
      <p className="note">The Tracker shows what is due when you open it. Nothing changes on its own: the app only reminds you and suggests. Dates you set yourself are never replaced. Each application also has “Add to calendar” so a calendar app can remind you while this app is closed.</p>
      {isDesktop() && <><Toggle checked={notify} disabled={off} onChange={(on) => { setNotify(on); setDesktopNotify(on) }}>Also show a desktop notification when the app opens</Toggle><p className="note">Shown by your operating system when follow-ups are due or an application may be closed. It only appears while this app is open; a calendar file reminds you when it is closed.</p></>}
      <fieldset className="rules" disabled={off}>
        <legend className="sr-only">Reminder rules</legend>
        <div className="rule-line"><Rule id="rule-apply" label="After you apply, follow up after" on={prefs.applyOn} days={prefs.applyDays} disabled={off || !loaded} onOn={(applyOn) => set({ applyOn })} onDays={(applyDays) => set({ applyDays })} /></div>
        <div className="rule-line"><Rule id="rule-interview" label="After an interview, follow up after" on={prefs.interviewOn} days={prefs.interviewDays} disabled={off || !loaded} onOn={(interviewOn) => set({ interviewOn })} onDays={(interviewDays) => set({ interviewDays })} /></div>
        <div className="rule-line"><Rule id="followup-days" label="Suggest closing as “No reply” after" on={prefs.noReplyOn} days={prefs.ghostedDays} disabled={off || !loaded} onOn={(noReplyOn) => set({ noReplyOn })} onDays={(ghostedDays) => set({ ghostedDays })} /></div>
        <label className="rule-days snooze">Snooze for <input id="snooze-days" aria-label="Snooze (days)" type="number" min={1} max={60} value={prefs.snoozeDays} disabled={off || !loaded} onChange={(event) => set({ snoozeDays: Number(event.target.value) })} /> days</label>
      </fieldset>
    </FoldCard>
    {toastNode}
  </div>
}
