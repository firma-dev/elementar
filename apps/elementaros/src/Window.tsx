import type { ComponentChildren, JSX } from 'preact'

export interface WindowProps {
  /** Заголовок в титлбаре. Набирается капсом OCR — сюда пишется готовая строка. */
  title: string
  tone?: 'accent' | 'danger'
  children: ComponentChildren
}

/**
 * Прямоугольное окно с титлбаром — опорный приём айдентики: содержимое среды
 * всегда живёт в окне. Три квадрата справа — знак окна, а не орган управления:
 * нажимать в них нечего, поэтому и разметка не кнопочная.
 */
export function Window({ title, tone, children }: WindowProps): JSX.Element {
  const cls = tone === undefined ? 'os-window' : `os-window os-window--${tone}`
  return (
    <article class={cls}>
      <header class="os-window__bar">
        <span class="os-window__title">{title}</span>
        <span class="os-window__knobs" aria-hidden="true">
          <span class="os-window__knob" />
          <span class="os-window__knob" />
          <span class="os-window__knob" />
        </span>
      </header>
      <div class="os-window__body">{children}</div>
    </article>
  )
}
