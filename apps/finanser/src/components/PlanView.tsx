import type { JSX } from 'preact'
import { formatAmount, parseAmount } from '../money.js'
import type { Kopeck } from '../money.js'
import { hasPlan, living, toGoal } from '../plan.js'
import type { Plan } from '../plan.js'
import { Amount } from './Amount.js'
import { Fold } from './Fold.js'

export interface PlanViewProps {
  plan: Plan
  /** Сколько отложено за текущий месяц — считается по операциям, не вводится. */
  setAside: Kopeck
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (next: Plan) => void
}

/**
 * План и копилка.
 *
 * Спрашивается три числа: сколько человек рассчитывает получить, сколько
 * уходит на обязательное и сколько откладывать. Четвёртое, «на жизнь», не
 * спрашивается — оно уже известно (Д-026). Спросить его значило бы позволить
 * сумме не сойтись, а потом гадать, какому из четырёх чисел верить.
 *
 * Копилка — единственное, что нельзя вывести: накопительный счёт человек
 * обычно не выгружает. Отложенное за месяц, наоборот, видно в операциях, и
 * спрашивать его не за чем.
 */
export function PlanView({
  plan,
  setAside,
  open,
  onOpenChange,
  onChange,
}: PlanViewProps): JSX.Element {
  const rest = living(plan)
  const set = (field: keyof Plan) => (value: Kopeck) => onChange({ ...plan, [field]: value })

  return (
    <Fold
      title="План и копилка"
      meta={hasPlan(plan) ? undefined : 'не заполнен'}
      open={open}
      onOpenChange={onOpenChange}
    >
      <p class="f-note">
        Три числа за месяц. «На жизнь» не спрашивается — это остаток, и он же становится дневным и
        недельным пределом.
      </p>

      <div class="f-plan">
        <Money label="Доход в плане" value={plan.income} onChange={set('income')} />
        <Money label="Обязательные платежи" value={plan.fixed} onChange={set('fixed')} />
        <Money label="В копилку за месяц" value={plan.save} onChange={set('save')} />
        <Money label="Уже в копилке" value={plan.saved} onChange={set('saved')} />
      </div>

      {!hasPlan(plan) ? null : (
        <dl class="f-plan__out">
          <div>
            <dt class="f-plan__k">на жизнь</dt>
            <dd class={rest < 0 ? 'f-plan__v f-plan__v--bad' : 'f-plan__v'}>
              <Amount value={rest} kopecks="never" />
            </dd>
          </div>
          <div>
            <dt class="f-plan__k">отложено за месяц</dt>
            <dd class="f-plan__v">
              <Amount value={setAside} kopecks="never" />
            </dd>
          </div>
          <div>
            <dt class="f-plan__k">до месячной цели</dt>
            <dd class="f-plan__v">
              <Amount value={toGoal(plan, setAside)} kopecks="never" />
            </dd>
          </div>
        </dl>
      )}

      {rest >= 0 ? null : (
        <p class="f-note f-hint">
          План не сходится: обязательное и откладываемое вместе больше дохода. Это не округляется до
          нуля — иначе невыполнимый план выглядел бы выполнимым.
        </p>
      )}
    </Fold>
  )
}

/**
 * Поле для суммы.
 *
 * Хранится в копейках, показывается рублями. Ввод разбирается тем же кодом,
 * что и суммы из выписки: «70 000», «70000», «70 000,50» — всё это одно и то
 * же число, и заставлять человека угадывать формат незачем.
 */
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
