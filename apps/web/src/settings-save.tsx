import { createContext, useContext, useEffect, useRef } from 'react'

// Sections of the Settings page that save to their own place (follow-up days, the feed file) hand their pending
// change to the page, so one save bar saves everything and discards everything.
export type SaveSection = { save: () => Promise<void>; discard: () => void }
export const SaveRegistry = createContext<(key: string, section: SaveSection | null) => void>(() => {})

// Sections that bring back an unsaved edit tell the page, which says so once.
export const RestoreAnnouncer = createContext<() => void>(() => {})

export function useSaveSection(key: string, dirty: boolean, save: () => Promise<void>, discard: () => void) {
  const register = useContext(SaveRegistry)
  const latest = useRef({ save, discard })
  latest.current = { save, discard }
  useEffect(() => {
    register(key, dirty ? { save: () => latest.current.save(), discard: () => latest.current.discard() } : null)
    return () => register(key, null)
  }, [key, dirty])
}
