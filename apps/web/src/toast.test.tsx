// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Toast, toastSeconds } from './toast.js'

afterEach(() => { cleanup(); vi.useRealTimers() })
describe('toast', () => {
  it('closes by itself after ten seconds, whatever kind it is', () => {
    vi.useFakeTimers()
    expect(toastSeconds).toBe(10)
    for (const error of [false, true]) {
      const onClose = vi.fn()
      const view = render(<Toast error={error} onClose={onClose}>Something happened</Toast>)
      expect(screen.getByRole(error ? 'alert' : 'status').textContent).toContain('Something happened')
      act(() => { vi.advanceTimersByTime(9999) })
      expect(onClose).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1) })
      expect(onClose).toHaveBeenCalledOnce()
      view.unmount()
    }
  })

  it('stays open while it is pointed at or focused, then closes ten seconds after', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    render(<Toast onUndo={() => {}} onClose={onClose}>Job skipped</Toast>)
    const toast = screen.getByRole('status')
    fireEvent.mouseEnter(toast)
    act(() => { vi.advanceTimersByTime(60000) })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseLeave(toast)
    act(() => { vi.advanceTimersByTime(10000) })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on Escape from inside the message', () => {
    const onClose = vi.fn()
    render(<Toast onClose={onClose}>Saved</Toast>)
    fireEvent.keyDown(screen.getByRole('status'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
