import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getToasts, subscribeToasts, toast } from '../src/components/Toast/toastStore.js'

describe('стор тостов', () => {
  beforeEach(() => {
    toast.clear()
  })

  it('возвращает id и кладёт тост в стор', () => {
    const id = toast.show({ message: 'Задача удалена' })
    expect(getToasts()).toHaveLength(1)
    expect(getToasts()[0]?.id).toBe(id)
    expect(getToasts()[0]?.duration).toBe(6000)
    expect(getToasts()[0]?.tone).toBe('neutral')
  })

  it('одинаковый id заменяет тост, а не копит стопку', () => {
    toast.show({ id: 'sync', message: 'Синхронизация' })
    toast.show({ id: 'sync', message: 'Синхронизировано', tone: 'success' })
    expect(getToasts()).toHaveLength(1)
    expect(getToasts()[0]?.message).toBe('Синхронизировано')
    expect(getToasts()[0]?.tone).toBe('success')
  })

  it('одновременно не больше трёх', () => {
    for (const n of [1, 2, 3, 4, 5]) toast.show({ message: `${n}` })
    expect(getToasts().map((t) => t.message)).toEqual(['3', '4', '5'])
  })

  it('duration: 0 сохраняется как «до закрытия вручную»', () => {
    toast.show({ message: 'Нет сети', duration: 0, tone: 'danger' })
    expect(getToasts()[0]?.duration).toBe(0)
  })

  it('dismiss и clear убирают тосты и уведомляют подписчиков', () => {
    const seen = vi.fn()
    const unsubscribe = subscribeToasts(seen)
    const id = toast.show({ message: 'Отменить?' })
    toast.dismiss(id)
    expect(getToasts()).toHaveLength(0)
    // подписка при регистрации + показ + скрытие
    expect(seen).toHaveBeenCalledTimes(3)
    toast.dismiss('нет-такого')
    expect(seen).toHaveBeenCalledTimes(3)
    unsubscribe()
    toast.show({ message: 'После отписки' })
    expect(seen).toHaveBeenCalledTimes(3)
  })
})
