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
import { fold, normalize } from './text.js'
import { dropLeftovers, operationOf } from './operation.js'

/**
 * Служебные слова сравниваются в сложенной форме — той же, в какой приходит
 * описание. Списки ниже писались латиницей, и «Осуществлен через СБП»
 * пришлось переводить руками; в переводе я и ошибся — «щ» здесь `SCH`, а я
 * написал `SHCH`, — и слово «Осуществлен» стало именем получателя с суммой в
 * двадцать три тысячи. Теперь перевод делает `fold`, тот же самый, через
 * который проходит описание: разойтись они больше не могут.
 */
function folded(words: readonly string[]): Set<string> {
  return new Set(words.map((word) => fold(word).trim()))
}

/** Организационные формы. Выбрасываются целым словом, а не подстрокой. */
const FORMS = folded([
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
const PLACES = folded([
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
const NOISE = folded([
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
  // Хвост карточной операции: «CARD **3523 16AUG RUB 1319.00 Suxofruct».
  // Валюта и «через СБП» стоят в каждой второй строке выписки и именем
  // получателя не являются ни в одном банке.
  'RUB',
  'RUR',
  'USD',
  'EUR',
  'SBP',
  'СБП',
  'ОСУЩЕСТВЛЕН',
  'ЧЕРЕЗ',
  'ПОКУПКИ',
  'КАРТЕ',
  'ПОЛУЧАТЕЛЬ',
  'ОТПРАВИТЕЛЬ',
  'НОМЕРУ',
  'ТЕЛЕФОНА',
])

/**
 * Дата внутри описания: «16AUG», «01JUL». Терминал ставит её в хвост карточной
 * операции, и без этой строки она попадала в ключ получателя — один «Дринкит»
 * рассыпался на семь получателей, по одному на каждый день покупки.
 */
const DATE_TOKEN = /^\d{1,2}[A-Z]{3}$/

/**
 * Ключ получателя: то, по чему одинаковые операции считаются одним и тем же
 * магазином. Числовые хвосты (номер точки) выбрасываются — иначе каждая
 * «Пятёрочка» окажется отдельным получателем.
 */
export function merchantKey(description: string): string {
  return cleanWords(description, true)
}

/**
 * Чистка описания до имени получателя.
 *
 * Отбор всегда идёт по сложенной форме: списки служебных слов записаны
 * латиницей, и «ООО» отсеивается только после перевода в «OOO». А вот наружу
 * может выйти любая из двух форм — `translit` решает какая. Слова при этом
 * идут парами: перевод в латиницу побуквенный, поэтому число слов в обеих
 * формах одинаково, и пара не разъезжается.
 */
function cleanWords(description: string, translit: boolean, fallback?: string): string {
  const rest = operationOf(description).rest
  // Берём остаток после служебного начала: «Оплата в YANDEXGO» — это YANDEXGO,
  // а не «В YANDEXGO». Предлог, оставшийся от «оплата в», не имя получателя.
  const plain = normalize(rest).trim().split(' ')
  const folded = fold(rest).trim().split(' ')

  // Отсев идёт одним проходом по парам: слово выбрасывается сразу из обеих
  // форм. Снимать предлоги отдельным шагом было нельзя — `dropLeftovers`
  // выкидывает их и из середины, и обрезать вторую форму по длине первой
  // значило бы потерять не то слово.
  const kept: string[] = []
  const keptFolded: string[] = []
  folded.forEach((word, i) => {
    if (word === '') return
    if (FORMS.has(word) || PLACES.has(word) || NOISE.has(word)) return
    // Чистые числа и коды вида «5411», «1234» — это номер точки, а не имя.
    if (/^\d+$/.test(word)) return
    if (DATE_TOKEN.test(word)) return
    if (dropLeftovers([word]).length === 0) return
    kept.push(plain[i] ?? word)
    keptFolded.push(word)
  })

  const key = (translit ? keptFolded : kept).join(' ').trim()
  if (key !== '') return key
  // Чистить было нечего. Для ключа это значит «возьми описание целиком»: разные
  // безымянные операции иначе склеятся в одного получателя. Для подписи —
  // наоборот, описание не годится, и вызывающий передаёт сюда пустую строку,
  // чтобы узнать об этом и подставить вид операции.
  if (fallback !== undefined) return fallback
  return (translit ? fold(description) : normalize(description)).trim()
}

/**
 * Подпись, когда чистить было нечего.
 *
 * Бывают описания без имени вовсе: « 10118.00 RUB . Осуществлен через СБП.» —
 * сумма, валюта и способ, больше ничего. Ключ в таком случае берётся из всего
 * описания целиком, иначе разные безымянные операции склеились бы в одного
 * получателя. А вот подписью описание быть не может: в списке источников
 * стояло «10118 00 Rub Осуществлен Через Сбп», и это не имя, а мусор в поле,
 * где ждут имя.
 *
 * Вид операции знает `operation.ts`, и здесь берётся именно он: сказать
 * «Перевод» честнее, чем «Без описания», когда про операцию известно, что это
 * перевод.
 */
function kindLabel(description: string): string {
  switch (operationOf(description).kind) {
    case 'transfer':
      return 'Перевод'
    case 'cash':
      return 'Наличные'
    case 'reward':
      return 'Кэшбэк'
    case 'topup':
      return 'Пополнение'
    case 'saving':
      return 'В копилку'
    case 'fee':
      return 'Комиссия'
    default:
      return 'Без описания'
  }
}

/**
 * Читаемая подпись: `PYATEROCHKA 1234 MOSCOW RU` → `Pyaterochka`.
 *
 * Ключ считается по сложенной форме — с транслитерацией, иначе «пятерочка» не
 * нашла бы «PYATEROCHKA». Но подпись из ключа годится только там, где банк и
 * писал латиницей. «Зарплата за месяц ООО РОГА И КОПЫТА» превращалась в
 * «Zarplata Mesyats Roga I Kopyta» — человек читает такое дважды, прежде чем
 * узнать. Поэтому имя, написанное кириллицей, кириллицей и остаётся: чистится
 * тем же способом, но без перевода в латиницу.
 */
export function merchantLabel(description: string): string {
  if (cleanWords(description, true, '') === '') return kindLabel(description)
  const source = CYRILLIC.test(description)
    ? cleanWords(description, false)
    : merchantKey(description)
  if (source === '') return description
  return source
    .split(' ')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ')
}

const CYRILLIC = /[А-Яа-яЁё]/

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
