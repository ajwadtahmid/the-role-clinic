// Light, dark, or follow the computer. The choice is kept in this browser only; nothing is sent anywhere.
export type Theme = 'system' | 'light' | 'dark'
const key = 'rc-theme'
export function getTheme(): Theme { try { const value = localStorage.getItem(key); return value === 'light' || value === 'dark' ? value : 'system' } catch { return 'system' } }
const resolve = (theme: Theme) => theme === 'system' ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme
export function applyTheme(theme: Theme = getTheme()) { document.documentElement.dataset.theme = resolve(theme) }
export function setTheme(theme: Theme) { try { if (theme === 'system') localStorage.removeItem(key); else localStorage.setItem(key, theme) } catch { /* storage may be unavailable; the choice then lasts for this visit only */ } applyTheme(theme) }
// Follow the computer while "system" is chosen.
export function watchTheme() { window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (getTheme() === 'system') applyTheme('system') }) }
