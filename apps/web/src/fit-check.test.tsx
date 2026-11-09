// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { JobFit } from './fit-check.js'
import type { Analysis } from './job-detail.js'

afterEach(() => cleanup())

const requirement = (id: string, quote: string, over: Record<string, unknown> = {}) => ({ id, quote, kind: 'hard', category: 'skill', skill: '', start: 0, end: 1, assessment: 'unknown', basis: '', ...over })
function analysis(over: Partial<Analysis> = {}): Analysis {
  return {
    extraction: { requirements: [requirement('a', 'Clear written communication'), requirement('b', 'Irvine, CA or Fairfax, VA', { category: 'location', basis: 'Profile location is not recorded.' }), requirement('c', 'Experience with Terraform', { skill: 'Terraform' })], seniority: '', vocabulary: [], partial: false },
    preliminaryGaps: [{ requirementId: 'c', quote: 'Experience with Terraform', reason: '', evidenceIds: [] }],
    fit: { pct: 50, label: 'Partial fit', hardCovered: 1, hardTotal: 2, niceCovered: 0, niceTotal: 0 },
    matches: [{ requirementId: 'a', bulletId: 'x', text: 'Authored 70 Standard Operating Procedures', context: 'Quality Associate', suggested: true, reason: 'Wrote procedures for others.' }],
    tailored: null, runs: [{ id: 'r', kind: 'extract', status: 'done', step: 'saving', error: null, usage: null, costEstimate: 0, createdAt: '2026-11-08T10:00:00Z', finishedAt: '2026-11-08T10:00:20Z' }],
    ...over,
  } as Analysis
}

describe('Fit check tab', () => {
  it('labels a match the local model suggested and says how many there are', () => {
    render(<JobFit jobId="j" analysis={analysis()} busy={false} onCheck={vi.fn()} />)
    expect(screen.getAllByText(/Suggested by your local model: Wrote procedures for others\./).length).toBeGreaterThan(0)
    expect(screen.getByText(/1 found by your local model, not by keywords/)).toBeTruthy()
  })

  it('shows a location it cannot judge with the knockout checks, not as a missing skill', () => {
    render(<JobFit jobId="j" analysis={analysis()} busy={false} onCheck={vi.fn()} />)
    expect(screen.getByText('Not shown yet (1)')).toBeTruthy()
    expect(screen.getByText('Profile location is not recorded.')).toBeTruthy()
  })
})
