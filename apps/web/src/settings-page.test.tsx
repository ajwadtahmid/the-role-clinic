// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetDrafts } from './unsaved.js'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { serve } from '@hono/node-server'
import { fetch as nodeFetch, Request as NodeRequest, Response as NodeResponse, Headers as NodeHeaders } from 'undici'
import { createApp } from '../../server/src/app.js'
import { createDatabase } from '../../server/src/db.js'
import { SettingsPage } from './settings-page.js'

const directories: string[] = []
const servers: Array<ReturnType<typeof serve>> = []
afterEach(async () => {
  cleanup(); forgetDrafts()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function setup() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'role-clinic-settings-')); directories.push(dataDirectory)
  const { sqlite, db } = createDatabase(dataDirectory)
  const reservation = createServer()
  const port = await new Promise<number>((resolve) => reservation.listen(0, '127.0.0.1', () => resolve((reservation.address() as { port: number }).port)))
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  vi.stubGlobal('Request', NodeRequest); vi.stubGlobal('Response', NodeResponse); vi.stubGlobal('Headers', NodeHeaders)
  const app = createApp({ dataDirectory, sqlite, db, port, webPort: 5173, development: true })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port })
  servers.push(server)
  await new Promise<void>((resolve) => server.on('listening', () => resolve()))
  ;(window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${port}/`)
  vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => nodeFetch(`http://127.0.0.1:${port}${input}`, { ...init, headers: { ...(init.method && init.method !== 'GET' ? { origin: `http://127.0.0.1:${port}` } : {}), ...init.headers } } as Parameters<typeof nodeFetch>[1]))
  render(<SettingsPage />)
  return { user: userEvent.setup(), sqlite }
}

