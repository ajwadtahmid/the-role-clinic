import { useEffect, useState } from 'react'

// Asking for the Add job dialog from anywhere: the Jobs page opens it, even when it is not the page showing yet.
let pendingAdd = false
export function requestAddJob() {
  pendingAdd = true
  if (location.hash === '' || location.hash === '#top' || location.hash === '#jobs' || /^#jobs?\//.test(location.hash)) window.dispatchEvent(new Event('role-clinic:add-job'))
  else location.hash = '#jobs'
}
export function usePendingAddJob(open: () => void) {
  useEffect(() => {
    const ask = () => { if (pendingAdd) { pendingAdd = false; open() } }
    ask()
    window.addEventListener('role-clinic:add-job', ask)
    return () => window.removeEventListener('role-clinic:add-job', ask)
  }, [])
}

const typing = (target: EventTarget | null) => Boolean((target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
const rows: Array<[string, string]> = [['N', 'Add a job'], ['Ctrl K', 'Search and commands'], ['?', 'This list'], ['S', 'Save the job (when reviewing)'], ['X', 'Skip the job (when reviewing)'], ['J / K', 'Next or previous job (when reviewing)'], ['Esc', 'Close a window']]

// N adds a job and ? lists the keys. Neither fires while you are typing, with a window open, or with Ctrl, Alt or Cmd held.
export function ShortcutKeys() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); return }
      if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target) || document.querySelector('[role="dialog"]:not(.shortcut-sheet)')) return
      if (event.key === '?') { event.preventDefault(); setOpen((value) => !value) }
      else if (event.key.toLowerCase() === 'n') { event.preventDefault(); requestAddJob() }
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [])
  if (!open) return null
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
    <div className="dialog panel shortcut-sheet" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
      <div className="panel-heading"><h2 id="shortcut-title">Keyboard shortcuts</h2><button type="button" className="text-button" aria-label="Close" onClick={() => setOpen(false)}>×</button></div>
      <dl className="keys">{rows.map(([key, what]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{what}</dd></div>)}</dl>
    </div>
  </div>
}
