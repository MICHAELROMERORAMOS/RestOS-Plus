import React, { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import './TableQrContextMenu.css'

// A long press opens this panel. The only customer credential is the branch's
// rotating six-digit code; no individual PIN is issued or displayed here.
export default function TableQrContextMenu({ table, locationId, position, onClose, onGoToRequests, orderEnabled = true, onPermissionChange, onShowCode }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function changePermission(next) {
    if (busy || !locationId || !table?.id) return
    setBusy(true)
    setError('')
    try {
      const { data, error: changeError } = await supabase.rpc('manage_qr_table_order_setting', {
        p_location_id: locationId, p_table_id: table.id, p_enabled: next,
      })
      if (changeError) throw changeError
      onPermissionChange?.(table.id, data?.enabledByTable?.[table.id] === true)
    } catch (exception) {
      setError(exception.message || 'No se pudo cambiar la configuración de la mesa.')
    } finally {
      setBusy(false)
    }
  }

  if (!table) return null
  return <>
    <div className="table-qr-context-backdrop" onClick={onClose} aria-hidden="true"/>
    <div className="table-qr-context" role="dialog" aria-modal="true"
      aria-label={`Opciones QR de ${table.name}`}
      style={{ top: position?.top ?? 90, left: position?.left ?? 20 }}
      onKeyDown={event => {if(event.key === 'Escape') onClose()}}>
      <div className="table-qr-context-head">
        <div><b>{table.name}</b><small>Acceso QR · Código único de 6 dígitos</small></div>
        <button type="button" className="table-qr-close" onClick={onClose} aria-label="Cerrar">×</button>
      </div>
      {error && <p className="table-qr-error" role="alert">{error}</p>}
      <div className="table-qr-order-permission">
        <div>
          <b>Permitir pedidos del cliente por QR</b>
          <small>{orderEnabled
            ? 'El cliente puede solicitar productos después de acceder con el código general.'
            : 'Los pedidos QR están bloqueados en esta mesa. El mesero puede pedir normalmente.'}</small>
        </div>
        <label className="table-qr-switch">
          <input type="checkbox" aria-label="Permitir pedidos QR de esta mesa" checked={orderEnabled}
            disabled={busy} onChange={event => changePermission(event.target.checked)}/>
          <span aria-hidden="true"/>
        </label>
      </div>
      <p className="table-qr-hint">El mismo código de 6 números sirve para todas las mesas de la sucursal y cambia cada 20 minutos. No necesitas generar códigos adicionales.</p>
      <button type="button" className="btn primary table-qr-action" onClick={() => {onClose();onShowCode?.()}}>
        🔐 Ver código de la sucursal
      </button>
      <button type="button" className="btn table-qr-action" onClick={onGoToRequests}>Ver solicitudes QR</button>
    </div>
  </>
}
