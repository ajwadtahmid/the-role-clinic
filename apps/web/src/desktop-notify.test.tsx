// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async () => undefined)
let tauri = true
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => (invoke as (...a: unknown[]) => unknown)(...args), isTauri: () => tauri }))

afterEach(() => { invoke.mockClear(); localStorage.clear(); tauri = true; vi.unstubAllGlobals() })

describe('desktop notifications', () => {
  it('are off until chosen, only exist in the desktop app, and send plain text to the native command', async () => {
    const { desktopNotifyOn, setDesktopNotify, showDesktopNotification } = await import('./desktop.js')
    expect(desktopNotifyOn()).toBe(false)
    setDesktopNotify(true); expect(desktopNotifyOn()).toBe(true)
    tauri = false; expect(desktopNotifyOn()).toBe(false)
    tauri = true; setDesktopNotify(false); expect(desktopNotifyOn()).toBe(false)
    await showDesktopNotification('The Role Clinic', '2 follow-ups due')
    expect(invoke).toHaveBeenCalledWith('show_notification', { title: 'The Role Clinic', body: '2 follow-ups due' })
  })

  it('is shown once when the app opens with something due and the option is on, and never when it is off', async () => {
    const { render, cleanup, waitFor } = await import('@testing-library/react')
    const { setDesktopNotify } = await import('./desktop.js')
    vi.stubGlobal('fetch', async () => Response.json({ on: true, due: 2, suggestions: 1 }))
    vi.resetModules()
    setDesktopNotify(true)
    const { ReminderNotice } = await import('./reminder-notice.js')
    const view = render(<ReminderNotice />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('show_notification', { title: 'The Role Clinic', body: '2 follow-ups due · 1 application may be closed' }))
    expect(invoke).toHaveBeenCalledTimes(1)
    view.unmount(); cleanup()
    // Off: the on-screen message still appears, but the system is not asked to show anything.
    invoke.mockClear(); vi.resetModules(); setDesktopNotify(false)
    const again = await import('./reminder-notice.js')
    const second = render(<again.ReminderNotice />)
    await waitFor(() => expect(second.container.textContent).toContain('2 follow-ups due'))
    expect(invoke).not.toHaveBeenCalled()
  })
})
