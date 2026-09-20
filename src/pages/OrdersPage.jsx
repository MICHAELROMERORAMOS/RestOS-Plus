import React from 'react'
import { useRestaurant, orderBalance, orderTotal } from '../context/RestaurantContext.jsx'

export default function OrdersPage() {
  const { state, tableLabel } = useRestaurant()
  return (
    <section className="view active">
      <div className="hero"><div><h2>Pedidos</h2><p>Historial, estado operativo y rondas enviadas.</p></div></div>
      <div className="card">
        <div className="list">
          {state.orders.length ? state.orders.slice().reverse().map((order) => {
            const items = order.rounds.flatMap((round) => round.items).filter((item) => !item.voided)
            const tableText = order.tableIds?.length
              ? order.tableIds.map((id) => tableLabel(id)).join(' + ')
              : order.mode === 'delivery'
                ? `Domicilio · ${order.delivery?.customerName || 'Cliente'}`
                : 'Servicio rápido'
            return (
              <div className="row order-history-row" key={order.id}>
                <div>
                  <b>#{order.id} · {tableText}{order.pager ? ` · Pager ${order.pager}` : ''}</b>
                  <small>
                    {order.mode === 'delivery' && order.delivery
                      ? `${order.delivery.address} · ${order.delivery.neighborhood} · ${order.delivery.city} · ${order.delivery.phone} · `
                      : ''}
                    {order.rounds.length} comandas · {items.map((item) => `${item.quantity}× ${item.name}`).join(', ') || 'Sin productos'}
                  </small>
                </div>
                <div className="history-meta"><span className="badge">{String(order.status || 'open').toUpperCase()}</span><strong>€{orderTotal(order).toFixed(2)}</strong>{orderBalance(order) > 0.005 && <small>Saldo €{orderBalance(order).toFixed(2)}</small>}</div>
              </div>
            )
          }) : <div className="empty-block">Todavía no hay pedidos.</div>}
        </div>
      </div>
    </section>
  )
}
