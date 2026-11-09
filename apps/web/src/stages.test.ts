import { describe, expect, it } from 'vitest'
import { choiceOf, nextAction, splitChoice, stageLabel, stageOf, statusChoices, statusText } from './stages.js'

const progress = { hasExtraction: false, hasDraft: false, hasExport: false }

describe('stages', () => {
  it('gives each of the seven stored statuses its own stage and name', () => {
    expect(['new', 'saved', 'skipped', 'applied', 'interviewing', 'offer', 'closed'].map(stageOf))
      .toEqual(['review', 'saved', 'skipped', 'applied', 'interviewing', 'offer', 'closed'])
    expect(['new', 'saved', 'skipped', 'applied', 'interviewing', 'offer', 'closed'].map(stageLabel))
      .toEqual(['To review', 'Saved', 'Skipped', 'Applied', 'Interviewing', 'Offer', 'Closed'])
    expect(stageLabel('unknown-value')).toBe('To review')
  })

  it('reads old status values from history as today’s stages', () => {
    expect(stageLabel('screening')).toBe('Interviewing')
    for (const old of ['accepted', 'rejected', 'withdrawn', 'ghosted']) expect(stageLabel(old)).toBe('Closed')
    expect(statusText('ghosted')).toBe('Closed · No reply')
    expect(statusText('closed', 'accepted')).toBe('Closed · You accepted')
    expect(statusText('closed')).toBe('Closed')
    expect(statusText('applied')).toBe('Applied')
  })

  it('offers each ending of a closed job as its own menu choice', () => {
    expect(statusChoices.map((choice) => choice.value)).toEqual(['new', 'saved', 'skipped', 'applied', 'interviewing', 'offer', 'closed:rejected', 'closed:no_reply', 'closed:withdrawn', 'closed:accepted'])
    expect(choiceOf('closed', 'no_reply')).toBe('closed:no_reply')
    expect(choiceOf('ghosted')).toBe('closed:no_reply')
    expect(choiceOf('applied')).toBe('applied')
    expect(splitChoice('closed:withdrawn')).toEqual({ status: 'closed', outcome: 'withdrawn' })
    expect(splitChoice('offer')).toEqual({ status: 'offer' })
  })

  it('offers one next step per point in a job’s life', () => {
    expect(nextAction({ status: 'new', ...progress }).id).toBe('extract')
    expect(nextAction({ status: 'new', ...progress, hasExtraction: true }).label).toBe('Tailor résumé')
    expect(nextAction({ status: 'new', hasExtraction: true, hasDraft: true, hasExport: false }).label).toBe('Review and export')
    expect(nextAction({ status: 'saved', ...progress }).label).toBe('Check fit')
    expect(nextAction({ status: 'saved', ...progress, hasExtraction: true }).label).toBe('Tailor résumé')
    expect(nextAction({ status: 'saved', hasExtraction: true, hasDraft: true, hasExport: false }).label).toBe('Review and export')
    expect(nextAction({ status: 'saved', hasExtraction: true, hasDraft: true, hasExport: true }).label).toBe('Mark as applied')
  })

  it('offers Mark as applied first when AI features are off or the job has no description to check', () => {
    expect(nextAction({ status: 'new', ...progress, ai: false })).toMatchObject({ id: 'markApplied', label: 'Mark as applied' })
    expect(nextAction({ status: 'saved', ...progress, ai: false, hasExtraction: true })).toMatchObject({ id: 'markApplied' })
    expect(nextAction({ status: 'new', ...progress, hasText: false })).toMatchObject({ id: 'markApplied', hint: expect.stringContaining('Add the job description') })
    // Once applied, closed or skipped it behaves the same with or without AI.
    expect(nextAction({ status: 'applied', ...progress, ai: false }).id).toBe('tracker')
    expect(nextAction({ status: 'skipped', ...progress, ai: false }).id).toBe('none')
  })

  it('points to the Tracker once applied and offers nothing for a closed or skipped job', () => {
    for (const status of ['applied', 'interviewing', 'offer']) expect(nextAction({ status, ...progress }).id).toBe('tracker')
    for (const status of ['closed', 'skipped']) expect(nextAction({ status, ...progress }).id).toBe('none')
  })
})
