import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { outcomeLabels, stageLabels } from './stages.js'
import { Icon } from './icons.js'

type Row = { row: number; company: string; title: string; status: string; applied: string | null; appliedFromSheet: boolean; verdict: 'new' | 'duplicate' | 'skipped'; reason?: string; warning?: string }
type Preview = {
  sheets: string[]; sheet: string; headers: string[]; mapping: Record<string, number>; dateOrder: 'mdy' | 'dmy'; missing: string[]
  counts: { total: number; new: number; duplicate: number; skipped: number }; statusWords: Array<{ word: string; count: number; choice: string; known: boolean }>
  ambiguousDates: number; rows: Row[]; recent: Array<{ id: string; createdAt: string; added: number; undoneAt: string | null }>
}
type Source = { format: 'csv' | 'xlsx' | 'paste'; content: string; name: string }
const fieldLabels: Array<[string, string, boolean]> = [['company', 'Company', true], ['title', 'Role', true], ['status', 'Status or stage', false], ['applied', 'Date applied', false], ['followUp', 'Follow-up date', false], ['location', 'Location', false], ['url', 'Link to the posting', false], ['contacts', 'Contact', false], ['notes', 'Notes', false]]
const choices = ['saved', 'applied', 'interviewing', 'offer', 'skipped', 'closed:rejected', 'closed:no_reply', 'closed:withdrawn', 'closed:accepted']
const choiceLabel = (choice: string) => { const [status, outcome] = choice.split(':'); return outcome ? `${stageLabels.closed} · ${outcomeLabels[outcome]}` : status === 'saved' ? stageLabels.saved : status === 'skipped' ? stageLabels.skipped : stageLabels[status as keyof typeof stageLabels] }

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer); let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

