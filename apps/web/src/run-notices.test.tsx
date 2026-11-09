// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { RunNotices } from './run-notices.js'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = '' })

class FakeEventSource {
  static last: FakeEventSource
  listeners: Record<string, (event: MessageEvent) => void> = {}
  constructor() { FakeEventSource.last = this }
  addEventListener(name: string, listener: (event: MessageEvent) => void) { this.listeners[name] = listener }
  close() {}
  emit(data: object) { this.listeners.run({ data: JSON.stringify(data) } as MessageEvent) }
}
const event = (overrides: object) => ({ id: 1, jobId: 'job-1', kind: 'extract', status: 'done', step: 'complete', timestamp: new Date().toISOString(), ...overrides })

describe('run notices', () => {
  function setup() {
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ job: { title: 'Engineer', company: 'Acme' } })))
    render(<RunNotices />)
  }

  it('tells you a run finished or failed for a job you are not looking at', async () => {
    setup()
    await act(async () => { FakeEventSource.last.emit(event({})) })
    expect((await screen.findByRole('status')).textContent).toContain('Fit check finished for Engineer at Acme.')
    await act(async () => { FakeEventSource.last.emit(event({ id: 2, kind: 'tailor', status: 'failed', message: 'The model did not answer.' })) })
    expect((await screen.findAllByText(/Tailoring failed for Engineer at Acme: The model did not answer\./)).length).toBe(1)
    expect(screen.getAllByRole('link', { name: 'Open job' })[0].getAttribute('href')).toBe('#jobs/job-1')
  })

  it('ignores progress events, replays, old events and the job that is open', async () => {
    setup()
    await act(async () => {
      FakeEventSource.last.emit(event({ status: 'running' }))
      FakeEventSource.last.emit(event({ id: 3, timestamp: '2020-01-01T00:00:00.000Z' }))
    })
    window.location.hash = '#jobs/job-1'
    await act(async () => { FakeEventSource.last.emit(event({ id: 4 })) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('stays quiet about background fit checks', async () => {
    setup()
    await act(async () => { FakeEventSource.last.emit(event({ id: 9, quiet: true })) })
    expect(screen.queryByRole('status')).toBeNull()
  })

})
