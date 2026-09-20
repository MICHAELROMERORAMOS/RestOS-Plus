import React from 'react'
import { orderPaidTotal } from '../../context/RestaurantContext.jsx'

export function deliveredItems(order) {
  return (order.rounds || []).flatMap((round) => (round.items || []))
    .filter((item) => !item.voided && item.prepStatus === 'delivered')
}

export function isPaidAndDelivered(order, orderBalance) {
  const items = (order.rounds || []).flatMap((round) => (round.items || [])).filter((item) => !item.voided)
  return order.status !== 'cancelled' && items.length > 0 && items.every((item) => item.prepStatus === 'delivered') && orderBalance(order) <= 0.005
}

function modeLabel(order, tableLabel) {
  if (order.mode === 'delivery') return `Domicilio · ${order.delivery?.customerName || 'Cliente'}`
  if (order.mode === 'quick') return `Servicio rápido · Orden #${order.id}`
  return tableLabel || 'Mesa'
}

export default function DeliveredOrderModal({
  orders,
  onClose,
  formatMoney,
  tableLabelFor,
  loading = false,
  hasMore = false,
  onLoadMore,
}) {
  return (
    <div className="modal open delivered-history-modal" onClick={onClose}>
      <div className="modal-card delivered-history-card" onClick={(event) => event.stopPropagation()}>
        <div className="section-title">
          <div><h3>📦 Historial de entregas</h3><p className="muted">Solo productos entregados y no anulados.</p></div>
          <button className="btn" onClick={onClose}>×</button>
        </div>
        {!orders.length && loading ? <div className="empty-block">Cargando historial…</div> : !orders.length ? <div className="empty-block">No hay pedidos entregados todavía.</div> : (
          <div className="list delivered-history-list">
            {orders.map((order) => {
              const items = deliveredItems(order)
              const paid = orderPaidTotal(order)
              return <article className="card" key={order.id}>
                <div className="section-title">
                  <div><h4>{modeLabel(order, tableLabelFor?.(order))}</h4><small>Orden #{order.id}{order.invoiceNumber ? ` · Factura ${order.invoiceNumber}` : ''}</small></div>
                  <small>{order.closedAt ? new Date(order.closedAt).toLocaleString('es-CO') : ''}</small>
                </div>
                <div className="list">
                  {items.map((item) => {
                    const quantity = Number(item.quantity || 0)
                    const price = Number(item.price || 0)
                    return <div className="list-row" key={`${order.id}-${item.lineId}`}><span>{quantity} × {item.name}<small>{formatMoney(price)} c/u</small></span><b>{formatMoney(price * quantity)}</b></div>
                  })}
                </div>
                <div className="section-title"><span>Total productos entregados</span><b>{formatMoney(order.total || items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0))}</b></div>
                <div className="section-title"><span>Valor pagado</span><b>{formatMoney(paid)}</b></div>
              </article>
            })}
            {hasMore && (
              <button className="btn full" type="button" onClick={onLoadMore} disabled={loading}>
                {loading ? 'Cargando…' : 'Cargar más entregas'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
