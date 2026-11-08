import type { ReactNode } from 'react'

export type NavKey = 'jobs' | 'tracker' | 'resume' | 'settings'
const links: Array<[NavKey, string, string]> = [
  ['jobs', '#jobs', 'Jobs'], ['tracker', '#tracker', 'Tracker'],
  ['resume', '#resume', 'Résumé'], ['settings', '#settings', 'Settings'],
]

// The routes are hash links, so a skip link cannot use `#main` as a real address: it would change the route.
function skipToMain(event: React.MouseEvent) {
  event.preventDefault()
  document.getElementById('main')?.focus()
}

// One header for every screen: the same four destinations in the same order, with the current one marked.
export function AppHeader({ current }: { current: NavKey }) {
  return <>
    <a className="skip-link" href="#main" onClick={skipToMain}>Skip to main content</a>
    <header className="topbar">
      <a className="wordmark" href="#top"><span className="mark">RC</span><span>The Role Clinic</span></a>
      <nav aria-label="Primary">{links.map(([key, href, label]) => <a key={key} href={href} aria-current={key === current ? 'page' : undefined}>{label}</a>)}</nav>
      <span className="local-chip">
        <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
        Private · on this device
      </span>
    </header>
  </>
}

// The two halves of the Résumé page: the source résumé, and the private details that never reach a model.
export function ResumeTabs({ current }: { current: 'master' | 'profile' }) {
  return <nav className="job-tabs resume-tabs" aria-label="Résumé sections">
    <a className={`job-tab ${current === 'master' ? 'active' : ''}`} href="#resume" aria-current={current === 'master' ? 'page' : undefined}>Master résumé</a>
    <a className={`job-tab ${current === 'profile' ? 'active' : ''}`} href="#resume/profile" aria-current={current === 'profile' ? 'page' : undefined}>Profile</a>
  </nav>
}

// A compact page title with at most one line of orientation, so the work starts near the top of the screen.
export function PageHeader({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return <section className="page-header"><h1>{title}</h1>{children && <p className="page-note">{children}</p>}{actions && <div className="page-actions">{actions}</div>}</section>
}

// A short list of the sections on a long page; each button scrolls to its section.
export function SectionRail({ items }: { items: Array<{ id: string; label: string; count?: number }> }) {
  return <nav className="rail" aria-label="On this page">{items.map(({ id, label, count }) => <button key={id} type="button" onClick={() => { const target = document.getElementById(id); target?.scrollIntoView?.({ block: 'start' }); target?.focus() }}>{label}{count !== undefined && <span className="n">{count}</span>}</button>)}</nav>
}
