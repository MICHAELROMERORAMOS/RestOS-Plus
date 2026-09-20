import React, { useMemo, useState } from 'react'
import { useRestaurant, orderBalance, orderPaidTotal, orderTotal } from '../../context/RestaurantContext.jsx'

function money(value) {
  return Number(value || 0).toFixed(2)
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

export default function SplitBillModal({ orders, tableText, onClose }) {
  const { recordPayments, formatMoney } = useRestaurant()
  const [mode, setMode] = useState('choose')
  const [parts, setParts] = useState(2)
  const [paidParts, setPaidParts] = useState(0)
  const [selected, setSelected] = useState({})

  const activeOrders = useMemo(
    () => (orders || [])
      .filter((order) => !['closed', 'cancelled', 'merged'].includes(order.status) && orderBalance(order) > 0.005)
      .slice()
      .sort((a, b) => (a.created || 0) - (b.created || 0)),
    [orders],
  )

  const total = activeOrders.reduce((sum, order) => sum + orderTotal(order), 0)
  const paid = activeOrders.reduce((sum, order) => sum + orderPaidTotal(order), 0)
  const balance = activeOrders.reduce((sum, order) => sum + orderBalance(order), 0)

  const productLines = useMemo(() => (
    activeOrders.flatMap((order) => (
      (order.rounds || []).flatMap((round) => (
        (round.items || [])
          .filter((item) => !item.voided)
          .map((item) => {
            const alreadyAssigned = activeOrders
              .flatMap((candidate) => candidate.payments || [])
              .flatMap((payment) => payment.itemAllocations || [])
              .filter((allocation) => allocation.lineId === item.lineId)
              .reduce((sum, allocation) => sum + Number(allocation.quantity || 0), 0)

            return {
              key: `${order.id}:${item.lineId}`,
              orderId: order.id,
              lineId: item.lineId,
              name: item.name,
              price: Number(item.price || 0),
              availableQuantity: Math.max(0, Number(item.quantity || 0) - alreadyAssigned),
            }
          })
      ))
    )).filter((line) => line.availableQuantity > 0)
  ), [activeOrders])

  function allocateAcrossOrders(requestedAmount) {
    let remaining = Math.min(Number(requestedAmount || 0), balance)
    const allocations = []

    for (const order of activeOrders) {
      if (remaining <= 0.005) break
      const orderPending = orderBalance(order)
      if (orderPending <= 0.005) continue

      const amount = Math.min(orderPending, remaining)
      allocations.push({ orderId: order.id, amount })
      remaining -= amount
    }

    return allocations
  }

  async function performPayment(allocations, label, onSuccess) {
    const amount = allocations.reduce((sum, allocation) => sum + Number(allocation.amount || 0), 0)
    if (amount <= 0.005) return window.alert('No hay importe pendiente para cobrar.')

    const method = askPaymentMethod()
    if (!method) return

    const confirmed = window.confirm(
      `¿Confirmar cobro de ${formatMoney(amount)} para ${tableText}?\n\n${label}\n\nSi todavía hay productos pendientes, la mesa seguirá marcada como Esperando comida.`,
    )
    if (!confirmed) return

    const result = await recordPayments(allocations, method)
    if (!result.ok) return window.alert(result.message)

    onSuccess?.()
  }

  function chargeEqualPart() {
    if (balance <= 0.005) return onClose()

    const remainingParts = Math.max(1, Number(parts || 2) - Number(paidParts || 0))
    const amount = remainingParts === 1
      ? balance
      : Math.round((balance / remainingParts) * 100) / 100

    performPayment(
      allocateAcrossOrders(amount),
      `Parte ${paidParts + 1} de ${parts}.`,
      () => {
        const nextPaid = paidParts + 1
        if (nextPaid >= parts || balance - amount <= 0.005) {
          onClose()
        } else {
          setPaidParts(nextPaid)
        }
      },
    )
  }

  function setProductQuantity(line, nextQuantity) {
    const quantity = Math.max(0, Math.min(line.availableQuantity, Number(nextQuantity || 0)))
    setSelected((current) => ({
      ...current,
      [line.key]: quantity,
    }))
  }

  const selectedProductData = useMemo(() => {
    const itemAllocations = []

    productLines.forEach((line) => {
      const quantity = Number(selected[line.key] || 0)
      if (quantity <= 0) return

      itemAllocations.push({
        lineId: line.lineId,
        sourceOrderId: line.orderId,
        quantity,
        unitPrice: line.price,
        name: line.name,
      })
    })

    return {
      total: itemAllocations.reduce(
        (sum, allocation) => sum + (Number(allocation.quantity || 0) * Number(allocation.unitPrice || 0)),
        0,
      ),
      itemAllocations,
    }
  }, [productLines, selected])

  function chargeSelectedProducts() {
    if (selectedProductData.total <= 0.005) return window.alert('Selecciona al menos un producto.')
    if (selectedProductData.total > balance + 0.005) {
      return window.alert('Los productos seleccionados superan el saldo pendiente de la mesa.')
    }

    const allocations = allocateAcrossOrders(selectedProductData.total)
    if (!allocations.length) return window.alert('No hay saldo pendiente para cobrar.')

    allocations[0] = {
      ...allocations[0],
      itemAllocations: selectedProductData.itemAllocations,
    }

    performPayment(
      allocations,
      `Productos seleccionados · ${formatMoney(selectedProductData.total)}.`,
      () => setSelected({}),
    )
  }

  if (balance <= 0.005) return null

  return (
    <div className="modal open split-bill-modal" onClick={onClose}>
      <div className="modal-card split-bill-card" onClick={(event) => event.stopPropagation()}>
        <div className="section-title">
          <div>
            <h3>Dividir cuenta · {tableText}</h3>
            <p className="muted">Saldo pendiente {formatMoney(balance)} · Total {formatMoney(total)} · Pagado {formatMoney(paid)}</p>
          </div>
          <button className="btn" onClick={onClose}>×</button>
        </div>

        {mode === 'choose' && (
          <div className="split-choice-grid">
            <button className="split-choice" onClick={() => setMode('equal')}>
              <span className="split-choice-icon">÷</span>
              <b>Partes iguales</b>
              <small>Divide el saldo entre 2, 3, 4 o más cuentas.</small>
            </button>

            <button className="split-choice" onClick={() => setMode('products')}>
              <span className="split-choice-icon">🍽️</span>
              <b>Por productos</b>
              <small>Selecciona exactamente qué productos paga cada cliente.</small>
            </button>
          </div>
        )}

        {mode === 'equal' && (
          <div className="split-equal-panel">
            <button className="linkbtn" onClick={() => { setMode('choose'); setPaidParts(0) }}>← Cambiar tipo de división</button>

            <label className="split-parts-field">
              <span>Número de cuentas</span>
              <select
                value={parts}
                disabled={paidParts > 0}
                onChange={(event) => { setParts(Number(event.target.value)); setPaidParts(0) }}
              >
                {[2,3,4,5,6,7,8,9,10].map((count) => <option value={count} key={count}>{count} cuentas</option>)}
              </select>
            </label>

            <div className="split-equal-summary">
              <span>Parte {paidParts + 1} de {parts}</span>
              <strong>
                {formatMoney(
                  (parts - paidParts) <= 1
                    ? balance
                    : Math.round((balance / (parts - paidParts)) * 100) / 100,
                )}
              </strong>
              <small>Después de cobrar esta parte, RestOS+ recalcula automáticamente el saldo restante.</small>
            </div>

            <button className="btn primary full" onClick={chargeEqualPart}>Cobrar esta parte</button>
          </div>
        )}

        {mode === 'products' && (
          <div className="split-products-panel">
            <button className="linkbtn" onClick={() => { setMode('choose'); setSelected({}) }}>← Cambiar tipo de división</button>

            <div className="split-products-list">
              {productLines.length ? productLines.map((line) => {
                const selectedQty = Number(selected[line.key] || 0)

                return (
                  <div className="split-product-row" key={line.key}>
                    <div className="split-product-copy">
                      <b>{line.name}</b>
                      <small>{formatMoney(line.price)} c/u · {line.availableQuantity} disponible{line.availableQuantity === 1 ? '' : 's'}</small>
                    </div>

                    <div className="split-product-qty">
                      <button onClick={() => setProductQuantity(line, selectedQty - 1)} disabled={selectedQty <= 0}>−</button>
                      <strong>{selectedQty}</strong>
                      <button onClick={() => setProductQuantity(line, selectedQty + 1)} disabled={selectedQty >= line.availableQuantity}>+</button>
                    </div>

                    <strong className="split-product-total">{formatMoney(selectedQty * line.price)}</strong>
                  </div>
                )
              }) : <div className="empty-inline">No hay productos disponibles para dividir.</div>}
            </div>

            <div className="split-selected-total">
              <span>Productos seleccionados</span>
              <strong>{formatMoney(selectedProductData.total)}</strong>
            </div>

            <button
              className="btn primary full"
              disabled={selectedProductData.total <= 0.005 || selectedProductData.total > balance + 0.005}
              onClick={chargeSelectedProducts}
            >
              Cobrar productos seleccionados
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
