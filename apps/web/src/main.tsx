import React from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsPage } from './settings-page.js'
import './style.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsPage />
  </React.StrictMode>,
)
