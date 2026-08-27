import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { PEOPLE, dayLabel, isCategory, weekdayLabel } from '../model.js'
import type { Categorized, Category } from '../model.js'
import { merchantKey, merchantLabel } from '../merchant.js'
import { formatShare } from '../money.js'
import { operationOf } from '../operation.js'
import { Amount } from './Amount.js'
import { Pick } from './Pick.js'

export interface TransfersProps {
  rows: readonly Categorized[]
  /** Трата за отрезок — чтобы сказать, какую долю занимают переводы. */
  totalSpend: number
  /** Что предлагать в выборе: основные, включённые дополнительные и «не траты». */
  options: readonly Category[]
  /** Категория человеку: ложится на все его переводы и на будущие выписки. */
  onMerchantCategory: (key: string, category: Category) => void
  /** Категория одному переводу: сильнее, чем поставленная человеку. */
  onCategory: (id: string, category: Category) => void
}

/** Один человек и всё, что ему ушло. */
interface Person {
  key: string
  label: string
  total: number
  rows: Categorized[]
  /** Общая категория, если она у всех переводов одна. Иначе null. */
  common: Category | null
}

/** «пт, 21 августа, 22:48» — то, по чему перевод вспоминается. */
function when(tx: Categorized): string {
  const day = `${weekdayLabel(tx.date)}, ${dayLabel(tx.date)}`
  return tx.time === null ? day : `${day}, ${tx.time}`
}

/** Сколько человек показываем сразу. Дальше — по требованию. */
const PAGE = 8

/**
 * Переводы людям среди операций.
 *
 * Отбор по виду операции, а не по нынешней категории: названный перевод
 * остаётся переводом, и убирать его из разбора значило бы прятать сделанный
 * выбор от того, кто его сделал.
 *
 * Вынесено из компонента наружу, потому что об этом спрашивает и разметка
 * страницы: блок рисуется рамкой и тенью, и когда переводов нет, пустая
 * коробка остаётся на экране. Компонент, вернувший `null`, её не убирает —
 * решать должен тот, кто эту коробку ставит.
 */
export function sentToPeople(rows: readonly Categorized[]): Categorized[] {
  return rows.filter((tx) => tx.amount < 0 && operationOf(tx.description).category === PEOPLE)
}

/**
 * Кому вы переводите.
 *
 * Отдельным блоком под расходами, а не строкой среди категорий, потому что это
 * не категория. За аренду, за пиво и жене на продукты банк называет одним
 * словом «перевод»: в описании только номер телефона и имя, и что это была за
 * трата, знает лишь человек. На настоящей выписке такой строкой оказались три
 * четверти всех трат — самая крупная статья расходов не говорила о них ничего.
 *
 * Разбор идёт по людям, а не по операциям: арендодателю переводят каждый месяц
 * одно и то же, и назвать это один раз должно хватить навсегда. Но одному
 * человеку переводят и за разное — жене на продукты в среду и ей же на подарок
 * в пятницу, — поэтому строка раскрывается, и внутри у каждого перевода свой
 * выбор. Поставленное переводу сильнее поставленного человеку: это правило
 * порядка источников (`categorize.ts`), а не отдельная договорённость.
 *
 * В списке остаются и уже названные: раздел отвечает на вопрос «кому я
 * перевожу», а не «что осталось разобрать». Пропав из списка после первого же
 * выбора, человек унёс бы с собой и возможность передумать.
 */
