import { useEffect, useState } from 'react'
import { calendarDate, type TrackerSummary } from '../../../packages/shared/src/index.js'
import { api } from './api.js'
import { AppHeader, PageHeader } from './layout.js'
import { Skeleton } from './ui/skeleton.js'
import { statusText } from './stages.js'

type Counts = { new: number; saved: number; triage: number; applied: number }

// What needs attention now: follow-ups that are due, applications that may be closed, jobs waiting for review, and how the week is going.
export function TodayPage() {
  const [data, setData] = useState<TrackerSummary | null>(null), [counts, setCounts] = useState<Counts | null>(null), [goal, setGoal] = useState<number | null | undefined>(undefined), [draft, setDraft] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    void Promise.all([api<TrackerSummary>('/api/tracker'), api<Counts>('/api/jobs/counts'), api<{ goal: number | null }>('/api/weekly-goal')])
      .then(([summary, count, weekly]) => { setData(summary); setCounts(count); setGoal(weekly.goal) }).catch((e) => setError((e as Error).message))
  }, [])
  async function saveGoal(value: number | null) {
    try { const result = await api<{ goal: number | null }>('/api/weekly-goal', { method: 'PUT', body: JSON.stringify({ goal: value }) }); setGoal(result.goal); setDraft('') } catch (e) { setError((e as Error).message) }
  }
  if (error && !data) return <main className="shell" id="main" tabIndex={-1}><AppHeader current="today" /><p role="alert" className="notice error">{error}</p></main>
  if (!data || !counts || goal === undefined) return <main className="shell" id="main" tabIndex={-1}><AppHeader current="today" /><PageHeader title="Today" /><Skeleton lines={5} label="Loading today…" /></main>
  const today = calendarDate(), appliedThisWeek = data.appliedThisWeek
  const interviewing = data.jobs.filter((j) => j.status === 'interviewing').length
  const empty = data.jobs.length === 0
  return <main className="shell" id="main" tabIndex={-1}>
    <AppHeader current="today" />
    <PageHeader title="Today" actions={<a className="button primary" href="#jobs">Add or open jobs</a>}>{empty ? 'Nothing here yet. Add your first job to get started.' : 'What needs you now.'}</PageHeader>
    {counts.new > 0 && <section className="panel today-card" aria-label="Jobs to review"><div><h2>{counts.new} job{counts.new === 1 ? '' : 's'} to review</h2><p className="subtle">Go through them one at a time: save the good ones, skip the rest.</p></div><a className="button primary" href="#review">Start reviewing</a></section>}
    {(data.followUps.length > 0 || data.ghostedSuggestions.length > 0) ? <section className="panel today-card stacked" aria-label="Follow-ups">
      {data.followUps.length > 0 && <><h2>Follow-ups due <span className="count">{data.followUps.length}</span></h2>{data.followUps.map((job) => <a className="reminder-row" key={job.id} href={`#tracker?job=${job.id}`}>{job.company} · {job.title} <strong>{job.followUpDate! < today ? 'Overdue' : 'Due'} {job.followUpDate}</strong></a>)}</>}
      {data.ghostedSuggestions.length > 0 && <><h2>May be closed <span className="count">{data.ghostedSuggestions.length}</span></h2><p className="subtle">No reply in {data.preferences.ghostedDays} days. Open one to keep waiting or close it.</p>{data.ghostedSuggestions.map((job) => <a className="reminder-row" key={job.id} href={`#tracker?job=${job.id}`}>{job.company} · {job.title} <span className="subtle">{statusText(job.status, job.outcome)}</span></a>)}</>}
    </section> : !empty && <section className="panel today-card"><div><h2>Nothing is due</h2><p className="subtle">No follow-ups are waiting.{data.preferences.remindersOn ? '' : ' Reminders are off in Settings.'}</p></div></section>}
    {!empty && <section className="panel today-card stacked" aria-label="This week">
      <h2>This week</h2>
      <dl className="momentum"><div><dt>Applied</dt><dd>{appliedThisWeek}</dd></div><div><dt>Replies</dt><dd>{data.repliesThisWeek}</dd></div><div><dt>Interviewing now</dt><dd>{interviewing}</dd></div><div><dt>Follow-ups due</dt><dd>{data.followUps.length}</dd></div></dl>
      {goal ? <div><progress max={goal} value={Math.min(appliedThisWeek, goal)} aria-label={`Applied ${appliedThisWeek} of ${goal} this week`} /> <span className="subtle">{appliedThisWeek} of {goal} applications this week</span> <button className="text-button" onClick={() => void saveGoal(null)}>Turn off goal</button></div>
        : <form className="goal-form" onSubmit={(event) => { event.preventDefault(); const n = Number(draft); if (Number.isInteger(n) && n >= 1 && n <= 100) void saveGoal(n); else setError('Choose a whole number from 1 to 100.') }}><label>Weekly goal (optional)<input type="number" min={1} max={100} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Applications a week" /></label><button className="button secondary">Set goal</button>{error && <span role="alert" className="subtle">{error}</span>}</form>}
    </section>}
  </main>
}
