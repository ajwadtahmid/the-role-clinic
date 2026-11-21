import type { ReactNode } from 'react'

// A card whose body folds away. The heading stays visible, with a short summary of what is inside.
export function FoldCard({ title, summary, open, onToggle, children }: { title: string; summary?: ReactNode; open: boolean; onToggle: (open: boolean) => void; children: ReactNode }) {
  return <details className="panel fold-card" open={open} onToggle={(event) => { if (event.currentTarget.open !== open) onToggle(event.currentTarget.open) }}>
    <summary><h2>{title}</h2>{summary && <span className="subtle">{summary}</span>}</summary>
    <div className="fold-body">{children}</div>
  </details>
}
