import React, { useEffect, useMemo, useState } from 'react'
import SplitBillModal from '../components/payments/SplitBillModal.jsx'
import InvoiceCustomerFields, {
  invoiceCustomerFromOrders,
  validateInvoiceCustomer,
} from '../components/payments/InvoiceCustomerFields.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useRestaurant, orderBalance, orderPaidTotal, orderTotal } from '../context/RestaurantContext.jsx'
import {
  createKitchenVoidRequest,
  listMyKitchenVoidRequestsForOrders,
} from '../services/voidAuthorizationService.js'

function money(value) {
  return Number(value || 0).toFixed(2)
}

function groupKeyFor(order) {
  return [...(order.tableIds || [])].sort().join('|') || `order-${order.id}`
}

function groupItems(group, { requestableOnly = false } = {}) {
  return (group?.orders || []).flatMap((order) => (
    (order.rounds || []).flatMap((round) => (
      (round.items || [])
        .filter((item) => !item.voided && (!requestableOnly || item.prepStatus !== 'delivered'))
        .map((item) => ({
          orderId: order.id,
          roundId: round.id,
          lineId: item.lineId,
          name: item.name,
          quantity: Number(item.quantity || 0),
          amount: Number(item.price || 0) * Number(item.quantity || 0),
        }))
    ))
  ))
}

