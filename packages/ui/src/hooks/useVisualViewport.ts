import { useEffect, useState } from 'preact/hooks'

/**
 * Высота экранной клавиатуры. Пишется в --e-kb-inset на <html>, чтобы шиты и
 * поля ввода поднимались над клавиатурой без прыжков раскладки.
 */
export function useVisualViewport(): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const vv = typeof window === 'undefined' ? undefined : window.visualViewport
    if (vv === undefined || vv === null) return

    const update = (): void => {
      const value = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      setInset(value)
      document.documentElement.style.setProperty('--e-kb-inset', `${value}px`)
    }

    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      document.documentElement.style.setProperty('--e-kb-inset', '0px')
    }
  }, [])

  return inset
}
