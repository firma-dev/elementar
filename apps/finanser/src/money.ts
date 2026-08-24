/**
 * Деньги — целые числа в копейках (ТЗ §1). Ни одной операции во float: разбор
 * строки идёт по цифрам, а не через parseFloat, потому что 0.1 + 0.2 в рублях
 * даёт копейку расхождения на тысяче строк выписки.
 */

/** Сумма в копейках. Отрицательная — расход, положительная — приход. */
export type Kopeck = number

/** Пробелы, которыми банки разделяют разряды: обычный, неразрывный, узкий. */
const SPACES = /[\s   ]/g

/** Минусы, которые встречаются в выгрузках: дефис, минус, тире, длинное тире. */
const MINUSES = /^[-−–—]/

/**
 * Разбор денежной строки в копейки. Понимает «-1 234,50», «1234.5», «+1 234»,
 * «(1 234,50)» (скобки = минус), «1 234,50 ₽». Возвращает null, если числа нет.
 */
export function parseAmount(raw: string): Kopeck | null {
  let s = raw.replace(SPACES, '')
  if (s === '') return null

  let negative = false
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true
    s = s.slice(1, -1)
  }
  if (MINUSES.test(s)) {
    negative = true
    s = s.slice(1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  }

  // Валюта и прочий хвост отбрасываются: считаем только цифры и разделители.
  s = s.replace(/[^\d.,]/g, '')
  if (s === '') return null

  const sep = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'))
  const tail = sep === -1 ? '' : s.slice(sep + 1)

  // Разделитель дробной части — последний из «,» и «.». Одна или две цифры за
  // ним — копейки: «1.23». Ровно три — группа тысяч: «1.234» это 1234 рубля.
  //
  // Четыре и больше — снова копейки, и это не редкость: валютные и
  // инвестиционные строки банки отдают с четырьмя знаками, выгрузки из 1С тоже.
  // Группой тысяч такой хвост быть не может — в группе всегда ровно три цифры.
  // Без этой ветки «1 234,5678» читалось как 12 345 678 ₽ вместо 1 234,57 ₽:
  // ошибка в десять тысяч раз, заметная только глазами.
  const digitTail = sep !== -1 && /^\d+$/.test(tail)
  const headDigits = sep === -1 ? '' : s.slice(0, sep).replace(/[.,]/g, '')
  // Ровно три цифры — обычно группа тысяч, но не после голого нуля: «0,455» это
  // сорок шесть копеек, а не четыреста пятьдесят пять рублей. Ноль не бывает
  // старшей группой разряда.
  const thousandsGroup = tail.length === 3 && headDigits !== '' && headDigits !== '0'
  const fractional = digitTail && !thousandsGroup
  const intPart = fractional ? s.slice(0, sep) : s
  const fracPart = fractional ? tail : ''

  const digits = intPart.replace(/[.,]/g, '')
  if (digits === '' && fracPart === '') return null

  const rub = digits === '' ? 0 : Number(digits)
  if (!Number.isFinite(rub)) return null

  // Хвост длиннее двух знаков округляем до копейки, а не отбрасываем: 0,455
  // это 46 копеек, а не 45. Округление вверх по половине — то же правило, что
  // у банка в выписке.
  const kop =
    fracPart === '' ? 0 : Math.round(Number(`0.${fracPart}`) * 100)
  if (!Number.isFinite(kop)) return null

  const value = rub * 100 + kop
  // За пределом точности целых чисел арифметика перестаёт быть целочисленной, и
  // дальше каждая сумма — приблизительная. Лучше «не число», чем тихая ложь.
  if (!Number.isSafeInteger(value)) return null
  return negative ? -value : value
}

/** Разряды пробелами: 1234567 → «1 234 567». Пробел неразрывный: число не рвётся. */
function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

export interface FormatOptions {
  /** Копейки: «auto» — только когда они не нули; «always»; «never» — округление до рубля. */
  kopecks?: 'auto' | 'always' | 'never'
  /** Показывать «+» у прихода. Минус у расхода показывается всегда. */
  plus?: boolean
  /** Отбросить знак совсем: для колонок, где направление задано столбцом. */
  abs?: boolean
}

/**
 * Копейки → строка без знака валюты. Рубль ставится отдельным компонентом (Д-013),
 * потому что глифа `₽` нет ни в одном из двух шрифтов канона.
 */
export function formatAmount(value: Kopeck, options: FormatOptions = {}): string {
  const { kopecks = 'auto', plus = false, abs = false } = options
  const negative = value < 0 && !abs
  const total = Math.abs(Math.round(value))

  const showKopecks = kopecks === 'always' || (kopecks === 'auto' && total % 100 !== 0)
  const rub = showKopecks ? Math.trunc(total / 100) : Math.round(total / 100)
  const kop = total % 100

  const body = showKopecks
    ? `${groupDigits(String(rub))},${String(kop).padStart(2, '0')}`
    : groupDigits(String(rub))

  if (negative) return `−${body}`
  if (plus && value > 0) return `+${body}`
  return body
}

/** Доля в процентах: одна значащая после запятой, пока доля меньше десяти. */
export function formatShare(part: Kopeck, whole: Kopeck): string {
  if (whole === 0) return '0'
  const pct = (Math.abs(part) / Math.abs(whole)) * 100
  return pct < 10 ? pct.toFixed(1).replace('.', ',') : String(Math.round(pct))
}
