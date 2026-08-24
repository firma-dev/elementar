import { render } from 'preact'
import './finanser.css'
import { App } from './app.js'
import { registerPwa } from './pwa.js'
import { startTheme } from './theme.js'

// До отрисовки: иначе первый кадр выйдет светлым на тёмном устройстве.
startTheme()

const root = document.getElementById('app')
if (root !== null) render(<App />, root)

if (import.meta.env.PROD) registerPwa()
