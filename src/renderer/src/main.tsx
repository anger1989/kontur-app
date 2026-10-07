import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Golos Text — интерфейсный шрифт. Кириллица и латиница лежат в одном файле
// на вес (несколько @font-face с unicode-range), отдельный субсет не нужен.
import '@fontsource/golos-text/400.css'
import '@fontsource/golos-text/500.css'
import '@fontsource/golos-text/600.css'
// IBM Plex: моноширинный и для заметок — латиница и кириллица отдельными
// субсетами, без кириллического субсета половина текста уехала бы в системный шрифт.
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/cyrillic-400.css'
import '@fontsource/ibm-plex-serif/400.css'
import '@fontsource/ibm-plex-serif/400-italic.css'
import '@fontsource/ibm-plex-serif/600.css'
import '@fontsource/ibm-plex-serif/cyrillic-400.css'
import '@fontsource/ibm-plex-serif/cyrillic-600.css'

import './styles/globals.css'
import App from '@/App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
