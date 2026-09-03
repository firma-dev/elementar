import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { IncomeSource } from '../income.js'
import type { Kopeck } from '../money.js'
import { dayInput, dayLabel, parseDayInput } from '../model.js'
import { Amount } from './Amount.js'

export interface ArrivalsProps {
  sources: readonly IncomeSource[]
  /** Ближайший ожидаемый приход — по регулярным источникам. */
  next: { date: string; label: string; amount: Kopeck } | null
  /** Поправить дату ожидания. Пустая строка — вернуться к догадке. */
  onSetDate: (date: string) => void
  /** Названа ли дата рукой — тогда об этом говорится прямо. */
  byHand: boolean
}

/** Сколько источников показываем. Больше трёх — это уже список, а не ответ. */
const SHOWN = 3

/** «3 раза», «11 раз», «1 раз» — иначе в строке стояло «3 РАЗ». */
function times(n: number): string {
  const tens = n % 100
  const ones = n % 10
  if (tens >= 11 && tens <= 14) return `${n} раз`
  if (ones === 1) return `${n} раз`
  if (ones >= 2 && ones <= 4) return `${n} раза`
  return `${n} раз`
}

/**
 * Откуда и когда приходят деньги.
 *
 * Сверху — когда ждать следующий приход, ниже — от кого деньги приходят
 * вообще. Регулярные первыми: на них живут, остальное случается.
 *
 * Три строки, а не двадцать: полный список стоит за дверью «подробно». На
 * сводке он отвечал бы на вопрос, которого никто не задаёт каждый день, — «а
 * кто прислал мне тысячу в апреле».
 *
 * Всё выровнено по одной сетке — и строка ожидания, и строки источников: имя
 * слева, приписка и сумма справа по общей вертикали. Раньше строка ожидания
 * шла сплошняком, «25 СЕНТЯБРЯ 73 494 ЗАРПЛАТА АВАНС КАПИТАЛ ГРУП», и читать
 * её приходилось по слогам.
 */
/**
 * Как часто приходит: по промежутку, а не по одному слову «регулярный».
 *
 * Зарплата два раза в месяц подписывалась «каждый месяц» — метка ставилась по
 * признаку регулярности, а он про постоянство, не про частоту.
 */
function ритм(source: IncomeSource): string {
  if (!source.regular) return times(source.count)
  const gap = Math.round(source.typicalGap)
  if (gap <= 9) return 'каждую неделю'
  if (gap <= 20) return 'два раза в месяц'
  if (gap <= 45) return 'каждый месяц'
  return 'раз в несколько месяцев'
}

export function Arrivals({ sources, next, onSetDate, byHand }: ArrivalsProps): JSX.Element | null {
  const [asking, setAsking] = useState(false)
  // Что не так с введённой датой. Пустая строка — всё в порядке.
  const [беда, setБеда] = useState('')
  // Ожидание показывается и без источников за отрезок: в начале месяца
  // приходов ещё нет, а вопрос «когда придут» как раз тогда и задают.
  if (sources.length === 0 && next === null) return null
  const top = [...sources]
    .sort((a, b) => Number(b.regular) - Number(a.regular) || b.total - a.total)
    .slice(0, SHOWN)

  return (
    <div class="f-arr">
      {asking ? (
        /* Дата — то, от чего считается «сколько можно тратить в день», и
           ошибиться в ней дороже, чем в любой другой. Приложение считает её по
           ритму прошлых приходов, но ритм знает не всё: праздники сдвигают
           зарплату, работу меняют, премию обещают к пятнице. */
        <form
          class="f-ask"
          onSubmit={(event) => {
            event.preventDefault()
            const field = (event.currentTarget as HTMLFormElement).elements.namedItem(
              'дата',
            ) as HTMLInputElement
            const iso = parseDayInput(field.value)
            /**
             * Непонятая строка не глотается.
             *
             * Раньше форма закрывалась в любом случае: человек вводил
             * «5 сентября» или «05/09», дата не менялась, и ничего сказано не
             * было — он уходил уверенным, что поправил.
             */
            if (iso === '') {
              setБеда('Дата не понята. Нужно число, месяц и год: 05.09.2026.')
              return
            }
            setБеда('')
            onSetDate(iso)
            setAsking(false)
          }}
        >
          <label class="f-ask__k" for="приход-дата">
            Когда ждёте приход
          </label>
          <input
            id="приход-дата"
            name="дата"
            type="text"
            inputMode="numeric"
            maxLength={10}
            placeholder="ДД.ММ.ГГГГ"
            defaultValue={next === null ? '' : dayInput(next.date)}
            autoFocus
          />
          <button type="submit" class="f-btn">
            запомнить
          </button>
          <button
            type="button"
            class="f-btn"
            onClick={() => {
              setБеда('')
              onSetDate('')
              setAsking(false)
            }}
          >
            как считает
          </button>
          {беда === '' ? null : (
            <p class="f-ask__err" role="alert">
              {беда}
            </p>
          )}
        </form>
      ) : next === null ? (
        /**
         * Назвать дату можно и тогда, когда угадать её не из чего.
         *
         * Форма жила внутри «если приход угадан», а угадывается он только по
         * источнику с историей в три месяца. Фрилансер, человек на новой работе
         * и тот, кто выгрузил выписку за два месяца, видели «регулярных
         * источников не видно» — и ни одной двери, которая это чинит. Ровно те,
         * кому дата нужнее всего.
         */
        <p class="f-arr__row f-arr__row--next">
          <span class="f-arr__who">приход</span>
          <button type="button" class="f-arr__when" onClick={() => setAsking(true)}>
            когда ждёте · назвать
          </button>
        </p>
      ) : (
        <p class="f-arr__row f-arr__row--next">
          <span class="f-arr__who">{next.label}</span>
          {/* «Изменить» написано словом: пунктирного подчёркивания мало —
              человек спросил, как поправить дату, глядя прямо на неё. Та же
              подпись, что у остатка: одно действие — одно слово. */}
          <button type="button" class="f-arr__when" onClick={() => setAsking(true)}>
            {byHand ? 'ждёте' : 'ждём'} {dayLabel(next.date)} · изменить
          </button>
          <Amount class="f-arr__sum" value={next.amount} kopecks="never" />
        </p>
      )}

      <ul class="f-arr__list" role="list">
        {top.map((source) => (
          <li key={source.key} class="f-arr__row">
            <span class="f-arr__who">{source.label}</span>
            <span class="f-arr__mark">{ритм(source)}</span>
            <Amount class="f-arr__sum" value={source.total} kopecks="never" />
          </li>
        ))}
      </ul>

      {sources.length > SHOWN ? (
        <p class="f-arr__more">ещё {sources.length - SHOWN} · в «подробно»</p>
      ) : null}
    </div>
  )
}
