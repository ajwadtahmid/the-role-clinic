import type { ReactNode } from 'react'

export type NavKey = 'jobs' | 'tracker' | 'answers' | 'master' | 'profile' | 'settings'
const links: Array<[NavKey, string, string]> = [
  ['jobs', '#jobs', 'Jobs'], ['tracker', '#tracker', 'Tracker'], ['answers', '#answers', 'Answers'],
  ['master', '#master', 'Master résumé'], ['profile', '#profile', 'Profile'], ['settings', '#settings', 'Settings'],
]

// The routes are hash links, so a skip link cannot use `#main` as a real address: it would change the route.
function skipToMain(event: React.MouseEvent) {
  event.preventDefault()
  document.getElementById('main')?.focus()
}

// One header for every screen: the same six destinations in the same order, with the current one marked.
export function AppHeader({ current }: { current: NavKey }) {
  return <>
    <a className="skip-link" href="#main" onClick={skipToMain}>Skip to main content</a>
    <header className="topbar">
      <a className="wordmark" href="#top"><span className="mark">RC</span><span>The Role Clinic</span></a>
      <nav aria-label="Primary">{links.map(([key, href, label]) => <a key={key} href={href} aria-current={key === current ? 'page' : undefined}>{label}</a>)}</nav>
      <span className="local-chip"><span className="green-dot" aria-hidden="true" /> Private · on this device</span>
    </header>
  </>
}

// A compact page title with at most one line of orientation, so the work starts near the top of the screen.
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return <section className="page-header"><h1>{title}</h1>{children && <p className="page-note">{children}</p>}</section>
}
