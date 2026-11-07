import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FirstRun } from './runtime.js'
import { SettingsPage } from './settings-page.js'
import { TrackerPage } from './tracker-page.js'
import { Workspace } from './workspace.js'
import { MasterPage, ProfilePage } from './master-page.js'
import { RunNotices } from './run-notices.js'
import './style.css'

function Pages() {
  const [route, setRoute] = useState(location.hash)
  useEffect(() => { const update = () => setRoute(location.hash); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update) }, [])
  // Moving to another page puts focus on its heading, so screen readers announce where you are. Choosing a job within Jobs does not count.
  const page = route.split(/[/?]/)[0].replace(/^#job$/, '#jobs').replace('#answers', '#tracker').replace('#master', '#resume').replace('#profile', '#resume'), previousPage = useRef(page)
  useEffect(() => {
    if (previousPage.current === page) return
    previousPage.current = page
    // Pages load their data first and show their heading afterwards, so look for it for a couple of seconds.
    let tries = 0
    const timer = window.setInterval(() => {
      const heading = document.querySelector<HTMLElement>('main h1')
      if (heading) { heading.tabIndex = -1; heading.focus(); window.clearInterval(timer) } else if (++tries > 40) window.clearInterval(timer)
    }, 50)
    return () => window.clearInterval(timer)
  }, [page])
  if (route === '#answers') return <TrackerPage openLibrary />
  if (route.startsWith('#tracker')) return <TrackerPage key={route} />
  if (route === '#gaps') return <TrackerPage gapsOnly />
  if (route === '#settings') return <SettingsPage />
  if (route === '#resume/profile' || route === '#profile') return <ProfilePage />
  if (route.startsWith('#resume') || route.startsWith('#master')) return <MasterPage key={route} />
  return <Workspace />
}

function App() { return <><Pages /><RunNotices /></> }

createRoot(document.getElementById('root')!).render(<React.StrictMode><FirstRun><App /></FirstRun></React.StrictMode>)
