import React, { useState } from 'react'

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
}) {
  const [switching, setSwitching] = useState(false)

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
    </header>
  )
}
