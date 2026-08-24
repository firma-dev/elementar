/**
 * Модель финансера. Плоские записи, никакой вложенности: то же правило, что у
 * документа Элементара (`ARCHITECTURE.md` §3.1), хотя документа здесь нет —
 * финансер v0 живёт целиком в браузере (Д-012).
 */
import type { Kopeck } from './money.js'

/** Категории. Порядок задаёт порядок в списках и не меняется без нужды. */
export const CATEGORIES = [
  'Продукты',
  'Кафе и рестораны',
  'Транспорт',
  'Такси',
  'Автомобиль',
  'Жильё и ЖКХ',
  'Связь и интернет',
  'Подписки',
  'Здоровье',
  'Красота',
  'Одежда',
  'Дом и техника',
  'Маркетплейсы',
  'Дети',
  'Питомцы',
  'Развлечения',
  'Алкоголь',
  'Образование',
  'Путешествия',
  'Подарки',
  'Переводы',
  'Наличные',
  'Налоги и штрафы',
  'Кредиты',
  'Доход',
  'Прочее',
] as const

export type Category = (typeof CATEGORIES)[number]

/** Куда попадает всё, что не опознано (ТЗ §2 п.3). */
export const OTHER: Category = 'Прочее'

/** Куда попадает приход. Отдельная категория, а не расходная с плюсом. */
export const INCOME: Category = 'Доход'

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value)
}

/** Одна операция выписки. */
export interface Tx {
  /**
   * Устойчивый идентификатор: считается из даты, суммы и описания, а не из
   * номера строки. Человек грузит выписку заново — ручные правки категорий
   * должны пережить перезагрузку, поэтому ключ не может зависеть от порядка.
   */
  id: string
  /** Дата операции, ISO `ГГГГ-ММ-ДД`. Времени нет: в картине года оно не нужно. */
  date: string
  /** Копейки. Расход отрицательный, приход положительный. */
  amount: Kopeck
  /** Описание из выписки как есть, включая «OOO ROGA I KOPYTA». */
  description: string
  /** Код категории мерчанта, если банк его дал. */
  mcc: string | null
  /** Категория, проставленная банком. Используется как подсказка, не как истина. */
  bankCategory: string | null
}

/** Операция с уже назначенной категорией. */
export interface Categorized extends Tx {
  category: Category
  /**
   * Откуда взялась категория. Порядок перечисления — порядок применения:
   * рука на операции, рука на получателе, вид операции, словарь, MCC,
   * столбец банка, ничего.
   */
  source: 'manual' | 'merchant' | 'operation' | 'rule' | 'mcc' | 'bank' | 'fallback'
}

/** Месяц как `ГГГГ-ММ`: ключ группировки в картине года. */
export type MonthKey = string

export function monthOf(date: string): MonthKey {
  return date.slice(0, 7)
}

const MONTH_NAMES = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
] as const

const MONTH_SHORT = [
  'янв',
  'фев',
  'мар',
  'апр',
  'май',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
] as const

/** «2025-03» → «март 2025». Без Intl: локаль устройства не должна влиять на подписи. */
export function monthLabel(key: MonthKey, short = false): string {
  const [year, month] = key.split('-')
  const index = Number(month) - 1
  const names = short ? MONTH_SHORT : MONTH_NAMES
  const name = names[index] ?? month ?? ''
  return `${name} ${year ?? ''}`.trim()
}

/** «2025-03» → «мар». Только имя, без года: подпись под столбиком графика. */
export function monthShort(key: MonthKey): string {
  const index = Number(key.slice(5, 7)) - 1
  return MONTH_SHORT[index] ?? key.slice(5, 7)
}

/** «2025-03-17» → «17 марта». Родительный падеж для строк списка. */
const MONTH_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const

export function dayLabel(date: string): string {
  const [, month, day] = date.split('-')
  const index = Number(month) - 1
  return `${Number(day)} ${MONTH_GENITIVE[index] ?? ''}`.trim()
}

/**
 * FNV-1a, 32 бита. Криптографии здесь не нужно: идентификатор нужен только чтобы
 * ручная правка нашла свою строку после перезагрузки выписки.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Идентификатор операции. Одинаковые операции в один день (две поездки по 300 ₽)
 * различаются порядковым номером дубля — он же переживает перезагрузку, если
 * порядок строк в выписке не изменился.
 */
export function txId(
  date: string,
  amount: Kopeck,
  description: string,
  duplicate: number,
  statement = '',
): string {
  const body = fnv1a(`${date}|${amount}|${description}`)
  const tail = duplicate === 0 ? '' : `-${duplicate}`
  return statement === '' ? `${body}${tail}` : `${statement}:${body}${tail}`
}

/**
 * Ключ выписки. Нужен, когда человек грузит несколько счетов сразу.
 *
 * Без него две одинаковые покупки кофе с дебетовой и с кредитной карты имеют
 * один и тот же идентификатор, и вторая молча исчезает при склейке — то есть
 * пропадают деньги. С ключом они различаются, а повторная загрузка того же
 * файла по-прежнему даёт те же идентификаторы и не плодит дублей: ключ считан
 * из содержимого, а не из времени загрузки.
 */
export function statementKey(from: string, to: string, count: number): string {
  return fnv1a(`${from}|${to}|${count}`)
}
