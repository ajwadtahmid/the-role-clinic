import { api } from './api.js'

// Turns the job feed on or off. Off stops imports and hides the feed's undecided jobs; nothing is deleted.
export function setFeedEnabled(enabled: boolean) {
  return api<{ enabled: boolean; fileFound: boolean; configured: boolean }>('/api/feed/enabled', { method: 'PUT', body: JSON.stringify({ enabled }) })
}
