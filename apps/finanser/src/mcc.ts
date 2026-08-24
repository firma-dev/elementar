/**
 * Код категории мерчанта (MCC) → наша категория.
 *
 * MCC ставит платёжная сеть, а не банк и не магазин: он не зависит от того, как
 * терминал написал имя, и не ломается от опечаток. Поэтому он идёт в разборе
 * сразу после словаря — как второе независимое свидетельство.
 *
 * В сокращённой выписке Т-Банка («Выписки и справки») колонки MCC нет, и слой
 * молчит. В полной выгрузке операций — есть, и тогда он закрывает заметную часть
 * того, что иначе стало бы «Прочим».
 *
 * Таблица неполная сознательно: сюда занесены только диапазоны, в которых мы
 * уверены. Спорный код лучше оставить «Прочим», чем разложить наугад.
 */
import type { Category } from './model.js'

const RANGES: ReadonlyArray<{ from: number; to: number; category: Category }> = [
  { from: 5411, to: 5411, category: 'Продукты' },
  { from: 5412, to: 5412, category: 'Продукты' },
  { from: 5422, to: 5422, category: 'Продукты' },
  { from: 5441, to: 5441, category: 'Продукты' },
  { from: 5451, to: 5451, category: 'Продукты' },
  { from: 5462, to: 5462, category: 'Продукты' },
  { from: 5499, to: 5499, category: 'Продукты' },
  { from: 5811, to: 5814, category: 'Кафе и рестораны' },
  { from: 4111, to: 4112, category: 'Транспорт' },
  { from: 4131, to: 4131, category: 'Транспорт' },
  { from: 4121, to: 4121, category: 'Такси' },
  { from: 4011, to: 4011, category: 'Транспорт' },
  { from: 5541, to: 5542, category: 'Автомобиль' },
  { from: 5511, to: 5533, category: 'Автомобиль' },
  { from: 7523, to: 7523, category: 'Автомобиль' },
  { from: 7531, to: 7549, category: 'Автомобиль' },
  { from: 4900, to: 4900, category: 'Жильё и ЖКХ' },
  { from: 6513, to: 6513, category: 'Жильё и ЖКХ' },
  { from: 4812, to: 4816, category: 'Связь и подписки' },
  { from: 4899, to: 4899, category: 'Связь и подписки' },
  { from: 5912, to: 5912, category: 'Здоровье' },
  { from: 8011, to: 8099, category: 'Здоровье' },
  { from: 5122, to: 5122, category: 'Здоровье' },
  { from: 7230, to: 7230, category: 'Красота' },
  { from: 7297, to: 7298, category: 'Красота' },
  { from: 5977, to: 5977, category: 'Красота' },
  { from: 5611, to: 5699, category: 'Одежда' },
  { from: 5931, to: 5949, category: 'Одежда' },
  { from: 7296, to: 7296, category: 'Одежда' },
  { from: 5200, to: 5261, category: 'Дом и техника' },
  { from: 5262, to: 5262, category: 'Маркетплейсы' },
  { from: 5399, to: 5399, category: 'Маркетплейсы' },
  { from: 5921, to: 5921, category: 'Алкоголь' },
  { from: 5712, to: 5719, category: 'Дом и техника' },
  { from: 5722, to: 5732, category: 'Дом и техника' },
  { from: 5251, to: 5251, category: 'Дом и техника' },
  { from: 5945, to: 5945, category: 'Дети' },
  { from: 8351, to: 8351, category: 'Дети' },
  { from: 742, to: 742, category: 'Питомцы' },
  { from: 5995, to: 5995, category: 'Питомцы' },
  { from: 7832, to: 7841, category: 'Развлечения' },
  { from: 7911, to: 7999, category: 'Развлечения' },
  { from: 7997, to: 7997, category: 'Развлечения' },
  { from: 5815, to: 5818, category: 'Подписки' },
  { from: 8211, to: 8299, category: 'Образование' },
  { from: 5942, to: 5942, category: 'Образование' },
  { from: 3000, to: 3350, category: 'Путешествия' },
  { from: 4511, to: 4511, category: 'Путешествия' },
  { from: 4722, to: 4722, category: 'Путешествия' },
  { from: 7011, to: 7011, category: 'Путешествия' },
  { from: 3501, to: 3999, category: 'Путешествия' },
  { from: 5992, to: 5992, category: 'Подарки' },
  { from: 6010, to: 6012, category: 'Наличные' },
  { from: 4829, to: 4829, category: 'Переводы' },
  { from: 6536, to: 6538, category: 'Переводы' },
  { from: 9211, to: 9399, category: 'Налоги и штрафы' },
  { from: 6051, to: 6051, category: 'Переводы' },
]

/** Категория по MCC. null — кода нет, он мусорный или мы в нём не уверены. */
export function byMcc(mcc: string | null): Category | null {
  if (mcc === null) return null
  const code = Number(mcc.trim())
  if (!Number.isInteger(code) || code <= 0) return null
  for (const range of RANGES) {
    if (code >= range.from && code <= range.to) return range.category
  }
  return null
}
