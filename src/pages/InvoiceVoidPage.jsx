import React, { useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import {
  consumeInvoiceVoidAuthorization,
  findPaidInvoiceForVoid,
  requestInvoiceVoidAuthorization,
  sendAccountVoidConfirmation,
} from '../services/voidAuthorizationService.js'

const REASONS = [
  'Error al cobrar',
  'Factura duplicada',
  'Pedido equivocado',
  'Cliente solicita cancelación',
  'Error de precio o descuento',
  'Otro',
]

export default function InvoiceVoidPage() {
  const auth = useAuth()
  const { formatMoney, refreshOperationalData } = useRestaurant()
  const restaurantId = auth.userContext?.membership?.restaurant_id || null

  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [invoice, setInvoice] = useState(null)
  const [reason, setReason] = useState('')
  const [comment, setComment] = useState('')
  const [requestId, setRequestId] = useState(null)
  const [expiresAt, setExpiresAt] = useState(null)
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [completed, setCompleted] = useState(null)

  const expiryLabel = useMemo(() => {
    if (!expiresAt) return ''
    return new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }, [expiresAt])

  function resetAuthorization() {
    setReason('')
    setComment('')
    setRequestId(null)
    setExpiresAt(null)
    setCode('')
    setCompleted(null)
  }

  async function searchInvoice(event) {
    event?.preventDefault()
    const normalized = invoiceNumber.trim().toUpperCase()
    if (!normalized) return setMessage('Introduce el número de factura.')
    if (!restaurantId || auth.isDesignMode) {
      return setMessage('Inicia sesión en el restaurante para consultar facturas reales.')
    }

    setBusy(true)
    setMessage('')
    setInvoice(null)
    resetAuthorization()
    try {
      const found = await findPaidInvoiceForVoid(restaurantId, normalized)
      setInvoice(found)
      setInvoiceNumber(found.invoiceNumber)
    } catch (error) {
      setMessage(error?.message || 'No se pudo consultar la factura.')
    } finally {
      setBusy(false)
    }
  }

  async function requestCode() {
    if (!invoice) return
    if (!reason) return setMessage('Selecciona el motivo de la anulación.')
    if (comment.trim().length < 5) return setMessage('Escribe una observación de al menos 5 caracteres.')

    setBusy(true)
    setMessage('')
    try {
      const result = await requestInvoiceVoidAuthorization({
        restaurantId,
        invoiceNumber: invoice.invoiceNumber,
        reason,
        comment,
      })
      setRequestId(result.requestId)
      setExpiresAt(result.expiresAt)
      setCode('')
      setMessage(`Código enviado al owner. Es válido hasta ${new Date(result.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`)
    } catch (error) {
      setMessage(error?.message || 'No se pudo enviar el código al owner.')
    } finally {
      setBusy(false)
    }
  }

  async function confirmVoid() {
    if (!requestId || !/^\d{6}$/.test(code)) return setMessage('Introduce el código de 6 dígitos.')
    setBusy(true)
    setMessage('')
    try {
      const result = await consumeInvoiceVoidAuthorization({ requestId, code })
      if (!result?.ok) {
        const suffix = Number.isFinite(result?.attemptsRemaining)
          ? ` Quedan ${result.attemptsRemaining} intentos.`
          : ''
        setMessage(`${result?.message || 'El código no es válido.'}${suffix}`)
        return
      }

      await refreshOperationalData()
      let emailWarning = ''
      try {
        await sendAccountVoidConfirmation(result.auditId)
      } catch (error) {
        emailWarning = ` La anulación se guardó, pero falló el correo de confirmación: ${error?.message || 'error de correo'}.`
      }

      setCompleted(result)
      setInvoice(null)
      setRequestId(null)
      setCode('')
      setMessage(`Factura ${result.invoiceNumber} anulada. Reembolso pendiente: ${formatMoney(result.refundDue)}.${emailWarning}`)
    } catch (error) {
      setMessage(error?.message || 'No se pudo confirmar la anulación.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="view active">
      <div className="hero">
        <div>
          <h2>Anular factura</h2>
          <p>Solo se pueden anular facturas pagadas al 100 %. La factura se conserva para auditoría.</p>
        </div>
      </div>

      <div className="grid two">
        <div className="card">
          <div className="section-title">
            <h3>Buscar factura</h3>
            <span className="badge">Solo pagadas</span>
          </div>
          <form className="order-tools" onSubmit={searchInvoice}>
            <input
              value={invoiceNumber}
              onChange={(event) => setInvoiceNumber(event.target.value.toUpperCase())}
              placeholder="Ej. FAC-000017"
              disabled={busy || Boolean(requestId)}
            />
            <button className="btn primary" disabled={busy || Boolean(requestId)}>
              {busy && !invoice ? 'Buscando…' : 'Buscar factura'}
            </button>
          </form>

          {message && <div className={completed ? 'notice' : 'notice warn'}>{message}</div>}

          {invoice && (
            <div className="invoice-void-result">
              <div className="row">
                <div>
                  <b>{invoice.invoiceNumber}</b>
                  <small>{invoice.tableLabel || `Orden #${invoice.orderNumber}`} · {new Date(invoice.issuedAt).toLocaleString()}</small>
                </div>
                <span className="badge">PAGADA 100 %</span>
              </div>

              <div className="list" style={{ marginTop: 12 }}>
                {(invoice.items || []).map((item) => (
                  <div className="row" key={item.id}>
                    <span>{Number(item.quantity)} × {item.name}</span>
                    <strong>{formatMoney(item.amount)}</strong>
                  </div>
                ))}
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                <b>Total pagado</b>
                <strong>{formatMoney(invoice.paidTotal)}</strong>
              </div>

              <label className="controlled-void-reason">
                <span>Motivo *</span>
                <select value={reason} disabled={Boolean(requestId) || busy} onChange={(event) => setReason(event.target.value)}>
                  <option value="">Seleccionar motivo…</option>
                  {REASONS.map((item) => <option key={item}>{item}</option>)}
                </select>
              </label>

              <label className="controlled-void-reason">
                <span>Observación *</span>
                <textarea
                  value={comment}
                  disabled={Boolean(requestId) || busy}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="Explica por qué debe anularse esta factura"
                />
              </label>

              {!requestId ? (
                <button className="btn primary full" disabled={busy} onClick={requestCode}>
                  {busy ? 'Enviando código…' : 'Solicitar anulación y enviar código'}
                </button>
              ) : (
                <>
                  <label className="void-code-field">
                    <span>Código enviado al owner {expiryLabel && `· vence ${expiryLabel}`}</span>
                    <input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength="6"
                      value={code}
                      onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                    />
                  </label>
                  <div className="notice warn">
                    Al confirmar se anulará la factura completa y el total quedará como reembolso pendiente. El inventario no se reintegra automáticamente.
                  </div>
                  <button className="btn primary full" disabled={busy || code.length !== 6} onClick={confirmVoid}>
                    {busy ? 'Validando…' : 'Validar código y anular factura'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="card">
          <div className="section-title"><h3>Seguridad y auditoría</h3><span>🔐</span></div>
          <div className="list">
            <div className="row"><b>Estado requerido</b><span>Pagada al 100 %</span></div>
            <div className="row"><b>Código</b><span>6 dígitos · un uso</span></div>
            <div className="row"><b>Vigencia</b><span>10 minutos</span></div>
            <div className="row"><b>Intentos</b><span>Máximo 5</span></div>
            <div className="row"><b>Resultado</b><span>Reembolso pendiente</span></div>
          </div>
          <div className="notice warn">
            RestOS+ no elimina ni reutiliza la factura. Conserva productos, pagos, motivo, solicitante, autorización y fecha de anulación.
          </div>
        </div>
      </div>
    </section>
  )
}
