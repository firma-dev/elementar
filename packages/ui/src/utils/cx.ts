export type ClassValue = string | false | null | undefined

/** Склейка имён классов; false/null/undefined отбрасываются. */
export function cx(...parts: readonly ClassValue[]): string {
  let out = ''
  for (const p of parts) {
    if (!p) continue
    out = out === '' ? p : `${out} ${p}`
  }
  return out
}
