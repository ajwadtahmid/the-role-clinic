import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsPage } from './settings-page.js'
import { Workspace } from './workspace.js'
import './style.css'

function App() {
  const [settings, setSettings] = useState(location.hash === '#settings')
  useEffect(() => { const update = () => setSettings(location.hash === '#settings'); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update) }, [])
  return settings ? <SettingsPage /> : <Workspace />
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
