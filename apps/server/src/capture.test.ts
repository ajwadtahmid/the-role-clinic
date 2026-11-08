import { describe, expect, it } from 'vitest'
import { captureJobUrl } from './capture.js'

const leverUrl = 'https://jobs.lever.co/example/job-123'
function savedResponse(body: unknown): Parameters<typeof captureJobUrl>[1] {
  return async (url) => ({ url, body: JSON.stringify(body), contentType: 'application/json' })
}

describe('posting completeness', () => {
  it('keeps every Lever list section in order, including unnamed eligibility sections', async () => {
    const body = {
      text: 'Platform Engineer', description: '<p>Help our engineering team operate reliable services.</p>',
      lists: [
        { text: 'Requirements', content: '<ul><li>1+ years with AWS and Kubernetes.</li><li>Working knowledge of Linux.</li></ul>' },
        { text: 'Preferred', content: '<p>Terraform experience.</p>' },
        { text: '', content: '<p>Additional requirements:</p><ul><li>Eligible to work in the United States.</li><li>Hybrid schedule in Irvine.</li></ul>' },
      ],
      additional: '<p>Equal opportunity employer.</p>', categories: { location: 'Irvine' }, applyUrl: 'https://example.test/apply',
    }
    const captured = await captureJobUrl(leverUrl, savedResponse(body))
    expect(captured.text).toBe('Help our engineering team operate reliable services.\n\nRequirements\n\n1+ years with AWS and Kubernetes. Working knowledge of Linux.\n\nPreferred\n\nTerraform experience.\n\nAdditional requirements: Eligible to work in the United States. Hybrid schedule in Irvine.\n\nEqual opportunity employer.')
    expect(captured.rawSnapshot).toBe(JSON.stringify(body))
    expect(captured).toMatchObject({ location: 'Irvine', applyUrl: body.applyUrl, captureMethod: 'lever-api' })
  })

  it.each([undefined, [], null])('keeps Lever descriptions without list sections (%j)', async (lists) => {
    const captured = await captureJobUrl(leverUrl, savedResponse({ text: 'Engineer', description: '<p>Build reliable systems for a collaborative engineering team.</p>', lists, additional: '<p>Remote work available.</p>' }))
    expect(captured.text).toBe('Build reliable systems for a collaborative engineering team.\n\nRemote work available.')
  })

  it('cleans entity-encoded Greenhouse HTML without losing qualifications or the original response', async () => {
    const body = { title: 'Engineer', content: '&lt;p&gt;Required qualifications:&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python &amp;amp; SQL experience.&lt;/li&gt;&lt;li&gt;Bachelor&amp;#39;s degree or equivalent experience.&lt;/li&gt;&lt;/ul&gt;' }
    const captured = await captureJobUrl('https://job-boards.greenhouse.io/example/jobs/123', savedResponse(body))
    expect(captured.text).toBe("Required qualifications: Python & SQL experience. Bachelor's degree or equivalent experience.")
    expect(captured.rawSnapshot).toBe(JSON.stringify(body))
  })

  it('separates block boundaries while preserving inline words and literal comparison text', async () => {
    const body = { title: 'Engineer', content: '<h2>Requirements</h2><p>Type<strong>Script</strong> experience.</p><ul><li>Python.</li><li>SQL.</li></ul><p>Latency &lt; 20ms.<br>Remote role in the US.</p>' }
    const captured = await captureJobUrl('https://job-boards.greenhouse.io/example/jobs/123', savedResponse(body))
    expect(captured.text).toBe('Requirements TypeScript experience. Python. SQL. Latency < 20ms. Remote role in the US.')
  })
})
