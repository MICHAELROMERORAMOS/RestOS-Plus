import React, { useEffect, useState } from 'react'

export default function Topbar({
  title,
  canKitchen,
  canOrder,
  onKitchen,
  onNewOrder,
  companyName,
  locations = [],
  activeLocation,
  onLocationChange,
  workspaceMode = 'branch',
  canCompanyControl = false,
  onEnterCentral,
  onEnterBranch,
  onLogout,
}) {
  const [switching, setSwitching] = useState(false)
  const [fullscreen, setFullscreen] = useState(() => Boolean(
    document.fullscreenElement || document.webkitFullscreenElement,
  ))

  useEffect(() => {
    function syncFullscreenState() {
      setFullscreen(Boolean(document.fullscreenElement || document.webkitFullscreenElement))
    }

    document.addEventListener('fullscreenchange', syncFullscreenState)
    document.addEventListener('webkitfullscreenchange', syncFullscreenState)
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState)
      document.removeEventListener('webkitfullscreenchange', syncFullscreenState)
    }
  }, [])

  async function toggleFullscreen() {
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement

    try {
      if (fullscreenElement) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen
        if (!exit) throw new Error('Fullscreen exit is not supported')
        await exit.call(document)
        return
      }

      const target = document.documentElement
      const request = target.requestFullscreen || target.webkitRequestFullscreen
      if (!request) {
        window.alert('Este navegador o televisor no permite activar pantalla completa desde la página.')
        return
      }

      await request.call(target)
    } catch {
      window.alert('No fue posible activar pantalla completa. Inténtalo nuevamente desde este botón.')
    }
  }

  async function changeLocation(event) {
    const locationId = event.target.value
    if (!locationId || locationId === activeLocation?.id) return
    setSwitching(true)
    try {
      if (onEnterBranch) await onEnterBranch(locationId)
      else if (onLocationChange) await onLocationChange(locationId)
    } finally {
      setSwitching(false)
    }
  }

  async function enterBranchFromCentral(event) {
    const locationId = event.target.value
    if (!locationId || !onEnterBranch) return
    setSwitching(true)
    try {
      await onEnterBranch(locationId)
    } finally {
      setSwitching(false)
    }
  }

  const isBranch = workspaceMode === 'branch'
  const isCentral = workspaceMode === 'central'

  return (
    <header className="top">
      <div className="top-title-block">
        <h1>{title}</h1>

        {isCentral ? (
          <div className="top-branch-context top-scope-context">
            <span className="top-company-name">{companyName || 'Empresa'}</span>
            <span className="top-context-separator">·</span>
            <span className="top-scope-pill central">🏢 Control central</span>
          </div>
        ) : (
          <div className="top-branch-context">
            <span className="top-company-name">{companyName || 'Empresa'}</span>
            <span className="top-context-separator">·</span>
            {locations.length > 1 ? (
              <select
                className="top-branch-select"
                value={activeLocation?.id || ''}
                onChange={changeLocation}
                disabled={switching}
                aria-label="Sucursal activa"
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>{location.name}</option>
                ))}
              </select>
            ) : (
              <span className="top-branch-name">{activeLocation?.name || 'Sin sucursal'}</span>
            )}
          </div>
        )}
      </div>

      <div className="top-right-actions">
        <div className="actions top-context-actions">
          {isCentral && locations.length > 0 && (
            <select
              className="top-enter-branch"
              value=""
              onChange={enterBranchFromCentral}
              disabled={switching}
              aria-label="Entrar a una sucursal"
            >
              <option value="">📍 Entrar a sucursal…</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>{location.name}</option>
              ))}
            </select>
          )}

          {!isCentral && canCompanyControl && (
            <button className="btn" onClick={onEnterCentral}>🏢 Control central</button>
          )}

          {isBranch && canKitchen && <button className="btn" onClick={onKitchen}>🍳 Cocina</button>}
          {isBranch && canOrder && <button className="btn primary" onClick={onNewOrder}>＋ Nuevo pedido</button>}
        </div>

        <button
          type="button"
          className={`top-fullscreen-toggle ${fullscreen ? 'active' : ''}`}
          onClick={toggleFullscreen}
          aria-label={fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
          title={fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
        >
          <span aria-hidden="true">{fullscreen ? '⤢' : '⛶'}</span>
        </button>

        <button
          type="button"
          className="top-mobile-logout"
          onClick={onLogout}
          aria-label="Cerrar sesión"
          title="Cerrar sesión"
        >
          <span className="top-mobile-logout-icon">↪</span>
          <span className="top-mobile-logout-text">Salir</span>
        </button>
      </div>
    </header>
  )
}
