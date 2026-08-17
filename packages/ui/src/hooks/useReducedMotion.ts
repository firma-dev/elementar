import { useMediaQuery } from './useMediaQuery.js'

/** reduce не отключает обратную связь, а сжимает её (§11.6). */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)')
}
