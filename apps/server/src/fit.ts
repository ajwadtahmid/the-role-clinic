import type { Extraction, Gap } from '../../../packages/shared/src/index.js'
import type { BulletScore, Master } from '../../../packages/shared/src/index.js'
import { evidenceRows } from './pipeline-core.js'

export type FitLabel = 'Strong fit' | 'Good fit' | 'Partial fit' | 'Weak fit'
export type Fit = { pct: number; label: FitLabel; hardCovered: number; hardTotal: number; niceCovered: number; niceTotal: number }

// How much of a posting the master résumé already covers. A key requirement counts in full and a nice-to-have a quarter;
// knockout conditions are warnings of their own and are not part of the score. Covered means no gap was found for it.
export function computeFit(extraction: Extraction, gaps: Gap[]): Fit | null {
  const missing = new Set(gaps.map((gap) => gap.requirementId))
  const hard = extraction.requirements.filter((item) => item.kind === 'hard'), nice = extraction.requirements.filter((item) => item.kind === 'nice')
  if (!hard.length && !nice.length) return null
  const hardCovered = hard.filter((item) => !missing.has(item.id)).length, niceCovered = nice.filter((item) => !missing.has(item.id)).length
  const pct = Math.round((hardCovered + niceCovered * .25) / (hard.length + nice.length * .25) * 100)
  const label: FitLabel = pct >= 75 ? 'Strong fit' : pct >= 55 ? 'Good fit' : pct >= 40 ? 'Partial fit' : 'Weak fit'
  return { pct, label, hardCovered, hardTotal: hard.length, niceCovered, niceTotal: nice.length }
}

// For each covered requirement, the master résumé bullet that supports it best (shown on the Fit check tab).
export function bestMatches(extraction: Extraction, gaps: Gap[], scores: BulletScore[], master: Master) {
  const missing = new Set(gaps.map((gap) => gap.requirementId)), rows = new Map(evidenceRows(master).map((row) => [row.bullet.id, row]))
  return extraction.requirements.flatMap((requirement) => {
    if (missing.has(requirement.id)) return []
    const best = scores.find((score) => score.score >= 25 && score.requirementIds.includes(requirement.id) && rows.has(score.bulletId))
    const row = best && rows.get(best.bulletId)
    return row ? [{ requirementId: requirement.id, bulletId: row.bullet.id, text: row.bullet.text.slice(0, 300), context: row.context }] : []
  })
}
