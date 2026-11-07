import { describe, expect, it } from 'vitest'
import { nextAction, stageLabel, stageOf } from './stages.js'

const progress = { hasExtraction: false, hasDraft: false, hasExport: false }

describe('stages', () => {
  it('groups the eleven stored statuses into six stages', () => {
    expect(['new', 'saved', 'applied', 'screening', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn', 'ghosted', 'skipped'].map(stageOf))
      .toEqual(['review', 'saved', 'applied', 'applied', 'interviewing', 'offer', 'offer', 'closed', 'closed', 'closed', 'closed'])
    expect(stageLabel('screening')).toBe('Applied')
    expect(stageLabel('ghosted')).toBe('Closed')
    expect(stageLabel('unknown-value')).toBe('To review')
  })

  it('offers one next step per point in a job’s life', () => {
    expect(nextAction({ status: 'new', ...progress }).id).toBe('extract')
    expect(nextAction({ status: 'saved', ...progress }).label).toBe('Check fit')
    expect(nextAction({ status: 'saved', ...progress, hasExtraction: true }).label).toBe('Tailor résumé')
    expect(nextAction({ status: 'saved', hasExtraction: true, hasDraft: true, hasExport: false }).label).toBe('Review and export')
    expect(nextAction({ status: 'saved', hasExtraction: true, hasDraft: true, hasExport: true }).label).toBe('Mark as applied')
  })

  it('moves on to follow-up once applied and offers nothing for a closed job', () => {
    for (const status of ['applied', 'screening', 'interviewing', 'offer', 'accepted']) expect(nextAction({ status, ...progress }).id).toBe('followup')
    for (const status of ['rejected', 'withdrawn', 'ghosted', 'skipped']) expect(nextAction({ status, ...progress }).id).toBe('none')
  })
})
