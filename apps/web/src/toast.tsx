import { useEffect, useState, type ReactNode } from 'react'

export const toastSeconds = 10
const glyph = { check: <path d="M5 12.5l4.5 4.5L19 7.5" />, alert: <path d="M12 7v6M12 17h.01" />, info: <path d="M12 11v6M12 7.5h.01" />, x: <path d="M7 7l10 10M17 7L7 17" /> }
export function ToastIcon({ name }: { name: keyof typeof glyph }) {
  return <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">{glyph[name]}</svg>
}

// Pointing at a toast or tabbing into it holds it open (so Undo can be reached); the line along its foot shows the time left.
export function useToastTimer(onClose: () => void, deps: unknown[] = []) {
  const [held, setHeld] = useState(false), [cycle, setCycle] = useState(0)
  useEffect(() => {
    if (held) return
    const timer = window.setTimeout(onClose, toastSeconds * 1000)
    return () => window.clearTimeout(timer)
  }, [held, ...deps])
  const hold = (on: boolean) => { setHeld(on); if (!on) setCycle((n) => n + 1) }
  return {
    handlers: { onMouseEnter: () => hold(true), onMouseLeave: () => hold(false), onFocus: () => hold(true), onBlur: () => hold(false), onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Escape') onClose() } },
    timer: <i className="toast-timer" key={cycle} style={{ animationDuration: `${toastSeconds}s`, animationPlayState: held ? 'paused' : 'running' }} aria-hidden="true" />,
  }
}

// A short message at the bottom of the screen. It does not move the page, can offer Undo, and closes by itself after ten seconds. Escape closes it.
export function Toast({ children, onUndo, onClose, error = false }: { children: ReactNode; onUndo?: () => void; onClose: () => void; error?: boolean }) {
  const { handlers, timer } = useToastTimer(onClose, [children])
  return <div className={`toast${error ? ' toast-error' : ''}`} role={error ? 'alert' : 'status'} {...handlers}>
    <span className="toast-icon"><ToastIcon name={error ? 'alert' : 'check'} /></span>
    <span className="toast-text">{children}</span>
    {onUndo && <button className="toast-action" onClick={() => { onUndo(); onClose() }}>Undo</button>}
    <button className="toast-close" aria-label="Dismiss message" onClick={onClose}><ToastIcon name="x" /></button>
    {timer}
  </div>
}

// One message at a time for a page or panel: say() confirms, fail() reports an error that stays until dismissed.
export function useToast() {
  const [toast, set] = useState<{ text: string; error?: boolean } | null>(null)
  return {
    say: (text: string) => set(text ? { text } : null),
    fail: (error: unknown) => set({ text: (error as Error).message, error: true }),
    node: toast ? <Toast error={toast.error} onClose={() => set(null)}>{toast.text}</Toast> : null,
  }
}
