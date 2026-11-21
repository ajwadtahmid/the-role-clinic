// A 0 to 1 score for how alike two company names or job titles are (Jaro-Winkler on lowercase letters and digits).
export function similarity(left: string, right: string) {
  const a = left.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), b = right.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (a === b) return 1
  if (!a || !b) return 0
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const am = Array(a.length).fill(false), bm = Array(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) if (!bm[j] && a[i] === b[j]) { am[i] = true; bm[j] = true; matches++; break }
  if (!matches) return 0
  let k = 0, transpositions = 0
  for (let i = 0; i < a.length; i++) if (am[i]) { while (!bm[k]) k++; if (a[i] !== b[k]) transpositions++; k++ }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3
  let prefix = 0; while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++
  return jaro + prefix * 0.1 * (1 - jaro)
}
