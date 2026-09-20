import React from 'react'
import { useRestaurant, orderBalance, orderPaidTotal, orderTotal } from '../context/RestaurantContext.jsx'

export default function CashierPage() {
  const { state, recordPayment, tableLabel } = useRestaurant()
  const open = state.orders.filter((order) => (
    order.mode === 'table'
    && !['closed', 'cancelled', 'merged'].includes(order.status)
    && (order.rounds?.length || 0) > 0
  ))

  function charge(order, full = true) {
    const balance = orderBalance(order)
    if (balance <= 0) return window.alert('Esta cuenta ya está pagada.')

    const raw = full
      ? String(balance)
      : window.prompt(
        `Saldo pendiente €${balance.toFixed(2)}. ¿Cuánto deseas cobrar ahora?`,
        (balance / 2).toFixed(2),
      )

    if (raw === null) return

    const amount = Number(String(raw).replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0) return window.alert('Importe inválido.')

    const methodRaw = window.prompt('Método de pago: escribe cash o card. Pulsa Cancelar para abortar.', 'card')
    if (methodRaw === null) return

    const method = methodRaw.trim().toLowerCase()
    if (!['cash', 'card'].includes(method)) {
      return window.alert('Método inválido. Usa cash o card.')
    }

    if (full) {
      const tableText = order.tableIds.map((id) => tableLabel(id)).join(' + ')
      const confirmed = window.confirm(
        `¿Confirmar cobro de €${Math.min(amount, balance).toFixed(2)} y cerrar ${tableText || `Orden #${order.id}`}?`,
      )
      if (!confirmed) return
    }

    const result = recordPayment(order.id, amount, method)
    if (!result.ok) window.alert(result.message)
  }

  return (
    <section className="view active">
      <div className="hero">
        <div>
          <h2>Caja · Cobrar mesa</h2>
          <p>Permite pago total o parcial. La mesa solo se libera cuando la cuenta queda completamente pagada.</p>
        </div>
      </div>

      <div className="card">
        <div className="list">
          {open.length ? open.map((order) => {
            const total = orderTotal(order)
            const paid = orderPaidTotal(order)
            const balance = orderBalance(order)
            const tableText = order.tableIds.map((id) => tableLabel(id)).join(' + ')

            return (
              <div className="row cashier-row" key={order.id}>
                <div>
                  <b>{tableText} · Orden #{order.id}</b>
                  <small>{order.rounds.length} comandas · Total €{total.toFixed(2)} · Pagado €{paid.toFixed(2)}</small>
                </div>
                <div className="cash-actions">
                  <strong>Saldo €{balance.toFixed(2)}</strong>
                  <button className="btn" onClick={() => charge(order, false)}>Pago parcial</button>
                  <button className="btn primary" onClick={() => charge(order, true)}>Cobrar saldo y cerrar</button>
                </div>
              </div>
            )
          }) : <div className="empty-block">No hay cuentas abiertas.</div>}
        </div>
      </div>
    </section>
  )
}
