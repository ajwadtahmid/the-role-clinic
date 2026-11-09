import { useEffect, useState, type ReactNode } from 'react'

// A short confirmation at the bottom of the screen. It does not move the page, can offer Undo, and closes by itself unless told not to.
export function Toast({ children, onUndo, onClose, error = false, autoClose = !error }: { children: ReactNode; onUndo?: () => void; onClose: () => void; error?: boolean; autoClose?: boolean }) {
  useEffect(() => {
    if (!autoClose) return
    const timer = window.setTimeout(onClose, 8000)
    return () => window.clearTimeout(timer)
  }, [children, autoClose])
  return <div className={`toast${error ? ' toast-error' : ''}`} role={error ? 'alert' : 'status'}>
    <span className="toast-text">{children}</span>
    {onUndo && <button className="button quiet small" onClick={() => { onUndo(); onClose() }}>Undo</button>}
    <button className="text-button small toast-close" aria-label="Dismiss message" onClick={onClose}>×</button>
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
