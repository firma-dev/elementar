/**
 * Разбор описания операции. Банк отдаёт мерчанта в том виде, в каком его
 * прислал терминал: `OOO ROGA I KOPYTA 1234 MOSCOW RUS`. Это норма входных
 * данных (ТЗ §2 п.2), но читать выписку в таком виде нельзя.
 *
 * Два применения: подпись в списке операций и разбор «Прочего» — там одинаковые
 * получатели собираются в одну строку, и категория ставится получателю, а не
 * каждой операции по отдельности.
 */
import type { Categorized, Category } from './model.js'
import { fold } from './text.js'
import { dropLeftovers, operationOf } from './operation.js'

/** Организационные формы. Выбрасываются целым словом, а не подстрокой. */
const FORMS = new Set([
  'ООО',
  'ОАО',
  'ЗАО',
  'ПАО',
  'АО',
  'ИП',
  'НКО',
  'ТСЖ',
  'ФГУП',
  'МУП',
  'ГБУ',
  'АНО',
  'OOO',
  'OAO',
  'ZAO',
  'PAO',
  'AO',
  'IP',
  'LLC',
  'LTD',
  'INC',
  'GMBH',
  'PLC',
  'CO',
])

/** Города и страны, которые терминал дописывает к имени. */
const PLACES = new Set([
  'MOSCOW',
  'MOSKVA',
  'MOSKOW',
  'MSK',
  'МОСКВА',
  'SPB',
  'ST',
  'PETERSBURG',
  'PETERBURG',
  'SANKT',
  'САНКТ',
  'ПЕТЕРБУРГ',
  'EKATERINBURG',
  'EKB',
  'NOVOSIBIRSK',
  'KAZAN',
  'SOCHI',
  'KRASNODAR',
  'PERM',
  'SAMARA',
  'UFA',
  'OMSK',
  'ROSTOV',
  'RUS',
  'RU',
  'RUSSIA',
  'РОССИЯ',
  'G',
  'Г',
  'GOROD',
  'MYTISCHI',
  'KHOTKOVO',
  'PUSHKINO',
  'PETERBU',
  'SANKTPETERBURG',
  'PODOLSK',
  'KHIMKI',
  'BALASHIKHA',
  'LYUBERTSY',
  'ODINTSOVO',
  'KRASNOGORSK',
  'MSKVA',
])

/**
 * Технические слова платёжной сети: к имени получателя отношения не имеют.
 *
 * Отдельно про БИК, ИНН и КПП: банк дописывает их к некоторым платежам вместе
 * с номерами. Без чистки один и тот же получатель распадается на два ключа —
 * «PLATIPOMIRU» и «PLATIPOMIRU BIK INN KPP», — и в разборе непонятного он
 * занимает две строки вместо одной.
 */
const NOISE = new Set([
  'SBP',
  'СБП',
  'TERMINAL',
  'ТЕРМИНАЛ',
  'POS',
  'RETAIL',
  'CARD',
  'КАРТА',
  'PAYMENT',
  'PAY',
  'ОПЛАТА',
  'OPLATA',
  'PURCHASE',
  'POKUPKA',
  'ПОКУПКА',
  'MERCHANT',
  'SERVICE',
  'SERVICES',
  'SHOP',
  'STORE',
  'MARKET',
  'SUPERMARKET',
  'ONLINE',
  'INTERNET',
  'WWW',
  'COM',
  'RU2',
  'NDS',
  'НДС',
  'CH',
  'PAYME',
  'BIK',
  'INN',
  'KPP',
  'RS',
  'KS',
  'SCHET',
  'DOGOVOR',
])

/**
 * Ключ получателя: то, по чему одинаковые операции считаются одним и тем же
 * магазином. Числовые хвосты (номер точки) выбрасываются — иначе каждая
 * «Пятёрочка» окажется отдельным получателем.
 */
export function merchantKey(description: string): string {
  // Берём остаток после служебного начала: «Оплата в YANDEXGO» — это YANDEXGO,
  // а не «В YANDEXGO». Предлог, оставшийся от «оплата в», не имя получателя.
  const words = fold(operationOf(description).rest)
    .trim()
    .split(' ')
    .filter((word) => word !== '')
    .filter((word) => !FORMS.has(word))
    .filter((word) => !PLACES.has(word))
    .filter((word) => !NOISE.has(word))
    // Чистые числа и коды вида «5411», «1234» — это номер точки, а не имя.
    .filter((word) => !/^\d+$/.test(word))

  const key = dropLeftovers(words).join(' ').trim()
  // Если после чистки не осталось ничего — значит имя и было техническим:
  // возвращаем исходное сложенное описание, чтобы не склеить всё подряд.
  return key === '' ? fold(description).trim() : key
}

/** Читаемая подпись: `PYATEROCHKA 1234 MOSCOW RU` → `Pyaterochka`. */
export function merchantLabel(description: string): string {
  const key = merchantKey(description)
  if (key === '') return description
  return key
    .split(' ')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ')
}

/** Получатель, собранный из нескольких операций. */
export interface MerchantGroup {
  key: string
  label: string
  /** Описание последней операции — по нему человек узнаёт получателя. */
  sample: string
  total: number
  count: number
  category: Category
}

/**
 * Одинаковые получатели в одну строку, по убыванию суммы. Считаются только
 * траты: приход и переезды денег в разбор «Прочего» не идут.
 */
export function groupByMerchant(rows: readonly Categorized[]): MerchantGroup[] {
  const map = new Map<string, MerchantGroup>()
  for (const tx of rows) {
    if (tx.amount >= 0) continue
    const key = merchantKey(tx.description)
    const found = map.get(key)
    if (found === undefined) {
      map.set(key, {
        key,
        label: merchantLabel(tx.description),
        sample: tx.description,
        total: -tx.amount,
        count: 1,
        category: tx.category,
      })
    } else {
      found.total -= tx.amount
      found.count += 1
    }
  }
  return [...map.values()].sort((a, b) => b.total - a.total)
}

/**
 * Подсказка по уже сделанным правкам.
 *
 * Человек назвал «VV_9688» продуктами — почти наверняка «VV_6939_KCO» тоже
 * продукты. Терминалы одной сети отличаются номером, а имя остаётся общим.
 *
 * Это именно подсказка, а не автоматическое действие. Угаданная категория
 * выглядит так же правдоподобно, как верная, и один раз это уже стоило
 * четверти годовых трат (Д-018): решение остаётся за человеком.
 *
 * Совпадением считается общее слово от четырёх букв. Короче — совпадают
 * случайно; целиком — это не подсказка, а тот же самый ключ.
 */
export function suggestCategory(
  key: string,
  named: Readonly<Record<string, Category>>,
): { category: Category; from: string } | null {
  const words = new Set(key.split(' ').filter((w) => w.length >= 4))
  if (words.size === 0) return null
  for (const [known, category] of Object.entries(named)) {
    if (known === key) continue
    for (const word of known.split(' ')) {
      if (word.length >= 4 && words.has(word)) return { category, from: known }
    }
  }
  return null
}
