import { useEffect, useState } from 'preact/hooks'
import type { ReadonlySignal } from '@preact/signals'

/** Явная подписка на сигнал: не полагаемся на глобальный патч preact-опций. */
export function useSignalValue<T>(s: ReadonlySignal<T>): T {
  const [value, setValue] = useState<T>(() => s.value)
  useEffect(() => s.subscribe(setValue), [s])
  return value
}
