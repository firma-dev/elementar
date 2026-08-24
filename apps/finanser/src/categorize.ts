/**
 * Категоризация. Порядок источников зафиксирован и не меняется по настроению:
 *
 *   1. рука человека на этой операции — правка всегда сильнее машины (ТЗ §2 п.3);
 *   2. рука человека на получателе — одна правка на всю «Пятёрочку» за год;
 *   3. вид операции по служебному началу описания — это знание банка о своей же
 *      операции, и оно точнее словаря;
 *   4. словарь правил по имени получателя;
 *   5. код мерчанта MCC — независимое свидетельство платёжной сети;
 *   6. столбец «Категория» самой выписки;
 *   7. «Прочее».
 *
 * Шаги 5 и 6 сверх ТЗ и добавлены сознательно: оба приезжают в том же файле,
 * наружу за ними ходить не надо, а без них «Прочее» съедает половину года.
 *
 * Почему вид операции стоит выше словаря: иначе «внешний перевод по номеру
 * телефона» попадает в «Связь и интернет» по слову «телефон». На настоящей
 * выписке это было сорок шесть операций и четверть годовых трат — и цифра
 * выглядела правдоподобно, поэтому ошибку никто бы не заметил.
 */
import type { Category, Categorized, Tx } from './model.js'
import { INCOME, OTHER, PARENT, collapse, isCategory } from './model.js'
import { KEYWORD_INDEX } from './rules.js'
import { fold, normalize } from './text.js'
import { merchantKey } from './merchant.js'
import { operationOf } from './operation.js'
import { byMcc } from './mcc.js'

export { normalize }

/** Категория по словарю правил. null — ни одно слово не подошло. */
export function byRules(description: string): Category | null {
  const haystack = fold(description)
  for (const [keyword, category] of KEYWORD_INDEX) {
    if (haystack.includes(keyword)) return category
  }
  return null
}

/**
 * Категории банка → наши. Не полный справочник, а те названия, что
 * реально встречаются в выписке; всё остальное падает дальше, в «Прочее».
 */
const BANK_MAP: Readonly<Record<string, Category>> = {
  СУПЕРМАРКЕТЫ: 'Продукты',
  ПРОДУКТЫ: 'Продукты',
  РЕСТОРАНЫ: 'Кафе и рестораны',
  ФАСТФУД: 'Кафе и рестораны',
  КАФЕ: 'Кафе и рестораны',
  ТРАНСПОРТ: 'Транспорт',
  КАРШЕРИНГ: 'Транспорт',
  'Ж Д БИЛЕТЫ': 'Транспорт',
  ТАКСИ: 'Такси',
  ТОПЛИВО: 'Автомобиль',
  АВТОУСЛУГИ: 'Автомобиль',
  АВТОМОБИЛЬ: 'Автомобиль',
  ДОМ: 'Жильё и ЖКХ',
  'ДОМ И РЕМОНТ': 'Дом и техника',
  'КОММУНАЛЬНЫЕ ПЛАТЕЖИ': 'Жильё и ЖКХ',
  СВЯЗЬ: 'Связь и подписки',
  ИНТЕРНЕТ: 'Связь и подписки',
  'DIGITAL ТОВАРЫ': 'Подписки',
  МУЗЫКА: 'Подписки',
  АПТЕКИ: 'Здоровье',
  'МЕДИЦИНСКИЕ УСЛУГИ': 'Здоровье',
  МЕДИЦИНА: 'Здоровье',
  КРАСОТА: 'Красота',
  'ОДЕЖДА И ОБУВЬ': 'Одежда',
  СПОРТТОВАРЫ: 'Одежда',
  'РАЗЛИЧНЫЕ ТОВАРЫ': 'Дом и техника',
  ТЕХНИКА: 'Дом и техника',
  'ДЕТСКИЕ ТОВАРЫ': 'Дети',
  ЖИВОТНЫЕ: 'Питомцы',
  РАЗВЛЕЧЕНИЯ: 'Развлечения',
  КИНО: 'Развлечения',
  ИГРЫ: 'Развлечения',
  СПОРТ: 'Развлечения',
  ИСКУССТВО: 'Развлечения',
  КНИГИ: 'Образование',
  ОБРАЗОВАНИЕ: 'Образование',
  АВИАБИЛЕТЫ: 'Путешествия',
  ОТЕЛИ: 'Путешествия',
  ПУТЕШЕСТВИЯ: 'Путешествия',
  ЦВЕТЫ: 'Подарки',
  СУВЕНИРЫ: 'Подарки',
  ПЕРЕВОДЫ: 'Переводы',
  'ПЕРЕВОДЫ ВЫВОД': 'Переводы',
  НАЛИЧНЫЕ: 'Наличные',
  ШТРАФЫ: 'Налоги и штрафы',
  ГОСУСЛУГИ: 'Налоги и штрафы',
  НАЛОГИ: 'Налоги и штрафы',
  'ФИНАНСОВЫЕ УСЛУГИ': 'Кредиты',
  'УСЛУГИ БАНКА': 'Кредиты',
  ПОПОЛНЕНИЯ: 'Доход',
  ЗАРПЛАТА: 'Доход',
}

