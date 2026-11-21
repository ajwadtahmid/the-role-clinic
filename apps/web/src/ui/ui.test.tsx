// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { Toggle } from './toggle.js'
import { Skeleton } from './skeleton.js'
import { FoldCard } from './fold-card.js'
import { usePasteJobLink } from '../add-job.js'

afterEach(cleanup)

function Harness({ blocked = false, onOpen }: { blocked?: boolean; onOpen: (url: string) => void }) {
  usePasteJobLink(blocked, onOpen)
  return <><input aria-label="note" /><p>page</p></>
}
const paste = (target: Element | Window, text: string) => {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown }
  event.clipboardData = { getData: () => text }
  target.dispatchEvent(event)
}

describe('ui kit', () => {
  it('Toggle is a keyboard switch that reports its state', async () => {
    const user = userEvent.setup()
    function Host() { const [on, setOn] = useState(false); return <Toggle checked={on} onChange={setOn}>Remind me</Toggle> }
    render(<Host />)
    const sw = screen.getByRole('switch', { name: 'Remind me' }) as HTMLInputElement
    expect(sw.checked).toBe(false)
    sw.focus(); await user.keyboard(' ')
    expect(sw.checked).toBe(true)
  })

  it('Skeleton announces its label to screen readers', () => {
    render(<Skeleton label="Loading jobs…" />)
    expect(screen.getByRole('status').textContent).toContain('Loading jobs…')
  })

  it('FoldCard shows its heading when folded and calls back when toggled', async () => {
    const user = userEvent.setup(), changed = vi.fn()
    render(<FoldCard title="Follow-ups" summary="Off" open={false} onToggle={changed}><p>body</p></FoldCard>)
    expect(screen.getByRole('heading', { name: 'Follow-ups' })).toBeTruthy()
    await user.click(screen.getByText('Off'))
    expect(changed).toHaveBeenCalledWith(true)
  })

  it('pasting a job link on the page opens the dialog; text fields, other text and open dialogs do not', () => {
    const open = vi.fn()
    const { rerender } = render(<Harness onOpen={open} />)
    paste(document.body, 'https://boards.greenhouse.io/acme/jobs/1')
    expect(open).toHaveBeenCalledWith('https://boards.greenhouse.io/acme/jobs/1')
    open.mockClear()
    paste(screen.getByLabelText('note'), 'https://example.com/job')
    paste(document.body, 'just some words')
    paste(document.body, 'javascript:alert(1)')
    expect(open).not.toHaveBeenCalled()
    rerender(<Harness blocked onOpen={open} />)
    paste(document.body, 'https://example.com/job')
    expect(open).not.toHaveBeenCalled()
  })
})

describe('theme', () => {
  it('applies the chosen theme to the page, remembers it, and goes back to following the computer', async () => {
    const { applyTheme, getTheme, setTheme } = await import('../theme.js')
    localStorage.clear()
    expect(getTheme()).toBe('system')
    setTheme('dark'); expect(document.documentElement.dataset.theme).toBe('dark'); expect(getTheme()).toBe('dark')
    setTheme('light'); expect(document.documentElement.dataset.theme).toBe('light')
    setTheme('system'); expect(getTheme()).toBe('system'); expect(localStorage.getItem('rc-theme')).toBeNull()
    applyTheme(); expect(['light', 'dark']).toContain(document.documentElement.dataset.theme)
  })
})
