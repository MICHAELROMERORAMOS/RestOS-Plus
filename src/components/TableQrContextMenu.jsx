import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import './TableQrContextMenu.css'

// Kept separate from the table click handler, so regular table operations remain unchanged.
export default function TableQrContextMenu({ table, locationId, position, onClose, onGoToRequests }) {
  const [session, setSession] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [printing, setPrinting] = useState(false)

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

  function copyPin() {
    if (!session?.code) return
    navigator.clipboard?.writeText(session.code)
      .catch(() => window.prompt('Copia el PIN', session.code))
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
            <small>Autorización de pedidos QR</small>
          </div>
          <button type="button" className="table-qr-close" onClick={onClose} aria-label="Cerrar">×</button>
        </div>
        {busy && <p className="table-qr-hint">Consultando mesa…</p>}
        {error && <p className="table-qr-error" role="alert">{error}</p>}
        {session?.active ? (
          <div className="table-qr-pin">
            <small>{session.claimed ? 'Mesa abierta por el cliente' : 'PIN para entregar al cliente'}</small>
            <strong>{session.code}</strong>
            <small>Expira: {session.expiresAt ? new Date(session.expiresAt).toLocaleString('es') : '—'}</small>
          </div>
        ) : (
          <p className="table-qr-hint">Genera un PIN para que el cliente abra esta mesa escaneando su QR impreso.</p>
        )}
        {!session?.active && (
          <button type="button" className="btn primary table-qr-action" disabled={busy} onClick={() => action('open')}>
            Generar PIN de 4 dígitos
          </button>
        )}
        {session?.active && (
          <>
            <div className="table-qr-context-actions">
              <button type="button" className="btn" disabled={busy} onClick={copyPin}>Copiar PIN</button>
              <button type="button" className="btn" disabled={busy} onClick={printPin}>Imprimir PIN</button>
            </div>
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
