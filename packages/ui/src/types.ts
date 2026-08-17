import type { ComponentChildren } from 'preact'

/** Хроматика зарезервирована: четыре списка, агент, два участника, три статуса (§11.0). */
export type Tone =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'work'
  | 'home'
  | 'hobby'
  | 'craft'
  | 'agent'

export type Slot = ComponentChildren

export interface Base {
  class?: string
  id?: string
  'data-testid'?: string
}
