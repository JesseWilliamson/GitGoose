import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './components/App'
import { boot } from './lib/store'
import './styles.css'

window.addEventListener('error', (e) => void window.gitsquid.logError(`${e.message}\n${e.error?.stack ?? ''}`))
window.addEventListener('unhandledrejection', (e) => void window.gitsquid.logError(String(e.reason?.stack ?? e.reason)))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
void boot()
