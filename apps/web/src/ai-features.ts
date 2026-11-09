import { useSyncExternalStore } from 'react'
import { api } from './api.js'

// Whether the AI parts (fit check, tailoring, the Résumé page) are in use. One copy shared by every page.
// If it cannot be read, the app behaves as it always did and shows everything.
export type AiFeatures = { chosen: boolean; enabled: boolean; hidden: boolean }
const everything: AiFeatures = { chosen: true, enabled: true, hidden: false }
let state: AiFeatures | null = null
const listeners = new Set<() => void>()
const publish = (next: AiFeatures) => { state = next; listeners.forEach((listener) => listener()) }

export async function loadAiFeatures(): Promise<AiFeatures> {
  try {
    const settings = await api<{ aiFeatures?: AiFeatures }>('/api/settings')
    publish(settings.aiFeatures ?? everything)
  } catch { publish(state ?? everything) }
  return state!
}

export async function setAiFeatures(patch: Partial<AiFeatures>): Promise<AiFeatures> {
  const result = await api<{ aiFeatures: AiFeatures }>('/api/ai-features', { method: 'PUT', body: JSON.stringify(patch) })
  publish(result.aiFeatures)
  return result.aiFeatures
}

export const aiShowing = (features: AiFeatures) => features.enabled && !features.hidden

// features is the saved choice; active is whether AI parts should be on screen right now.
export function useAiFeatures() {
  const features = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => state ?? everything)
  return { features, active: aiShowing(features) }
}
