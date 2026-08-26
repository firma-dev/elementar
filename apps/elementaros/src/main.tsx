import { render } from 'preact'
import '@elementar/ui/styles.css'
import './landing.css'
import { App } from './app.js'

const root = document.getElementById('app')
if (root !== null) render(<App />, root)
