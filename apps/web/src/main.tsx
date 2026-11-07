import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FirstRun } from './runtime.js'
import { SettingsPage } from './settings-page.js'
import { TrackerPage } from './tracker-page.js'
import { AnswersPage } from './answers.js'
import { Workspace } from './workspace.js'
import { MasterPage, ProfilePage } from './master-page.js'
import './style.css'

function App() {
  const [route, setRoute] = useState(location.hash)
  useEffect(() => { const update = () => setRoute(location.hash); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update) }, [])
  if (route === '#tracker') return <TrackerPage />
  if (route === '#gaps') return <TrackerPage gapsOnly />
  if (route === '#answers') return <AnswersPage />
  if (route.startsWith('#job/')) return <Workspace key={route} initialJobId={route.slice(5).split('?')[0]} />
  if (route === '#settings') return <SettingsPage />
  if (route.startsWith('#master')) return <MasterPage key={route} />
  if (route === '#profile') return <ProfilePage />
  return <Workspace />
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><FirstRun><App /></FirstRun></React.StrictMode>)
