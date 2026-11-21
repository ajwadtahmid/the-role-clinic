import { useState } from 'react'
import { getTheme, setTheme, type Theme } from './theme.js'

// Settings → Appearance. A choice applies at once and stays in this browser.
export function AppearancePanel() {
  const [theme, set] = useState<Theme>(getTheme())
  const choose = (value: Theme) => { setTheme(value); set(value) }
  return <section className="panel block editor-panel" id="appearance" tabIndex={-1} aria-labelledby="appearance-heading">
    <div className="block-head"><h2 id="appearance-heading">Appearance</h2></div>
    <p className="note">Your résumé page stays light in dark mode, because that is how it prints.</p>
    <div className="theme-choices" role="radiogroup" aria-label="Theme">{(['system', 'light', 'dark'] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={theme === value} className={`button small${theme === value ? ' primary' : ''}`} onClick={() => choose(value)}>{value === 'system' ? 'Match my computer' : value === 'light' ? 'Light' : 'Dark'}</button>)}</div>
  </section>
}
