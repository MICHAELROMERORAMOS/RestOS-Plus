import React, { useMemo, useState } from 'react'
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
  const { state, recordPayments, tableLabel } = useRestaurant()
  const [split, setSplit] = useState(null)

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
      .sort((a, b) => {
        const aTime = a.orders[0]?.created || 0
        const bTime = b.orders[0]?.created || 0
        return aTime - bTime
      })
  }, [state.orders, tableLabel])

  const activeGroup = split ? groups.find((group) => group.key === split.groupKey) : null

  const productLines = useMemo(() => {
    if (!activeGroup) return []

    return activeGroup.orders.flatMap((order) => (
      (order.rounds || []).flatMap((round) => (
        (round.items || [])
          .filter((item) => !item.voided)
          .map((item) => {
            const alreadyAssigned = (order.payments || [])
              .flatMap((payment) => payment.itemAllocations || [])
              .filter((allocation) => allocation.lineId === item.lineId)
              .reduce((sum, allocation) => sum + Number(allocation.quantity || 0), 0)

            return {
              key: `${order.id}:${item.lineId}`,
              orderId: order.id,
              lineId: item.lineId,
              name: item.name,
              price: Number(item.price || 0),
              quantity: Number(item.quantity || 0),
              availableQuantity: Math.max(0, Number(item.quantity || 0) - alreadyAssigned),
              roundId: round.id,
            }
          })
      ))
    )).filter((line) => line.availableQuantity > 0)
  }, [activeGroup])

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

  function performPayment(group, allocations, label, onSuccess) {
    const total = allocations.reduce((sum, allocation) => sum + Number(allocation.amount || 0), 0)
    if (total <= 0.005) return window.alert('No hay importe pendiente para cobrar.')

    const method = askPaymentMethod()
    if (!method) return

    const confirmed = window.confirm(
      `¿Confirmar cobro de €${money(total)} para ${group.tableText}?\n\n${label}\n\nSi todavía hay productos pendientes, la mesa seguirá marcada como Esperando comida.`,
    )
    if (!confirmed) return

    const result = recordPayments(allocations, method)
    if (!result.ok) return window.alert(result.message)
    onSuccess?.()
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
      `Saldo total de ${group.tableText}: €${money(group.balance)}. ¿Cuánto deseas cobrar ahora?`,
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

  function openSplit(group) {
    setSplit({
      groupKey: group.key,
      mode: 'choose',
      parts: 2,
      paidParts: 0,
      selected: {},
    })
  }

  function chargeEqualPart() {
    if (!activeGroup || !split) return
    const remainingParts = Math.max(1, Number(split.parts || 2) - Number(split.paidParts || 0))
    const amount = remainingParts === 1
      ? activeGroup.balance
      : Math.round((activeGroup.balance / remainingParts) * 100) / 100

    performPayment(
      activeGroup,
      allocateAcrossOrders(activeGroup, amount),
      `Parte ${split.paidParts + 1} de ${split.parts}.`,
      () => {
        const nextPaid = split.paidParts + 1
        if (nextPaid >= split.parts || activeGroup.balance - amount <= 0.005) {
          setSplit(null)
        } else {
          setSplit((current) => current ? { ...current, paidParts: nextPaid } : current)
        }
      },
    )
  }

  function setProductQuantity(line, nextQuantity) {
    const quantity = Math.max(0, Math.min(line.availableQuantity, Number(nextQuantity || 0)))
    setSplit((current) => current ? {
      ...current,
      selected: {
        ...current.selected,
        [line.key]: quantity,
      },
    } : current)
  }

  const selectedProductData = useMemo(() => {
    if (!activeGroup || !split) return { total: 0, allocations: [], invalidOrderIds: [] }

    const byOrder = new Map()

    productLines.forEach((line) => {
      const quantity = Number(split.selected?.[line.key] || 0)
      if (quantity <= 0) return

      const existing = byOrder.get(line.orderId) || {
        orderId: line.orderId,
        amount: 0,
        itemAllocations: [],
      }

      existing.amount += quantity * line.price
      existing.itemAllocations.push({
        lineId: line.lineId,
        quantity,
        unitPrice: line.price,
        name: line.name,
      })
      byOrder.set(line.orderId, existing)
    })

    const allocations = Array.from(byOrder.values())
    const invalidOrderIds = allocations
      .filter((allocation) => {
        const order = activeGroup.orders.find((candidate) => candidate.id === allocation.orderId)
        return !order || allocation.amount > orderBalance(order) + 0.005
      })
      .map((allocation) => allocation.orderId)

    return {
      total: allocations.reduce((sum, allocation) => sum + allocation.amount, 0),
      allocations,
      invalidOrderIds,
    }
  }, [activeGroup, productLines, split])

  function chargeSelectedProducts() {
    if (!activeGroup || !split) return
    if (selectedProductData.total <= 0.005) return window.alert('Selecciona al menos un producto.')
    if (selectedProductData.total > activeGroup.balance + 0.005) {
      return window.alert('Los productos seleccionados superan el saldo pendiente.')
    }
    if (selectedProductData.invalidOrderIds.length) {
      return window.alert('Hay pagos previos en esta cuenta que impiden asignar esos productos exactamente. Reduce la selección o usa división por importe.')
    }

    performPayment(
      activeGroup,
      selectedProductData.allocations,
      `Productos seleccionados · €${money(selectedProductData.total)}.`,
      () => setSplit((current) => current ? { ...current, selected: {} } : current),
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
                  {' · '}Total €{money(group.total)} · Pagado €{money(group.paid)}
                </small>
              </div>

              <div className="cash-actions">
                <strong>Saldo €{money(group.balance)}</strong>
                <button className="btn" onClick={() => chargeCustom(group)}>Pago por importe</button>
                <button className="btn" onClick={() => openSplit(group)}>Dividir cuenta</button>
                <button className="btn primary" onClick={() => chargeFull(group)}>Cobrar todo</button>
              </div>
            </div>
          )) : <div className="empty-block">No hay cuentas pendientes de cobro.</div>}
        </div>
      </div>

      {split && activeGroup && (
        <div className="modal open split-bill-modal" onClick={() => setSplit(null)}>
          <div className="modal-card split-bill-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div>
                <h3>Dividir cuenta · {activeGroup.tableText}</h3>
                <p className="muted">Saldo pendiente €{money(activeGroup.balance)}</p>
              </div>
              <button className="btn" onClick={() => setSplit(null)}>×</button>
            </div>

            {split.mode === 'choose' && (
              <div className="split-choice-grid">
                <button className="split-choice" onClick={() => setSplit((current) => ({ ...current, mode: 'equal' }))}>
                  <span className="split-choice-icon">÷</span>
                  <b>Partes iguales</b>
                  <small>Divide el saldo entre 2, 3, 4 o más cuentas.</small>
                </button>

                <button className="split-choice" onClick={() => setSplit((current) => ({ ...current, mode: 'products' }))}>
                  <span className="split-choice-icon">🍽️</span>
                  <b>Por productos</b>
                  <small>Selecciona exactamente qué productos paga cada cliente.</small>
                </button>
              </div>
            )}

            {split.mode === 'equal' && (
              <div className="split-equal-panel">
                <button className="linkbtn" onClick={() => setSplit((current) => ({ ...current, mode: 'choose', paidParts: 0 }))}>← Cambiar tipo de división</button>

                <label className="split-parts-field">
                  <span>Número de cuentas</span>
                  <select
                    value={split.parts}
                    disabled={split.paidParts > 0}
                    onChange={(event) => setSplit((current) => ({ ...current, parts: Number(event.target.value), paidParts: 0 }))}
                  >
                    {[2,3,4,5,6,7,8,9,10].map((count) => <option value={count} key={count}>{count} cuentas</option>)}
                  </select>
                </label>

                <div className="split-equal-summary">
                  <span>Parte {split.paidParts + 1} de {split.parts}</span>
                  <strong>
                    €{money(
                      (split.parts - split.paidParts) <= 1
                        ? activeGroup.balance
                        : Math.round((activeGroup.balance / (split.parts - split.paidParts)) * 100) / 100,
                    )}
                  </strong>
                  <small>Después de cobrar esta parte, RestOS+ recalcula automáticamente el saldo restante.</small>
                </div>

                <button className="btn primary full" onClick={chargeEqualPart}>Cobrar esta parte</button>
              </div>
            )}

            {split.mode === 'products' && (
              <div className="split-products-panel">
                <button className="linkbtn" onClick={() => setSplit((current) => ({ ...current, mode: 'choose', selected: {} }))}>← Cambiar tipo de división</button>

                <div className="split-products-list">
                  {productLines.length ? productLines.map((line) => {
                    const selectedQty = Number(split.selected?.[line.key] || 0)
                    return (
                      <div className="split-product-row" key={line.key}>
                        <div className="split-product-copy">
                          <b>{line.name}</b>
                          <small>€{money(line.price)} c/u · {line.availableQuantity} disponible{line.availableQuantity === 1 ? '' : 's'}</small>
                        </div>

                        <div className="split-product-qty">
                          <button onClick={() => setProductQuantity(line, selectedQty - 1)} disabled={selectedQty <= 0}>−</button>
                          <strong>{selectedQty}</strong>
                          <button onClick={() => setProductQuantity(line, selectedQty + 1)} disabled={selectedQty >= line.availableQuantity}>+</button>
                        </div>

                        <strong className="split-product-total">€{money(selectedQty * line.price)}</strong>
                      </div>
                    )
                  }) : <div className="empty-inline">No hay productos disponibles para dividir.</div>}
                </div>

                <div className="split-selected-total">
                  <span>Productos seleccionados</span>
                  <strong>€{money(selectedProductData.total)}</strong>
                </div>

                <button
                  className="btn primary full"
                  disabled={selectedProductData.total <= 0.005 || selectedProductData.total > activeGroup.balance + 0.005 || selectedProductData.invalidOrderIds.length > 0}
                  onClick={chargeSelectedProducts}
                >
                  Cobrar productos seleccionados
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
