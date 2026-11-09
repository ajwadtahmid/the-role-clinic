import { useCallback, useEffect, useRef, useState } from 'react'
import { FeedSettings } from './feed-settings.js'
import { AboutPanel, BackupsPanel } from './runtime.js'
import { taskNames, type PublicSettings, type TaskName } from '../../../packages/shared/src/index.js'
import { AppHeader, PageHeader, SectionRail } from './layout.js'
import { FollowUpSettings } from './followup-settings.js'
import { Toast } from './toast.js'
import { RestoreAnnouncer, SaveRegistry, type SaveSection } from './settings-save.js'
import { readDraft, useDraft } from './unsaved.js'

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
  // What is stored, as text, so the page can tell when something has changed and offer one Save for all of it.
  const [stored, setStored] = useState('')
  // The model last used with each provider for each step, so switching providers does not lose what was typed.
  const remembered = useRef<Record<string, string>>({})
  const adopt = (value: PublicSettings) => {
    for (const task of taskNames) { const choice = value.taskModels[task]; remembered.current[`${task}:${choice.provider}`] = choice.model }
    setSettings(value); setStored(JSON.stringify(value))
  }
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  // Whether Ollama answers at the saved address; checked quietly when the page opens and whenever the address is saved.
  const [ollama, setOllama] = useState<{ state: 'checking' | 'ok' | 'down'; error?: string }>({ state: 'checking' })
  const savedOllamaUrl = stored ? (JSON.parse(stored) as PublicSettings).ollamaBaseUrl : ''
  useEffect(() => {
    if (!savedOllamaUrl) return
    setOllama({ state: 'checking' })
    request<{ ok: boolean; models?: string[]; error?: string }>('/api/connections/ollama/test', { method: 'POST', body: '{}' })
      .then((result) => { if (result.ok) { setOllama({ state: 'ok' }); if (result.models) setOllamaModels(result.models) } else setOllama({ state: 'down', error: result.error }) })
      .catch((error: Error) => setOllama({ state: 'down', error: error.message }))
  }, [savedOllamaUrl])
  // Sections that save elsewhere (follow-up days, the feed path) register here, so one bar saves everything.
  const [sections, setSections] = useState<Record<string, SaveSection>>({})
  const register = useCallback((key: string, section: SaveSection | null) => setSections((current) => {
    if (!section && !(key in current)) return current
    const next = { ...current }
    if (section) next[key] = section; else delete next[key]
    return next
  }), [])
  const announceRestored = useCallback(() => setNotice({ kind: 'neutral', text: 'Your unsaved changes are back. Save them or discard them.' }), [])
  const [editing, setEditing] = useState<Record<string, boolean>>({})

  useEffect(() => {
    request<PublicSettings>('/api/settings').then((value) => {
      adopt(value)
      // Edits made before leaving the page come back, as long as the saved settings have not changed since.
      const draft = readDraft<SettingsDraft>('settings', JSON.stringify(value))
      if (draft) { setSettings(draft); announceRestored() }
    }).catch((error: Error) => setNotice({ kind: 'error', text: error.message }))
  }, [])

  function updateTask(task: TaskName, key: 'provider' | 'model' | 'reasoning' | 'temperature', value: string | number | undefined) {
    if (key === 'model' && settings) remembered.current[`${task}:${settings.taskModels[task].provider}`] = String(value ?? '')
    setSettings((current) => current ? {
      ...current,
      taskModels: {
        ...current.taskModels,
        [task]: { ...current.taskModels[task], ...(['provider', 'model'].includes(key) ? { reasoning: 'auto' as const } : {}), [key]: value },
      },
    } : current)
  }
  // Every step except the local eligibility check is run by a model, so these are the ones a provider choice applies to.
  const modelSteps = taskNames.filter((task) => task !== 'eligibilityAnalysis')
  const runsOn = (provider: 'ollama' | 'anthropic') => settings ? modelSteps.filter((task) => settings.taskModels[task].provider === provider) : []
  const mode = !settings ? 'ollama' : runsOn('ollama').length === modelSteps.length ? 'ollama' : runsOn('anthropic').length === modelSteps.length ? 'anthropic' : 'mixed'
  const providerModel = (provider: 'ollama' | 'anthropic') => { const models = [...new Set(runsOn(provider).map((task) => settings!.taskModels[task].model))]; return models.length === 1 ? models[0] : '' }
  function chooseProvider(provider: 'ollama' | 'anthropic') {
    setSettings((current) => {
      if (!current) return current
      const taskModels = { ...current.taskModels }
      for (const task of modelSteps) {
        const now = taskModels[task]
        remembered.current[`${task}:${now.provider}`] = now.model
        taskModels[task] = now.provider === provider ? now : { ...now, provider, model: remembered.current[`${task}:${provider}`] ?? '', reasoning: 'auto' }
      }
      return { ...current, taskModels }
    })
  }
  function setProviderModel(provider: 'ollama' | 'anthropic', model: string) { for (const task of runsOn(provider)) updateTask(task, 'model', model) }
  const pricedModels = settings ? [...new Set(taskNames.filter((task) => task !== 'eligibilityAnalysis' && settings.taskModels[task].provider === 'anthropic').map((task) => settings.taskModels[task].model).filter(Boolean))] : []
  function updatePrice(model: string, field: 'inputPerMillion' | 'outputPerMillion', value: string) {
    setSettings((current) => current ? { ...current, modelPrices: { ...current.modelPrices, [model]: { inputPerMillion: current.modelPrices[model]?.inputPerMillion ?? 0, outputPerMillion: current.modelPrices[model]?.outputPerMillion ?? 0, [field]: Number(value) } } } : current)
  }

  async function saveAll() {
    if (!settings) return
    setBusy('save')
    setNotice(null)
    // A step with no model cannot run, and the server's message for that is unhelpful, so say what to do here.
    const missing = (['anthropic', 'ollama'] as const).find((provider) => runsOn(provider).some((task) => !settings.taskModels[task].model.trim()))
    if (missing) { setBusy(null); setNotice({ kind: 'error', text: missing === 'anthropic' ? 'Type a Claude model ID before saving.' : 'Choose an Ollama model before saving.' }); return }
    try {
      if (settingsChanged) {
        const body = { ...settings, ...(settings.anthropicApiKey ? { anthropicApiKey: settings.anthropicApiKey } : {}) }
        adopt(await request<PublicSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }))
      }
      for (const section of Object.values(sections)) await section.save()
      setNotice({ kind: 'success', text: 'Settings saved locally.' })
    } catch (error) { setNotice({ kind: 'error', text: (error as Error).message }) }
    finally { setBusy(null) }
  }
  function discardAll() {
    if (settingsChanged) adopt(JSON.parse(stored) as PublicSettings)
    for (const section of Object.values(sections)) section.discard()
    setConfirmDiscard(false)
  }

  async function testConnection(provider: 'ollama' | 'anthropic') {
    if (!settings) return
    setBusy(provider)
    setNotice(null)
    try {
      if (provider === 'anthropic' && settings.anthropicApiKey) {
        const { anthropicApiKey, ...publicSettings } = settings
        const saved = await request<PublicSettings>('/api/settings', { method: 'PUT', body: JSON.stringify({ ...publicSettings, anthropicApiKey }) })
        adopt(saved)
      }
      // The address in the field is the one tested, saved or not.
      const result = await request<{ ok: boolean; detail?: string; error?: string; models?: string[] }>(`/api/connections/${provider}/test`, { method: 'POST', body: JSON.stringify(provider === 'ollama' ? { ollamaBaseUrl: settings.ollamaBaseUrl } : {}) })
      if (provider === 'ollama') { if (result.models) setOllamaModels(result.models); if (settings.ollamaBaseUrl === savedOllamaUrl) setOllama(result.ok ? { state: 'ok' } : { state: 'down', error: result.error }) }
      setNotice({ kind: result.ok ? 'success' : 'error', text: result.detail ?? result.error ?? 'Connection test failed.' })
    } catch (error) { if (provider === 'ollama' && settings.ollamaBaseUrl === savedOllamaUrl) setOllama({ state: 'down', error: (error as Error).message }); setNotice({ kind: 'error', text: (error as Error).message }) }
    finally { setBusy(null) }
  }

  async function clearKey() {
    setBusy('clear-key')
    try {
      const saved = await request<PublicSettings>('/api/settings/anthropic-key', { method: 'DELETE' })
      adopt(saved)
      setNotice({ kind: 'success', text: 'Anthropic API key removed from local settings.' })
    } catch (error) { setNotice({ kind: 'error', text: (error as Error).message }) }
    finally { setBusy(null) }
  }

  const settingsChanged = Boolean(settings) && (JSON.stringify({ ...settings, anthropicApiKey: undefined }) !== stored || Boolean(settings?.anthropicApiKey))
  const pending = settingsChanged || Object.keys(sections).length > 0
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  useDraft('settings', stored, settings, settingsChanged, settings !== null)
  const usesClaude = runsOn('anthropic').length > 0
  if (!settings) return <main className="shell"><p className="loading">Loading local settings…</p></main>

  const claudeReady = Boolean(settings.anthropicApiKeyConfigured || settings.anthropicApiKey)
  const localModel = providerModel('ollama'), claudeModel = providerModel('anthropic')
  const installed = ollamaModels.some((model) => model === localModel || model === `${localModel}:latest`)
  // The first thing in the block says what state tailoring is really in, not just what is typed.
  const status: { tone: 'ok' | 'warn' | 'off'; title: string; text: string } =
    mode === 'mixed' ? { tone: 'off', title: 'Custom mix of both', text: 'Some steps run on this computer and some on Claude. See “Fine-tune each step” below.' }
    : mode === 'anthropic' ? (!claudeReady ? { tone: 'warn', title: 'Claude needs an API key', text: 'Paste your key in the Claude card, then test it.' }
      : !claudeModel ? { tone: 'warn', title: 'Claude needs a model', text: 'Type the Claude model ID to use, then test the key.' }
      : { tone: 'ok', title: `Claude is set up: ${claudeModel}`, text: 'Your résumé bullets and the job text are sent to Anthropic. Your contact details and saved answers never are.' })
    : !localModel ? { tone: 'warn', title: 'Ollama needs a model', text: 'Choose an installed model, then test the connection.' }
    : ollama.state === 'checking' ? { tone: 'off', title: 'Checking for Ollama…', text: `Looking for it at ${savedOllamaUrl}.` }
    : ollama.state === 'down' ? { tone: 'warn', title: `Ollama is not running at ${savedOllamaUrl}`, text: 'Saving and tracking jobs works without it. Start or install Ollama, or choose Claude to tailor résumés.' }
    : ollamaModels.length > 0 && !installed ? { tone: 'warn', title: `${localModel} is not installed in Ollama`, text: `Installed: ${ollamaModels.slice(0, 5).join(', ')}${ollamaModels.length > 5 ? ` and ${ollamaModels.length - 5} more` : ''}. Choose one of those, or install it with “ollama pull ${localModel}”.` }
    : { tone: 'ok', title: `Ollama is set up: ${localModel}`, text: 'Tailoring runs on this computer. Nothing leaves it.' }
  // A step that simply follows the chosen provider and has no model yet says nothing; the status line above already does.
  const modelSummary = (task: TaskName) => { const { provider, model } = settings.taskModels[task]; return model || provider !== mode ? `${provider === 'ollama' ? 'Ollama' : 'Claude'} · ${model || 'no model'}` : '' }

  return <SaveRegistry.Provider value={register}><RestoreAnnouncer.Provider value={announceRestored}><main className="shell" id="main" tabIndex={-1}>
    <AppHeader current="settings" />
    <PageHeader title="Settings">Everything here stays on this computer unless you choose Claude.</PageHeader>

    {notice && <Toast error={notice.kind === 'error'} onClose={() => setNotice(null)}>{notice.text}</Toast>}

    <div className="rs-layout"><SectionRail items={[{ id: 'models', label: 'Résumé tailoring' }, { id: 'feed', label: 'Job feed' }, { id: 'followups', label: 'Follow-ups' }, { id: 'backups', label: 'Backups' }, { id: 'about', label: 'About' }]} /><div className="content">
    <section className="panel provider-panel block" id="models" tabIndex={-1} aria-labelledby="tailoring-heading">
      <div className="block-head"><h2 id="tailoring-heading">Résumé tailoring</h2></div>
      <div className={`status-line${status.tone === 'ok' ? '' : ` ${status.tone}`}`} role="status"><span className="dot" aria-hidden="true" /><div><b>{status.title}</b><span className="t">{status.text}</span></div></div>
      <div className="provider-grid" role="radiogroup" aria-label="Where tailoring runs">
        <article className={`provider-card${mode === 'ollama' ? ' chosen' : ''}`}>
          <div className="provider-title"><span className="provider-icon ollama-icon"><svg className="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 21h8M12 17v4" /></svg></span><div><h3>On this computer</h3><p>Ollama · free and private</p></div><button className="button small provider-choose" role="radio" aria-checked={mode === 'ollama'} onClick={() => chooseProvider('ollama')}>{mode === 'ollama' ? 'In use' : 'Use this'}</button></div>
          <label className="field-label" htmlFor="ollama-url">Local server address</label>
          <input id="ollama-url" value={settings.ollamaBaseUrl} onChange={(event) => setSettings({ ...settings, ollamaBaseUrl: event.target.value })} />
          {runsOn('ollama').length > 0 && <><label className="field-label" htmlFor="ollama-model">Model for these steps</label><input id="ollama-model" list="installed-models" placeholder="Model ID" value={localModel} onChange={(event) => setProviderModel('ollama', event.target.value)} /></>}
          <div className="button-row"><button className="button small" disabled={busy === 'ollama'} onClick={() => testConnection('ollama')}>{busy === 'ollama' ? 'Checking…' : 'Test connection'}</button></div>
        </article>
        <article className={`provider-card${mode === 'anthropic' ? ' chosen' : ''}`}>
          <div className="provider-title"><span className="provider-icon claude-icon"><svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" /></svg></span><div><h3>Claude</h3><p>Anthropic API · your account, costs money</p></div><button className="button small provider-choose" role="radio" aria-checked={mode === 'anthropic'} onClick={() => chooseProvider('anthropic')}>{mode === 'anthropic' ? 'In use' : 'Use this'}</button></div>
          <label className="field-label label-split" htmlFor="anthropic-key"><span>API key</span>{settings.anthropicApiKeyConfigured && <span className="saved-label">Saved on this computer</span>}</label>
          <input id="anthropic-key" type="password" autoComplete="new-password" placeholder={settings.anthropicApiKeyConfigured ? 'Saved. Type a new key to replace it.' : 'sk-ant-…'} value={settings.anthropicApiKey ?? ''} onChange={(event) => setSettings({ ...settings, anthropicApiKey: event.target.value })} />
          {runsOn('anthropic').length > 0 && <><label className="field-label" htmlFor="anthropic-model">Model for these steps</label><input id="anthropic-model" placeholder="Claude model ID" value={claudeModel} onChange={(event) => setProviderModel('anthropic', event.target.value)} /></>}
          <div className="button-row"><button className="button small" disabled={busy === 'anthropic'} onClick={() => testConnection('anthropic')}>{busy === 'anthropic' ? 'Checking…' : 'Test key'}</button>{settings.anthropicApiKeyConfigured && <button className="button small quiet danger" disabled={busy === 'clear-key'} onClick={clearKey}>Remove saved key</button>}</div>
        </article>
      </div>
      {settings.taskModels.requirementExtraction.provider === 'ollama' && <label className="auto-fit"><input type="checkbox" checked={settings.autoFitCheck} onChange={(event) => setSettings({ ...settings, autoFitCheck: event.target.checked })} /><span><b>Check each new job’s fit automatically</b><span className="t">Off by default. Uses this computer in the background while you work, including for jobs the job feed brings in. You can always check a job yourself, or press Check fits on the Jobs page.</span></span></label>}

      {usesClaude && <details className="more" open>
        <summary>Spending limits <span className="muted">· ${settings.costCapUsd} a run · ${settings.monthlyCapUsd} a month</span></summary>
        <div className="body">
          <p className="note">A paid run will not start if it would go over either limit. Enter your provider’s current prices so the estimate is right. Local Ollama calls have no API charge.</p>
          <div className="form-pair">
            <label>Most to spend on one run (USD)<input type="number" min="0" max="100" step="0.01" value={settings.costCapUsd} onChange={(event) => setSettings({ ...settings, costCapUsd: Number(event.target.value) })} /></label>
            <label>Most to spend in a calendar month (USD)<input type="number" min="0" max="10000" step="0.5" value={settings.monthlyCapUsd} onChange={(event) => setSettings({ ...settings, monthlyCapUsd: Number(event.target.value) })} /></label>
          </div>
          {pricedModels.map((model) => <div className="price-pair" key={model}><strong>{model}</strong><div className="form-pair"><label>Input USD / 1M tokens<input type="number" min="0" step="0.01" value={settings.modelPrices[model]?.inputPerMillion ?? ''} onChange={(event) => updatePrice(model, 'inputPerMillion', event.target.value)} /></label><label>Output USD / 1M tokens<input type="number" min="0" step="0.01" value={settings.modelPrices[model]?.outputPerMillion ?? ''} onChange={(event) => updatePrice(model, 'outputPerMillion', event.target.value)} /></label></div></div>)}
          {pricedModels.length > 0 && <p className="note">Prices change; confirm them with your provider before using its API. Missing prices prevent a paid run from starting.</p>}
        </div>
      </details>}

      <details className="more adv">
        <summary>Fine-tune each step <span className="muted">· {mode === 'mixed' ? 'custom mix' : 'all steps use the choice above'}</span></summary>
        <div className="body">
          <p className="note">Most people never need this. Local model calls run one at a time. Suggested local starting model: Gemma 4 12B.</p>
          <div className="step-list">
            {taskNames.map((task) => <div className={`step${editing[task] ? ' open' : ''}`} key={task}>
              <div><h4>{labels[task].title}</h4><p>{labels[task].description}</p></div>
              {task === 'eligibilityAnalysis' ? <span className="where">Local rules · your private profile stays off-model</span> : <div className="actions">{modelSummary(task) && <span className="where">{modelSummary(task)}</span>}<button className="button small quiet" aria-expanded={Boolean(editing[task])} aria-label={`${editing[task] ? 'Close' : 'Edit'} ${labels[task].title}`} onClick={() => setEditing({ ...editing, [task]: !editing[task] })}>{editing[task] ? 'Done' : 'Edit'}</button></div>}
              {task !== 'eligibilityAnalysis' && editing[task] && <div className="edit">
                <label>Provider for {labels[task].title}
                  <select id={`${task}-provider`} value={settings.taskModels[task].provider} onChange={(event) => updateTask(task, 'provider', event.target.value)}>
                    <option value="ollama">Ollama · local</option><option value="anthropic">Anthropic API</option>
                  </select>
                </label>
                <label>Model for {labels[task].title}
                  <input id={`${task}-model`} value={settings.taskModels[task].model} list="installed-models" onChange={(event) => updateTask(task, 'model', event.target.value)} placeholder="Model ID" />
                </label>
                {settings.taskModels[task].provider === 'ollama' ? <label>Reasoning
                  <select value={settings.taskModels[task].reasoning ?? 'auto'} onChange={(event) => updateTask(task, 'reasoning', event.target.value)}>
                    <option value="auto">Automatic</option>
                    {/^gpt-oss(?::|$)/i.test(settings.taskModels[task].model) ? <><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></> : <><option value="off">Off</option><option value="on">On</option></>}
                  </select>
                </label> : null}
                <label>Temperature
                  <input type="number" min="0" max={settings.taskModels[task].provider === 'anthropic' ? 1 : 2} step="0.1" placeholder={settings.taskModels[task].provider === 'ollama' ? 'Auto (0.2)' : 'Provider default'} value={settings.taskModels[task].temperature ?? ''} onChange={(event) => updateTask(task, 'temperature', event.target.value === '' ? undefined : Number(event.target.value))} />
                </label>
              </div>}
            </div>)}
          </div>
          <datalist id="installed-models">{ollamaModels.map((model) => <option value={model} key={model} />)}</datalist>
        </div>
      </details>
    </section>

    <div id="feed" tabIndex={-1}><FeedSettings /></div>
    <div id="followups" tabIndex={-1}><FollowUpSettings /></div>
    <div id="backups" tabIndex={-1}><BackupsPanel /></div>
    <div id="about" tabIndex={-1}><AboutPanel /></div>

    </div></div>
    {pending && <div className="savebar" role="group" aria-label="Unsaved settings">{confirmDiscard ? <><span>Discard every unsaved change?</span><button className="button danger small" onClick={discardAll}>Yes, discard</button><button className="button quiet small" onClick={() => setConfirmDiscard(false)}>Keep editing</button></> : <><span>You have unsaved settings.</span><button className="button primary small" disabled={busy === 'save'} onClick={saveAll}>{busy === 'save' ? 'Saving…' : 'Save settings'}</button><button className="button quiet small" disabled={busy === 'save'} onClick={() => setConfirmDiscard(true)}>Discard</button></>}</div>}
  </main></RestoreAnnouncer.Provider></SaveRegistry.Provider>
}