export function Transfers({
  rows,
  totalSpend,
  options,
  onMerchantCategory,
  onCategory,
}: TransfersProps): JSX.Element | null {
  const [limit, setLimit] = useState(PAGE)
  const [open, setOpen] = useState<string | null>(null)

  // Отбор по виду операции, а не по нынешней категории: названный перевод
  // остаётся переводом, и убирать его из разбора значило бы прятать сделанный
  // выбор от того, кто его сделал.
  const sent = rows.filter((tx) => tx.amount < 0 && operationOf(tx.description).category === PEOPLE)
  if (sent.length === 0) return null

  const map = new Map<string, Person>()
  for (const tx of sent) {
    const key = merchantKey(tx.description)
    const found = map.get(key)
    if (found === undefined) {
      map.set(key, {
        key,
        label: merchantLabel(tx.description),
        total: -tx.amount,
        rows: [tx],
        common: tx.category,
      })
    } else {
      found.total -= tx.amount
      found.rows.push(tx)
      if (found.common !== tx.category) found.common = null
    }
  }

  const people = [...map.values()].sort((a, b) => b.total - a.total)
  const shown = people.slice(0, limit)
  const tail = people.slice(limit)
  const tailSum = tail.reduce((sum, p) => sum + p.total, 0)
  const sum = people.reduce((s, p) => s + p.total, 0)
  // Сколько ещё не названо — по переводам, а не по людям. По людям считать
  // нельзя: человек, у которого один перевод назван, а двадцать три нет,
  // «названным» не становится, но и в «неназванные» целиком не попадает.
  const left = sent.filter((tx) => tx.category === PEOPLE).reduce((s, tx) => s - tx.amount, 0)

  return (
    <>
      <h2 class="f-block__title">
        Кому вы переводите
        <span class="f-tr__share">
          {formatShare(sum, totalSpend)}% трат
          {left === 0 ? null : (
            <>
              {' · '}
              <Amount value={left} kopecks="never" /> без имени
            </>
          )}
        </span>
      </h2>

      <p class="f-note">
        Банк называет одним словом «перевод» и аренду, и пиво, и деньги жене на продукты — в
        описании только имя получателя. Категория, поставленная человеку, ложится на все его
        переводы и на будущие выписки. Если одному и тому же человеку вы переводите за разное —
        раскройте строку и назовите отдельный перевод.
      </p>

      <ul class="f-unknown__list" role="list">
        {shown.map((person) => {
          const opened = open === person.key
          // Переводы приходят в порядке выписки — с самого свежего.
          const last = person.rows[0]
          if (last === undefined) return null
          return (
            <li key={person.key} class="f-unknown__row">
              <div class="f-unknown__line">
                <button
                  type="button"
                  class="f-tr__name"
                  aria-expanded={opened}
                  onClick={() => setOpen(opened ? null : person.key)}
                >
                  <span class="f-tr__sign" aria-hidden="true">
                    {opened ? '−' : '+'}
                  </span>
                  {person.label}
                </button>
                <Amount class="f-unknown__sum" value={person.total} kopecks="never" />
              </div>

              <span class="f-unknown__pick">
                {/* Когда был последний — прямо в строке, не под раскрытием.
                    Смысл времени в том, чтобы вспомнить перевод, а вспоминать
                    приходится до нажатия, а не после: строка, в которой стоят
                    только имя и сумма, не подсказывает, нажимать ли вообще. */}
                <span class="f-unknown__count">
                  {person.rows.length} пер. · {when(last)}
                  {person.common === null
                    ? ` · ${person.rows.filter((tx) => tx.category === PEOPLE).length} без имени`
                    : ''}
                </span>
                <Pick
                  value={person.common === null || person.common === PEOPLE ? '' : person.common}
                  options={options}
                  placeholder="— за что —"
                  label={`Категория переводов человеку ${person.label}`}
                  onChange={(next) => {
                    if (isCategory(next)) onMerchantCategory(person.key, next)
                  }}
                />
              </span>

              {opened ? (
                <div class="f-peek">
                  {person.rows.map((tx) => (
                    <div key={tx.id} class="f-peek__row">
                      {/* День недели и время — то, по чему перевод вспоминается.
                          Сумма и имя получателя об одном переводе из двадцати
                          не говорят ничего, а «пт, 22:48» говорит. Время есть
                          не всегда: зачисления банк проводит без него. */}
                      <span class="f-peek__day">
                        {weekdayLabel(tx.date)}, {dayLabel(tx.date)}
                        {tx.time === null ? null : <span class="f-tr__time">{tx.time}</span>}
                      </span>
                      <Amount class="f-peek__sum" value={tx.amount} abs kopecks="never" />
                      <Pick
                        value={tx.category === PEOPLE ? '' : tx.category}
                        options={options}
                        placeholder="— за что —"
                        label={`Категория перевода от ${dayLabel(tx.date)}`}
                        quiet
                        onChange={(next) => {
                          if (isCategory(next)) onCategory(tx.id, next)
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>

      {tail.length > 0 ? (
        <button type="button" class="f-more" onClick={() => setLimit(limit + PAGE * 2)}>
          Ещё · осталось {tail.length} на {Math.round(tailSum / 100)}
        </button>
      ) : null}
    </>
  )
}
