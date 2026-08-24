/**
 * Наличные.
 *
 * Сняли восемь тысяч в банкомате — и дальше они невидимы: в выписке одна
 * строка «Наличные» вместо продуктов, такси и кофе. Это не мелочь: у людей,
 * которые снимают, так исчезает от пяти до пятнадцати процентов трат, и
 * картина года врёт ровно на эту долю, ничего об этом не сообщая.
 *
 * Банк тут не поможет — он и сам не знает, куда ушли купюры. Знает только
 * человек. Значит, единственный честный способ — дать ему разложить снятие
 * самому, и сделать это дёшево: одно снятие, несколько сумм, готово.
 *
 * Разложенное хранится отдельно от операций и не меняет их: выписка остаётся
 * тем, что сказал банк. Разбивка — это то, что сказал человек, и она наложена
 * поверх, как и правки категорий.
 */
import type { Categorized, Category } from './model.js'
import type { Kopeck } from './money.js'

/** Одна доля снятия: сколько и на что. */
export interface CashPart {
  category: Category
  amount: Kopeck
}

/** Разбивки снятий: идентификатор операции → доли. */
export type CashSplits = Readonly<Record<string, readonly CashPart[]>>

/** Сколько из снятия уже разложено. */
export function splitTotal(parts: readonly CashPart[]): Kopeck {
  return parts.reduce((sum, part) => sum + Math.abs(part.amount), 0) as Kopeck
}

/**
 * Сколько осталось разложить. Ноль — снятие разобрано целиком.
 *
 * Может уйти в минус, если человек написал больше, чем снял: это его ошибка, и
 * показать её надо, а не подрезать молча до нуля.
 */
export function splitLeft(withdrawal: Kopeck, parts: readonly CashPart[]): Kopeck {
  return (Math.abs(withdrawal) - splitTotal(parts)) as Kopeck
}

/**
 * Проверить долю перед записью. Пустые и нулевые доли не хранятся: строка «0 ₽
 * на продукты» — это не сведение, а мусор, который потом надо объяснять.
 */
export function cleanParts(parts: readonly CashPart[]): CashPart[] {
  return parts
    .filter((part) => Math.abs(part.amount) > 0)
    .map((part) => ({ category: part.category, amount: Math.abs(part.amount) as Kopeck }))
}

/**
 * Развернуть разложенные снятия в траты.
 *
 * Само снятие остаётся переездом денег и не трогается: банк сказал правду — со
 * счёта ушли восемь тысяч. Доли добавляются отдельными строками с планом
 * «трата»: купюры потратили, и это второе событие, а не то же самое.
 * Двойного счёта здесь нет ровно потому, что снятие тратой не считается
 * (Д-015).
 *
 * Источник у долей — `manual`: их назвал человек, и никакое правило не должно
 * их перебивать.
 */
export function expandCash(rows: readonly Categorized[], splits: CashSplits): Categorized[] {
  const extra: Categorized[] = []
  for (const tx of rows) {
    const parts = splits[tx.id]
    if (parts === undefined || parts.length === 0) continue
    // Разбивка живёт, пока операция остаётся снятием. Стоит человеку назвать
    // само снятие тратой — «Продукты», например, — и оно перестаёт быть
    // переездом денег: восемь тысяч считаются тратой сами по себе, а доли
    // добавляли к ним ещё восемь. Шестнадцать тысяч трат из восьми снятых.
    //
    // Разбивку при этом не выбрасываем: вернул категорию «Наличные» — доли на
    // месте. Забыть работу человека молча хуже, чем временно её не показать.
    if (tx.category !== 'Наличные') continue
    parts.forEach((part, i) => {
      extra.push({
        ...tx,
        id: `${tx.id}#${i}`,
        amount: -Math.abs(part.amount) as Kopeck,
        description: `Наличные · ${part.category}`,
        mcc: null,
        bankCategory: null,
        category: part.category,
        source: 'manual',
      })
    })
  }
  if (extra.length === 0) return rows as Categorized[]
  return [...rows, ...extra].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

/** Снятия наличных: то, что можно разложить. */
export function withdrawals(rows: readonly Categorized[]): Categorized[] {
  return rows.filter((tx) => tx.category === 'Наличные' && tx.amount < 0 && !tx.id.includes('#'))
}
