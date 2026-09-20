import React, { useEffect, useMemo, useState } from 'react'
import SplitBillModal from '../components/payments/SplitBillModal.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { useRestaurant, orderBalance, orderPaidTotal, orderTotal } from '../context/RestaurantContext.jsx'
import {
  createKitchenVoidRequest,
  listMyKitchenVoidRequests,
  markKitchenVoidRequestApplied,
} from '../services/voidAuthorizationService.js'

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
    applyKitchenApprovedVoidRequest,
  } = useRestaurant()

  const restaurantId = auth.userContext?.membership?.restaurant_id || null
  const canRequestUnpaidVoid = auth.can('orders.void.request_unpaid')

  const [splitGroupKey, setSplitGroupKey] = useState(null)
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
      const batches = await Promise.all(
        unpaidOrders.map((order) => listMyKitchenVoidRequests(restaurantId, order.id)),
      )
      const requests = batches.flat()
      setMyVoidRequests(requests)

      for (const request of requests) {
        if (request.status !== 'approved' || request.applied_at) continue

        const order = unpaidOrders.find((candidate) => String(candidate.id) === String(request.order_ref))
        if (!order || orderPaidTotal(order) > 0.005) continue

        const result = applyKitchenApprovedVoidRequest(order.id, request)
        if (!result.ok) continue

        try {
          await markKitchenVoidRequestApplied(request.id)
        } catch {
          // Retry acknowledgement on next poll.
        }
      }
    } catch (error) {
      if (!silent) window.alert(error?.message || 'No se pudieron consultar las solicitudes de anulación.')
    }
  }

  useEffect(() => {
    if (!restaurantId || !canRequestUnpaidVoid) return undefined

    refreshVoidRequests({ silent: true })
    const timer = window.setInterval(() => {
      refreshVoidRequests({ silent: true })
    }, 5000)

    return () => window.clearInterval(timer)
  }, [restaurantId, canRequestUnpaidVoid, groups.length])

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

  async function performPayment(group, allocations, label) {
    const total = allocations.reduce((sum, allocation) => sum + Number(allocation.amount || 0), 0)
    if (total <= 0.005) return window.alert('No hay importe pendiente para cobrar.')

    const method = askPaymentMethod()
    if (!method) return

    const confirmed = window.confirm(
      `¿Confirmar cobro de ${formatMoney(total)} para ${group.tableText}?\n\n${label}\n\nSi todavía hay productos pendientes, la mesa seguirá marcada como Esperando comida.`,
    )
    if (!confirmed) return

    const result = await recordPayments(allocations, method)
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
          <h2>Caja · Cobrar mesa</h2>
          <p>Una mesa se cobra como una sola cuenta. Las anulaciones sin pago pasan por Cocina; las facturas pagadas se anulan desde el módulo Anular factura.</p>
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

      {splitGroup && (
        <SplitBillModal
          orders={splitGroup.orders}
          tableText={splitGroup.tableText}
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
