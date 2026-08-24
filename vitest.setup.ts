// Общая подготовка окружения тестов.
// IndexedDB в node отсутствует — подсовываем fake-indexeddb.
import 'fake-indexeddb/auto'

/**
 * localStorage в node тоже отсутствует, и это не мелочь: финансер хранит в нём
 * всё, а `globalThis.localStorage?.…` при отсутствии объекта молча ничего не
 * делает. Из-за этого весь слой хранения был не покрыт ничем — 938 зелёных
 * тестов не заметили, что восстановление кладёт в ключ объект вместо массива и
 * роняет приложение белым экраном при следующем открытии вкладки.
 *
 * Реализация нарочно простая и синхронная, как настоящая: ключи строками,
 * значения строками, никакой квоты. Тест, которому нужна переполненная квота,
 * подменяет `setItem` сам.
 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.map.get(String(key)) ?? null
  }

  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value))
  }

  removeItem(key: string): void {
    this.map.delete(String(key))
  }

  clear(): void {
    this.map.clear()
  }
}

if (globalThis.localStorage === undefined) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  })
}

// Этот файл выполняется заново для каждого тестового файла, поэтому чистки
// здесь достаточно: файлы не наследуют хранилище друг у друга. Внутри одного
// файла состояние общее — как в настоящей вкладке, где сигналы `store.ts`
// читаются один раз при импорте модуля.
