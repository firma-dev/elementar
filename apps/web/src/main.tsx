import { render } from 'preact'
import '@elementar/ui/styles.css'
import '@elementar/shell/styles.css'
import './shell/shell.css'
import { App } from './app.js'
import { startRouter } from './routes.js'
import { startTheme } from './theme.js'
import { registerPwa } from './pwa.js'
import { installRuntime } from './runtime/install.js'

startTheme()
installRuntime()
startRouter()

const pwa = registerPwa()

const root = document.getElementById('app')
if (root !== null) render(<App pwa={pwa} />, root)
