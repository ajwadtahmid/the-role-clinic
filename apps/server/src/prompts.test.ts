import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prompts, type PromptName } from './prompts.js'

// Append-only record of every prompt version ever shipped. To change a prompt: edit its text, bump its
// `version` in prompts.ts, and add the new version and hash here. Never edit an existing entry.
const history: Record<PromptName, Record<string, string>> = {
  requirementExtraction: { v1: '46b29ecc9b8a0c281240cbfc0a0fd79350f4c17a4758b3ea5ec22fafe0694407', v2: 'eaee1b3fb6fad219846057d4edd5a24e509a1cd3734f2a4815fb49b9093f565c' },
  bulletScoring: { v1: '7779cdec09744e6fdcadd2919132f4087d7f2f09cdbd0b1f40b02e5f4221028c', v2: '28e7091225cfde216f807539832fc1816ad9a83a87a67a3de911e50f1580de54', 'v3': '2b0c7ecbd18e81f3253c2783eeff3615822aedc02e63bceda63a8e463e3f9598' },
  resumeDrafting: { v1: '5b4abd614f568c17c7192ba59ea3944155fed8cc35f2010c198e8fa48be0a24f', 'v2': 'dabf7671179669013bb35568ecd2b3c7ec897c50c15194fa4e34d0c2d72b2c9e' },
  claimVerification: { v1: 'f8661ec3c0e2670ccf564afa8d0821cb9b5253707d1e78fcf9d9ffdea2674c93', 'v2': '0f952e8a560a31424d33cb679b02009cd046f38ee2289d6cf7b402ac7e641a34', 'v3': '48da8dc1e50fc62ed44a95041a1358fe99466411472eee0e533f5e434cad7b35' },
  antiSlop: { v1: 'aa9e3645cac5ec18c0821a56e823f4b6f958743ef9574350523ade197399cb5e', 'v2': '0caf0e7087736ef4d68d3643808191161c687216c17786574289dba210538d2d' },
  reviewVerification: { 'review-v1': '13edf789aac6821466c4d71b3a7468e9d14cc4135712fd8038bd8ea45243a166', 'review-v2': '979e47b3c54803ec19cf7a187ab5a6ab0066e700078f65b888b4d568bf5f9fea', 'review-v3': 'a8ad166d93f131855942ca1af9664b8ec51e250289f8851c7d020cf8d1e906c0' },
}

describe('prompt versions', () => {
  it.each(Object.keys(prompts) as PromptName[])('%s text matches its recorded version', (name) => {
    const { version, system } = prompts[name]
    const recorded = history[name][version]
    expect(recorded, `${name} ${version} has no recorded hash; add it to the history in this test`).toBeDefined()
    expect(createHash('sha256').update(system).digest('hex'), `${name} text changed without a new version label`).toBe(recorded)
  })
})
