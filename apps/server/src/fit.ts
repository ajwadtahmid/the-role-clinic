import { isOpenCondition, type Extraction, type Gap, type Suggestion } from '../../../packages/shared/src/index.js'
import type { BulletScore, Master } from '../../../packages/shared/src/index.js'
import { evidenceRows, findGaps, skillItems, techNames } from './pipeline-core.js'

const norm = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim()
// The local model's suggestions that still hold: the bullet is still active and still contains the words the model quoted from it.
// A requirement that names a technology (Rust, Terraform, Postgres) is only ever covered by a bullet that names it; the model cannot suggest its way past that.
export function liveSuggestions(extraction: Extraction, master: Master): Suggestion[] {
  const rows = new Map(evidenceRows(master).map((row) => [row.bullet.id, row])), byId = new Map(extraction.requirements.map((item) => [item.id, item]))
  const tools = new Set([...techNames, ...master.skills.map((skill) => skill.name)].map((name) => name.toLowerCase()))
  const namesTool = (id: string) => skillItems(byId.get(id)?.skill ?? '').some((part) => tools.has(part.toLowerCase()))
  return (extraction.suggestions ?? []).filter((item) => byId.has(item.requirementId) && !namesTool(item.requirementId) && norm(item.evidence).length >= 12 && norm(rows.get(item.bulletId)?.bullet.text ?? '').includes(norm(item.evidence)))
}
// The gaps the Fit check shows: what the keyword check missed, less what the local model found and the quote proves.
export function fitGaps(extraction: Extraction, scores: BulletScore[], master: Master): Gap[] {
  const suggested = new Set(liveSuggestions(extraction, master).map((item) => item.requirementId))
  return findGaps(extraction, scores, master).filter((gap) => !suggested.has(gap.requirementId))
}

export type FitLabel = 'Strong fit' | 'Good fit' | 'Partial fit' | 'Weak fit'
export type Fit = { pct: number; label: FitLabel; hardCovered: number; hardTotal: number; niceCovered: number; niceTotal: number }

// How much of a posting the master résumé already covers. A key requirement counts in full and a nice-to-have a quarter;
// knockout conditions are warnings of their own and are not part of the score. Covered means no gap was found for it.
export function computeFit(extraction: Extraction, gaps: Gap[]): Fit | null {
  const missing = new Set(gaps.map((gap) => gap.requirementId))
  // A location or degree the app cannot judge yet is a check on the Fit tab, not a missing skill.
  const scored = extraction.requirements.filter((item) => !isOpenCondition(item))
  const hard = scored.filter((item) => item.kind === 'hard'), nice = scored.filter((item) => item.kind === 'nice')
  if (!hard.length && !nice.length) return null
  const hardCovered = hard.filter((item) => !missing.has(item.id)).length, niceCovered = nice.filter((item) => !missing.has(item.id)).length
  const pct = Math.round((hardCovered + niceCovered * .25) / (hard.length + nice.length * .25) * 100)
  const label: FitLabel = pct >= 75 ? 'Strong fit' : pct >= 55 ? 'Good fit' : pct >= 40 ? 'Partial fit' : 'Weak fit'
  return { pct, label, hardCovered, hardTotal: hard.length, niceCovered, niceTotal: nice.length }
}

// For each covered requirement, the master résumé bullet that supports it best (shown on the Fit check tab).
export function bestMatches(extraction: Extraction, gaps: Gap[], scores: BulletScore[], master: Master) {
  const missing = new Set(gaps.map((gap) => gap.requirementId)), rows = new Map(evidenceRows(master).map((row) => [row.bullet.id, row]))
  const suggestions = liveSuggestions(extraction, master)
  return extraction.requirements.flatMap((requirement) => {
    if (missing.has(requirement.id)) return []
    const best = scores.find((score) => score.score >= 25 && score.requirementIds.includes(requirement.id) && rows.has(score.bulletId))
    const row = best && rows.get(best.bulletId)
    if (row) return [{ requirementId: requirement.id, bulletId: row.bullet.id, text: row.bullet.text.slice(0, 300), context: row.context }]
    const suggestion = suggestions.find((item) => item.requirementId === requirement.id), suggested = suggestion && rows.get(suggestion.bulletId)
    return suggested ? [{ requirementId: requirement.id, bulletId: suggested.bullet.id, text: suggested.bullet.text.slice(0, 300), context: suggested.context, suggested: true, reason: suggestion.reason }] : []
  })
}
