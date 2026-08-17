import type { JSX } from 'preact'
import { useState } from 'preact/hooks'
import { Field, IconButton, useVisualViewport } from '@elementar/ui'
import { S } from '../strings.js'
import { parseComposer } from '../dates.js'
import { addTask } from '../actions.js'
import type { PlanerStore } from '../store.js'

const SPARK = (
  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
    <path
      d="M10 3l1.6 3.9L15.5 8.5l-3.9 1.6L10 14l-1.6-3.9L4.5 8.5l3.9-1.6z"
      fill="currentColor"
    />
  </svg>
)

export interface ComposerProps {
  store: PlanerStore
  /** Кнопки агента нет вовсе, если модель не настроена (§12.10). */
  onAgent?: () => void
}

/**
 * Композер — главный элемент главного экрана. Позиционируется по visualViewport,
 * а не sticky: в iOS Safari sticky уезжает под клавиатуру (§12.4).
 */
export function Composer({ store, onAgent }: ComposerProps): JSX.Element {
  const [text, setText] = useState('')
  useVisualViewport()

  const submit = (): void => {
    const parsed = parseComposer(text, store.today.value)
    if (parsed.title === '') return
    addTask(store.doc, {
      title: parsed.title,
      bucket: store.composerBucket.value,
      date: parsed.date,
      time: parsed.time,
    })
    setText('')
  }

  return (
    <div class="p-composer e-safe-bottom">
      <div class="p-composer__inner">
        <Field
          class="p-composer__field"
          value={text}
          onValueChange={setText}
          ariaLabel={S.composer.placeholder}
          placeholder={S.composer.placeholder}
          enterKeyHint="done"
          autoCapitalize="sentences"
          onEnter={submit}
          onEscape={() => setText('')}
          suffix={
            text.trim() === '' ? undefined : (
              <IconButton label={S.composer.submit} icon="↵" variant="primary" onClick={submit} />
            )
          }
        />
        {onAgent === undefined ? null : (
          <IconButton
            class="p-composer__agent"
            label={S.composer.agent}
            icon={SPARK}
            tone="agent"
            onClick={onAgent}
          />
        )}
      </div>
    </div>
  )
}
