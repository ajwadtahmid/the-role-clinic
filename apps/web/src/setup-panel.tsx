import { useEffect, useState } from 'react'
import { api } from './api.js'
import { setAiFeatures, useAiFeatures } from './ai-features.js'
import { setFeedEnabled } from './feed-switch.js'
import { useToast } from './toast.js'
import { Toggle } from './ui/toggle.js'

type Feed = { enabled: boolean; fileFound: boolean; configured: boolean }
const levelName = (feedOn: boolean, tailorOn: boolean) => tailorOn ? 'Track, feed and tailor' : feedOn ? 'Track and job feed' : 'Track only'
// What the app is set up to do, as two switches on top of tracking: use a job feed, and tailor résumés with AI.
// Turning either off hides its parts and keeps its data. Tailoring on needs the guided setup first.
export function SetupPanel() {
  const { features, active } = useAiFeatures(), [feed, setFeed] = useState<Feed | null>(null), { say, fail, node: toastNode } = useToast()
  useEffect(() => { void api<Feed>('/api/feed/status').then(setFeed).catch(() => undefined) }, [])
  async function feedSwitch(on: boolean) {
    try { setFeed(await setFeedEnabled(on)); say(on ? 'Job feed is on. Jobs it brought in are back in To review.' : 'Job feed is off. Nothing was deleted.') } catch (error) { fail(error) }
  }
  async function tailorSwitch(on: boolean) {
    // Turning it on for the first time goes through the guided setup; after that it is a plain switch.
    if (on && !features.enabled) { location.hash = '#settings?setup'; return }
    try { await setAiFeatures(on ? { enabled: true, hidden: false } : { hidden: true }); say(on ? 'Tailoring is on.' : 'Tailoring is off. Your résumé, drafts and fit checks are kept.') } catch (error) { fail(error) }
  }
  const feedOn = feed?.enabled ?? false
  return <section className="panel block editor-panel" id="setup" tabIndex={-1} aria-labelledby="setup-heading">
    <div className="block-head"><h2 id="setup-heading">Your setup</h2><span className="subtle">{levelName(feedOn, active)}</span></div>
    <p className="note">Tracking is always on. Add the rest when you want it; turning one off only hides it, and nothing you saved is deleted.</p>
    <div className="setup-row"><Toggle checked={feedOn} disabled={!feed} onChange={(on) => void feedSwitch(on)}>Use a job feed</Toggle><span className="subtle">A CSV a search tool fills with jobs. {feed && feedOn && !feed.fileFound ? 'No file found yet: see Job feed below.' : 'They arrive in To review.'}</span></div>
    <div className="setup-row"><Toggle checked={active} onChange={(on) => void tailorSwitch(on)}>Tailor résumés with AI</Toggle><span className="subtle">Fit checks and tailored résumés on this computer. Needs Ollama.</span></div>
    {toastNode}
  </section>
}
