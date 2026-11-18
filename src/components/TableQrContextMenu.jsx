import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import './TableQrContextMenu.css'

// Kept separate from the table click handler, so regular table operations remain unchanged.
export default function TableQrContextMenu({ table, locationId, position, onClose, onGoToRequests, orderEnabled = true, onPermissionChange }) {
  const [session, setSession] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [printing, setPrinting] = useState(false)
  const [savingPermission, setSavingPermission] = useState(false)

  useEffect(() => {
    let active = true
    if (!table?.id || !supabase) return undefined
    setBusy(true)
    setSession(null)
    setError('')
    supabase.rpc('manage_qr_guest_session', { p_table_id: table.id, p_action: 'read' })
      .then(({ data, error: requestError }) => {
        if (!active) return
        if (requestError) setError(requestError.message)
        else setSession(data)
      })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [table?.id, locationId])

  useEffect(() => {
    if (!table) return undefined
    function onKeyDown(event) { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [table, onClose])

  async function action(name) {
    if (busy) return
    setBusy(true)
    setError('')
    const { data, error: requestError } = await supabase.rpc('manage_qr_guest_session', {
      p_table_id: table.id,
      p_action: name,
    })
    if (requestError) setError(requestError.message)
    else setSession(data)
    setBusy(false)
  }

  async function changePermission(next) {
    if (busy || savingPermission || !locationId || !table?.id) return
    setSavingPermission(true)
    setError('')
    const { data, error: changeError } = await supabase.rpc('manage_qr_table_order_setting', {
      p_location_id: locationId, p_table_id: table.id, p_enabled: next,
    })
    if (changeError) setError(changeError.message)
    else {
      onPermissionChange?.(table.id, data?.enabledByTable?.[table.id] === true)
    }
    setSavingPermission(false)
  }

  function copyPin() {
    if (!session?.code) return
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(session.code)
        .catch(() => window.prompt('Copia el PIN', session.code))
    } else {
      window.prompt('Copia el PIN', session.code)
    }
  }

  function printPin() {
    if (!session?.active) return
    setPrinting(true)
    window.setTimeout(() => {
      window.print()
      setPrinting(false)
    }, 180)
  }

  if (!table) return null
  return (
    <>
      <div className="table-qr-context-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="table-qr-context"
        role="dialog"
        aria-label={`Opciones QR de ${table.name}`}
        style={{ top: position?.top ?? 90, left: position?.left ?? 20 }}
      >
        <div className="table-qr-context-head">
          <div>
            <b>{table.name}</b>
            <small>Mantén pulsada la mesa para gestionar las opciones QR</small>
          </div>
          <button type="button" className="table-qr-close" onClick={onClose} aria-label="Cerrar">×</button>
        </div>
        {busy && <p className="table-qr-hint">Consultando mesa…</p>}
        {error && <p className="table-qr-error" role="alert">{error}</p>}
        <div className="table-qr-order-permission">
          <div>
            <b>Permitir pedidos del cliente por QR</b>
            <small>{orderEnabled ? 'Los clientes pueden enviar pedidos desde esta mesa.' : 'Bloqueado solo para clientes. El mesero puede tomar pedidos normalmente.'}</small>
          </div>
          <label className="table-qr-switch" aria-label="Habilitar pedidos QR para esta mesa">
            <input type="checkbox" checked={orderEnabled} disabled={busy || savingPermission} onChange={event => changePermission(event.target.checked)} />
            <span aria-hidden="true" />
          </label>
        </div>
        {!orderEnabled && <p className="table-qr-hint">Esta mesa mantiene el menú digital y las solicitudes de atención QR cuando estén habilitadas. No acepta nuevos pedidos de productos desde el celular.</p>}
        {session?.active && orderEnabled ? (
          <div className="table-qr-pin">
            <small>{session.claimed ? 'Mesa abierta por el cliente' : 'PIN para entregar al cliente'}</small>
            <strong>{session.code}</strong>
            <small>Expira: {session.expiresAt ? new Date(session.expiresAt).toLocaleString('es') : '—'}</small>
          </div>
        ) : orderEnabled ? (
          <p className="table-qr-hint">Genera un PIN para que el cliente abra esta mesa escaneando su QR impreso.</p>
        ) : null}
        {!session?.active && orderEnabled && (
          <button type="button" className="btn primary table-qr-action" disabled={busy || !orderEnabled} onClick={() => action('open')}>
            Generar PIN de 4 dígitos
          </button>
        )}
        {session?.active && (
          <>
            {orderEnabled && <div className="table-qr-context-actions">
              <button type="button" className="btn" disabled={busy} onClick={copyPin}>Copiar PIN</button>
              <button type="button" className="btn" disabled={busy} onClick={printPin}>Imprimir PIN</button>
            </div>}
            <button type="button" className="btn table-qr-action" disabled={busy} onClick={() => action('close')}>
              Desactivar PIN
            </button>
          </>
        )}
        <button type="button" className="btn table-qr-action" onClick={onGoToRequests}>
          Ver solicitudes QR
        </button>
      </div>
      {printing && session?.active && (
        <div className="table-qr-single-print">
          <h2>{table.name}</h2>
          <p>PIN temporal para pedidos QR</p>
          <strong>{session.code}</strong>
          <p>Escanea el QR de la mesa e introduce estos 4 números.</p>
          <small>RestOS+ · Solo para esta visita</small>
        </div>
      )}
    </>
  )
}
