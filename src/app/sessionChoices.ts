import { useState } from 'react'

/** Whether `i` indexes a list of `n` choices. */
export const isIndex = (i: unknown, n: number): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < n

/**
 * A dialog's choices, kept for the browser session under `key` (per-tab convenience only): `read`
 * makes valid choices of whatever was stored ({} when nothing was), and `choose` changes some.
 */
export function useSessionChoices<T extends object>(key: string, read: (stored: Record<string, unknown>) => T): [T, (change: Partial<T>) => void] {
  const [choices, setChoices] = useState(() => {
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(key) ?? '{}')
      return read(stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {})
    } catch {
      return read({})
    }
  })
  const choose = (change: Partial<T>) =>
    setChoices((c) => {
      const next = { ...c, ...change }
      try {
        sessionStorage.setItem(key, JSON.stringify(next))
      } catch {
        // per-tab convenience only
      }
      return next
    })
  return [choices, choose]
}
