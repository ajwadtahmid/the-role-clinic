import { useEffect, useState } from 'react'
import { api } from './api.js'
import { copyText } from './answers.js'
import { setAiFeatures, useAiFeatures } from './ai-features.js'
import { useToast } from './toast.js'

type Saved = { ollamaBaseUrl: string; anthropicApiKeyConfigured: boolean; taskModels: { requirementExtraction: { provider: string; model: string } } }
type Check = { ok: boolean; models?: string[] }
// Step 0 is not in the setup; 1 to 3 are Ollama, the model, and a quick test.
const wantsSetup = () => /[?&]setup\b/.test(location.hash)

// The AI features section of Settings: off with a guided setup, on with a way to hide it, or hidden with a way to show it again.
// Nothing here deletes anything; hiding only changes what is shown.
export function AiFeaturesPanel({ advancedOpen, onAdvanced }: { advancedOpen: boolean; onAdvanced: (open: boolean) => void }) {
  const { features } = useAiFeatures(), { say, fail, node: toastNode } = useToast()
  const [saved, setSaved] = useState<Saved | null>(null), [step, setStep] = useState(wantsSetup() ? 1 : 0)
  const [ollamaMissing, setOllamaMissing] = useState(false), [modelMissing, setModelMissing] = useState(false), [checking, setChecking] = useState(false)
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'passed' | 'failed'; text: string }>({ state: 'idle', text: '' }), [busy, setBusy] = useState(false)
  useEffect(() => { void api<Saved>('/api/settings').then(setSaved).catch(() => undefined) }, [])
  const model = saved?.taskModels.requirementExtraction.model || 'gemma4:12b'
  const localModel = !saved || saved.taskModels.requirementExtraction.provider === 'ollama'

  async function look(forModel: boolean) {
    setChecking(true)
    try {
      const result = await api<Check>('/api/connections/ollama/test', { method: 'POST', body: '{}' })
      setOllamaMissing(false)
      const installed = (result.models ?? []).some((name) => name === model || name === `${model}:latest`)
      if (installed) { setModelMissing(false); setTest({ state: 'idle', text: '' }); setStep(3) } else { setModelMissing(forModel); setStep(2) }
    } catch { setOllamaMissing(true); setStep(1) } finally { setChecking(false) }
  }
  async function runTest() {
    setTest({ state: 'running', text: '' })
    try { const result = await api<{ seconds: number }>('/api/ai/test', { method: 'POST', body: '{}' }); setTest({ state: 'passed', text: `Test passed in ${result.seconds} second${result.seconds === 1 ? '' : 's'}. Everything ran on this computer.` }) }
    catch (error) { setTest({ state: 'failed', text: (error as Error).message }) }
  }
  async function change(patch: { enabled?: boolean; hidden?: boolean }, message: string) {
    setBusy(true)
    try { await setAiFeatures(patch); say(message) } catch (error) { fail(error) } finally { setBusy(false) }
  }
  const leave = () => { setStep(0); if (wantsSetup()) location.hash = '#settings' }
  const stepClass = (n: number) => step > n ? 'done' : step === n ? 'now' : 'wait'

  if (features.enabled) return <section className="panel block" id="ai" tabIndex={-1} aria-labelledby="ai-heading">{toastNode}
    <div className="block-head"><h2 id="ai-heading">AI features</h2></div>
    {features.hidden
      ? <><div className="status-line" role="status"><span className="dot" aria-hidden="true" /><div><b>AI features are hidden</b><span className="t">Your fit checks, drafts and résumé are kept, just out of sight.</span></div></div>
        <div className="button-row"><button className="button primary" disabled={busy} onClick={() => void change({ hidden: false }, 'AI features are showing again.')}>Show AI features</button></div></>
      : <><div className="status-line" role="status"><span className="dot" aria-hidden="true" /><div><b>AI features are on</b><span className="t">{saved?.taskModels.requirementExtraction.provider === 'anthropic' ? 'Fit checks and tailoring use Claude, which sends the job text and your résumé bullets to Anthropic.' : `Fit checks and tailoring use ${model} on this computer. Nothing leaves it.`}</span></div></div>
        <div className="button-row"><button className="button" disabled={busy} onClick={() => void change({ hidden: true }, 'AI features hidden. Nothing was deleted.')}>Hide AI features</button></div>
        <p className="subtle">Hiding only changes what you see. Fit checks, drafts and your résumé stay saved, and Show brings them back.</p></>}
  </section>

  return <section className="panel block" id="ai" tabIndex={-1} aria-labelledby="ai-heading">{toastNode}
    <div className="block-head"><h2 id="ai-heading">AI features</h2></div>
    {step === 0
      ? <><div className="status-line" role="status"><span className="dot" aria-hidden="true" /><div><b>AI features are off</b><span className="t">You are using The Role Clinic as a tracker, and that is fully supported.</span></div></div>
        <p className="subtle">Turn them on to check how well you fit a job and to tailor résumés. They run on this computer with Ollama, so nothing is sent anywhere. Setup takes a few minutes the first time.</p>
        <div className="button-row"><button className="button primary" disabled={!localModel} onClick={() => { setStep(1); setOllamaMissing(false) }}>Set up AI features</button></div></>
      : <><p className="subtle">Three short steps. You can stop at any time; tracking keeps working the whole time.</p>
        <ol className="ai-steps">
          <li className={stepClass(1)}><span className="n" aria-hidden="true">{step > 1 ? '✓' : 1}</span><div><b>Check that Ollama is running</b>
            {step === 1 && <><p className="subtle">Ollama is a free app that runs AI models on your computer.</p>
              {ollamaMissing && <p role="alert" className="notice error"><b>Ollama was not found.</b> Install it from ollama.com and open it, then check again.</p>}
              <div className="button-row"><button className="button primary" disabled={checking} onClick={() => void look(false)}>{checking ? 'Checking…' : ollamaMissing ? 'Check again' : 'Check for Ollama'}</button><button className="text-button" onClick={leave}>Do this later</button></div></>}</div></li>
          <li className={stepClass(2)}><span className="n" aria-hidden="true">{step > 2 ? '✓' : 2}</span><div><b>Get a model</b>
            {step === 2 && <><p className="subtle">We suggest <b>{model}</b>, downloaded once. Run this in a terminal:</p>
              <div className="ai-cmd"><code>ollama pull {model}</code><button className="button small" onClick={() => void copyText(`ollama pull ${model}`, say)}>Copy</button></div>
              {modelMissing && <p role="alert" className="notice error"><b>{model} is not downloaded yet.</b> It can take a while. Check again when the download finishes.</p>}
              <div className="button-row"><button className="button primary" disabled={checking} onClick={() => void look(true)}>{checking ? 'Checking…' : modelMissing ? 'Check again' : 'Check for the model'}</button><button className="text-button" onClick={leave}>Do this later</button></div></>}</div></li>
          <li className={stepClass(3)}><span className="n" aria-hidden="true">3</span><div><b>Test it</b>
            {step === 3 && <><p className="subtle">A short test to make sure it answers.</p>
              {test.state === 'passed' && <p role="status" className="notice ok">{test.text}</p>}
              {test.state === 'failed' && <p role="alert" className="notice error"><b>The test did not work.</b> {test.text}</p>}
              <div className="button-row">{test.state === 'passed'
                ? <button className="button primary" disabled={busy} onClick={() => void change({ enabled: true }, 'AI features are on. Fit checks and Tailor résumé are now available.')}>Turn on AI features</button>
                : <button className="button primary" disabled={test.state === 'running'} onClick={() => void runTest()}>{test.state === 'running' ? 'Testing…' : test.state === 'failed' ? 'Try again' : 'Run a quick test'}</button>}
                <button className="text-button" onClick={leave}>Do this later</button></div></>}</div></li>
        </ol></>}
    <details className="more adv" open={advancedOpen} onToggle={(event) => onAdvanced(event.currentTarget.open)}>
      <summary>Advanced: use your own Claude key <span className="muted">· separate from the local setup</span></summary>
      <div className="body"><p className="note">Claude runs on Anthropic’s servers: the job text and your résumé bullets are sent to Anthropic when you use it. Your contact details and answers never are. It costs money, and you set the spending limits. Saving a key does not turn AI features on by itself.</p>
        {saved?.anthropicApiKeyConfigured && <div className="button-row"><button className="button primary" disabled={busy} onClick={() => void change({ enabled: true }, 'AI features are on, using Claude.')}>Turn on AI features with Claude</button></div>}</div>
    </details>
  </section>
}
