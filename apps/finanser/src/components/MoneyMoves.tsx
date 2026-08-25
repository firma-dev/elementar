import type { JSX } from 'preact'
import type { Categorized } from '../model.js'
import { byPlane, byPlaneCategory } from '../stats.js'
import { planeOfTx } from '../plane.js'
import { Amount } from './Amount.js'
import { Fold } from './Fold.js'

/**
 * Движения денег. Отдельно от трат, потому что переводы, наличные и кредиты
 * тратами не являются: снял пятьдесят тысяч и заплатил ими же — без разделения
 * в годовой сумме получится сто. План категории решает это раз и навсегда,
 * вместо флага «исключить переводы», который человек забудет включить.
 */
interface Props {
  rows: readonly Categorized[]
  /** Расцепить пару: приход перестаёт считаться переводом между своими. */
  onUnpair: (id: string) => void
}

export function MoneyMoves({ rows, onUnpair }: Props): JSX.Element | null {
  const planes = byPlane(rows)
  if (planes.move.count === 0) return null

  /**
   * Приходы, которые пара засчитала переводом между своими счетами.
   *
   * Пара — догадка по трём признакам: та же сумма, разные счета, два дня
   * разницы. Этого мало. Перевод маме 50 000 с одной карты и гонорар 50 000 на
   * другую через день выглядят одинаково, и гонорар молча уходит из
   * «Поступлений»: круглые суммы у переводов и у гонораров совпадают ровно
   * потому, что и те и другие круглые.
   *
   * Уточнить признаки нечем — в выписке больше ничего нет. Поэтому догадка
   * показывается: «предлагает, но не делает». Расцепить можно здесь же, и
   * ручная правка сильнее пары навсегда.
   *
   * След пары узнаётся по тому, что она сама и ставит: приход, названный
   * «Переводами» не человеком и не правилом, а разбором операции.
   */
  const guessed = rows.filter(
    (tx) => tx.amount > 0 && tx.category === 'Переводы' && tx.source === 'operation',
  )

  const moved = byPlaneCategory(rows, 'move')
  // Внутри переезда деньги идут в обе стороны: снятие — минус, возврат займа
  // партнёром — плюс. Считаем стороны раздельно, иначе «итог» врёт.
  let out = 0
  let back = 0
  for (const tx of rows) {
    if (planeOfTx(tx.category, tx.amount) !== 'move') continue
    if (tx.amount < 0) out -= tx.amount
    else back += tx.amount
  }

  return (
    <Fold title="Движения денег · не траты" meta={`${planes.move.count} оп.`}>
      <p class="f-note">
        Переводы, наличные и кредиты в картину года не входят: деньги переехали, а не потратились.
      </p>

      <dl class="f-moves__nums">
        <div>
          <dt class="f-moves__k">ушло</dt>
          <dd class="f-moves__v">
            <Amount value={out} kopecks="never" />
          </dd>
        </div>
        <div>
          <dt class="f-moves__k">пришло</dt>
          <dd class="f-moves__v f-moves__v--in">
            <Amount value={back} kopecks="never" />
          </dd>
        </div>
        <div>
          <dt class="f-moves__k">итог</dt>
          <dd class="f-moves__v">
            <Amount value={back - out} kopecks="never" plus />
          </dd>
        </div>
      </dl>

      {guessed.length === 0 ? null : (
        <div class="f-moves__guess">
          <p class="f-note">
            {guessed.length === 1
              ? 'Одно пополнение засчитано переводом между своими счетами'
              : `Пополнений засчитано переводами между своими счетами: ${guessed.length}`}
            . Это догадка по совпадению суммы и даты — если деньги пришли со
            стороны, расцепите, и они вернутся в поступления.
          </p>
          <ul class="f-moves__rows" role="list">
            {guessed.map((tx) => (
              <li key={tx.id} class="f-moves__row">
                <span class="f-moves__name">{tx.description}</span>
                <Amount value={tx.amount} kopecks="never" />
                <button type="button" class="f-linkish" onClick={() => onUnpair(tx.id)}>
                  это не перевод
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul class="f-moves__rows" role="list">
        {moved.map((row) => (
          <li key={row.category} class="f-moves__row">
            <span class="f-moves__name">{row.category}</span>
            <span class="f-moves__kind">{row.count} оп.</span>
            <Amount value={row.spend} kopecks="never" />
          </li>
        ))}
      </ul>
    </Fold>
  )
}
