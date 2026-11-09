// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { loadAiFeatures } from './ai-features.js'
import { AiFeaturesPanel } from './ai-setup.js'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = '' })

const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }))
// A stand-in server: what Ollama answers can be changed between clicks, and the AI-features choice is remembered like the real one.
function stub(initial: { enabled: boolean; hidden?: boolean }) {
  const state = { features: { chosen: true, enabled: initial.enabled, hidden: initial.hidden ?? false }, ollama: 'down' as 'down' | 'no-model' | 'ready', test: 'ok' as 'ok' | 'fail' }
  const saved = { ollamaBaseUrl: 'http://127.0.0.1:11434', anthropicApiKeyConfigured: false, taskModels: { requirementExtraction: { provider: 'ollama', model: 'gemma4:12b' } } }
  vi.stubGlobal('fetch', (path: string, init: RequestInit = {}) => {
    if (path === '/api/settings') return json({ ...saved, aiFeatures: state.features })
    if (path === '/api/connections/ollama/test') return state.ollama === 'down' ? json({ error: 'fetch failed' }, 500) : json({ ok: true, models: state.ollama === 'ready' ? ['gemma4:12b'] : ['llama3:8b'] })
    if (path === '/api/ai/test') return state.test === 'ok' ? json({ ok: true, seconds: 3, model: 'gemma4:12b' }) : json({ ok: false, error: 'The model did not answer.' }, 502)
    if (path === '/api/ai-features') { state.features = { ...state.features, ...JSON.parse(String(init.body)), chosen: true }; return json({ aiFeatures: state.features }) }
    return json({}, 404)
  })
  return state
}
const show = async () => { await loadAiFeatures(); render(<AiFeaturesPanel advancedOpen={false} onAdvanced={() => undefined} />) }

describe('AI features setup', () => {
  it('walks through Ollama, the model and a test, says what is wrong at each step, and only then turns AI on', async () => {
    const server = stub({ enabled: false }), user = userEvent.setup()
    await show()
    expect(screen.getByText('AI features are off')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Set up AI features' }))
    await user.click(screen.getByRole('button', { name: 'Check for Ollama' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Ollama was not found')
    server.ollama = 'no-model'
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText('ollama pull gemma4:12b')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Check for the model' }))
    expect((await screen.findByRole('alert')).textContent).toContain('gemma4:12b is not downloaded yet')
    server.ollama = 'ready'; server.test = 'fail'
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    await user.click(await screen.findByRole('button', { name: 'Run a quick test' }))
    expect((await screen.findByRole('alert')).textContent).toContain('The model did not answer.')
    // Nothing is on until the test has passed and the person says so.
    expect(server.features.enabled).toBe(false)
    server.test = 'ok'
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect((await screen.findByRole('status')).textContent).toContain('Test passed in 3 seconds')
    await user.click(screen.getByRole('button', { name: 'Turn on AI features' }))
    expect(await screen.findByText('AI features are on')).toBeTruthy()
    expect(server.features.enabled).toBe(true)
  })

  it('hides AI features without deleting anything, and shows them again', async () => {
    const server = stub({ enabled: true }), user = userEvent.setup()
    await show()
    await user.click(await screen.findByRole('button', { name: 'Hide AI features' }))
    expect(await screen.findByText('AI features are hidden')).toBeTruthy()
    expect(server.features).toEqual({ chosen: true, enabled: true, hidden: true })
    await user.click(screen.getByRole('button', { name: 'Show AI features' }))
    expect(await screen.findByText('AI features are on')).toBeTruthy()
  })

  it('opens straight into the setup when sent there from the first-run choice, and keeps Claude as a separate advanced option', async () => {
    stub({ enabled: false }); window.location.hash = '#settings?setup'
    await show()
    expect(screen.getByRole('button', { name: 'Check for Ollama' })).toBeTruthy()
    expect(screen.getByText(/Advanced: use your own Claude key/)).toBeTruthy()
  })
})
