// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { serve } from '@hono/node-server'
import { fetch as nodeFetch, Request as NodeRequest, Response as NodeResponse, Headers as NodeHeaders } from 'undici'
import { createApp } from '../../server/src/app.js'
import { createDatabase } from '../../server/src/db.js'
import { ImportDialog } from './import-dialog.js'

const directories: string[] = []
const servers: Array<ReturnType<typeof serve>> = []
afterEach(async () => {
  cleanup()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function setup(ui: React.ReactElement) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'role-clinic-today-flow-')); directories.push(dataDirectory)
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
  render(ui)
  return { user: userEvent.setup(), sqlite }
}


describe('Import from a spreadsheet', () => {
  it('walks pasted cells through matching, checking and importing, lets a status word be changed, and can be undone', async () => {
    const imported = vi.fn()
    const { user, sqlite } = await setup(<ImportDialog onClose={() => undefined} onImported={imported} />)
    const cells = ['Company\tRole\tStatus\tDate applied', 'Acme\tEngineer\tIn limbo\t2026-10-05', 'Beta\tAnalyst\tRejected\t2026-10-06', '\tNobody\tApplied\t2026-10-07'].join('\n')
    fireEvent.change(await screen.findByLabelText(/Or paste cells/), { target: { value: cells } })
    await user.click(screen.getByRole('button', { name: 'Use the pasted cells' }))
    // Matching: the columns are found by their headings.
    expect(await screen.findByRole('combobox', { name: 'Column for Company' })).toBeTruthy()
    expect((screen.getByRole('combobox', { name: 'Column for Role' }) as HTMLSelectElement).value).toBe('1')
    await user.click(screen.getByRole('button', { name: 'Check the rows' }))
    expect(await screen.findByText(/to import/)).toBeTruthy()
    expect(screen.getByText('not recognised')).toBeTruthy()
    expect(screen.getByText('Skipped: No company')).toBeTruthy()
    // Nothing is saved yet; a word is mapped by the person, then the import runs.
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 0 })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Stage for in limbo' }), 'closed:withdrawn')
    await user.click(await screen.findByRole('button', { name: 'Import 2 jobs' }))
    expect(await screen.findByText(/jobs imported, 1 left out/)).toBeTruthy()
    expect(imported).toHaveBeenCalled()
    expect(sqlite.prepare("SELECT a.status,a.outcome FROM applications a JOIN jobs j ON j.id=a.job_id WHERE j.company='Acme'").get()).toEqual({ status: 'closed', outcome: 'withdrawn' })
    await user.click(screen.getByRole('button', { name: 'Undo this import' }))
    expect(await screen.findByText(/Undone: 2 jobs removed/)).toBeTruthy()
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 0 })
    sqlite.close()
  })

  it('refuses a file type it cannot read and says what is missing when Company or Role has no column', async () => {
    const { user, sqlite } = await setup(<ImportDialog onClose={() => undefined} onImported={() => undefined} />)
    const input = await screen.findByLabelText(/A spreadsheet file/) as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'notes.pdf')] } })
    expect((await screen.findByRole('alert')).textContent).toContain('Choose an .xlsx, .csv or .tsv file')
    fireEvent.change(screen.getByLabelText(/Or paste cells/), { target: { value: 'Org\tJob\nAcme\tEngineer' } })
    await user.click(screen.getByRole('button', { name: 'Use the pasted cells' }))
    expect(await screen.findByText(/Choose the column for Company to go on/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Check the rows' }) as HTMLButtonElement).disabled).toBe(true)
    sqlite.close()
  })
})
