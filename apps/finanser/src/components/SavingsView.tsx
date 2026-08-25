import type { JSX } from 'preact'
import { formatAmount, parseAmount } from '../money.js'
import type { Kopeck } from '../money.js'
import type { Plan } from '../plan.js'
import { deadline, forecast, monthsBetween, pace, progress, savedByMonth, verdictOf } from '../savings.js'
import type { MonthVerdict, SavedMonth } from '../savings.js'
import type { Categorized } from '../model.js'
import { monthLabel } from '../model.js'
import { Amount } from './Amount.js'

export interface SavingsProps {
  rows: readonly Categorized[]
  /** Край данных, `ГГГГ-ММ-ДД`. От него считаются сроки. */
  edge: string
  plan: Plan
  onChange: (next: Plan) => void
}

/**
 * Копилка: сколько лежит, к чему идём, успеваем ли и как шли месяцы.
 *
 * Здесь только два числа спрашиваются рукой — сколько уже лежит и какая цель.
 * Остальное считается: сколько откладывается на самом деле, какой темп, когда
 * наберётся. Спрашивать то, что видно в операциях, значит позволить двум
 * ответам разойтись.
 *
 * Качество выполнения показывается месяцами, а не одной долей. «Выполнено на
 * 74%» — это среднее, за которым не видно, был ли один пропущенный месяц или
 * шесть недобранных: лечится это по-разному.
 */
export function SavingsView({ rows, edge, plan, onChange }: SavingsProps): JSX.Element {
  const history = savedByMonth(rows, edge, plan.save)
  const rate = pace(history)
  const ahead = forecast(plan, rate, edge)
  const due = deadline(plan, edge)
  const share = progress(plan)
  const set = (field: keyof Plan) => (value: Kopeck) => onChange({ ...plan, [field]: value })

  return (
    <section class="f-save">
      <h2 class="f-eyebrow">Копилка</h2>

      <div class="f-save__now">
        <Amount class="f-save__sum" value={plan.saved} kopecks="never" />
        {plan.goal > 0 ? (
          <span class="f-save__of">
            из <Amount value={plan.goal} kopecks="never" />
          </span>
        ) : null}
      </div>

      {/* Полоса только при заданной цели: шкала без цели показывает долю от
          неизвестного, то есть врёт формой, ничего не сказав словами. */}
      {share === null ? null : (
        <div class="f-save__track" role="img" aria-label={`Пройдено ${Math.round(share * 100)}%`}>
          <span class="f-save__fill" style={`width:${Math.round(share * 100)}%`} />
        </div>
      )}

      <dl class="f-save__facts">
        <div>
          <dt class="f-save__k">откладывается</dt>
          <dd class="f-save__v">
            {rate === 0 ? (
              <span class="f-save__none">пока нисколько</span>
            ) : (
              <>
                <Amount value={rate} kopecks="never" /> <span class="f-save__unit">в месяц</span>
              </>
            )}
          </dd>
        </div>

        {plan.goal <= 0 ? null : (
          <div>
            <dt class="f-save__k">осталось</dt>
            <dd class="f-save__v">
              <Amount value={ahead.left} kopecks="never" />
            </dd>
          </div>
        )}

        {ahead.month === null ? null : (
          <div>
            <dt class="f-save__k">при нынешнем темпе</dt>
            <dd class="f-save__v f-save__v--word">{monthLabel(ahead.month)}</dd>
          </div>
        )}
      </dl>

      {/* Срок. Не упрёк, а арифметика: сколько надо откладывать, чтобы успеть.
          Приложение не знает, почему человек отстал, и говорить об этом ему
          нечего — а число, которое всё исправит, назвать может. */}
      {due === null ? null : (
        <p class={due.needed !== null && due.needed > rate ? 'f-save__due f-save__due--late' : 'f-save__due'}>
          {/* Месяц во всех ветках стоит в именительном: «к апрелю» требует
              таблицы падежей ради одной строки, а «к апрель 2027» — это брак.
              Фраза перестроена так, чтобы склонение не понадобилось. */}
          {due.needed === null ? (
            <>Срок — {monthLabel(plan.goalDate)}. Он прошёл, а цель не взята.</>
          ) : due.needed === 0 ? (
            <>Цель взята.</>
          ) : due.needed > rate ? (
            <>
              Срок — {monthLabel(plan.goalDate)}. Чтобы успеть, надо откладывать{' '}
              <Amount value={due.needed} kopecks="never" /> в месяц — на{' '}
              <Amount value={(due.needed - rate) as Kopeck} kopecks="never" /> больше нынешнего.
            </>
          ) : (
            <>
              Срок — {monthLabel(plan.goalDate)}. Успеваете: нужно{' '}
              <Amount value={due.needed} kopecks="never" /> в месяц, откладывается больше.
            </>
          )}
        </p>
      )}

      {history.length === 0 ? null : <Quality history={history.slice(-6)} />}

      <div class="f-save__fields">
        <Money label="Уже в копилке" value={plan.saved} onChange={set('saved')} />
        <Money label="Цель" value={plan.goal} onChange={set('goal')} />
        <Month
          label="К месяцу"
          value={plan.goalDate}
          onChange={(next) => onChange({ ...plan, goalDate: next })}
        />
        <Money label="В копилку за месяц" value={plan.save} onChange={set('save')} />
      </div>
    </section>
  )
}

