import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles/global.css'

class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('RestOS+ root error:', error, info)
  }

  render() {
    if (this.state.error) {
      const detail = this.state.error?.stack || this.state.error?.message || String(this.state.error)
      return (
        <div style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#102f24',
          color: '#fff',
          padding: 24,
          fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif',
        }}>
          <div style={{ maxWidth: 720, width: '100%' }}>
            <h1 style={{ marginBottom: 8 }}>RestOS+ no pudo iniciar</h1>
            <p style={{ color: '#bdd0c8', lineHeight: 1.5 }}>
              React cargó, pero ocurrió un error dentro de la aplicación.
            </p>
            <pre style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: '#0b241b',
              padding: 14,
              borderRadius: 12,
              color: '#f5d8d8',
              fontSize: 12,
            }}>{detail}</pre>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
)
