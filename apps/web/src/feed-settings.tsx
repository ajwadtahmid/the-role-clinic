import { useEffect, useState } from 'react'
import { api } from './api.js'
import { useToast } from './toast.js'

type Status = { configured: boolean; path: string | null; isDefault: boolean; defaultPath: string | null; lastCheckedAt: string | null }
type TestResult = { rows: number; valid: number; invalid: number; alreadyImported: number; newRows: number; missingColumns: string[] }
type Plan = { csvRows: number; triageJobs: Array<{ id: string; company: string; title: string; date: string }>; cutoff: string }

// Settings for an optional job feed: a CSV that another tool fills with jobs it found. Role Clinic only reads it,
// marks what it imported, and removes old rows when the owner asks.
export function FeedSettings() {
  const [status, setStatus] = useState<Status | null>(null), [path, setPath] = useState(''), [busy, setBusy] = useState(''), { say: setMessage, fail, node: toastNode } = useToast()
  const [test, setTest] = useState<TestResult | null>(null), [days, setDays] = useState('60'), [plan, setPlan] = useState<Plan | null>(null)
  useEffect(() => { void api<Status>('/api/feed/status').then((value) => { setStatus(value); setPath(value.isDefault ? '' : value.path ?? '') }).catch(fail) }, [])
  async function run<T>(name: string, work: () => Promise<T>) { setBusy(name); setMessage(''); try { return await work() } catch (error) { fail(error) } finally { setBusy('') } }
  const save = () => run('save', async () => { const value = await api<Status>('/api/feed/path', { method: 'PUT', body: JSON.stringify({ path }) }); setStatus(value); setTest(null); setPlan(null); setMessage(value.isDefault ? 'Using the default location. Use Check now to import.' : value.configured ? 'Job feed saved. Use Check now to import.' : 'No file found yet at the default location.') })
  const testFile = () => run('test', async () => { setTest(await api<TestResult>('/api/feed/test', { method: 'POST', body: JSON.stringify({ path }) })) })
  const check = () => run('check', async () => { const result = await api<{ imported: number; duplicates: number; invalid: number; notice: string | null }>('/api/feed/refresh', { method: 'POST', body: '{}' }); setMessage(`${result.imported} new job${result.imported === 1 ? '' : 's'} added to To review; ${result.duplicates} already known${result.invalid ? `; ${result.invalid} skipped for missing details` : ''}.${result.notice ? ` ${result.notice}` : ''}`) })
  const preview = () => run('preview', async () => { setPlan(await api<Plan>('/api/feed/cleanup/preview', { method: 'POST', body: JSON.stringify({ days: Number(days) }) })) })
  const clean = () => run('clean', async () => { const result = await api<{ removedRows: number; removedJobs: number; notice: string | null }>('/api/feed/cleanup', { method: 'POST', body: JSON.stringify({ days: Number(days) }) }); setPlan(null); setMessage(`Removed ${result.removedRows} row${result.removedRows === 1 ? '' : 's'} from the file and ${result.removedJobs} undecided job${result.removedJobs === 1 ? '' : 's'}.${result.notice ? ` ${result.notice}` : ''}`) })
  return <section className="panel block editor-panel feed-panel" aria-labelledby="feed-heading">
    <h2 id="feed-heading">Job feed <span className="subtle">(optional)</span></h2>
    <p className="subtle">If a search tool such as Claude Code or Codex saves the jobs it finds to a CSV file, Role Clinic can read it. New rows appear in To review on the Jobs page. Role Clinic never searches; it only reads the file, marks the rows it imported in an Imported column, and removes old rows when you run Clean up. <a href="/guide.html#job-feed" target="_blank" rel="noreferrer">File format ↗</a></p>
    <p className="subtle">Default location: <code>{status?.defaultPath ?? 'in your data folder'}</code>. The search tool writes there, and Role Clinic uses it as soon as the file exists. Fill in a path below only to use a different file, and leave it empty to go back to the default.</p>
    <label htmlFor="feed-path">Path to a different CSV file (optional)</label>
    <input id="feed-path" value={path} placeholder={status?.defaultPath ?? '/path/to/jobs.csv'} autoComplete="off" spellCheck={false} onChange={(event) => { setPath(event.target.value); setTest(null) }} />
    <div className="button-row">
      <button className="button primary" disabled={!!busy} onClick={() => void save()}>Save path</button>
      <button className="button secondary" disabled={!!busy || (!path.trim() && !status?.defaultPath)} onClick={() => void testFile()}>Test file</button>
      <button className="button secondary" disabled={!!busy || !status?.configured} onClick={() => void check()}>Check now</button>
    </div>
    {test && <p role="status">{test.missingColumns.length ? `The file is missing required columns: ${test.missingColumns.join(', ')}.` : `${test.rows} rows: ${test.valid} usable, ${test.invalid} skipped for missing details, ${test.alreadyImported} already imported, ${test.newRows} new. Nothing was changed.`}</p>}
    {status?.configured && <div className="feed-cleanup"><h3>Clean up</h3>
      <p className="subtle">Removes imported rows and undecided jobs from the feed older than a number of days (posted date if the row has one, otherwise found date). Tracked, applied and skipped jobs and rows you have not imported are never touched. Removed URLs are still remembered, so they are not imported again.</p>
      <div className="button-row"><label htmlFor="feed-days">Older than (days)</label><input id="feed-days" type="number" min={1} max={3650} value={days} onChange={(event) => { setDays(event.target.value); setPlan(null) }} /><button className="button secondary" disabled={!!busy} onClick={() => void preview()}>Preview</button></div>
      {plan && <div role="status"><p>{plan.csvRows} row{plan.csvRows === 1 ? '' : 's'} in the file and {plan.triageJobs.length} undecided feed job{plan.triageJobs.length === 1 ? '' : 's'} older than {plan.cutoff}.</p>{!!plan.triageJobs.length && <ul>{plan.triageJobs.slice(0, 10).map((job) => <li key={job.id}>{job.title}, {job.company} · {job.date}</li>)}</ul>}{plan.triageJobs.length > 10 && <p className="subtle">and {plan.triageJobs.length - 10} more.</p>}<button className="button secondary" disabled={!!busy || (!plan.csvRows && !plan.triageJobs.length)} onClick={() => void clean()}>Remove these</button></div>}
    </div>}
    {toastNode}
  </section>
}
