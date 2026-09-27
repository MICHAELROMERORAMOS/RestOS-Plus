import React, { useMemo, useState } from 'react'
import { useRestaurant, orderBalance, orderPaidTotal, orderTotal } from '../../context/RestaurantContext.jsx'
import InvoiceCustomerFields, {
  invoiceCustomerFromOrders,
  validateInvoiceCustomer,
} from './InvoiceCustomerFields.jsx'
import PaymentMethodPicker, { paymentMethodLabel } from './PaymentMethodPicker.jsx'

export default function SplitBillModal({
  orders,
  tableText,
  initialInvoiceCustomer,
  onClose,
  onAccountPaid,
  beforePayment,
  deliveryCourierSection,
}) {
  const { recordPayments, formatMoney } = useRestaurant()
  const [mode, setMode] = useState('choose')
  const [parts, setParts] = useState(2)
  const [paidParts, setPaidParts] = useState(0)
  const [selected, setSelected] = useState({})
  const [paymentMethod, setPaymentMethod] = useState('card')
  const [invoiceCustomer, setInvoiceCustomer] = useState(
    initialInvoiceCustomer || invoiceCustomerFromOrders(orders || []),
  )
  const [busy, setBusy] = useState(false)
  const [lastInvoices, setLastInvoices] = useState([])

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
    )).filter((line) => line.availableQuantity > 0.0001)
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

  function allocateSelectedProducts(itemAllocations) {
    const byOrder = new Map()

    itemAllocations.forEach((item) => {
      const amount = Number(item.quantity || 0) * Number(item.unitPrice || 0)
      if (amount <= 0) return

      const current = byOrder.get(item.sourceOrderId) || {
        orderId: item.sourceOrderId,
        amount: 0,
        itemAllocations: [],
      }

      current.amount += amount
      current.itemAllocations.push(item)
      byOrder.set(item.sourceOrderId, current)
    })

    return Array.from(byOrder.values())
  }

  async function performPayment(allocations, onSuccess) {
    const amount = allocations.reduce((sum, allocation) => sum + Number(allocation.amount || 0), 0)
    if (amount <= 0.005) return window.alert('No hay importe pendiente para cobrar.')

    const customerResult = validateInvoiceCustomer(invoiceCustomer)
    if (!customerResult.ok) return window.alert(customerResult.message)

    setBusy(true)
    try {
      if (beforePayment) {
        const gate = await beforePayment()
        if (!gate?.ok) {
          window.alert(gate?.message || 'Falta completar la información requerida antes de cobrar.')
          return
        }
      }

      const result = await recordPayments(allocations, paymentMethod, customerResult.customer)
      if (!result.ok) return window.alert(result.message)

      const invoices = Array.isArray(result.invoices) ? result.invoices : []
      setLastInvoices(invoices)

      try {
        await onAccountPaid?.(allocations, invoices)
      } catch (error) {
        window.alert(`El pago se registró, pero no se pudo completar una acción posterior: ${error?.message || 'error inesperado'}.`)
      }

      onSuccess?.(result)
    } finally {
      setBusy(false)
    }
  }

  function chargeEqualPart() {
    if (balance <= 0.005) return onClose()

    const remainingParts = Math.max(1, Number(parts || 2) - Number(paidParts || 0))
    const amount = remainingParts === 1
      ? balance
      : Math.round((balance / remainingParts) * 100) / 100

    performPayment(
      allocateAcrossOrders(amount),
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

    const allocations = allocateSelectedProducts(selectedProductData.itemAllocations)
    if (!allocations.length) return window.alert('No hay productos pendientes para cobrar.')

    performPayment(
      allocations,
      () => setSelected({}),
    )
  }

  if (balance <= 0.005) return null

  return (
    <div className="modal open split-bill-modal" onClick={() => !busy && onClose()}>
      <div className="modal-card split-bill-card split-bill-professional" onClick={(event) => event.stopPropagation()}>
        <div className="payment-checkout-header">
          <div>
            <span className="payment-checkout-kicker">DIVIDIR CUENTA</span>
            <h3>{tableText}</h3>
            <p>Selecciona cómo se repartirá el saldo y cobra cada factura por separado.</p>
          </div>
          <button className="payment-close" disabled={busy} onClick={onClose}>×</button>
        </div>

        <div className="order-payment-totals payment-checkout-totals">
          <div><span>Total cuenta</span><strong>{formatMoney(total)}</strong></div>
          <div><span>Pagado</span><strong>{formatMoney(paid)}</strong></div>
          <div className="balance"><span>Pendiente</span><strong>{formatMoney(balance)}</strong></div>
        </div>

        {lastInvoices.length > 0 && (
          <div className="notice ok split-payment-success">
            ✓ Factura{lastInvoices.length === 1 ? '' : 's'} generada{lastInvoices.length === 1 ? '' : 's'}: {' '}
            <b>{lastInvoices.map((invoice) => invoice.invoiceNumber).filter(Boolean).join(' · ')}</b>
          </div>
        )}

        {mode === 'choose' && (
          <div className="split-choice-grid">
            <button className="split-choice" onClick={() => setMode('equal')}>
              <span className="split-choice-icon">÷</span>
              <b>Partes iguales</b>
              <small>Cada cobro genera una factura independiente por el valor de esa parte.</small>
            </button>

            <button className="split-choice" onClick={() => setMode('products')}>
              <span className="split-choice-icon">🍽️</span>
              <b>Por productos</b>
              <small>Elige exactamente qué productos paga cada persona. Lo pagado desaparece de la lista pendiente.</small>
            </button>
          </div>
        )}

        {mode !== 'choose' && (
          <div className="split-checkout-grid">
            <div className="split-main-panel">
              <button
                className="linkbtn"
                disabled={busy}
                onClick={() => {
                  setMode('choose')
                  setPaidParts(0)
                  setSelected({})
                  setLastInvoices([])
                }}
              >
                ← Cambiar tipo de división
              </button>

              {mode === 'equal' && (
                <div className="split-equal-panel">
                  <label className="split-parts-field">
                    <span>Número de facturas / personas</span>
                    <select
                      value={parts}
                      disabled={paidParts > 0 || busy}
                      onChange={(event) => { setParts(Number(event.target.value)); setPaidParts(0) }}
                    >
                      {[2,3,4,5,6,7,8,9,10].map((count) => (
                        <option value={count} key={count}>{count} facturas</option>
                      ))}
                    </select>
                  </label>

                  <div className="split-equal-summary">
                    <span>Factura {paidParts + 1} de {parts}</span>
                    <strong>
                      {formatMoney(
                        (parts - paidParts) <= 1
                          ? balance
                          : Math.round((balance / (parts - paidParts)) * 100) / 100,
                      )}
                    </strong>
                    <small>Después del cobro se recalcula el saldo antes de generar la siguiente factura.</small>
                  </div>
                </div>
              )}

              {mode === 'products' && (
                <div className="split-products-panel">
                  <div className="split-products-heading">
                    <b>Productos pendientes de cobro</b>
                    <small>Los productos ya facturados no vuelven a aparecer aquí.</small>
                  </div>

                  <div className="split-products-list">
                    {productLines.length ? productLines.map((line) => {
                      const selectedQty = Number(selected[line.key] || 0)

                      return (
                        <div className="split-product-row" key={line.key}>
                          <div className="split-product-copy">
                            <b>{line.name}</b>
                            <small>
                              {formatMoney(line.price)} c/u · {line.availableQuantity} pendiente{line.availableQuantity === 1 ? '' : 's'}
                            </small>
                          </div>

                          <div className="split-product-qty">
                            <button type="button" onClick={() => setProductQuantity(line, selectedQty - 1)} disabled={busy || selectedQty <= 0}>−</button>
                            <strong>{selectedQty}</strong>
                            <button type="button" onClick={() => setProductQuantity(line, selectedQty + 1)} disabled={busy || selectedQty >= line.availableQuantity}>+</button>
                          </div>

                          <strong className="split-product-total">{formatMoney(selectedQty * line.price)}</strong>
                        </div>
                      )
                    }) : <div className="empty-inline">No quedan productos pendientes de facturar.</div>}
                  </div>

                  <div className="split-selected-total">
                    <span>Esta factura</span>
                    <strong>{formatMoney(selectedProductData.total)}</strong>
                  </div>
                </div>
              )}
            </div>

            <aside className="split-payment-panel">
              {deliveryCourierSection && (
                <div className="split-delivery-courier">
                  <div className="payment-checkout-section-head">
                    <div>
                      <span>DOMICILIARIO</span>
                      <b>Quién recogió el pedido</b>
                    </div>
                  </div>
                  {deliveryCourierSection}
                </div>
              )}

              <div className="payment-checkout-section-head">
                <div>
                  <span>MÉTODO DE PAGO</span>
                  <b>{paymentMethodLabel(paymentMethod)}</b>
                </div>
              </div>
              <PaymentMethodPicker
                value={paymentMethod}
                onChange={setPaymentMethod}
                disabled={busy}
              />

              <div className="split-invoice-customer">
                <div className="payment-checkout-section-head">
                  <div>
                    <span>FACTURAR A</span>
                    <b>Cliente de esta factura</b>
                  </div>
                </div>
                <InvoiceCustomerFields
                  value={invoiceCustomer}
                  onChange={setInvoiceCustomer}
                  disabled={busy}
                />
              </div>

              {mode === 'equal' ? (
                <button className="btn primary full" disabled={busy} onClick={chargeEqualPart}>
                  {busy ? 'Registrando…' : `Cobrar factura ${paidParts + 1}`}
                </button>
              ) : (
                <button
                  className="btn primary full"
                  disabled={busy || selectedProductData.total <= 0.005 || selectedProductData.total > balance + 0.005}
                  onClick={chargeSelectedProducts}
                >
                  {busy ? 'Registrando…' : 'Cobrar y generar factura'}
                </button>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  )
}
