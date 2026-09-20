import React, { useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import {
  useRestaurant,
  orderBalance,
  orderPaidTotal,
  orderTotal,
} from '../context/RestaurantContext.jsx'
import {
  consumeAccountVoidAuthorization,
  requestAccountVoidAuthorization,
  sendAccountVoidConfirmation,
} from '../services/voidAuthorizationService.js'
import DeliveredOrderModal, { isPaidAndDelivered } from '../components/orders/DeliveredOrderModal.jsx'

export default function OrdersPage() {
  const auth = useAuth()
  const {
    state,
    tableLabel,
    formatMoney,
    voidPaidTableAccount,
  } = useRestaurant()

  const restaurantId = auth.userContext?.membership?.restaurant_id || null
  const canVoidPaidAccount = auth.can('orders.account_void.paid')

  const [voidTarget, setVoidTarget] = useState(null)
  const [voidReason, setVoidReason] = useState('')
  const [requestId, setRequestId] = useState(null)
  const [voidCode, setVoidCode] = useState('')
  const [expiresAt, setExpiresAt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showDelivered, setShowDelivered] = useState(false)

  const completedOrders = state.orders.filter((order) => ['table', 'quick'].includes(order.mode) && isPaidAndDelivered(order, orderBalance))

  function orderItems(order) {
    return (order.rounds || []).flatMap((round) => (
      (round.items || [])
        .filter((item) => !item.voided)
        .map((item) => ({
          orderId: order.id,
          roundId: round.id,
          lineId: item.lineId,
          name: item.name,
          quantity: Number(item.quantity || 0),
          amount: Number(item.price || 0) * Number(item.quantity || 0),
        }))
    ))
  }

  function closeVoidModal() {
    if (busy) return
    setVoidTarget(null)
    setVoidReason('')
    setRequestId(null)
    setVoidCode('')
    setExpiresAt(null)
  }

  function openPaidVoid(order, tableText) {
    if (!canVoidPaidAccount) return

    const paid = orderPaidTotal(order)
    const balance = orderBalance(order)

    if (paid <= 0.005 || balance > 0.005) {
      return window.alert('Esta opciÃ³n es Ãºnicamente para cuentas ya cobradas al 100 %.')
    }

    if (Number(order.refundDue || 0) > 0.005 || order.accountVoidedAt) {
      return window.alert('Esta cuenta ya tiene una anulaciÃ³n o reembolso pendiente.')
    }

    setVoidTarget({
      order,
      tableText,
      paid,
      items: orderItems(order),
    })
    setVoidReason('')
    setRequestId(null)
    setVoidCode('')
    setExpiresAt(null)
  }

  async function requestCode() {
    if (!voidTarget || !restaurantId) return
    if (voidReason.trim().length < 4) {
      return window.alert('Escribe un motivo claro para anular la cuenta cobrada.')
    }

    setBusy(true)

    try {
      const result = await requestAccountVoidAuthorization({
        restaurantId,
        orderRef: voidTarget.order.id,
        tableLabel: voidTarget.tableText,
        amountPaid: voidTarget.paid,
        reason: voidReason.trim(),
        fullyPaid: true,
      })

      setRequestId(result.requestId)
      setExpiresAt(result.expiresAt || null)
      setVoidCode('')
    } catch (error) {
      window.alert(error?.message || 'No se pudo enviar el cÃ³digo al administrador.')
    } finally {
      setBusy(false)
    }
  }

  async function confirmCode() {
    if (!voidTarget || !requestId) return

    const code = voidCode.trim()
    if (!/^\d{6}$/.test(code)) {
      return window.alert('Introduce el cÃ³digo de 6 dÃ­gitos enviado al correo del administrador.')
    }

    setBusy(true)

    try {
      const auditId = await consumeAccountVoidAuthorization({
        requestId,
        code,
        orderRef: voidTarget.order.id,
        tableLabel: voidTarget.tableText,
        items: voidTarget.items,
        reason: voidReason.trim(),
        amountPaid: voidTarget.paid,
      })

      const result = await voidPaidTableAccount(
        [voidTarget.order.id],
        {
          reason: voidReason.trim(),
          auditId,
          authorizationRequestId: requestId,
          allowFullyPaid: true,
        },
      )

      if (!result.ok) throw new Error(result.message)

      let emailWarning = ''
      try {
        await sendAccountVoidConfirmation(auditId)
      } catch (error) {
        emailWarning = `\n\nLa cuenta fue anulada, pero no se pudo enviar el correo de confirmaciÃ³n: ${error?.message || 'error de correo'}`
      }

      setBusy(false)
      setVoidTarget(null)
      setVoidReason('')
      setRequestId(null)
      setVoidCode('')
      setExpiresAt(null)

      window.alert(
        `Cuenta cobrada anulada. Reembolso pendiente: ${formatMoney(result.refundDue)}.${emailWarning}`,
      )
    } catch (error) {
      window.alert(error?.message || 'No se pudo validar la anulaciÃ³n de la cuenta cobrada.')
      setBusy(false)
    }
  }

  return (
    <section className="view active">
      <div className="hero">
        <div>
          <h2>Pedidos</h2>
          <p>Historial, estado operativo y rondas enviadas.</p>
        </div>
        <button className="btn" onClick={() => setShowDelivered(true)}>ð¦ Entregados ({completedOrders.length})</button>
      </div>

      <div className="card">
        <div className="list">
          {state.orders.length ? state.orders.slice().reverse().map((order) => {
            const allItems = (order.rounds || []).flatMap((round) => round.items || [])
            const activeItems = allItems.filter((item) => !item.voided)
            const tableText = order.tableIds?.length
              ? order.tableIds.map((id) => tableLabel(id)).join(' + ')
              : order.mode === 'delivery'
                ? `Domicilio Â· ${order.delivery?.customerName || 'Cliente'}`
                : 'Servicio rÃ¡pido'

            const paid = orderPaidTotal(order)
            const balance = orderBalance(order)
            const fullyPaidTable = (
              order.mode === 'table'
              && paid > 0.005
              && balance <= 0.005
              && Number(order.refundDue || 0) <= 0.005
              && !order.accountVoidedAt
            )

            return (
              <div className="row order-history-row" key={order.id}>
                <div className="order-history-copy">
                  <b>#{order.id} Â· {tableText}{order.pager ? ` Â· Pager ${order.pager}` : ''}</b>
                  <small>
                    {order.mode === 'delivery' && order.delivery
                      ? `${order.delivery.address} Â· ${order.delivery.neighborhood} Â· ${order.delivery.city} Â· ${order.delivery.phone} Â· `
                      : ''}
                    {order.rounds.length} comandas Â· {
                      (order.accountVoidedAt ? allItems : activeItems)
                        .map((item) => `${item.quantity}Ã ${item.name}`)
                        .join(', ') || 'Sin productos'
                    }
                  </small>

                  {order.accountVoidedAt && (
                    <span className="void-request-state rejected">
                      Cuenta anulada Â· Reembolso pendiente {formatMoney(order.refundDue || paid)}
                    </span>
                  )}

                  {order.fiscalCorrectionRequired && (
                    <span className="void-lock critical">
                      Factura emitida Â· requiere correcciÃ³n fiscal externa
                    </span>
                  )}
                </div>

                <div className="history-meta">
                  <span className="badge">{String(order.status || 'open').toUpperCase()}</span>
                  <strong>{formatMoney(orderTotal(order))}</strong>
                  {balance > 0.005 && <small>Saldo {formatMoney(balance)}</small>}

                  {canVoidPaidAccount && fullyPaidTable && (
                    <button className="mini danger paid-order-void-btn" onClick={() => openPaidVoid(order, tableText)}>
                      ð Anular cuenta cobrada
                    </button>
                  )}
                </div>
              </div>
            )
          }) : <div className="empty-block">TodavÃ­a no hay pedidos.</div>}
        </div>
      </div>

      {showDelivered && <DeliveredOrderModal orders={completedOrders} onClose={() => setShowDelivered(false)} formatMoney={formatMoney} tableLabelFor={(order) => (order.tableIds || []).map((id) => tableLabel(id)).join(' + ')} />}

      {voidTarget && (
        <div className="modal open controlled-void-modal" onClick={closeVoidModal}>
          <div className="modal-card controlled-void-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div>
                <h3>ð Anular cuenta ya cobrada</h3>
                <p className="muted">{voidTarget.tableText} Â· Orden #{voidTarget.order.id}</p>
              </div>
              <button className="btn" disabled={busy} onClick={closeVoidModal}>Ã</button>
            </div>

            <div className="account-void-summary paid-account-summary">
              <div>
                <span>Total cobrado</span>
                <strong>{formatMoney(voidTarget.paid)}</strong>
              </div>
              <div className="refund">
                <span>Reembolso pendiente</span>
                <strong>{formatMoney(voidTarget.paid)}</strong>
              </div>
            </div>

            <div className="account-void-products">
              {voidTarget.items.map((item) => (
                <div key={item.lineId}>
                  <span>{item.quantity} Ã {item.name}</span>
                  <strong>{formatMoney(item.amount)}</strong>
                </div>
              ))}
            </div>

            <label className="controlled-void-reason">
              <span>Motivo *</span>
              <textarea
                value={voidReason}
                disabled={Boolean(requestId) || busy}
                onChange={(event) => setVoidReason(event.target.value)}
                placeholder="Explica por quÃ© debe anularse esta cuenta ya cobrada"
              />
            </label>

            {!requestId ? (
              <>
                <div className="notice warn">
                  Esta operaciÃ³n es exclusiva del Owner / Super Admin. Se enviarÃ¡ un cÃ³digo de 6 dÃ­gitos al correo del administrador y la mesa no volverÃ¡ a abrirse.
                </div>

                <button className="btn primary full" disabled={busy} onClick={requestCode}>
                  {busy ? 'Enviando cÃ³digoâ¦' : 'Enviar cÃ³digo al administrador'}
                </button>
              </>
            ) : (
              <>
                <div className="notice">
                  CÃ³digo enviado.
                  {expiresAt ? ` VÃ¡lido hasta ${new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : ''}
                </div>

                <label className="void-code-field">
                  <span>CÃ³digo de autorizaciÃ³n</span>
                  <input
                    inputMode="numeric"
                    maxLength="6"
                    value={voidCode}
                    onChange={(event) => setVoidCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                  />
                </label>

                <div className="notice warn">
                  Al confirmar se anularÃ¡ la cuenta histÃ³rica completa y el total ya cobrado quedarÃ¡ como reembolso pendiente.
                </div>

                <button className="btn primary full" disabled={busy || voidCode.length !== 6} onClick={confirmCode}>
                  {busy ? 'Validandoâ¦' : 'Validar cÃ³digo y anular cuenta cobrada'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
