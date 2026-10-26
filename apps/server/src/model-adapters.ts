import Anthropic from '@anthropic-ai/sdk'
import type { TaskName } from '../../../packages/shared/src/index.js'
import type { AppSettings } from '../../../packages/shared/src/index.js'

export interface ModelRequest {
  system: string
  user: string
  tier: 'fast' | 'strong'
  schema?: Record<string, unknown>
}

export interface ModelResponse {
  text: string
  usage?: { inputTokens: number; outputTokens: number }
  model: string
  provider: 'ollama' | 'anthropic'
}

export interface ModelAdapter {
  readonly provider: 'ollama' | 'anthropic'
  complete(model: string, request: ModelRequest): Promise<ModelResponse>
  unload?(model: string, baseUrl?: string): Promise<void>
}

function jsonInstructions(schema?: Record<string, unknown>) {
  if (!schema) return ''
  return `\nReturn only valid JSON matching this JSON Schema. Do not include markdown fences.\n${JSON.stringify(schema)}`
}

export class OllamaAdapter implements ModelAdapter {
  readonly provider = 'ollama' as const

  constructor(private getSettings: () => Promise<AppSettings>) {}

  async complete(model: string, request: ModelRequest): Promise<ModelResponse> {
    const settings = await this.getSettings()
    const base = new URL(settings.ollamaBaseUrl)
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Ollama must be configured on this computer.')
    const response = await fetch(new URL('/api/chat', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: request.system + jsonInstructions(request.schema) },
          { role: 'user', content: request.user },
        ],
        stream: false,
        keep_alive: '5m',
        ...(request.schema ? { format: request.schema } : {}),
        options: { num_ctx: request.tier === 'strong' ? 8192 : 4096 },
      }),
      signal: AbortSignal.timeout(180000),
    })
    if (!response.ok) throw new Error(`Ollama request failed with HTTP ${response.status}.`)
    const payload = await response.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; model?: string }
    if (typeof payload.message?.content !== 'string') throw new Error('Ollama returned no message content.')
    return {
      text: payload.message.content,
      model: payload.model ?? model,
      provider: this.provider,
      ...(Number.isFinite(payload.prompt_eval_count) || Number.isFinite(payload.eval_count)
        ? { usage: { inputTokens: payload.prompt_eval_count ?? 0, outputTokens: payload.eval_count ?? 0 } }
        : {}),
    }
  }

  async unload(model: string, baseUrl?: string): Promise<void> {
    const settings = await this.getSettings()
    const base = new URL(baseUrl ?? settings.ollamaBaseUrl)
    const response = await fetch(new URL('/api/chat', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [], keep_alive: 0, stream: false }),
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error(`Ollama could not unload the previous model (HTTP ${response.status}).`)
  }
}

export class AnthropicAdapter implements ModelAdapter {
  readonly provider = 'anthropic' as const

  constructor(private getSettings: () => Promise<AppSettings>) {}

  async complete(model: string, request: ModelRequest): Promise<ModelResponse> {
    const settings = await this.getSettings()
    if (!settings.anthropicApiKey) throw new Error('Add an Anthropic API key in Settings first.')
    const client = new Anthropic({ apiKey: settings.anthropicApiKey, maxRetries: 1, timeout: 180000 })
    const response = await client.messages.create({
      model,
      max_tokens: request.tier === 'strong' ? 4096 : 2048,
      system: request.system + jsonInstructions(request.schema),
      messages: [{ role: 'user', content: request.user }],
    })
    const text = response.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n')
    return {
      text,
      model: response.model,
      provider: this.provider,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    }
  }
}

export class SerialModelQueue {
  private tail: Promise<void> = Promise.resolve()
  private queuedCount = 0

  get pendingCount() { return this.queuedCount }

  run<T>(operation: () => Promise<T>): Promise<T> {
    this.queuedCount += 1
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result.finally(() => { this.queuedCount -= 1 })
  }
}

export class ModelRouter {
  private readonly queue = new SerialModelQueue()
  private readonly adapters: Record<'ollama' | 'anthropic', ModelAdapter>
  private activeLocalModel?: { model: string; baseUrl: string }

  constructor(private getSettings: () => Promise<AppSettings>, adapters?: Partial<Record<'ollama' | 'anthropic', ModelAdapter>>) {
    const settingsLoader = getSettings
    this.adapters = {
      ollama: adapters?.ollama ?? new OllamaAdapter(settingsLoader),
      anthropic: adapters?.anthropic ?? new AnthropicAdapter(settingsLoader),
    }
  }

  complete(task: TaskName, request: ModelRequest): Promise<ModelResponse> {
    return this.queue.run(async () => {
      const settings = await this.getSettings()
      const choice = settings.taskModels[task]
      const nextLocal = choice.provider === 'ollama' ? { model: choice.model, baseUrl: settings.ollamaBaseUrl } : undefined
      const isSameLocalModel = this.activeLocalModel?.model === nextLocal?.model && this.activeLocalModel?.baseUrl === nextLocal?.baseUrl
      if (this.activeLocalModel && !isSameLocalModel) {
        await this.adapters.ollama.unload?.(this.activeLocalModel.model, this.activeLocalModel.baseUrl)
      }
      this.activeLocalModel = nextLocal
      return this.adapters[choice.provider].complete(choice.model, request)
    })
  }
}
