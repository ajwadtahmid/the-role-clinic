import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { ToastIcon, useToastTimer } from './toast.js'

type Notice = { key: string; jobId: string; failed: boolean; text: string }
type RunEventData = { id: number; jobId?: string; kind?: string; status: string; message?: string; quiet?: boolean; timestamp: string }
const labels: Record<string, string> = { extract: 'Fit check', tailor: 'Tailoring', reverify: 'Re-check' }

// Tells you when a fit check or tailoring run ends, on whatever page you are on. Events from before this page loaded, and
// events for the job you are looking at (its own status strip shows those), are ignored.
export function RunNotices() {
  const [notices, setNotices] = useState<Notice[]>([])
  const seen = useRef(new Set<number>()), opened = useRef(Date.now())
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const events = new EventSource('/api/runs/events')
    events.addEventListener('run', (message) => {
      const event = JSON.parse((message as MessageEvent).data) as RunEventData
      if (seen.current.has(event.id)) return
      seen.current.add(event.id)
      // Background fit checks are summed up on the Jobs page, not announced one by one.
      if (event.quiet) return
      if ((event.status !== 'done' && event.status !== 'failed') || !event.jobId || Date.parse(event.timestamp) < opened.current - 1000) return
      if (location.hash.startsWith(`#jobs/${event.jobId}`) || location.hash.startsWith(`#job/${event.jobId}`)) return
      const label = labels[event.kind ?? ''] ?? 'Run'
      void api<{ job: { title: string; company: string } }>(`/api/jobs/${event.jobId}`).then(({ job }) => {
        const where = `${job.title || 'a job'} at ${job.company || 'a company'}`
        const text = event.status === 'done' ? `${label} finished for ${where}.` : `${label} failed for ${where}${event.message ? `: ${event.message}` : '.'}`
        setNotices((current) => [...current.slice(-2), { key: `${event.id}`, jobId: event.jobId!, failed: event.status === 'failed', text }])
      }).catch(() => {})
    })
    return () => events.close()
  }, [])
  const dismiss = (key: string) => setNotices((current) => current.filter((item) => item.key !== key))
  if (!notices.length) return null
  return <div className="run-notices" role="status" aria-live="polite">{notices.map((notice) => <RunNotice key={notice.key} notice={notice} onClose={() => dismiss(notice.key)} />)}</div>
}

// Looks and behaves like every other toast.
function RunNotice({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const { handlers, timer } = useToastTimer(onClose)
  return <div className={`run-notice${notice.failed ? ' run-notice-failed' : ''}`} {...handlers}>
    <span className="toast-icon"><ToastIcon name={notice.failed ? 'alert' : 'check'} /></span>
    <span className="toast-text">{notice.text}</span><a className="toast-action" href={`#jobs/${notice.jobId}`} onClick={onClose}>Open job</a>
    <button className="toast-close" aria-label="Dismiss message" onClick={onClose}><ToastIcon name="x" /></button>
    {timer}
  </div>
}
