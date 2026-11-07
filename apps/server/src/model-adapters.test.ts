import { describe, expect, it } from 'vitest'
import { defaultSettings } from './settings.js'
import { ModelRouter, OllamaAdapter, contextWindowFor, type ModelAdapter } from './model-adapters.js'

describe('task-specific model routing', () => {
  it('uses each task selection and serializes provider calls', async () => {
    const settings = defaultSettings()
    settings.taskModels.requirementExtraction = { provider: 'ollama', model: 'qwen3.5:9b' }
    settings.taskModels.resumeDrafting = { provider: 'anthropic', model: 'claude-sonnet-5-5' }
    let activeCalls = 0
    let maximumActiveCalls = 0
    const seen: string[] = []
    const unloaded: string[] = []
    const adapter: ModelAdapter = {
      provider: 'ollama',
      async unload(model) { unloaded.push(model) },
      async complete(model) {
        activeCalls += 1
        maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls)
        seen.push(model)
        await new Promise((resolve) => setTimeout(resolve, 15))
        activeCalls -= 1
        return { text: '{}', model, provider: 'ollama' }
      },
    }
    const anthropic: ModelAdapter = {
      ...adapter,
      provider: 'anthropic',
      async complete(model) {
        const result = await adapter.complete(model, { system: '', user: '', tier: 'fast' })
        return { ...result, provider: 'anthropic' }
      },
    }
    const router = new ModelRouter(async () => settings, { ollama: adapter, anthropic })
    const [extraction, drafting] = await Promise.all([
      router.complete('requirementExtraction', { system: 'extract', user: 'job', tier: 'fast' }),
      router.complete('resumeDrafting', { system: 'draft', user: 'resume', tier: 'strong' }),
    ])
    expect(seen).toEqual(['qwen3.5:9b', 'claude-sonnet-5-5'])
    expect(unloaded).toEqual(['qwen3.5:9b'])
    expect(maximumActiveCalls).toBe(1)
    expect(extraction.model).toBe('qwen3.5:9b')
    expect(drafting.model).toBe('claude-sonnet-5-5')
  })
})

describe('local model context window', () => {
  const request = (chars: number, tier: 'fast' | 'strong' = 'fast') => ({ system: 'x'.repeat(200), user: 'y'.repeat(chars), tier, maxOutputTokens: 1400 })

  it('grows with the prompt so instructions are never truncated', () => {
    expect(contextWindowFor(request(2000))).toBe(4096)
    expect(contextWindowFor(request(2000, 'strong'))).toBe(8192)
    expect(contextWindowFor(request(30_000))).toBe(16384)
    expect(contextWindowFor(request(80_000))).toBe(32768)
  })

  it('refuses a prompt that cannot fit instead of letting Ollama cut it', () => {
    expect(() => contextWindowFor(request(120_000))).toThrow(/choose Claude/)
  })

  it('sends the computed window to Ollama and does not call it for an oversized prompt', async () => {
    const bodies: Array<{ options: { num_ctx: number } }> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => { bodies.push(JSON.parse(init!.body!)); return new Response(JSON.stringify({ message: { content: '{}' } })) }) as typeof fetch
    try {
      const adapter = new OllamaAdapter(async () => defaultSettings())
      await adapter.complete('gemma4:12b', request(30_000))
      expect(bodies[0].options.num_ctx).toBe(16384)
      await expect(adapter.complete('gemma4:12b', request(120_000))).rejects.toThrow(/context/)
      expect(bodies).toHaveLength(1)
    } finally { globalThis.fetch = original }
  })
})
