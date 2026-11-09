// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { RunStrip, type Analysis } from './job-detail.js'

afterEach(() => cleanup())

const requirement = (id: string, kind: 'knockout' | 'hard') => ({ id, quote: id, kind, category: 'skill', skill: '', start: 0, end: 1, assessment: 'unknown' as const, basis: '' })
function analysis(run: Partial<Analysis['runs'][number]> & { status: string }, extra: Partial<Analysis> = {}): Analysis {
  return { extraction: { requirements: [requirement('a', 'knockout'), requirement('b', 'hard'), requirement('c', 'hard')], seniority: '', vocabulary: [], partial: false }, preliminaryGaps: [], tailored: null, runs: [{ id: 'run-1', kind: 'extract', step: 'complete', error: null, usage: null, costEstimate: null, finishedAt: new Date().toISOString(), ...run }], ...extra } as Analysis
}
const show = (value: Analysis | null, dismissed: string | null = null, retry = vi.fn(), dismiss = vi.fn()) => render(<RunStrip analysis={value} dismissed={dismissed} onDismiss={dismiss} onRetry={retry} busy={false} />)

describe('run status strip', () => {
  it('says when a fit check is waiting or running, with its step', () => {
    show(analysis({ status: 'queued', step: 'queued', finishedAt: null }))
    expect(screen.getByRole('status').textContent).toBe('Fit check is waiting in the queue…')
    cleanup()
    show(analysis({ status: 'running', step: 'extracting' }))
    expect(screen.getByRole('status').textContent).toBe('Fit check is running: extracting')
  })

  it('shows why a run failed and offers a retry', async () => {
    const retry = vi.fn()
    show(analysis({ status: 'failed', kind: 'tailor', error: 'The model did not answer.' }), null, retry)
    expect(screen.getByRole('status').textContent).toContain('Tailoring failed: The model did not answer.')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledWith('run-1')
  })

  it('reports what a recent fit check found and can be dismissed', async () => {
    const dismiss = vi.fn()
    show(analysis({ status: 'done' }), null, vi.fn(), dismiss)
    expect(screen.getByRole('status').textContent).toContain('Fit check finished: 3 requirements found, 1 knockout condition.')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(dismiss).toHaveBeenCalledWith('run-1')
  })

  it('stays quiet about an old or dismissed finished run, and about jobs with no run', () => {
    const { container } = show(analysis({ status: 'done', finishedAt: '2020-01-01T00:00:00.000Z' }))
    expect(container.textContent).toBe('')
    cleanup()
    expect(show(analysis({ status: 'done' }), 'run-1').container.textContent).toBe('')
    cleanup()
    expect(show(null).container.textContent).toBe('')
  })

  it('reports a finished tailoring run by its draft lines', () => {
    show(analysis({ status: 'done', kind: 'tailor' }, { tailored: { runId: 'run-1', summary: null, skillsLine: [], lines: [{ outId: '1', text: 't', sourceIds: [], verdict: 'grounded', layer1Flags: [], layer2Reason: '', slopFlags: [] }], gaps: [], exportReady: false } }))
    expect(screen.getByRole('status').textContent).toContain('Tailoring finished: 1 draft lines ready to review.')
  })
})
