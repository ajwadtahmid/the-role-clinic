import { useEffect, useState } from 'react'
import { FeedSettings } from './feed-settings.js'
import { MaintenancePanel } from './runtime.js'
import { taskNames, type PublicSettings, type TaskName } from '../../../packages/shared/src/index.js'
import { AppHeader, PageHeader } from './layout.js'
import { FollowUpSettings } from './followup-settings.js'

const labels: Record<TaskName, { title: string; description: string }> = {
  requirementExtraction: { title: 'Requirement extraction', description: 'Find required and preferred qualifications in a job posting.' },
  eligibilityAnalysis: { title: 'Eligibility and gaps', description: 'Local checks compare job gates with private profile fields and résumé evidence.' },
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

  useEffect(() => {
    request<PublicSettings>('/api/settings').then(setSettings).catch((error: Error) => setNotice({ kind: 'error', text: error.message }))
  }, [])

  function updateTask(task: TaskName, key: 'provider' | 'model' | 'reasoning' | 'temperature', value: string | number | undefined) {
    setSettings((current) => current ? {
      ...current,
      taskModels: {
        ...current.taskModels,
        [task]: { ...current.taskModels[task], ...(['provider', 'model'].includes(key) ? { reasoning: 'auto' as const } : {}), [key]: value },
      },
    } : current)
  }
  const pricedModels = settings ? [...new Set(taskNames.filter((task) => task !== 'eligibilityAnalysis' && settings.taskModels[task].provider === 'anthropic').map((task) => settings.taskModels[task].model).filter(Boolean))] : []
  function updatePrice(model: string, field: 'inputPerMillion' | 'outputPerMillion', value: string) {
    setSettings((current) => current ? { ...current, modelPrices: { ...current.modelPrices, [model]: { inputPerMillion: current.modelPrices[model]?.inputPerMillion ?? 0, outputPerMillion: current.modelPrices[model]?.outputPerMillion ?? 0, [field]: Number(value) } } } : current)
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

  if (!settings) return <main className="shell"><p className="loading">Loading local settings…</p></main>

  return <main className="shell" id="main" tabIndex={-1}>
    <AppHeader current="settings" />
    <PageHeader title="Settings">Choose a model for each job-search task. Your settings and résumé data stay on this computer.</PageHeader>

    {notice && <div className={`notice ${notice.kind}`} role="status">{notice.text}</div>}

    <section className="panel provider-panel">
      <div className="panel-heading">
        <div><h2>Model providers</h2></div>
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
          <div className="button-row"><button className="button secondary" disabled={busy === 'anthropic'} onClick={() => testConnection('anthropic')}>{busy === 'anthropic' ? 'Checking…' : 'Test API key'}</button>{settings.anthropicApiKeyConfigured && <button className="text-button danger" disabled={busy === 'clear-key'} onClick={clearKey}>Remove key</button>}</div>
        </article>
      </div>
    </section>

    <section className="model-section">
      <div className="panel-heading model-heading">
        <div><h2>Pick a model for each task</h2></div>
        <p className="subtle">Local model calls are queued one at a time.</p>
      </div>
      <div className="task-list">
        {taskNames.map((task) => <article className="task-row" key={task}>
          <div className="task-copy"><h3>{labels[task].title}</h3><p>{labels[task].description}</p></div>
          {task === 'eligibilityAnalysis' ? <span className="local-rule-note">Local rules · private profile stays off-model</span> : <div className="choice-fields">
            <label className="sr-only" htmlFor={`${task}-provider`}>Provider for {labels[task].title}</label>
            <select id={`${task}-provider`} value={settings.taskModels[task].provider} onChange={(event) => updateTask(task, 'provider', event.target.value)}>
              <option value="ollama">Ollama · local</option><option value="anthropic">Anthropic API</option>
            </select>
            <label className="sr-only" htmlFor={`${task}-model`}>Model for {labels[task].title}</label>
            <input id={`${task}-model`} value={settings.taskModels[task].model} list="installed-models" onChange={(event) => updateTask(task, 'model', event.target.value)} placeholder="Model ID" />
            {settings.taskModels[task].provider === 'ollama' && <label>Reasoning
              <select value={settings.taskModels[task].reasoning ?? 'auto'} onChange={(event) => updateTask(task, 'reasoning', event.target.value)}>
                <option value="auto">Automatic</option>
                {/^gpt-oss(?::|$)/i.test(settings.taskModels[task].model) ? <><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></> : <><option value="off">Off</option><option value="on">On</option></>}
              </select>
            </label>}
            <label>Temperature
              <input type="number" min="0" max={settings.taskModels[task].provider === 'anthropic' ? 1 : 2} step="0.1" placeholder={settings.taskModels[task].provider === 'ollama' ? 'Auto (0.2)' : 'Provider default'} value={settings.taskModels[task].temperature ?? ''} onChange={(event) => updateTask(task, 'temperature', event.target.value === '' ? undefined : Number(event.target.value))} />
            </label>
          </div>}
        </article>)}
      </div>
      <datalist id="installed-models">{ollamaModels.map((model) => <option value={model} key={model} />)}</datalist>
      <div className="save-row"><p>Suggested local starting model: Gemma 4 12B. Change it per task as your evaluations show a better fit.</p><button className="button primary" disabled={busy === 'save'} onClick={saveSettings}>{busy === 'save' ? 'Saving…' : 'Save settings'}</button></div>
    </section>

    <FeedSettings />
    <FollowUpSettings />
    <section className="panel editor-panel"><h2>Welcome guide</h2><p className="subtle">Go through adding your résumé, choosing a model and saving your first job again, and bring back the quickstart on the Jobs page.</p><a className="button secondary" href="#welcome" onClick={() => { try { localStorage.removeItem('rc-quickstart-hidden') } catch { /* storage may be unavailable */ } }}>Show the welcome guide again</a></section>

    <MaintenancePanel />

    <section className="panel editor-panel cost-panel">
      <h2>Cost estimate and cap</h2>
      <p className="subtle">Local Ollama calls have no API charge. Enter your provider’s current per-million-token prices for each selected Anthropic model. Runs check estimates before starting and track reported usage after every call.</p>
      <label>Maximum estimated API spend per run (USD)<input type="number" min="0" max="100" step="0.01" value={settings.costCapUsd} onChange={(event) => setSettings({ ...settings, costCapUsd: Number(event.target.value) })} /></label>
      <label>Maximum API spend per calendar month (USD)<input type="number" min="0" max="10000" step="0.5" value={settings.monthlyCapUsd} onChange={(event) => setSettings({ ...settings, monthlyCapUsd: Number(event.target.value) })} /></label>
      {pricedModels.map((model) => <div className="editor-card" key={model}><strong>{model}</strong><div className="form-pair"><label>Input USD / 1M tokens<input type="number" min="0" step="0.01" value={settings.modelPrices[model]?.inputPerMillion ?? ''} onChange={(event) => updatePrice(model, 'inputPerMillion', event.target.value)} /></label><label>Output USD / 1M tokens<input type="number" min="0" step="0.01" value={settings.modelPrices[model]?.outputPerMillion ?? ''} onChange={(event) => updatePrice(model, 'outputPerMillion', event.target.value)} /></label></div></div>)}
      {pricedModels.length > 0 && <p className="subtle">Prices change; confirm them with your provider before using its API. Missing prices prevent a paid run from starting.</p>}
      <button className="button primary" disabled={busy === 'save'} onClick={saveSettings}>Save settings</button>
    </section>

    <footer><span>THE ROLE CLINIC</span><span>Nothing is uploaded unless you choose an API provider.</span></footer>
  </main>
}
