import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsPage } from './settings-page.js'
import { Workspace } from './workspace.js'
import { MasterPage, ProfilePage } from './master-page.js'
import './style.css'

function App() {
  const [route, setRoute] = useState(location.hash)
  useEffect(() => { const update = () => setRoute(location.hash); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update) }, [])
  if (route === '#settings') return <SettingsPage />
  if (route === '#master') return <MasterPage />
  if (route === '#profile') return <ProfilePage />
  return <Workspace />
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
