import { invoke, isTauri } from '@tauri-apps/api/core'

export const isDesktop = () => isTauri()
export async function writeClipboard(text: string) {
  if (isDesktop()) await invoke('clipboard_write', { text })
  else await navigator.clipboard.writeText(text)
}
// Desktop reminders are a per-computer choice kept in this app only: off until switched on in Settings, and only in the desktop app.
const notifyKey = 'rc-desktop-notify'
export const desktopNotifyOn = () => { try { return isDesktop() && localStorage.getItem(notifyKey) === '1' } catch { return false } }
export function setDesktopNotify(on: boolean) { try { if (on) localStorage.setItem(notifyKey, '1'); else localStorage.removeItem(notifyKey) } catch { /* the choice then lasts for this visit only */ } }
export async function showDesktopNotification(title: string, body: string) { await invoke('show_notification', { title, body }) }
export async function quitDesktop() { await invoke('quit_app') }
function notice(message: string, error = false) { window.dispatchEvent(new CustomEvent('role-clinic:desktop-notice', { detail: { message, error } })) }
// Keep browser links unchanged. In a desktop webview downloads need a user-selected native destination.
export function installDesktopLinks() {
  if (!isDesktop()) return
  document.addEventListener('click', (event) => {
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]')
    if (!anchor || event.defaultPrevented || event.button !== 0) return
    const url = new URL(anchor.href, location.href)
    if (anchor.hasAttribute('download') && url.origin === location.origin) {
      event.preventDefault()
      void invoke<boolean>('save_download', { path: url.pathname + url.search, filename: anchor.getAttribute('download') || null }).then((saved) => notice(saved ? 'File saved.' : 'Save canceled.')).catch((error) => notice(String(error), true))
    } else if (anchor.target === '_blank' || (url.origin !== location.origin && ['http:', 'https:'].includes(url.protocol))) {
      event.preventDefault()
      void invoke('open_external', { url: url.href }).catch((error) => notice(String(error), true))
    }
  })
  document.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'q') { event.preventDefault(); void quitDesktop() } })
}
