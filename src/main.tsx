import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/global.css'

const host = document.getElementById('root')
if (!host) throw new Error('The window has no #root element to mount into.')

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>
)