describe('settings page', () => {
  it('offers one save bar for changed settings, asks before discarding, and hides the cost cap until Claude is used', async () => {
    const { user, sqlite } = await setup()
    const address = await screen.findByLabelText('Local server address') as HTMLInputElement
    expect(screen.queryByRole('group', { name: 'Unsaved settings' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Cost estimate and cap' })).toBeNull()
    await user.clear(address); await user.type(address, 'http://127.0.0.1:11500')
    expect(screen.getByRole('group', { name: 'Unsaved settings' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(address.value).toBe('http://127.0.0.1:11500')
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    await user.click(screen.getByRole('button', { name: 'Yes, discard' }))
    expect(address.value).not.toBe('http://127.0.0.1:11500')
    expect(screen.queryByRole('group', { name: 'Unsaved settings' })).toBeNull()
    await user.clear(address); await user.type(address, 'http://127.0.0.1:11500')
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    await screen.findByText('Settings saved locally.')
    expect(screen.queryByRole('group', { name: 'Unsaved settings' })).toBeNull()
    sqlite.close()
  })

  it('keeps unsaved settings, follow-up days and the feed path when you leave and come back', async () => {
    const { user, sqlite } = await setup()
    const address = await screen.findByLabelText('Local server address') as HTMLInputElement
    await user.clear(address); await user.type(address, 'http://127.0.0.1:11555')
    await user.type(screen.getByLabelText('API key'), 'sk-ant-typed')
    const days = screen.getByLabelText('Days with no reply') as HTMLInputElement
    await waitFor(() => expect(days.disabled).toBe(false))
    await user.clear(days); await user.type(days, '21')
    await user.type(screen.getByLabelText('Path to a different CSV file'), '/tmp/other.csv')
    cleanup()
    render(<SettingsPage />)
    expect((await screen.findByLabelText('Local server address') as HTMLInputElement).value).toBe('http://127.0.0.1:11555')
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('sk-ant-typed')
    await waitFor(() => expect((screen.getByLabelText('Days with no reply') as HTMLInputElement).value).toBe('21'))
    await waitFor(() => expect((screen.getByLabelText('Path to a different CSV file') as HTMLInputElement).value).toBe('/tmp/other.csv'))
    expect(screen.getByRole('group', { name: 'Unsaved settings' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Discard' })); await user.click(screen.getByRole('button', { name: 'Yes, discard' }))
    cleanup()
    render(<SettingsPage />)
    expect((await screen.findByLabelText('Local server address') as HTMLInputElement).value).toBe('http://127.0.0.1:11434')
    sqlite.close()
  })

  it('tests the address in the field and does not call it the saved address’s status', async () => {
    const { user, sqlite } = await setup()
    const address = await screen.findByLabelText('Local server address') as HTMLInputElement
    await user.clear(address); await user.type(address, 'http://example.com:11434')
    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText(/plain HTTP URL on this computer/)).toBeTruthy()
    expect(screen.queryByText(/not running at http:\/\/example\.com/)).toBeNull()
    sqlite.close()
  })

  it('says plainly when Ollama is not running, and that saving and tracking jobs still works', async () => {
    const { sqlite } = await setup()
    expect(await screen.findByText(/Ollama is not running at http:\/\/127\.0\.0\.1:11434/)).toBeTruthy()
    expect(screen.getByText(/Saving and tracking jobs works without it/)).toBeTruthy()
    expect(screen.queryByText(/Ollama is set up/)).toBeNull()
    sqlite.close()
  })

  it('chooses where tailoring runs with two cards and remembers each provider’s model', async () => {
    const { user, sqlite } = await setup()
    const ollama = await screen.findByRole('radio', { name: 'In use' })
    const claude = screen.getByRole('radio', { name: 'Use this' })
    expect(ollama.closest('.provider-card')?.textContent).toContain('On this computer')
    const local = (screen.getByLabelText('Model for these steps') as HTMLInputElement).value
    expect(local).not.toBe('')
    await user.click(claude)
    expect(claude.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('group', { name: 'Unsaved settings' })).toBeTruthy()
    const claudeModel = screen.getByLabelText('Model for these steps') as HTMLInputElement
    expect(claudeModel.value).toBe('')
    await user.type(claudeModel, 'claude-example-model')
    // Going back to the local card brings back the local model, and Claude's is kept for later.
    await user.click(screen.getByRole('radio', { name: 'Use this' }))
    expect((screen.getByLabelText('Model for these steps') as HTMLInputElement).value).toBe(local)
    await user.click(screen.getByRole('radio', { name: 'Use this' }))
    expect((screen.getByLabelText('Model for these steps') as HTMLInputElement).value).toBe('claude-example-model')
    // One step set differently makes a custom mix, which is said out loud.
    await user.click(screen.getByText(/Fine-tune each step/))
    await user.click(screen.getByRole('button', { name: 'Edit Résumé drafting' }))
    await user.selectOptions(screen.getByLabelText('Provider for Résumé drafting'), 'ollama')
    expect(screen.getByText('Custom mix of both')).toBeTruthy()
    sqlite.close()
  })

  it('does not repeat "no model" on every step after choosing Claude', async () => {
    const { user, sqlite } = await setup()
    await user.click(await screen.findByRole('radio', { name: 'Use this' }))
    await user.click(screen.getByText(/Fine-tune each step/))
    expect(screen.getByText('Claude needs an API key')).toBeTruthy()
    expect(screen.queryAllByText('Claude · no model')).toHaveLength(0)
    sqlite.close()
  })

  it('offers automatic fit checks only for a local model, off until chosen, and saves the choice', async () => {
    const { user, sqlite } = await setup()
    const box = await screen.findByRole('checkbox', { name: /Check each new job’s fit automatically/ }) as HTMLInputElement
    expect(box.checked).toBe(false)
    await user.click(box)
    await user.click(screen.getByRole('button', { name: 'Save settings' }))
    await screen.findByText('Settings saved locally.')
    expect((await (await fetch('/api/settings')).json() as { autoFitCheck: boolean }).autoFitCheck).toBe(true)
    await user.click(screen.getByRole('radio', { name: 'Use this' }))
    expect(screen.queryByRole('checkbox', { name: /Check each new job’s fit automatically/ })).toBeNull()
    sqlite.close()
  })

})
