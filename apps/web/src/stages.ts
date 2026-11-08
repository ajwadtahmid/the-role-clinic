import { closedOutcomes, currentStatus } from '../../../packages/shared/src/index.js'

// The seven stored statuses, one stage and one name each. A closed job also carries an outcome.
export type Stage = 'review' | 'saved' | 'skipped' | 'applied' | 'interviewing' | 'offer' | 'closed'

const stageByStatus: Record<string, Stage> = { new: 'review', saved: 'saved', skipped: 'skipped', applied: 'applied', interviewing: 'interviewing', offer: 'offer', closed: 'closed' }
export const stageLabels: Record<Stage, string> = { review: 'To review', saved: 'Saved', skipped: 'Skipped', applied: 'Applied', interviewing: 'Interviewing', offer: 'Offer', closed: 'Closed' }
export const outcomeLabels: Record<string, string> = { rejected: 'Rejected', no_reply: 'No reply', withdrawn: 'You withdrew', accepted: 'You accepted' }

// Old status values (screening, ghosted…) still appear in status history; currentStatus maps them.
export function stageOf(status: string): Stage { return stageByStatus[currentStatus(status).status] ?? 'review' }
export function stageLabel(status: string) { return stageLabels[stageOf(status)] }
// "Closed · No reply" for a closed job, the stage name for the rest.
export function statusText(status: string, outcome?: string | null) {
  const now = currentStatus(status, outcome ?? null)
  return now.status === 'closed' && now.outcome ? `${stageLabels.closed} · ${outcomeLabels[now.outcome] ?? now.outcome}` : stageLabel(status)
}

// One list for the status menus. Closed needs a reason, so each ending is its own choice, written "closed:no_reply".
export const statusChoices = [
  ...(['new', 'saved', 'skipped', 'applied', 'interviewing', 'offer'] as const).map((status) => ({ value: status as string, label: stageLabel(status) })),
  ...closedOutcomes.map((outcome) => ({ value: `closed:${outcome}`, label: `Closed · ${outcomeLabels[outcome]}` })),
]
export function choiceOf(status: string, outcome?: string | null) {
  const now = currentStatus(status, outcome ?? null)
  return now.status === 'closed' ? `closed:${now.outcome ?? 'rejected'}` : now.status
}
export function splitChoice(choice: string): { status: string; outcome?: string } {
  const [status, outcome] = choice.split(':')
  return outcome ? { status, outcome } : { status }
}

export type NextActionId = 'extract' | 'track' | 'tailor' | 'review' | 'apply' | 'tracker' | 'none'
export type NextAction = { id: NextActionId; label: string; hint: string }
export type JobProgress = { status: string; hasExtraction: boolean; hasDraft: boolean; hasExport: boolean }

// One button for the step a job needs next, worked out from data the page already holds.
export function nextAction({ status, hasExtraction, hasDraft, hasExport }: JobProgress): NextAction {
  const stage = stageOf(status)
  if (stage === 'closed') return { id: 'none', label: '', hint: 'This job is closed. Change the status under More to reopen it.' }
  if (stage === 'skipped') return { id: 'none', label: '', hint: 'You skipped this job. Change the status under More to bring it back.' }
  if (stage !== 'review' && stage !== 'saved') return { id: 'tracker', label: 'Open in Tracker', hint: 'Follow-ups, contacts, notes and the answers you gave are kept in the tracker.' }
  if (!hasExtraction) return { id: 'extract', label: 'Check fit', hint: 'Finds what the posting requires and compares it with your profile and résumé.' }
  // Tailoring is the next real step; starting it also tracks a job that is still waiting for review.
  if (!hasDraft && stage === 'review') return { id: 'tailor', label: 'Tailor résumé', hint: 'Writes a draft from your master résumé; every line cites its source. This also adds the job to the Tracker.' }
  if (stage === 'review') return { id: 'review', label: 'Review and export', hint: 'Check each line, then export a DOCX or PDF.' }
  if (!hasDraft) return { id: 'tailor', label: 'Tailor résumé', hint: 'Writes a draft from your master résumé; every line cites its source.' }
  if (!hasExport) return { id: 'review', label: 'Review and export', hint: 'Check each line, then export a DOCX or PDF.' }
  return { id: 'apply', label: 'Mark as applied', hint: 'Choose the exported file you actually sent.' }
}
