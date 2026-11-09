// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
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
})
