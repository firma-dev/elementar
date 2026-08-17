import { useEffect, useState } from 'preact/hooks'
import { bp } from '../tokens.js'
import type { Breakpoint } from '../tokens.js'

function match(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(query).matches
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => match(query))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    setMatches(mql.matches)
    const onChange = (e: MediaQueryListEvent): void => setMatches(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** true, если ширина окна ≥ брейкпоинта. */
export function useBreakpointUp(name: Breakpoint): boolean {
  return useMediaQuery(`(min-width: ${bp[name]}px)`)
}
