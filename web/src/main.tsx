import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { initWallet } from './lib/wallet.ts'
import '@fontsource-variable/inter/index.css'
import './styles/tokens.css'
import './styles/app.css'

initWallet()
createRoot(document.getElementById('root')!).render(<App />)
