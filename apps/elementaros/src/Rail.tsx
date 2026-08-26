import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { useReducedMotion } from '@elementar/ui'

interface Item {
  id: string
  num: string
  name: string
}

/**
 * Рейка номеров справа: где ты в ленте и как прыгнуть в другой экран.
 *
 * Список не задан руками, а прочитан из разметки: экраны и так подписаны
 * номерами, и второй их перечень немедленно разошёлся бы с первым. Текущий
 * экран определяется наблюдателем с полем `-45%` сверху и снизу — в этой
 * полосе всегда ровно один экран, тот, что стоит посередине окна.
 */
export function Rail(): JSX.Element | null {
  const [items, setItems] = useState<Item[]>([])
  const [active, setActive] = useState('')
  const reduced = useReducedMotion()

  useEffect(() => {
    const screens = Array.from(document.querySelectorAll<HTMLElement>('.os-screen[id]'))
    setItems(
      screens.map((node) => ({
        id: node.id,
        num: node.dataset['num'] ?? '',
        name: node.dataset['name'] ?? '',
      })),
    )
    setActive(screens[0]?.id ?? '')

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id)
        }
      },
      { rootMargin: '-45% 0px -45% 0px' },
    )
    for (const node of screens) io.observe(node)
    return () => io.disconnect()
  }, [])

  if (items.length === 0) return null

  const jump = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({
      behavior: reduced ? 'auto' : 'smooth',
      block: 'start',
    })
  }

  return (
    <nav class="os-rail" aria-label="Разделы">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          class="os-rail__item"
          aria-current={item.id === active ? 'true' : 'false'}
          title={item.name}
          onClick={() => jump(item.id)}
        >
          {item.num}
        </button>
      ))}
    </nav>
  )
}
