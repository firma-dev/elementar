/** Побочные действия шаринга: буфер, navigator.share, скачивание файла-ключа. */

export type ShareOutcome = 'shared' | 'copied' | 'failed'

function nav(): Navigator | null {
  // navigator.share есть не везде: тип его знает, рантайм — нет
  return typeof navigator === 'undefined' ? null : navigator
}

export function canShare(): boolean {
  const n = nav()
  return n !== null && typeof n.share === 'function'
}

export async function copyText(text: string): Promise<boolean> {
  const n = nav()
  if (n?.clipboard !== undefined) {
    try {
      await n.clipboard.writeText(text)
      return true
    } catch {
      // ниже — запасной путь через скрытое поле
    }
  }
  if (typeof document === 'undefined') return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(area)
  return ok
}

/** Сначала системный «поделиться», при отказе — буфер обмена. */
export async function shareLink(a: { url: string; title?: string; text?: string }): Promise<ShareOutcome> {
  const n = nav()
  if (n !== null && typeof n.share === 'function') {
    try {
      await n.share({
        url: a.url,
        ...(a.title !== undefined ? { title: a.title } : {}),
        ...(a.text !== undefined ? { text: a.text } : {}),
      })
      return 'shared'
    } catch (e) {
      // Отмена в системном листе — не ошибка, второй раз копировать не надо
      if (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError') {
        return 'failed'
      }
    }
  }
  return (await copyText(a.url)) ? 'copied' : 'failed'
}

export function downloadFile(filename: string, body: string, mime = 'text/plain;charset=utf-8'): boolean {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return false
  const blob = new Blob([body], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Отзыв в микрозадаче: Safari не успевает начать скачивание при мгновенном revoke
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}

export function readFileText(file: File): Promise<string> {
  return file.text()
}
