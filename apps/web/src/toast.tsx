import { useEffect, type ReactNode } from 'react'

// A short confirmation at the bottom of the screen. It does not move the page, can offer Undo, and closes by itself unless told not to.
export function Toast({ children, onUndo, onClose, autoClose = true }: { children: ReactNode; onUndo?: () => void; onClose: () => void; autoClose?: boolean }) {
  useEffect(() => {
    if (!autoClose) return
    const timer = window.setTimeout(onClose, 8000)
    return () => window.clearTimeout(timer)
  }, [children, autoClose])
  return <div className="toast" role="status">
    <span className="toast-text">{children}</span>
    {onUndo && <button className="button quiet small" onClick={() => { onUndo(); onClose() }}>Undo</button>}
    <button className="text-button small toast-close" aria-label="Dismiss message" onClick={onClose}>×</button>
  </div>
}
