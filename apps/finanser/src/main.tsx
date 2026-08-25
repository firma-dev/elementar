import { render } from 'preact'
import './finanser.css'
import { App } from './app.js'
import { registerPwa } from './pwa.js'
import { startTheme } from './theme.js'

// До отрисовки: иначе первый кадр выйдет светлым на тёмном устройстве.
startTheme()

const root = document.getElementById('app')
if (root !== null) render(<App />, root)

if (import.meta.env.PROD) {
  registerPwa()
} else {
  /**
   * В разработке воркера быть не должно, и чужого — тоже.
   *
   * Он остаётся от прошлого `preview` на том же происхождении и отдаёт кэш
   * cache-first: dev-сервер работает, правки собираются, а в браузере
   * открывается сборка недельной давности. Со стороны это неотличимо от
   * «ничего не применилось», и ищут причину где угодно, кроме воркера.
   *
   * Помогает не всегда: пока кэш отдаёт старый index.html, этот код и не
   * запустится. Но после жёсткой перезагрузки он снимет воркер насовсем —
   * и второй раз человек в эту яму не попадёт.
   */
  void navigator.serviceWorker?.getRegistrations().then(async (list) => {
    if (list.length === 0) return
    await Promise.all(list.map((r) => r.unregister()))
    for (const key of await caches.keys()) await caches.delete(key)
    location.reload()
  })
}