export default function CashierPage() {
  const auth = useAuth()
  const {
    state,
    recordPayments,
    tableLabel,
    formatMoney,
    voidRequestsVersion,
  } = useRestaurant()

  const restaurantId = auth.userContext?.membership?.restaurant_id || null
  const canRequestUnpaidVoid = auth.can('orders.void.request_unpaid')

  const [splitGroupKey, setSplitGroupKey] = useState(null)
  const [chargeGroupKey, setChargeGroupKey] = useState(null)
  const [chargeAmount, setChargeAmount] = useState('')
  const [chargeMethod, setChargeMethod] = useState('card')
  const [chargeLabel, setChargeLabel] = useState('')
  const [chargeInvoiceCustomer, setChargeInvoiceCustomer] = useState(() => invoiceCustomerFromOrders([]))
  const [chargeBusy, setChargeBusy] = useState(false)
  const [myVoidRequests, setMyVoidRequests] = useState([])

  const [voidRequestGroupKey, setVoidRequestGroupKey] = useState(null)
  const [voidSelected, setVoidSelected] = useState({})
  const [voidReason, setVoidReason] = useState('')
  const [voidBusy, setVoidBusy] = useState(false)


  const groups = useMemo(() => {
    const grouped = new Map()

    state.orders
      .filter((order) => (
        ['table', 'quick', 'delivery'].includes(order.mode)
        && !['closed', 'cancelled', 'merged'].includes(order.status)
        && (order.rounds?.length || 0) > 0
        && (orderBalance(order) > 0.005 || Number(order.refundDue || 0) > 0.005)
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
          refundDue: orders.reduce((sum, order) => sum + Number(order.refundDue || 0), 0),
          tableText: group.tableIds.length
            ? group.tableIds.map((id) => tableLabel(id)).join(' + ')
            : group.orders[0]?.mode === 'delivery'
              ? `Domicilio · ${group.orders[0]?.delivery?.customerName || 'Sin cliente'}`
              : `Servicio rápido · Orden #${group.orders[0]?.id || ''}`,
        }
      })
      .sort((a, b) => (a.orders[0]?.created || 0) - (b.orders[0]?.created || 0))
  }, [state.orders, tableLabel])

  const splitGroup = splitGroupKey
    ? groups.find((group) => group.key === splitGroupKey) || null
    : null

  const chargeGroup = chargeGroupKey
    ? groups.find((group) => group.key === chargeGroupKey) || null
    : null

  const voidRequestGroup = voidRequestGroupKey
    ? groups.find((group) => group.key === voidRequestGroupKey) || null
    : null

  const latestRequestByLine = useMemo(() => {
    const map = new Map()

    myVoidRequests.forEach((request) => {
      ;(request.items || []).forEach((item) => {
        const key = `${request.order_ref}:${item.lineId}`
        if (!map.has(key)) map.set(key, request)
      })
    })

    return map
  }, [myVoidRequests])

  async function refreshVoidRequests({ silent = false } = {}) {
    if (!restaurantId || !canRequestUnpaidVoid) {
      setMyVoidRequests([])
      return
    }

    const unpaidOrders = groups
      .filter((group) => group.paid <= 0.005)
      .flatMap((group) => group.orders)

    if (!unpaidOrders.length) {
      setMyVoidRequests([])
      return
    }

    try {
      const requests = await listMyKitchenVoidRequestsForOrders(
        restaurantId,
        unpaidOrders.map((order) => order.id),
      )
      setMyVoidRequests(requests)
    } catch (error) {
      if (!silent) window.alert(error?.message || 'No se pudieron consultar las solicitudes de anulación.')
    }
  }

  useEffect(() => {
    if (!restaurantId || !canRequestUnpaidVoid) return undefined

    refreshVoidRequests({ silent: true })
    return undefined
  }, [restaurantId, canRequestUnpaidVoid, groups.length, voidRequestsVersion])

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

  function chargeFull(group) {
    setChargeGroupKey(group.key)
    setChargeAmount(money(group.balance))
    setChargeMethod('card')
    setChargeLabel('Cuenta completa.')
    setChargeInvoiceCustomer(invoiceCustomerFromOrders(group.orders))
  }

  function chargeCustom(group) {
    setChargeGroupKey(group.key)
    setChargeAmount(money(group.balance / 2))
    setChargeMethod('card')
    setChargeLabel('Pago por importe.')
    setChargeInvoiceCustomer(invoiceCustomerFromOrders(group.orders))
  }

  function closeCharge() {
    if (chargeBusy) return
    setChargeGroupKey(null)
    setChargeAmount('')
  }

  async function confirmPayment() {
    if (!chargeGroup) return

    const amount = Number(String(chargeAmount).replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0) return window.alert('Introduce un importe válido.')
    if (amount > chargeGroup.balance + 0.005) return window.alert('El importe supera el saldo pendiente.')

    const allocations = allocateAcrossOrders(chargeGroup, amount)
    if (!allocations.length) return window.alert('No hay saldo pendiente para cobrar.')

    const customerResult = validateInvoiceCustomer(chargeInvoiceCustomer)
    if (!customerResult.ok) return window.alert(customerResult.message)

    const invoiceText = customerResult.customer.requested
      ? `${customerResult.customer.fullName} · ${customerResult.customer.documentType} ${customerResult.customer.documentNumber}`
      : 'Consumidor final'
    const confirmed = window.confirm(
      `¿Confirmar cobro de ${formatMoney(amount)} para ${chargeGroup.tableText}?\n\n${chargeLabel}\nMétodo: ${chargeMethod === 'cash' ? 'Efectivo' : 'Tarjeta'}\nFactura: ${invoiceText}`,
    )
    if (!confirmed) return

    setChargeBusy(true)
    const result = await recordPayments(allocations, chargeMethod, customerResult.customer)
    setChargeBusy(false)
    if (!result.ok) return window.alert(result.message)
    closeCharge()
  }

  function openVoidRequest(group) {
    if (!canRequestUnpaidVoid) return
    if (group.paid > 0.005) return window.alert('La cuenta ya tiene pagos. Debe usarse la anulación de cuenta completa con autorización.')

    setVoidRequestGroupKey(group.key)
    setVoidSelected({})
    setVoidReason('')
  }

  async function submitVoidRequest() {
    if (!voidRequestGroup || !restaurantId) return
    if (voidRequestGroup.paid > 0.005) {
      return window.alert('La cuenta ya tiene pagos y ya no puede enviarse a Cocina como anulación no pagada.')
    }

    const selectedItems = groupItems(voidRequestGroup, { requestableOnly: true })
      .filter((item) => voidSelected[`${item.orderId}:${item.lineId}`])

    if (!selectedItems.length) return window.alert('Selecciona al menos un producto.')
    if (voidReason.trim().length < 4) return window.alert('Escribe un motivo claro.')

    const byOrder = new Map()
    selectedItems.forEach((item) => {
      const list = byOrder.get(item.orderId) || []
      list.push(item)
      byOrder.set(item.orderId, list)
    })

    setVoidBusy(true)

    try {
      for (const [orderId, items] of byOrder.entries()) {
        await createKitchenVoidRequest({
          restaurantId,
          orderRef: orderId,
          tableLabel: voidRequestGroup.tableText,
          items,
          reason: voidReason.trim(),
        })
      }

      setVoidRequestGroupKey(null)
      setVoidSelected({})
      setVoidReason('')
      await refreshVoidRequests({ silent: true })
    } catch (error) {
      window.alert(error?.message || 'No se pudo enviar la solicitud a Cocina.')
    } finally {
      setVoidBusy(false)
    }
  }

  return (
    <section className="view active">
      <div className="hero">
        <div>
          <h2>Caja · Cobrar cuentas</h2>
          <p>Cobra mesas, servicios rápidos y domicilios; la factura puede quedar a consumidor final o a nombre del cliente.</p>
        </div>
      </div>

      <div className="card">
        <div className="list cashier-groups">
          {groups.length ? groups.map((group) => {
            const unpaid = group.paid <= 0.005 && group.refundDue <= 0.005
            const refundPending = group.refundDue > 0.005

            return (
              <div className="row cashier-row cashier-group-row" key={group.key}>
                <div className="cashier-account-copy">
                  <b>{group.tableText}</b>
                  <small>
                    Cuenta única · {group.orders.length} {group.orders.length === 1 ? 'orden interna' : 'órdenes internas'}
                    {' · '}Total {formatMoney(group.total)} · Pagado {formatMoney(group.paid)}
                  </small>
                  {refundPending && <span className="void-request-state rejected">Reembolso pendiente {formatMoney(group.refundDue)}</span>}
                </div>

                <div className="cash-actions">
                  {refundPending ? (
                    <strong>Reembolso {formatMoney(group.refundDue)}</strong>
                  ) : (
                    <>
                      <strong>Saldo {formatMoney(group.balance)}</strong>
                      <button className="btn" onClick={() => chargeCustom(group)}>Pago por importe</button>
                      <button className="btn" onClick={() => setSplitGroupKey(group.key)}>Dividir cuenta</button>
                      <button className="btn primary" onClick={() => chargeFull(group)}>Cobrar todo</button>

                      {unpaid && canRequestUnpaidVoid && (
                        <button className="btn danger-outline" onClick={() => openVoidRequest(group)}>
                          Solicitar anulación
                        </button>
                      )}

                    </>
                  )}
                </div>
              </div>
            )
          }) : <div className="empty-block">No hay cuentas pendientes de cobro.</div>}
        </div>
      </div>

      {chargeGroup && (
        <div className="modal open" onClick={closeCharge}>
          <div className="modal-card cashier-payment-modal" onClick={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div>
                <h3>💳 Cobrar · {chargeGroup.tableText}</h3>
                <p className="muted">Saldo pendiente {formatMoney(chargeGroup.balance)}</p>
              </div>
              <button className="btn" disabled={chargeBusy} onClick={closeCharge}>×</button>
            </div>

            <div className="settings-form cashier-payment-fields">
              <label>
                <span>Importe a cobrar</span>
                <input
                  inputMode="decimal"
                  value={chargeAmount}
                  disabled={chargeBusy}
                  onChange={(event) => setChargeAmount(event.target.value)}
                />
              </label>

              <label>
                <span>Método de pago</span>
                <select value={chargeMethod} disabled={chargeBusy} onChange={(event) => setChargeMethod(event.target.value)}>
                  <option value="card">Tarjeta</option>
                  <option value="cash">Efectivo</option>
                </select>
              </label>
            </div>

            <div className="order-payment-shortcuts">
              <button className="btn" disabled={chargeBusy} onClick={() => setChargeAmount(money(chargeGroup.balance / 2))}>½ saldo</button>
              <button className="btn" disabled={chargeBusy} onClick={() => setChargeAmount(money(chargeGroup.balance))}>Saldo completo</button>
            </div>

            <InvoiceCustomerFields
              value={chargeInvoiceCustomer}
              onChange={setChargeInvoiceCustomer}
              disabled={chargeBusy}
            />

            <button className="btn primary full" disabled={chargeBusy} onClick={confirmPayment}>
              {chargeBusy ? 'Registrando cobro…' : 'Confirmar cobro'}
            </button>
          </div>
        </div>
      )}

      {splitGroup && (
        <SplitBillModal
          orders={splitGroup.orders}
          tableText={splitGroup.tableText}
          initialInvoiceCustomer={invoiceCustomerFromOrders(splitGroup.orders)}
          onClose={() => setSplitGroupKey(null)}
        />
      )}

      {voidRequestGroup && (
        <div className="modal open" onClick={() => !voidBusy && setVoidRequestGroupKey(null)}>
          <div className="modal-card controlled-void-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div>
                <h3>⚠ Solicitar anulación a Cocina</h3>
                <p className="muted">{voidRequestGroup.tableText} · cuenta sin pagos</p>
              </div>
              <button className="btn" disabled={voidBusy} onClick={() => setVoidRequestGroupKey(null)}>×</button>
            </div>

            <div className="void-request-product-list">
              {groupItems(voidRequestGroup, { requestableOnly: true }).map((item) => {
                const key = `${item.orderId}:${item.lineId}`
                const requestState = latestRequestByLine.get(key)

                return (
                  <label className="void-request-product" key={key}>
                    <input
                      type="checkbox"
                      disabled={requestState?.status === 'pending'}
                      checked={Boolean(voidSelected[key])}
                      onChange={() => setVoidSelected((current) => ({ ...current, [key]: !current[key] }))}
                    />
                    <span>
                      <b>{item.quantity} × {item.name}</b>
                      <small>
                        {formatMoney(item.amount)}
                        {requestState?.status === 'pending' ? ' · Pendiente Cocina' : ''}
                      </small>
                    </span>
                  </label>
                )
              })}
            </div>

            <label className="controlled-void-reason">
              <span>Motivo *</span>
              <textarea
                value={voidReason}
                onChange={(event) => setVoidReason(event.target.value)}
                placeholder="Explica por qué se solicita la anulación"
              />
            </label>

            <button className="btn primary full" disabled={voidBusy} onClick={submitVoidRequest}>
              {voidBusy ? 'Enviando…' : 'Enviar solicitud a Cocina'}
            </button>
          </div>
        </div>
      )}

    </section>
  )
}
