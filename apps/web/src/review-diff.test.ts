import { describe, expect, it } from 'vitest'
import { wordDiff } from './review-diff.js'

describe('wordDiff', () => {
  it('marks new words in the suggestion and dropped words in the original', () => {
    const result = wordDiff('Built a dashboard used by 40 agents.', 'Built a support dashboard for 40 agents.')
    expect(result.same).toBe(false)
    expect(result.suggested.filter((part) => part.kind === 'add').map((part) => part.text)).toEqual(['support', 'for'])
    expect(result.original.filter((part) => part.kind === 'del').map((part) => part.text)).toEqual(['used', 'by'])
  })
  it('treats wording that differs only in case and trailing punctuation as the same', () => {
    expect(wordDiff('Wrote tests, fast.', 'wrote tests fast').same).toBe(true)
  })
})
