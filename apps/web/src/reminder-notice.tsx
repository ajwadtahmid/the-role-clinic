import { useEffect, useState } from 'react'
import { api } from './api.js'
import { ToastIcon, useToastTimer } from './toast.js'
import { desktopNotifyOn, showDesktopNotification } from './desktop.js'

// Said once each time the app is opened, never again until it is reopened.
let announced = false
export function ReminderNotice() {
  const [text, setText] = useState('')
  useEffect(() => {
    if (announced) return
    announced = true
    void api<{ on: boolean; due: number; suggestions: number }>('/api/tracker/reminders').then(({ on, due, suggestions }) => {
      if (!on || (!due && !suggestions)) return
      const parts = [due ? `${due} follow-up${due === 1 ? '' : 's'} due` : '', suggestions ? `${suggestions} application${suggestions === 1 ? '' : 's'} may be closed` : ''].filter(Boolean)
      setText(parts.join(' · '))
      // In the desktop app, and only if switched on in Settings, the operating system shows it too.
      if (desktopNotifyOn()) void showDesktopNotification('The Role Clinic', parts.join(' · ')).catch(() => undefined)
    }).catch(() => {})
  }, [])
  if (!text) return null
  return <Notice text={text} onClose={() => setText('')} />
}
function Notice({ text, onClose }: { text: string; onClose: () => void }) {
  const { handlers, timer } = useToastTimer(onClose)
  return <div className="run-notices" role="status" aria-live="polite"><div className="run-notice" {...handlers}>
    <span className="toast-icon"><ToastIcon name="info" /></span><span className="toast-text">{text}</span>
    <a className="toast-action" href="#tracker" onClick={onClose}>Open Tracker</a>
    <button className="toast-close" aria-label="Dismiss message" onClick={onClose}><ToastIcon name="x" /></button>{timer}
  </div></div>
}
