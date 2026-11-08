import type { ModelRequest } from './model-adapters.js'

// Aliases exist only for one request. Stored evidence and review IDs remain unchanged.
export function aliasRequest(request: ModelRequest) {
  let end = 0, depth = 0, quoted = false, escaped = false
  for (; end < request.user.length; end++) {
    const c = request.user[end]
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false }
    else if (c === '"') quoted = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) { end++; break }
  }
  let value: unknown
  try { value = JSON.parse(request.user.slice(0, end)) } catch { return { request, restore: (text: string) => text } }
  const aliases = new Map<string, string>(), originals = new Map<string, string>(), counts: Record<string, number> = {}
  const id = (value: string, prefix: string) => {
    const key = `${prefix}:${value}`
    if (!aliases.has(key)) { const alias = `${prefix}${counts[prefix] = (counts[prefix] ?? 0) + 1}`; aliases.set(key, alias); originals.set(alias, value) }
    return aliases.get(key)!
  }
  const encode = (v: unknown, parent = ''): unknown => {
    if (Array.isArray(v)) return v.map(x => encode(x, parent))
    if (!v || typeof v !== 'object') return v
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      if (typeof x === 'string' && k === 'outId') return [k, id(x, 'L')]
      if (typeof x === 'string' && k === 'id' && ['bullets', 'sources', 'requirements'].includes(parent)) return [k, id(x, parent === 'requirements' ? 'R' : 'B')]
      return [k, encode(x, k)]
    }))
  }
  const encoded = encode(value)
  if (!aliases.size) return { request, restore: (text: string) => text }
  const prefixes: Record<string, string> = { bulletId: 'B', sourceIds: 'B', requirementIds: 'R', outId: 'L' }
  const schema = (v: unknown, field = ''): unknown => {
    if (Array.isArray(v)) return v.map(x => schema(x, field))
    if (!v || typeof v !== 'object') return v
    const object = v as Record<string, unknown>
    if (object.format === 'uuid') {
      const { format: _format, pattern: _pattern, ...rest } = object
      const prefix = prefixes[field], allowed = [...originals.keys()].filter(alias => !prefix || alias.startsWith(prefix))
      return { ...rest, ...(allowed.length ? { enum: allowed } : { pattern: `^${prefix ?? '[BRL]'}[1-9][0-9]*$` }) }
    }
    const result = Object.fromEntries(Object.entries(object).map(([k, x]) => [k, k === 'properties' && x && typeof x === 'object'
      ? Object.fromEntries(Object.entries(x).map(([name, property]) => [name, schema(property, name)]))
      : schema(x, field)]))
    // Scoring must cover the entire batch, even when no requirements were extracted.
    if (field === 'scores' && object.type === 'array' && counts.B) return { ...result, minItems: counts.B, maxItems: counts.B }
    if (field === 'requirementIds' && object.type === 'array' && !counts.R) return { ...result, maxItems: 0 }
    return result
  }
  // Only server-generated retry diagnostics follow the JSON input; evidence text is untouched.
  const suffix = request.user.slice(end).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, uuid => [...aliases].find(([k]) => k.endsWith(`:${uuid}`))?.[1] ?? uuid)
  const restoreValue = (v: unknown, key = ''): unknown => {
    if (Array.isArray(v)) return v.map(x => restoreValue(x, key))
    if (typeof v === 'string' && ['bulletId', 'requirementIds', 'sourceIds', 'outId'].includes(key)) {
      const prefix = key === 'outId' ? 'L' : key === 'requirementIds' ? 'R' : 'B'
      return v.startsWith(prefix) && originals.has(v) ? originals.get(v)! : `invalid-alias:${v}`
    }
    if (!v || typeof v !== 'object') return v
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restoreValue(x, k)]))
  }
  return {
    request: { ...request, user: JSON.stringify(encoded) + suffix, ...(request.schema ? { schema: schema(request.schema) as Record<string, unknown> } : {}) },
    restore(text: string) {
      try { const start = text.indexOf('{'), finish = text.lastIndexOf('}'); return JSON.stringify(restoreValue(JSON.parse(text.slice(start, finish + 1)))) }
      catch { return text }
    },
  }
}

// The one place that decides how many output tokens a call may use, so the estimate shown before a run and the
// guard applied to every call agree.
export function outputBudgetForChars(task: string, inputChars: number, base: number, model: string) {
  const inputAllowance = Math.ceil(inputChars / 8)
  const reasoningAllowance = /^gpt-oss(?::|$)/i.test(model) ? 1536 : 0
  const allowance = task === 'bulletScoring' ? Math.min(inputAllowance, 1024) : Math.min(inputAllowance, 4096)
  return Math.min(8192, Math.max(base, 1024) + allowance + reasoningAllowance)
}

export function outputBudget(task: string, request: ModelRequest, base: number, model: string) {
  return outputBudgetForChars(task, request.user.length, base, model)
}

export class TruncatedModelOutput extends Error {
  constructor(readonly budget: number) { super(`Model output exhausted its ${budget}-token budget; partial output was not accepted.`) }
}