// Brings applications in from a spreadsheet or pasted cells in four steps: choose, match the columns, check, import.
// Nothing is saved until the last step, and a finished import can be undone.
export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void | Promise<void> }) {
  const [step, setStep] = useState<'choose' | 'match' | 'check' | 'done'>('choose'), [source, setSource] = useState<Source | null>(null), [pasted, setPasted] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null), [mapping, setMapping] = useState<Record<string, number>>({}), [statusMap, setStatusMap] = useState<Record<string, string>>({})
  const [dateOrder, setDateOrder] = useState<'mdy' | 'dmy'>('mdy'), [sheet, setSheet] = useState(''), [keepDuplicates, setKeepDuplicates] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<{ batch: string; added: number; skipped: number } | null>(null), [undone, setUndone] = useState<string>('')
  const [recent, setRecent] = useState<Preview['recent']>([]), dialog = useRef<HTMLDivElement>(null)
  useEffect(() => { void api<{ imports: Preview['recent'] }>('/api/imports').then((r) => setRecent(r.imports)).catch(() => undefined); dialog.current?.querySelector<HTMLElement>('input,textarea')?.focus() }, [])
  const body = (extra: Record<string, unknown> = {}) => ({ format: source?.format, content: source?.content, sheet, mapping, statusMap, dateOrder, ...extra })

  async function run(from: Source, options: Record<string, unknown> = {}) {
    setBusy(true); setError('')
    try {
      const next = await api<Preview>('/api/import/preview', { method: 'POST', body: JSON.stringify({ format: from.format, content: from.content, sheet, statusMap, dateOrder, ...options }) })
      setPreview(next); setMapping(next.mapping); setSheet(next.sheet); setDateOrder(next.dateOrder); setSource(from); return next
    } catch (e) { setError((e as Error).message); return null } finally { setBusy(false) }
  }
  async function chooseFile(file: File) {
    setError('')
    if (file.size > 5_000_000) { setError('That file is larger than 5 MB.'); return }
    const isSheet = /\.xlsx$/i.test(file.name)
    if (!isSheet && !/\.(csv|tsv|txt)$/i.test(file.name)) { setError('Choose an .xlsx, .csv or .tsv file, or paste the cells below.'); return }
    const content = isSheet ? toBase64(await file.arrayBuffer()) : await file.text()
    const next = await run({ format: isSheet ? 'xlsx' : 'csv', content, name: file.name })
    if (next) setStep('match')
  }
  async function readPasted() { const next = await run({ format: 'paste', content: pasted, name: 'Pasted cells' }); if (next) setStep('match') }
  // Changing a column, the sheet, a status word or the date order re-reads the preview, so what is shown is what will be imported.
  const refresh = (patch: { mapping?: Record<string, number>; statusMap?: Record<string, string>; dateOrder?: 'mdy' | 'dmy'; sheet?: string }) => {
    if (!source) return
    const nextMapping = patch.mapping ?? mapping, nextStatus = patch.statusMap ?? statusMap, nextOrder = patch.dateOrder ?? dateOrder, nextSheet = patch.sheet ?? sheet
    setMapping(nextMapping); setStatusMap(nextStatus); setDateOrder(nextOrder); setSheet(nextSheet)
    void run(source, { sheet: nextSheet, mapping: patch.sheet ? undefined : nextMapping, statusMap: nextStatus, dateOrder: nextOrder })
  }
  async function apply() {
    if (!source) return
    setBusy(true); setError('')
    try { setResult(await api<{ batch: string; added: number; skipped: number }>('/api/import/apply', { method: 'POST', body: JSON.stringify(body({ includeDuplicates: keepDuplicates })) })); setStep('done'); await onImported() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function undo(batch: string) {
    setBusy(true); setError('')
    try { const r = await api<{ removed: number; kept: number }>(`/api/import/${batch}/undo`, { method: 'POST', body: '{}' }); setUndone(`Undone: ${r.removed} job${r.removed === 1 ? '' : 's'} removed${r.kept ? `, ${r.kept} kept because you have worked on ${r.kept === 1 ? 'it' : 'them'} since` : ''}.`); setRecent((list) => list.map((item) => item.id === batch ? { ...item, undoneAt: new Date().toISOString() } : item)); await onImported() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const keys = (event: React.KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
  const importable = preview ? preview.counts.new + (keepDuplicates ? preview.counts.duplicate : 0) : 0
  return <div className="dialog-backdrop"><div className="dialog panel import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title" ref={dialog} onKeyDown={keys}>
    <div className="panel-heading"><h2 id="import-title">Import from a spreadsheet</h2><button type="button" className="text-button" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
    <p className="subtle" aria-live="polite">Step {['choose', 'match', 'check', 'done'].indexOf(step) + 1} of 4 · nothing is saved until you press Import</p>
    {error && <p role="alert" className="notice error">{error}</p>}
    {undone && <p role="status" className="notice neutral">{undone}</p>}

    {step === 'choose' && <div className="import-step">
      <label className="field-label" htmlFor="import-file">A spreadsheet file (.xlsx, .csv or .tsv)</label>
      <input id="import-file" type="file" accept=".xlsx,.csv,.tsv,.txt" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void chooseFile(file) }} />
      <p className="subtle">The first row should be headings such as Company, Role, Status and Date applied. The file is read on this computer and nothing is sent anywhere.</p>
      <label className="field-label" htmlFor="import-paste">Or paste cells copied from a spreadsheet</label>
      <textarea id="import-paste" rows={6} value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="Select the cells in Excel or Google Sheets, including the heading row, copy, and paste here." />
      <div className="button-row"><button className="button primary" disabled={busy || !pasted.trim()} onClick={() => void readPasted()}>{busy ? 'Reading…' : 'Use the pasted cells'}</button><button className="button secondary" onClick={onClose}>Cancel</button></div>
      {recent.length > 0 && <details className="more"><summary>Recent imports</summary><ul className="run-history">{recent.map((item) => <li key={item.id}><span>{new Date(item.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · {item.added} added</span>{item.undoneAt ? <span className="subtle"> · undone</span> : <button className="text-button" disabled={busy} onClick={() => void undo(item.id)}>Undo this import</button>}</li>)}</ul></details>}
    </div>}

    {step === 'match' && preview && <div className="import-step">
      <p>{source?.name} · {preview.counts.total} row{preview.counts.total === 1 ? '' : 's'} under the headings</p>
      {preview.sheets.length > 1 && <label className="field-label">Sheet<select value={sheet} onChange={(event) => refresh({ sheet: event.target.value })}>{preview.sheets.map((name) => <option key={name}>{name}</option>)}</select></label>}
      <table className="import-match"><caption className="sr-only">Which column holds what</caption><thead><tr><th scope="col">In the app</th><th scope="col">Column in your sheet</th></tr></thead><tbody>
        {fieldLabels.map(([field, label, required]) => <tr key={field}><th scope="row">{label}{required && <span className="req-star"> required</span>}</th><td><select aria-label={`Column for ${label}`} value={mapping[field] ?? ''} onChange={(event) => { const next = { ...mapping }; if (event.target.value === '') delete next[field]; else next[field] = Number(event.target.value); refresh({ mapping: next }) }}><option value="">Not in my sheet</option>{preview.headers.map((header, index) => <option key={index} value={index}>{header || `Column ${index + 1}`}</option>)}</select></td></tr>)}
      </tbody></table>
      {preview.ambiguousDates > 0 && <fieldset className="date-order"><legend>Some dates like 03/04/2026 could be read two ways. Which order does your sheet use?</legend><label><input type="radio" name="order" checked={dateOrder === 'mdy'} onChange={() => refresh({ dateOrder: 'mdy' })} /> Month first (March 4)</label> <label><input type="radio" name="order" checked={dateOrder === 'dmy'} onChange={() => refresh({ dateOrder: 'dmy' })} /> Day first (3 April)</label></fieldset>}
      {preview.missing.length > 0 && <p role="alert" className="notice error">Choose the column for {preview.missing.map((field) => field === 'company' ? 'Company' : 'Role').join(' and ')} to go on.</p>}
      <div className="button-row"><button className="button primary" disabled={busy || preview.missing.length > 0} onClick={() => setStep('check')}>Check the rows</button><button className="text-button" onClick={() => setStep('choose')}>Back</button></div>
    </div>}

    {step === 'check' && preview && <div className="import-step">
      <p role="status"><strong>{preview.counts.new}</strong> to import · <strong>{preview.counts.duplicate}</strong> already saved · <strong>{preview.counts.skipped}</strong> skipped</p>
      {preview.statusWords.length > 0 && <><h3>Status words in your sheet</h3><p className="subtle">Check that each one means the right stage. Words the app did not recognise are marked.</p>
        <table className="import-match"><thead><tr><th scope="col">Your word</th><th scope="col">Rows</th><th scope="col">Becomes</th></tr></thead><tbody>{preview.statusWords.map((item) => <tr key={item.word}><th scope="row">{item.word}{!item.known && <span className="req-star"> not recognised</span>}</th><td>{item.count}</td><td><select aria-label={`Stage for ${item.word}`} value={statusMap[item.word] ?? item.choice} onChange={(event) => refresh({ statusMap: { ...statusMap, [item.word]: event.target.value } })}>{choices.map((choice) => <option key={choice} value={choice}>{choiceLabel(choice)}</option>)}</select></td></tr>)}</tbody></table></>}
      <p className="subtle">A job marked applied with no date gets today’s date as its applied date.</p>
      <div className="import-rows" tabIndex={0} aria-label="Rows"><table className="import-match"><thead><tr><th scope="col">Row</th><th scope="col">Job</th><th scope="col">Becomes</th><th scope="col">Applied</th><th scope="col">What happens</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.row} className={`import-${row.verdict}`}><td>{row.row}</td><td>{row.company || '—'} · {row.title || '—'}</td><td>{choiceLabel(row.status)}</td><td>{row.applied ? `${row.applied}${row.appliedFromSheet || row.status === 'saved' || row.status === 'skipped' ? '' : ' (today, not in the sheet)'}` : '—'}</td><td>{row.verdict === 'new' ? 'Import' : row.verdict === 'duplicate' ? row.reason : `Skipped: ${row.reason}`}{row.warning ? ` (${row.warning})` : ''}</td></tr>)}</tbody></table>{preview.counts.total > preview.rows.length && <p className="subtle">Showing the first {preview.rows.length} rows. The rest follow the same rules.</p>}</div>
      {preview.counts.duplicate > 0 && <label className="inline-check"><input type="checkbox" checked={keepDuplicates} onChange={(event) => setKeepDuplicates(event.target.checked)} />Also import the {preview.counts.duplicate} that look like jobs already saved</label>}
      <div className="button-row"><button className="button primary" disabled={busy || importable === 0} onClick={() => void apply()}>{busy ? 'Importing…' : `Import ${importable} job${importable === 1 ? '' : 's'}`}</button><button className="text-button" onClick={() => setStep('match')}>Back</button></div>
    </div>}

    {step === 'done' && result && <div className="import-step">
      <p role="status"><strong>{result.added}</strong> job{result.added === 1 ? '' : 's'} imported{result.skipped ? `, ${result.skipped} left out` : ''}.</p>
      <div className="button-row">{!undone && <button className="button secondary" disabled={busy} onClick={() => void undo(result.batch)}>Undo this import</button>}<button className="button primary" onClick={onClose}>Done</button></div>
    </div>}
  </div></div>
}
