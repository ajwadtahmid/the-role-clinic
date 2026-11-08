// A word-level comparison of a suggested line against the résumé bullet it came from, so the review can show what changed.
export type Part = { text: string; kind: 'same' | 'add' | 'del' }
const norm = (word: string) => word.toLowerCase().replace(/[.,;:]+$/, '')

// `similarity` is the share of words the two lines have in common. A line that shares few words with its source is not a reword of it, so marking every word would only be noise.
export function wordDiff(original: string, suggested: string): { original: Part[]; suggested: Part[]; same: boolean; similarity: number } {
  const a = original.split(/\s+/).filter(Boolean), b = suggested.split(/\s+/).filter(Boolean)
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = norm(a[i]) === norm(b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  const before: Part[] = [], after: Part[] = []
  let i = 0, j = 0
  while (i < a.length && j < b.length) {
    if (norm(a[i]) === norm(b[j])) { before.push({ text: a[i++], kind: 'same' }); after.push({ text: b[j++], kind: 'same' }) }
    else if (table[i + 1][j] >= table[i][j + 1]) before.push({ text: a[i++], kind: 'del' })
    else after.push({ text: b[j++], kind: 'add' })
  }
  while (i < a.length) before.push({ text: a[i++], kind: 'del' })
  while (j < b.length) after.push({ text: b[j++], kind: 'add' })
  const shared = before.filter((part) => part.kind === 'same').length
  return { original: before, suggested: after, same: a.length === b.length && a.every((word, k) => norm(word) === norm(b[k])), similarity: shared / Math.max(a.length, b.length, 1) }
}
