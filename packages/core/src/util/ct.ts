/** Сравнения за постоянное время: секреты и хеши сравниваем только этим. */

export function ctEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number)
  return d === 0
}

/** Строки сравниваются по кодам символов; длина утекает, содержимое — нет. */
export function ctEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
