// The 11 stored statuses shown as six stages. Only the display is grouped; stored values and the API are unchanged.
export type Stage = 'review' | 'saved' | 'applied' | 'interviewing' | 'offer' | 'closed'

const stageByStatus: Record<string, Stage> = {
  new: 'review', saved: 'saved', applied: 'applied', screening: 'applied', interviewing: 'interviewing',
  offer: 'offer', accepted: 'offer', rejected: 'closed', withdrawn: 'closed', ghosted: 'closed', skipped: 'closed',
}
export const stageLabels: Record<Stage, string> = { review: 'To review', saved: 'Saved', applied: 'Applied', interviewing: 'Interviewing', offer: 'Offer', closed: 'Closed' }

export function stageOf(status: string): Stage { return stageByStatus[status] ?? 'review' }
export function stageLabel(status: string) { return stageLabels[stageOf(status)] }

export type NextActionId = 'extract' | 'track' | 'tailor' | 'review' | 'apply' | 'tracker' | 'none'
export type NextAction = { id: NextActionId; label: string; hint: string }
export type JobProgress = { status: string; hasExtraction: boolean; hasDraft: boolean; hasExport: boolean }

// One button for the step a job needs next, worked out from data the page already holds.
export function nextAction({ status, hasExtraction, hasDraft, hasExport }: JobProgress): NextAction {
  const stage = stageOf(status)
  if (stage === 'closed') return { id: 'none', label: '', hint: 'This job is closed. Change the status under More to reopen it.' }
  if (stage !== 'review' && stage !== 'saved') return { id: 'tracker', label: 'Open in Tracker', hint: 'Follow-ups, contacts, notes and the answers you gave are kept in the tracker.' }
  if (!hasExtraction) return { id: 'extract', label: 'Check fit', hint: 'Finds what the posting requires and compares it with your profile and résumé.' }
  if (stage === 'review') return { id: 'track', label: 'Track this job', hint: 'Adds this job to the Tracker so you can keep answers and follow-ups with it.' }
  if (!hasDraft) return { id: 'tailor', label: 'Tailor résumé', hint: 'Writes a draft from your master résumé; every line cites its source.' }
  if (!hasExport) return { id: 'review', label: 'Review and export', hint: 'Check each line, then export a DOCX or PDF.' }
  return { id: 'apply', label: 'Mark as applied', hint: 'Choose the exported file you actually sent.' }
}
