import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { useAiFeatures } from './ai-features.js'
import type { Job } from './job-detail.js'
import { requestAddJob } from './shortcuts.js'

type Item = { key: string; label: string; hint: string; href: string }
const pages: Item[] = [
  { key: 'today', label: 'Today', hint: 'Page', href: '#today' }, { key: 'jobs', label: 'Jobs', hint: 'Page', href: '#jobs' }, { key: 'tracker', label: 'Tracker', hint: 'Page', href: '#tracker' },
  { key: 'qa', label: 'Q&A', hint: 'Page', href: '#qa' }, { key: 'settings', label: 'Settings', hint: 'Page', href: '#settings' }, { key: 'review', label: 'Start reviewing', hint: 'Action', href: '#review' }, { key: 'add', label: 'Add a job', hint: 'Action', href: '#add-job' },
]
// Ctrl+K (or Cmd+K) opens a box that jumps to a page, an action or any saved job by typing a few letters.
export function CommandPalette() {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [jobs, setJobs] = useState<Job[]>([]), [cursor, setCursor] = useState(0), input = useRef<HTMLInputElement>(null), { active } = useAiFeatures()
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setOpen((value) => !value); setQuery(''); setCursor(0) }
      else if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [])
  useEffect(() => { if (open) { input.current?.focus(); void api<{ jobs: Job[] }>('/api/jobs').then((r) => setJobs(r.jobs)).catch(() => setJobs([])) } }, [open])
  if (!open) return null
  const q = query.trim().toLowerCase()
  const entries: Item[] = [...pages, ...(active ? [{ key: 'resume', label: 'Résumé', hint: 'Page', href: '#resume' }] : [])].filter((item) => !q || item.label.toLowerCase().includes(q))
  const found: Item[] = q ? jobs.filter((j) => `${j.title} ${j.company}`.toLowerCase().includes(q)).slice(0, 8).map((j) => ({ key: j.id, label: `${j.title} · ${j.company}`, hint: 'Job', href: ['new', 'saved', 'skipped'].includes(j.status) ? `#jobs/${j.id}` : `#tracker?job=${j.id}` })) : []
  const items = [...entries, ...found], at = Math.min(cursor, Math.max(0, items.length - 1))
  const go = (item?: Item) => { if (!item) return; setOpen(false); if (item.href === '#add-job') requestAddJob(); else location.hash = item.href }
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
    <div className="dialog panel palette" role="dialog" aria-modal="true" aria-label="Search and commands">
      <input ref={input} role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items[at] ? `palette-${items[at].key}` : undefined} aria-label="Search and commands" placeholder="Jump to a job, page or action…" autoComplete="off" value={query}
        onChange={(event) => { setQuery(event.target.value); setCursor(0) }}
        onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setCursor(Math.min(at + 1, items.length - 1)) } else if (event.key === 'ArrowUp') { event.preventDefault(); setCursor(Math.max(at - 1, 0)) } else if (event.key === 'Enter') { event.preventDefault(); go(items[at]) } }} />
      <ul id="palette-list" role="listbox">{items.map((item, i) => <li key={item.key} id={`palette-${item.key}`} role="option" aria-selected={i === at}><button type="button" className={i === at ? 'active' : ''} onClick={() => go(item)}><span>{item.label}</span><span className="subtle">{item.hint}</span></button></li>)}{!items.length && <li className="subtle">Nothing matches.</li>}</ul>
      <p className="subtle">↑ ↓ to move · Enter to open · Esc to close</p>
    </div>
  </div>
}
