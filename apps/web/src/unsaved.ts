import { useEffect } from 'react'

// Unsaved edits live here, outside the page component, so leaving a page and coming back
// does not lose them. A draft only applies to the saved version it was started from.
const drafts = new Map<string, { base: string | null; value: unknown }>()

export function readDraft<T>(key: string, base: string | null): T | null {
  const draft = drafts.get(key)
  if (!draft) return null
  if (draft.base !== base) { drafts.delete(key); return null }
  return draft.value as T
}

// Keeps the draft in step with the page and asks the browser to confirm before the tab closes.
export function useDraft(key: string, base: string | null, value: unknown, dirty: boolean, ready: boolean) {
  useEffect(() => {
    if (!ready) return
    if (dirty) drafts.set(key, { base, value })
    else drafts.delete(key)
  }, [key, base, value, dirty, ready])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
}
