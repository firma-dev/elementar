import { render } from 'preact'
import './finanser.css'
import { App } from './app.js'

const root = document.getElementById('app')
if (root !== null) render(<App />, root)

/**
 * Сервис-воркер — единственная причина, по которой финансер открывается офлайн
 * (ТЗ §2 п.7). Регистрация относительная: приложение может стоять по адресу
 * `/финансер/`, а не в корне, и абсолютный путь туда бы не попал.
 *
 * Падение регистрации не ломает ничего: без воркера приложение просто требует
 * сети на первую загрузку. Поэтому — тихо.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  globalThis.addEventListener('load', () => {
    void navigator.serviceWorker.register(new URL('sw.js', document.baseURI)).catch(() => {})
  })
}
