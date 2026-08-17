const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Видимые фокусируемые потомки в порядке DOM (положительный tabindex запрещён, §11.7). */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  const found = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
  return found.filter((el) => el.offsetParent !== null || el === document.activeElement)
}

/** Есть ли настоящий курсор — hover-эффекты только там (§11.8). */
export function hasFinePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

/** will-change ставится только на время анимации и снимается по transitionend (§11.6). */
export function withWillChange(el: HTMLElement, prop: string): () => void {
  el.style.willChange = prop
  const clear = (): void => {
    el.style.willChange = ''
    el.removeEventListener('transitionend', clear)
    el.removeEventListener('animationend', clear)
  }
  el.addEventListener('transitionend', clear)
  el.addEventListener('animationend', clear)
  return clear
}
