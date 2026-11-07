import { useEffect, useState } from 'react'
export function DesktopNotice() {
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null)
  useEffect(() => { const show = (e: Event) => setNotice((e as CustomEvent).detail); window.addEventListener('role-clinic:desktop-notice', show); return () => window.removeEventListener('role-clinic:desktop-notice', show) }, [])
  return notice ? <div className={`notice desktop-notice ${notice.error ? 'error' : 'neutral'}`} role={notice.error ? 'alert' : 'status'}>{notice.message}<button className="text-button" aria-label="Dismiss file notification" onClick={() => setNotice(null)}>Dismiss</button></div> : null
}
