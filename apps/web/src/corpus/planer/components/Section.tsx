import type { JSX } from 'preact'
import { useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { cx } from '@elementar/ui'
import type { Tone } from '@elementar/ui'

export interface SectionProps {
  title: string
  count?: number
  tone?: Tone
  /** Свёрнутая по умолчанию секция: «Сделано сегодня», «Без проекта». */
  collapsible?: boolean
  defaultOpen?: boolean
  children: ComponentChildren
}

/** Заголовок секции списка. Ниже сгиба секции отдаются браузеру целиком (§13.8). */
export function Section({
  title,
  count,
  tone,
  collapsible = false,
  defaultOpen = true,
  children,
}: SectionProps): JSX.Element {
  const [open, setOpen] = useState(collapsible ? defaultOpen : true)
  const label = count === undefined ? title : `${title} · ${count}`

  return (
    <section class="p-section" data-tone={tone}>
      {collapsible ? (
        <button
          type="button"
          class={cx('p-section__head', 'p-section__head--button')}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span class="e-overline">{label}</span>
          <span class="p-section__chevron" aria-hidden="true">
            {open ? '⌄' : '›'}
          </span>
        </button>
      ) : (
        <div class="p-section__head">
          <span class="e-overline">{label}</span>
        </div>
      )}
      {open ? <div class="p-section__body">{children}</div> : null}
    </section>
  )
}
