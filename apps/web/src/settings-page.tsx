import { useEffect, useState } from 'react'
import { taskNames, type PublicSettings, type TaskName } from '../../../packages/shared/src/index.js'

const labels: Record<TaskName, { title: string; description: string }> = {
  requirementExtraction: { title: 'Requirement extraction', description: 'Find required and preferred qualifications in a job posting.' },
  eligibilityAnalysis: { title: 'Eligibility and gaps', description: 'Compare job gates with your profile and résumé evidence.' },
  bulletScoring: { title: 'Evidence selection', description: 'Rank résumé bullets against a job.' },
  resumeDrafting: { title: 'Résumé drafting', description: 'Select and rewrite cited résumé content.' },
  claimVerification: { title: 'Claim verification', description: 'Check revised statements against their cited sources.' },
  antiSlop: { title: 'Writing review', description: 'Flag repetitive or vague wording.' },
}

type SettingsDraft = PublicSettings & { anthropicApiKey?: string }
type Notice = { kind: 'success' | 'error' | 'neutral'; text: string } | null

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`)
  return payload as T
}

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsDraft | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [queueStatus, setQueueStatus] = useState('')

  useEffect(() => {
    request<PublicSettings>('/api/settings').then(setSettings).catch((error: Error) => setNotice({ kind: 'error', text: error.message }))
  }, [])

  function updateTask(task: TaskName, key: 'provider' | 'model', value: string) {
    setSettings((current) => current ? {
      ...current,
      taskModels: {
        ...current.taskModels,
        [task]: { ...current.taskModels[task], [key]: value },
      },
    } : current)
  }

  async function saveSettings() {
    if (!settings) return
    setBusy('save')
    setNotice(null)
    try {
      const body = { ...settings, ...(settings.anthropicApiKey ? { anthropicApiKey: settings.anthropicApiKey } : {}) }
      const saved = await request<PublicSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(body) })
      setSettings(saved)
      setNotice({ kind: 'success', text: 'Settings saved locally.' })
    } catch (error) { setNotice({ kind: 'error', text: (error as Error).message }) }
    finally { setBusy(null) }
  }

  async function testConnection(provider: 'ollama' | 'anthropic') {
    if (!settings) return
    setBusy(provider)
    setNotice(null)
    try {
      if (provider === 'anthropic' && settings.anthropicApiKey) {
        const { anthropicApiKey, ...publicSettings } = settings
        const saved = await request<PublicSettings>('/api/settings', { method: 'PUT', body: JSON.stringify({ ...publicSettings, anthropicApiKey }) })
        setSettings(saved)
      }
      const result = await request<{ ok: boolean; detail?: string; error?: string; models?: string[] }>(`/api/connections/${provider}/test`, { method: 'POST', body: '{}' })
      if (provider === 'ollama' && result.models) setOllamaModels(result.models)
      setNotice({ kind: result.ok ? 'success' : 'error', text: result.detail ?? result.error ?? 'Connection test failed.' })
    } catch (error) { setNotice({ kind: 'error', text: (error as Error).message }) }
    finally { setBusy(null) }
  }

  async function clearKey() {
    setBusy('clear-key')
    try {
      const saved = await request<PublicSettings>('/api/settings/anthropic-key', { method: 'DELETE' })
      setSettings(saved)
      setNotice({ kind: 'success', text: 'Anthropic API key removed from local settings.' })
    } catch (error) { setNotice({ kind: 'error', text: (error as Error).message }) }
    finally { setBusy(null) }
  }

  async function demoQueue() {
    setBusy('queue')
    setQueueStatus('Subscribing to run updates…')
    const events = new EventSource('/api/runs/events')
    events.addEventListener('run', (event) => {
      const detail = JSON.parse((event as MessageEvent).data) as { step: string; message?: string }
      setQueueStatus(`${detail.step}: ${detail.message ?? 'Updated'}`)
    })
    try {
      await request('/api/dev/queue-demo', { method: 'POST', body: '{}' })
      window.setTimeout(() => { events.close(); setBusy(null) }, 1000)
    } catch (error) { events.close(); setBusy(null); setQueueStatus((error as Error).message) }
  }

  if (!settings) return <main className="shell"><p className="loading">Loading local settings…</p></main>

  return <main className="shell">
    <header className="topbar">
      <a className="wordmark" href="#top"><span className="mark">RC</span><span>The Role Clinic</span></a>
      <span className="local-chip"><span className="green-dot" /> Private · on this device</span>
    </header>

    <section className="intro" id="top">
      <p className="eyebrow">LOCAL WORKSPACE · PHASE 1 FOUNDATION</p>
      <h1>Make the setup<br /><em>work for you.</em></h1>
      <p className="lede">Choose a model for each job-search task. Your settings and résumé data stay on this computer.</p>
    </section>

    {notice && <div className={`notice ${notice.kind}`} role="status">{notice.text}</div>}

    <section className="panel provider-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">CONNECTIONS</p><h2>Model providers</h2></div>
        <span className="subtle">Choose separately for every task below</span>
      </div>
      <div className="provider-grid">
        <article className="provider-card">
          <div className="provider-title"><span className="provider-icon ollama-icon">◉</span><div><h3>Ollama</h3><p>Runs locally on your machine</p></div></div>
          <label className="field-label" htmlFor="ollama-url">Local server address</label>
          <input id="ollama-url" value={settings.ollamaBaseUrl} onChange={(event) => setSettings({ ...settings, ollamaBaseUrl: event.target.value })} />
          <button className="button secondary" disabled={busy === 'ollama'} onClick={() => testConnection('ollama')}>{busy === 'ollama' ? 'Checking…' : 'Test Ollama connection'}</button>
          {ollamaModels.length > 0 && <p className="model-hint">Installed: {ollamaModels.slice(0, 5).join(', ')}{ollamaModels.length > 5 ? ` +${ollamaModels.length - 5} more` : ''}</p>}
        </article>
        <article className="provider-card">
          <div className="provider-title"><span className="provider-icon claude-icon">✳</span><div><h3>Anthropic API</h3><p>Uses your API account and billing</p></div></div>
          <label className="field-label" htmlFor="anthropic-key">API key {settings.anthropicApiKeyConfigured && <span className="saved-label">· saved</span>}</label>
          <input id="anthropic-key" type="password" autoComplete="new-password" placeholder={settings.anthropicApiKeyConfigured ? 'Saved in your private local data folder' : 'sk-ant-…'} value={settings.anthropicApiKey ?? ''} onChange={(event) => setSettings({ ...settings, anthropicApiKey: event.target.value })} />
          <div className="button-row"><button className="button secondary" disabled={busy === 'anthropic'} onClick={() => testConnection('anthropic')}>{busy === 'anthropic' ? 'Checking…' : 'Test API key'}</button>{settings.anthropicApiKeyConfigured && <button className="text-button" disabled={busy === 'clear-key'} onClick={clearKey}>Remove key</button>}</div>
        </article>
      </div>
    </section>

    <section className="model-section">
      <div className="panel-heading model-heading">
        <div><p className="eyebrow">TASK ROUTING</p><h2>Pick a model for each task</h2></div>
        <p className="subtle">Local model calls are queued one at a time.</p>
      </div>
      <div className="task-list">
        {taskNames.map((task) => <article className="task-row" key={task}>
          <div className="task-copy"><h3>{labels[task].title}</h3><p>{labels[task].description}</p></div>
          <div className="choice-fields">
            <label className="sr-only" htmlFor={`${task}-provider`}>Provider for {labels[task].title}</label>
            <select id={`${task}-provider`} value={settings.taskModels[task].provider} onChange={(event) => updateTask(task, 'provider', event.target.value)}>
              <option value="ollama">Ollama · local</option><option value="anthropic">Anthropic API</option>
            </select>
            <label className="sr-only" htmlFor={`${task}-model`}>Model for {labels[task].title}</label>
            <input id={`${task}-model`} value={settings.taskModels[task].model} list="installed-models" onChange={(event) => updateTask(task, 'model', event.target.value)} placeholder="Model ID" />
          </div>
        </article>)}
      </div>
      <datalist id="installed-models">{ollamaModels.map((model) => <option value={model} key={model} />)}</datalist>
      <div className="save-row"><p>Suggested local starting model: Gemma 4 12B. Change it per task as your evaluations show a better fit.</p><button className="button primary" disabled={busy === 'save'} onClick={saveSettings}>{busy === 'save' ? 'Saving…' : 'Save settings'}</button></div>
    </section>

    <section className="panel utility-panel">
      <div><p className="eyebrow">LOCAL DATA</p><h2>Backups and run updates</h2><p className="subtle">Backups are stored beside the local database. The run button verifies queue and SSE wiring only.</p></div>
      <div className="button-row"><button className="button secondary" onClick={async () => { try { const result = await request<{ filename: string }>('/api/backups', { method: 'POST', body: '{}' }); setNotice({ kind: 'success', text: `Database backup created: ${result.filename}` }) } catch (error) { setNotice({ kind: 'error', text: (error as Error).message }) } }}>Create database backup</button><button className="button secondary" disabled={busy === 'queue'} onClick={demoQueue}>{busy === 'queue' ? 'Listening…' : 'Test run updates'}</button></div>
      {queueStatus && <p className="queue-status" role="status">{queueStatus}</p>}
    </section>

    <footer><span>THE ROLE CLINIC</span><span>Phase 1 foundation · Nothing is uploaded unless you choose an API provider.</span></footer>
  </main>
}
