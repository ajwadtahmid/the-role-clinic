import { useEffect, useState } from 'react'
import { api } from './api.js'
import { useToast } from './toast.js'
import { useSaveSection } from './settings-save.js'

type Status = { configured: boolean; path: string | null; isDefault: boolean; defaultPath: string | null; lastCheckedAt: string | null }
type TestResult = { rows: number; valid: number; invalid: number; alreadyImported: number; newRows: number; missingColumns: string[] }
type Plan = { csvRows: number; triageJobs: Array<{ id: string; company: string; title: string; date: string }>; cutoff: string }

// Settings for an optional job feed: a CSV that another tool fills with jobs it found. Role Clinic only reads it,
// marks what it imported, and removes old rows when the owner asks. A different file path saves with the rest of the page.
export function FeedSettings() {
  const [status, setStatus] = useState<Status | null>(null), [path, setPath] = useState(''), [busy, setBusy] = useState(''), { say, fail, node: toastNode } = useToast()
  const [test, setTest] = useState<TestResult | null>(null), [days, setDays] = useState('60'), [plan, setPlan] = useState<Plan | null>(null)
  const savedPath = status ? (status.isDefault ? '' : status.path ?? '') : ''
  const dirty = status !== null && path !== savedPath
  useEffect(() => { void api<Status>('/api/feed/status').then((value) => { setStatus(value); setPath(value.isDefault ? '' : value.path ?? '') }).catch(fail) }, [])
  async function savePath() { const value = await api<Status>('/api/feed/path', { method: 'PUT', body: JSON.stringify({ path }) }); setStatus(value); setPath(value.isDefault ? '' : value.path ?? ''); setTest(null); setPlan(null) }
  useSaveSection('feed', dirty, savePath, () => { setPath(savedPath); setTest(null) })
  async function run<T>(name: string, work: () => Promise<T>) { setBusy(name); say(''); try { return await work() } catch (error) { fail(error) } finally { setBusy('') } }
  const testFile = () => run('test', async () => { setTest(await api<TestResult>('/api/feed/test', { method: 'POST', body: JSON.stringify({ path }) })) })
  // Checking uses the saved file, so a changed path is saved first.
  const check = () => run('check', async () => { if (dirty) await savePath(); const result = await api<{ imported: number; duplicates: number; invalid: number; notice: string | null }>('/api/feed/refresh', { method: 'POST', body: '{}' }); say(`${result.imported} new job${result.imported === 1 ? '' : 's'} added to To review; ${result.duplicates} already known${result.invalid ? `; ${result.invalid} skipped for missing details` : ''}.${result.notice ? ` ${result.notice}` : ''}`); setStatus(await api<Status>('/api/feed/status')) })
  const preview = () => run('preview', async () => { setPlan(await api<Plan>('/api/feed/cleanup/preview', { method: 'POST', body: JSON.stringify({ days: Number(days) }) })) })
  const clean = () => run('clean', async () => { const result = await api<{ removedRows: number; removedJobs: number; notice: string | null }>('/api/feed/cleanup', { method: 'POST', body: JSON.stringify({ days: Number(days) }) }); setPlan(null); say(`Removed ${result.removedRows} row${result.removedRows === 1 ? '' : 's'} from the file and ${result.removedJobs} undecided job${result.removedJobs === 1 ? '' : 's'}.${result.notice ? ` ${result.notice}` : ''}`) })
  const fileName = status?.path ? status.path.split(/[\\/]/).pop() : 'jobs.csv'
  return <section className="panel block editor-panel feed-panel" aria-labelledby="feed-heading">
    <div className="block-head"><h2 id="feed-heading">Job feed</h2><a className="button small quiet" href="/guide.html#job-feed" target="_blank" rel="noreferrer">How the file should look ↗</a></div>
    {status?.configured
      ? <div className="status-line" role="status"><span className="dot" aria-hidden="true" /><div><b>{status.isDefault ? `Reading ${fileName} from your data folder` : `Reading ${fileName}`}</b><span className="t">{status.lastCheckedAt ? `Last checked ${new Date(status.lastCheckedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.` : 'Not checked yet.'} New jobs appear in To review.</span></div></div>
      : <div className="status-line off" role="status"><span className="dot" aria-hidden="true" /><div><b>No feed file yet</b><span className="t">If a search tool such as Claude Code or Codex saves jobs to a CSV file, Role Clinic can read it. It never searches; it only reads the file.</span></div></div>}
    {status?.configured && <div className="actions"><button className="button small" disabled={!!busy} onClick={() => void check()}>{busy === 'check' ? 'Checking…' : 'Check now'}</button></div>}
    <details className="more"><summary>Use a different file</summary><div className="body">
      <p className="note">Role Clinic uses <code>{status?.defaultPath ?? 'jobs.csv in your data folder'}</code> as soon as it exists. Fill in a path only to use another file; leave it empty to go back to the default. The path saves with the other settings.</p>
      <label htmlFor="feed-path">Path to a different CSV file</label>
      <input id="feed-path" value={path} placeholder={status?.defaultPath ?? '/path/to/jobs.csv'} autoComplete="off" spellCheck={false} onChange={(event) => { setPath(event.target.value); setTest(null) }} />
      <div className="actions"><button className="button small" disabled={!!busy || (!path.trim() && !status?.defaultPath)} onClick={() => void testFile()}>Test file</button></div>
      {test && <p className="note" role="status">{test.missingColumns.length ? `The file is missing required columns: ${test.missingColumns.join(', ')}.` : `${test.rows} rows: ${test.valid} usable, ${test.invalid} skipped for missing details, ${test.alreadyImported} already imported, ${test.newRows} new. Nothing was changed.`}</p>}
    </div></details>
    {status?.configured && <details className="more"><summary>Clean up old rows</summary><div className="body">
      <p className="note">Removes imported rows and undecided jobs from the feed older than a number of days (posted date if the row has one, otherwise found date). Tracked, applied and skipped jobs and rows you have not imported are never touched. Removed URLs are still remembered, so they are not imported again.</p>
      <div className="actions"><label htmlFor="feed-days">Older than (days)</label><input id="feed-days" type="number" min={1} max={3650} value={days} onChange={(event) => { setDays(event.target.value); setPlan(null) }} /><button className="button small" disabled={!!busy} onClick={() => void preview()}>Preview</button></div>
      {plan && <div role="status"><p>{plan.csvRows} row{plan.csvRows === 1 ? '' : 's'} in the file and {plan.triageJobs.length} undecided feed job{plan.triageJobs.length === 1 ? '' : 's'} older than {plan.cutoff}.</p>{!!plan.triageJobs.length && <ul>{plan.triageJobs.slice(0, 10).map((job) => <li key={job.id}>{job.title}, {job.company} · {job.date}</li>)}</ul>}{plan.triageJobs.length > 10 && <p className="note">and {plan.triageJobs.length - 10} more.</p>}<button className="button small" disabled={!!busy || (!plan.csvRows && !plan.triageJobs.length)} onClick={() => void clean()}>Remove these</button></div>}
    </div></details>}
    {toastNode}
  </section>
}