/**
 * Как шли месяцы.
 *
 * Столбик на месяц, а не одна доля: пропущенный месяц и недобранный лечатся
 * по-разному, и в среднем они неразличимы. Пропуск красится отдельно —
 * это единственное, что стоит заметить с одного взгляда.
 */
function Quality({ history }: { history: readonly SavedMonth[] }): JSX.Element {
  /**
   * Шкала — это план, а не самый большой месяц.
   *
   * По самому большому месяцу все полосы становились относительными друг
   * другу: шесть месяцев ровно по плану давали шесть одинаковых полос во всю
   * ширину, и понять по ним было нечего. Когда шкала — план, конец дорожки и
   * есть цель: полоса до края значит «взято», короче — видно на сколько.
   * Отдельная риска плана после этого не нужна, а раньше она всегда упиралась
   * в конец полосы и читалась как дефект отрисовки.
   */
  const fallback = Math.max(...history.map((r) => r.saved), 1)

  return (
    <div class="f-save__quality">
      <h3 class="f-save__qk">Как шли месяцы</h3>
      <ul class="f-save__months" role="list">
        {history.map((row) => {
          const verdict = verdictOf(row)
          const scale = row.planned > 0 ? row.planned : fallback
          const width = Math.min(100, Math.round((row.saved / scale) * 100))
          return (
            <li key={row.month} class="f-save__month">
              <span class="f-save__mname">{shortMonth(row.month)}</span>
              <span class="f-save__mtrack">
                <span class={fillClass(verdict)} style={`width:${width}%`} />
              </span>
              <Amount class="f-save__mnum" value={row.saved} kopecks="never" />
              <span class={verdictClass(verdict)}>{verdict}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * «март 26» вместо «март 2026».
 *
 * Полное имя не помещалось в колонку и обрезалось многоточием: «апрель 2…»,
 * «август 2…». Обрезанный год не сообщает ничего, а рваный край колонки виден
 * сразу. Две цифры года читаются так же однозначно — в истории копилки соседние
 * века не встречаются.
 */
function shortMonth(month: string): string {
  const full = monthLabel(month)
  return full.replace(/\s(\d{2})(\d{2})$/, ' $2')
}

/**
 * Имена классов пишутся целиком, а не собираются подстановкой.
 *
 * Собранное из кусков имя не находится грепом, и правило в CSS выглядит
 * мёртвым — его удаляют при первой же уборке. Проверка «в файле нет правил,
 * которые никто не рисует» ловит ровно это и на подстановку не смотрит.
 */
function fillClass(verdict: MonthVerdict): string {
  switch (verdict) {
    case 'взято':
      return 'f-save__mfill f-save__mfill--ok'
    case 'недобрано':
      return 'f-save__mfill f-save__mfill--short'
    case 'пропущено':
      return 'f-save__mfill f-save__mfill--miss'
    default:
      return 'f-save__mfill f-save__mfill--none'
  }
}

function verdictClass(verdict: MonthVerdict): string {
  return verdict === 'пропущено'
    ? 'f-save__verdict f-save__verdict--miss'
    : 'f-save__verdict'
}

/** Поле для суммы. Хранится в копейках, показывается рублями. */
function Money({
  label,
  value,
  onChange,
}: {
  label: string
  value: Kopeck
  onChange: (next: Kopeck) => void
}): JSX.Element {
  return (
    <label class="f-field">
      <span class="f-field__k">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={value === 0 ? '' : formatAmount(value, { kopecks: 'auto', abs: true })}
        onChange={(event) => {
          const raw = (event.currentTarget as HTMLInputElement).value
          onChange(raw.trim() === '' ? (0 as Kopeck) : (Math.abs(parseAmount(raw) ?? 0) as Kopeck))
        }}
      />
    </label>
  )
}

/** Месяц. Родное поле браузера: свой календарь здесь ничего не добавит. */
function Month({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (next: string) => void
}): JSX.Element {
  return (
    <label class="f-field">
      <span class="f-field__k">{label}</span>
      <input
        type="month"
        value={value}
        onChange={(event) => onChange((event.currentTarget as HTMLInputElement).value)}
      />
    </label>
  )
}
