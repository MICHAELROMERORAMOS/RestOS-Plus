import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import './QrGuestOperations.css'

function formatRequestTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Hora no disponible'
  return date.toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export default function QrGuestOperations({ locationId, formatMoney }) {
  const [requests, setRequests] = useState([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [processingId, setProcessingId] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const requestEpoch = useRef(0)
  const processingRef = useRef(false)

  const loadRequests = useCallback(async (showLoading = false) => {
    const epoch = ++requestEpoch.current
    if (!locationId || !supabase) {
      setRequests([])
      return
    }
    if (showLoading) setLoading(true)
    const { data, error: fetchError } = await supabase.rpc('manage_qr_guest_requests', {
      p_location_id: locationId,
      p_action: 'list',
    })
    if (epoch !== requestEpoch.current) return
    if (fetchError) setError(fetchError.message || 'No se pudieron cargar las solicitudes QR.')
    else {
      setRequests(Array.isArray(data?.requests) ? data.requests : [])
      setError('')
    }
    if (showLoading) setLoading(false)
  }, [locationId])

  useEffect(() => {
    setRequests([])
    setQuery('')
    setNotice('')
    setError('')
    void loadRequests(true)
    const poll = () => {
      if (document.visibilityState === 'visible' && !processingRef.current) void loadRequests()
    }
    const timer = window.setInterval(poll, 8000)
    window.addEventListener('focus', poll)
    return () => {
      ++requestEpoch.current
      window.clearInterval(timer)
      window.removeEventListener('focus', poll)
    }
  }, [loadRequests])

  const pending = useMemo(() =>
    requests
      .filter((req) => req.status === 'pending')
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [requests],
  )

  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase('es')
    if (!term) return pending
    return pending.filter((req) =>
      [req.tableName, ...(Array.isArray(req.items) ? req.items.map((item) => item.name) : [])]
        .some((text) => String(text || '').toLocaleLowerCase('es').includes(term)),
    )
  }, [pending, query])

  async function review(req, action) {
    if (processingRef.current) return
    const confirmMessage = action === 'reviewed'
      ? `¿Confirmar la solicitud de ${req.tableName} y enviar sus productos a preparación?`
      : `¿Rechazar la solicitud de ${req.tableName}?`
    if (!window.confirm(confirmMessage)) return

    processingRef.current = true
    setProcessingId(req.id)
    setError('')
    setNotice('')
    const { error: actionError } = await supabase.rpc('manage_qr_guest_requests', {
      p_location_id: locationId,
      p_request_id: req.id,
      p_action: action,
    })
    if (actionError) {
      setError(actionError.message || 'No se pudo procesar la solicitud.')
    } else {
      setNotice(action === 'reviewed'
        ? `Pedido de ${req.tableName} confirmado y enviado a preparación.`
        : `Solicitud de ${req.tableName} rechazada.`)
    }
    processingRef.current = false
    setProcessingId(null)
    await loadRequests()
  }

  return (
    <div className="card section-gap qr-requests-workspace">
      <div className="qr-requests-toolbar">
        <div className="qr-requests-heading">
          <h3>Solicitudes de clientes</h3>
          <span className="badge">{pending.length} pendientes</span>
        </div>
        <button type="button" className="btn qr-requests-refresh" onClick={() => loadRequests(true)} disabled={loading || processingId !== null}>
          {loading ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>

      <div className="qr-requests-filters">
        <label className="qr-requests-search">
          <span className="sr-only">Buscar mesa o producto</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar mesa o producto…" autoComplete="off" />
        </label>
        <span className="qr-requests-status-label">Pendientes de confirmación</span>
      </div>

      {error && <div className="notice warn" role="alert">{error}</div>}
      {notice && <div className="notice qr-requests-success" role="status">{notice}</div>}

      <div className="qr-requests-grid">
        {filtered.map((req) => (
          <article className="qr-request-card" key={req.id}>
            <div className="qr-request-head">
              <div className="qr-request-table">
                <strong>{req.tableName || 'Mesa'}</strong>
                <small>{formatRequestTime(req.createdAt)}</small>
              </div>
              <span className="qr-request-status">Pendiente</span>
            </div>
            <div className="qr-request-items">
              {(Array.isArray(req.items) ? req.items : []).map((item, i) => (
                <div className="qr-request-item" key={`${item.productId || 'p'}-${i}`}>
                  <span className="qr-request-quantity">{item.quantity} ×</span>
                  <span>{item.name}</span>
                </div>
              ))}
            </div>
            <div className="qr-request-total">
              <span>Total solicitado</span>
              <strong>{typeof formatMoney === 'function' ? formatMoney(Number(req.total || 0)) : req.total}</strong>
            </div>
            <div className="qr-request-actions">
              <button type="button" className="btn" disabled={processingId !== null} onClick={() => review(req, 'rejected')}>
                Rechazar
              </button>
              <button type="button" className="btn primary" disabled={processingId !== null} onClick={() => review(req, 'reviewed')}>
                {processingId === req.id ? 'Procesando…' : 'Confirmar y enviar'}
              </button>
            </div>
          </article>
        ))}
      </div>

      {!loading && pending.length === 0 && (
        <div className="qr-requests-empty">
          <span aria-hidden="true">✓</span>
          <strong>Sin solicitudes pendientes</strong>
          <p>Los pedidos enviados desde el menú QR aparecerán aquí automáticamente.</p>
        </div>
      )}
      {!loading && pending.length > 0 && filtered.length === 0 && (
        <div className="qr-requests-empty">
          <strong>No hay solicitudes que coincidan.</strong>
          <p>Prueba otro nombre de mesa o producto.</p>
        </div>
      )}
      <p className="qr-requests-footnote">
        La autorización y el PIN se gestionan desde Mesas. Confirma los alérgenos antes de enviar cada solicitud a preparación.
      </p>
    </div>
  )
}
