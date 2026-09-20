import React, { useMemo, useState } from 'react'
import SplitBillModal from '../components/payments/SplitBillModal.jsx'
import { useRestaurant, orderBalance, orderPaidTotal, orderTotal } from '../context/RestaurantContext.jsx'

function money(value) {
  return Number(value || 0).toFixed(2)
}

function groupKeyFor(order) {
  return [...(order.tableIds || [])].sort().join('|') || `order-${order.id}`
}

function askPaymentMethod() {
  const raw = window.prompt('Método de pago: escribe cash o card. Pulsa Cancelar para abortar.', 'card')
  if (raw === null) return null

  const method = raw.trim().toLowerCase()
  if (!['cash', 'card'].includes(method)) {
    window.alert('Método inválido. Usa cash o card.')
    return null
  }

  return method
}

export default function CashierPage() {
  const { state, recordPayments, tableLabel, formatMoney } = useRestaurant()
  const [splitGroupKey, setSplitGroupKey] = useState(null)

  const groups = useMemo(() => {
    const grouped = new Map()

    state.orders
      .filter((order) => (
        order.mode === 'table'
        && !['closed', 'cancelled', 'merged'].includes(order.status)
        && (order.rounds?.length || 0) > 0
        && orderBalance(order) > 0.005
      ))
      .forEach((order) => {
        const key = groupKeyFor(order)
        const existing = grouped.get(key) || {
          key,
          tableIds: [...(order.tableIds || [])],
          orders: [],
        }

        existing.orders.push(order)
        grouped.set(key, existing)
      })

    return Array.from(grouped.values())
      .map((group) => {
        const orders = group.orders.slice().sort((a, b) => (a.created || 0) - (b.created || 0))

        return {
          ...group,
          orders,
          total: orders.reduce((sum, order) => sum + orderTotal(order), 0),
          paid: orders.reduce((sum, order) => sum + orderPaidTotal(order), 0),
          balance: orders.reduce((sum, order) => sum + orderBalance(order), 0),
          tableText: group.tableIds.map((id) => tableLabel(id)).join(' + '),
        }
      })
      .sort((a, b) => (a.orders[0]?.created || 0) - (b.orders[0]?.created || 0))
  }, [state.orders, tableLabel])

  const splitGroup = splitGroupKey
    ? groups.find((group) => group.key === splitGroupKey) || null
    : null

  function allocateAcrossOrders(group, requestedAmount) {
    let remaining = Math.min(Number(requestedAmount || 0), group.balance)
    const allocations = []

    for (const order of group.orders) {
      if (remaining <= 0.005) break

      const balance = orderBalance(order)
      if (balance <= 0.005) continue

      const amount = Math.min(balance, remaining)
      allocations.push({ orderId: order.id, amount })
      remaining -= amount
    }

    return allocations
  }

  function performPayment(group, allocations, label) {
    const total = allocations.reduce((sum, allocation) => sum + Number(allocation.amount || 0), 0)
    if (total <= 0.005) return window.alert('No hay importe pendiente para cobrar.')

    const method = askPaymentMethod()
    if (!method) return

    const confirmed = window.confirm(
      `¿Confirmar cobro de ${formatMoney(total)} para ${group.tableText}?\n\n${label}\n\nSi todavía hay productos pendientes, la mesa seguirá marcada como Esperando comida.`,
    )
    if (!confirmed) return

    const result = recordPayments(allocations, method)
    if (!result.ok) window.alert(result.message)
  }

  function chargeFull(group) {
    performPayment(
      group,
      allocateAcrossOrders(group, group.balance),
      'Cuenta completa de la mesa.',
    )
  }

  function chargeCustom(group) {
    const raw = window.prompt(
      `Saldo total de ${group.tableText}: ${formatMoney(group.balance)}. ¿Cuánto deseas cobrar ahora?`,
      money(group.balance / 2),
    )
    if (raw === null) return

    const amount = Number(String(raw).replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0) return window.alert('Importe inválido.')
    if (amount > group.balance + 0.005) return window.alert('El importe supera el saldo pendiente.')

    performPayment(
      group,
      allocateAcrossOrders(group, amount),
      'Pago parcial por importe.',
    )
  }

  return (
    <section className="view active">
      <div className="hero">
        <div>
          <h2>Caja · Cobrar mesa</h2>
          <p>Una mesa se cobra como una sola cuenta, aunque tenga varias comandas u órdenes internas. Solo se divide cuando el cliente lo solicita.</p>
        </div>
      </div>

      <div className="card">
        <div className="list cashier-groups">
          {groups.length ? groups.map((group) => (
            <div className="row cashier-row cashier-group-row" key={group.key}>
              <div className="cashier-account-copy">
                <b>{group.tableText}</b>
                <small>
                  Cuenta única · {group.orders.length} {group.orders.length === 1 ? 'orden interna' : 'órdenes internas'}
                  {' · '}Total {formatMoney(group.total)} · Pagado {formatMoney(group.paid)}
                </small>
              </div>

              <div className="cash-actions">
                <strong>Saldo {formatMoney(group.balance)}</strong>
                <button className="btn" onClick={() => chargeCustom(group)}>Pago por importe</button>
                <button className="btn" onClick={() => setSplitGroupKey(group.key)}>Dividir cuenta</button>
                <button className="btn primary" onClick={() => chargeFull(group)}>Cobrar todo</button>
              </div>
            </div>
          )) : <div className="empty-block">No hay cuentas pendientes de cobro.</div>}
        </div>
      </div>

      {splitGroup && (
        <SplitBillModal
          orders={splitGroup.orders}
          tableText={splitGroup.tableText}
          onClose={() => setSplitGroupKey(null)}
        />
      )}
    </section>
  )
}
