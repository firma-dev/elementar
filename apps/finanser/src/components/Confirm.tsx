import type { JSX } from 'preact'
import { useState } from 'preact/hooks'

interface Props {
  /** Что написано, пока ничего не произошло. */
  label: string
  /** Вопрос вместо действия. Формулируется так, чтобы было видно, что уносит. */
  question: string
  /** Подтверждение. Не «да», а название действия: «да» без глагола не читают. */
  confirm: string
  onConfirm: () => void
}

/**
 * Необратимое действие в два нажатия. Не модалка: модалка перекрывает экран и
 * заставляет читать заново то, что человек и так видит, а здесь достаточно
 * заменить ссылку вопросом на том же месте.
 *
 * Первое нажатие ничего не делает, второе — делает. Между ними всегда есть
 * «отмена», и она стоит последней: палец идёт к краю, и промах по краю должен
 * быть безопасным.
 *
 * Почему вообще: «забыть всё» сносит год разметки, а стояло обычной ссылкой в
 * подвале рядом с переключателем темы. Промах пальцем по телефону стоил
 * человеку всей работы, и отменить это было нечем.
 */
export function Confirm({ label, question, confirm, onConfirm }: Props): JSX.Element {
  const [asking, setAsking] = useState(false)

  if (!asking) {
    return (
      <button type="button" class="f-linkish f-linkish--danger" onClick={() => setAsking(true)}>
        {label}
      </button>
    )
  }

  return (
    <span class="f-confirm">
      <span class="f-confirm__q">{question}</span>{' '}
      <button
        type="button"
        class="f-linkish f-linkish--danger"
        onClick={() => {
          setAsking(false)
          onConfirm()
        }}
      >
        {confirm}
      </button>{' '}
      <span class="f-confirm__sep">·</span>{' '}
      <button type="button" class="f-linkish" onClick={() => setAsking(false)}>
        отмена
      </button>
    </span>
  )
}
