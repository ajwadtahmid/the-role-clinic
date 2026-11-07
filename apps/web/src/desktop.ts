import { invoke, isTauri } from '@tauri-apps/api/core'

export const isDesktop = () => isTauri()
export async function writeClipboard(text: string) {
  if (isDesktop()) await invoke('clipboard_write', { text })
  else await navigator.clipboard.writeText(text)
}
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
