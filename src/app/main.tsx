import '@fontsource/barlow/400.css'
import '@fontsource/barlow/600.css'
import '@fontsource/barlow-condensed/500.css'
import '@fontsource/barlow-condensed/600.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './app.css'
import { useEditor } from './store'

if (new URLSearchParams(location.search).has('demo')) useEditor.getState().startDemo()
// For checking layouts in the browser during development (never in a build).
if (import.meta.env.DEV) Object.assign(window, { editorStore: useEditor })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
