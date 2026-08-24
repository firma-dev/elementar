import type { JSX } from 'preact'
import { RULES } from '../rules.js'
import type { Category } from '../model.js'
import { merchantLabel } from '../merchant.js'

export interface RulesViewProps {
  /** Правки по получателю: их человек ставил сам, их же может снять. */
  named: Readonly<Record<string, Category>>
  /** Сколько правок стоит на отдельных операциях. */
  manualCount: number
  onForget: (key: string) => void
  onBack: () => void
}

/**
 * Словарь правил.
 *
 * Раньше он существовал только в коде, и человек не мог узнать, почему
 * «Пятёрочка» — это продукты. Приложение, которое раскладывает чужие деньги по
 * полкам, обязано показывать, по каким правилам оно это делает: иначе разговор
 * идёт не с инструментом, а с оракулом.
 *
 * Встроенный словарь показан только для чтения — он часть сборки. Правится он
 * поверх: назвали получателя в «Разборе непонятного» — правка попала сюда, и
 * отсюда же её можно снять.
 */
export function RulesView({ named, manualCount, onForget, onBack }: RulesViewProps): JSX.Element {
  const mine = Object.entries(named).sort((a, b) => a[0].localeCompare(b[0]))
  const total = RULES.reduce((n, rule) => n + rule.keywords.length, 0)

  return (
    <div>
      <p class="f-txhead">
        <button type="button" class="f-linkish" onClick={onBack}>
          ← картина года
        </button>
      </p>

      <h2 class="f-eyebrow f-secline">Ваши правки</h2>
      {mine.length === 0 ? (
        <p class="f-note">
          Пока ни одной. Назовите получателя в «Разборе непонятного» — правка появится здесь и будет
          применяться ко всем его операциям, включая будущие выписки.
        </p>
      ) : (
        <ul class="f-rules" role="list">
          {mine.map(([key, category]) => (
            <li key={key} class="f-rules__row">
              <span class="f-rules__name" title={key}>
                {merchantLabel(key)}
              </span>
              <span class="f-rules__cat">{category}</span>
              <button type="button" class="f-linkish" onClick={() => onForget(key)}>
                снять
              </button>
            </li>
          ))}
        </ul>
      )}
      {manualCount > 0 ? (
        <p class="f-note">
          Кроме того, {manualCount} операций вы поправили поштучно — такие правки видны в самой
          выписке точкой у категории.
        </p>
      ) : null}

      <h2 class="f-eyebrow f-secline">Встроенный словарь · {total} слов</h2>
      <p class="f-note">
        По этим словам финансер узнаёт получателя в описании операции. Словарь — часть сборки и
        отсюда не меняется: ваша правка всегда сильнее его.
      </p>
      <ul class="f-rules" role="list">
        {RULES.map((rule) => (
          <li key={rule.category} class="f-rules__group">
            <span class="f-rules__cat f-rules__cat--head">{rule.category}</span>
            <span class="f-rules__words">{rule.keywords.join(' · ')}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
