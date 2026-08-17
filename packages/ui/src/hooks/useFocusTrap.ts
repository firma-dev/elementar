import { useEffect } from 'preact/hooks'
import type { RefObject } from 'preact'
import { focusableWithin } from '../utils/dom.js'

/**
 * Ловушка фокуса: Tab не выходит за пределы контейнера, при закрытии фокус
 * возвращается на элемент-триггер, остальное приложение помечается inert (§11.8).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const root = ref.current
    if (!active || root === null) return

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const inerted: HTMLElement[] = []
    for (const node of Array.from(document.body.children)) {
      if (!(node instanceof HTMLElement)) continue
      if (node === root || node.contains(root)) continue
      if (node.hasAttribute('inert')) continue
      node.setAttribute('inert', '')
      inerted.push(node)
    }

    const first = focusableWithin(root)[0]
    if (first !== undefined) first.focus()
    else {
      root.setAttribute('tabindex', '-1')
      root.focus()
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const items = focusableWithin(root)
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const head = items[0]
      const tail = items[items.length - 1]
      if (head === undefined || tail === undefined) return
      const current = document.activeElement
      if (e.shiftKey && (current === head || !root.contains(current))) {
        e.preventDefault()
        tail.focus()
      } else if (!e.shiftKey && current === tail) {
        e.preventDefault()
        head.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      for (const node of inerted) node.removeAttribute('inert')
      previous?.focus()
    }
  }, [ref, active])
}
