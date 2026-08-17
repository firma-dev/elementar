import { useEffect, useState } from 'preact/hooks'

/**
 * Ленивый чанк по требованию (§12.11): модуль грузится только когда он понадобился,
 * и остаётся в памяти после. Пока не загрузился — вызывающий рисует скелет.
 */
export function useLazy<T>(load: () => Promise<T>, when: boolean): T | null {
  const [mod, setMod] = useState<T | null>(null)
  useEffect(() => {
    if (!when || mod !== null) return
    let alive = true
    void load().then((m) => {
      if (alive) setMod(m)
    })
    return () => {
      alive = false
    }
    // load пересоздаётся каждый рендер: следим только за флагом
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [when, mod])
  return mod
}