/** Категория по столбцу выписки. null — банк ничего не сказал или сказал непонятное. */
export function byBank(bankCategory: string | null): Category | null {
  if (bankCategory === null) return null
  const key = normalize(bankCategory).trim()
  if (key === '' || key === 'ДРУГОЕ' || key === 'ОСТАЛЬНОЕ') return null
  return BANK_MAP[key] ?? (isCategory(bankCategory) ? (bankCategory as Category) : null)
}

/** Ручные переопределения: идентификатор операции → категория. */
export type Overrides = Readonly<Record<string, Category>>

/** Ручные переопределения по получателю: ключ мерчанта → категория. */
export type MerchantOverrides = Readonly<Record<string, Category>>

/** Категория одной операции со ссылкой на источник. */
export function categorize(
  tx: Tx,
  overrides: Overrides,
  merchants: MerchantOverrides = {},
): Categorized {
  const manual = overrides[tx.id]
  if (manual !== undefined) return { ...tx, category: manual, source: 'manual' }

  // Правка получателя бьёт всё, что ниже: человек уже сказал, что это за место,
  // и повторять это на каждой из полусотни операций за год он не должен.
  const byMerchant = merchants[merchantKey(tx.description)]
  if (byMerchant !== undefined) return { ...tx, category: byMerchant, source: 'merchant' }

  const operation = operationOf(tx.description)
  if (operation.category !== null) {
    // Кэшбэк и проценты — доход, но только если деньги действительно пришли.
    if (operation.category !== INCOME || tx.amount > 0) {
      return { ...tx, category: operation.category, source: 'operation' }
    }
  }

  // Словарь смотрит на остаток описания, а не на всё целиком: служебное начало
  // («оплата в», «оплата услуг mbank») именем получателя не является.
  const rule = byRules(operation.rest)
  if (rule !== null && (rule !== INCOME || tx.amount > 0)) {
    return { ...tx, category: rule, source: 'rule' }
  }

  const mcc = byMcc(tx.mcc)
  if (mcc !== null) return { ...tx, category: mcc, source: 'mcc' }

  const bank = byBank(tx.bankCategory)
  if (bank !== null && (bank !== INCOME || tx.amount > 0)) {
    return { ...tx, category: bank, source: 'bank' }
  }

  // Приход без опознанного источника — всё равно доход, а не «Прочее»:
  // иначе в картине года приход попадает в расходную кучу.
  if (tx.amount > 0) return { ...tx, category: INCOME, source: 'fallback' }
  return { ...tx, category: OTHER, source: 'fallback' }
}

export function categorizeAll(
  list: readonly Tx[],
  overrides: Overrides,
  merchants: MerchantOverrides = {},
  /**
   * Включённые дополнительные категории. Всё, чего здесь нет, сворачивается в
   * родителя: не включивший «Такси» видит эти деньги в «Транспорте», а не в
   * отдельной строке, которую не просил.
   */
  extras: ReadonlySet<string> = new Set(),
): Categorized[] {
  return list.map((tx) => {
    const done = categorize(tx, overrides, merchants)
    // Сказанное человеком не сворачивается никогда. Он выбрал «Дети» — значит
    // различие ему нужно, и показывать вместо него «Покупки» было бы спором
    // с ним же. Сворачивается только угаданное.
    if (done.source === 'manual' || done.source === 'merchant') return done
    const shown = collapse(done.category, extras)
    return shown === done.category ? done : { ...done, category: shown }
  })
}

/**
 * Сколько операций и денег ждёт за каждой выключенной категорией.
 *
 * Нужно, чтобы предложить включить её не вслепую: «Такси — 47 операций на
 * 16 893» отвечает на вопрос «а есть ли мне разница» до того, как человек
 * нажмёт, а не после.
 */
export function pendingExtras(
  list: readonly Tx[],
  overrides: Overrides,
  merchants: MerchantOverrides = {},
): Map<Category, { count: number; spend: number }> {
  const out = new Map<Category, { count: number; spend: number }>()
  for (const tx of list) {
    const { category } = categorize(tx, overrides, merchants)
    if (PARENT[category] === undefined) continue
    const cell = out.get(category) ?? { count: 0, spend: 0 }
    cell.count += 1
    if (tx.amount < 0) cell.spend -= tx.amount
    out.set(category, cell)
  }
  return out
}
