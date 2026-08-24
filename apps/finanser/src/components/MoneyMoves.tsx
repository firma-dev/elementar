import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import type { Categorized } from '../model.js'
import { byPlane, byPlaneCategory } from '../stats.js'
import { planeOfTx } from '../plane.js'
import { Amount } from './Amount.js'

/**
 * Движения денег. Отдельно от трат, потому что переводы, наличные и кредиты
 * тратами не являются: снял пятьдесят тысяч и заплатил ими же — без разделения
 * в годовой сумме получится сто. План категории решает это раз и навсегда,
 * вместо флага «исключить переводы», который человек забудет включить.
 */
export function MoneyMoves({ rows }: { rows: readonly Categorized[] }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const planes = byPlane(rows)
  if (planes.move.count === 0) return null

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
    <section class="f-moves">
      <div class="f-moves__head">
        <h2 class="f-eyebrow f-eyebrow--quiet">Движения денег · не траты</h2>
        <button type="button" class="f-linkish" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'свернуть' : 'раскрыть'}
        </button>
      </div>

      <p class="f-note" style="margin-top:0.5em">
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

      {open ? (
        <ul class="f-moves__rows" role="list">
          {moved.map((row) => (
            <li key={row.category} class="f-moves__row">
              <span class="f-moves__name">{row.category}</span>
              <span class="f-moves__kind">{row.count} оп.</span>
              <Amount value={row.spend} kopecks="never" />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
