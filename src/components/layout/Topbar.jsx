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
}) {
  const [switching, setSwitching] = useState(false)

  async function changeLocation(event) {
    const locationId = event.target.value
    if (!locationId || locationId === activeLocation?.id || !onLocationChange) return
    setSwitching(true)
    try {
      await onLocationChange(locationId)
    } finally {
      setSwitching(false)
    }
  }

  return (
    <header className="top">
      <div className="top-title-block">
        <h1>{title}</h1>
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
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="top-branch-name">{activeLocation?.name || 'Sin sucursal'}</span>
          )}
        </div>
      </div>

      <div className="actions">
        {canKitchen && <button className="btn" onClick={onKitchen}>🍳 Cocina</button>}
        {canOrder && <button className="btn primary" onClick={onNewOrder}>＋ Nuevo pedido</button>}
      </div>
    </header>
  )
}
