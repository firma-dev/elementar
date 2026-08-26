import type { ComponentChildren, JSX } from 'preact'

export interface ScreenProps {
  id: string
  /** Номер для рейки навигации: `00` … `11`. */
  num: string
  /** Служебная метка вверху экрана, дословно из брифа. У обложки её нет. */
  label?: string
  /** Имя экрана для рейки и для программ чтения с экрана. */
  name: string
  /** Синяя заливка — акцентный экран. */
  accent?: boolean
  /** Широкий столбец: под сетку из окон. */
  wide?: boolean
  /** Подпись, прижатая к низу экрана. */
  foot?: ComponentChildren
  children: ComponentChildren
}

/** Экран ленты: один экран — один тезис. */
export function Screen({
  id,
  num,
  label,
  name,
  accent = false,
  wide = false,
  foot,
  children,
}: ScreenProps): JSX.Element {
  const cls = ['os-screen', accent ? 'os-screen--accent' : '', wide ? 'os-screen--wide' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <section id={id} class={cls} data-num={num} data-name={name} aria-label={name}>
      <div class="os-screen__inner">
        {label === undefined ? null : <p class="os-label">{label}</p>}
        {children}
      </div>
      {foot === undefined ? null : <div class="os-screen__foot">{foot}</div>}
    </section>
  )
}
