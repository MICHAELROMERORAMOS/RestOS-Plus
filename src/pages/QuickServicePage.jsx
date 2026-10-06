import React, { useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useRestaurant, orderTotal } from '../context/RestaurantContext.jsx'
import { quickServiceIdentity } from '../lib/quickOrderIdentity.js'
import { orderNumberLabel } from '../lib/orderNumber.js'

function formatTime(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('es', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function shortName(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return ''
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[1]}`
}

function orderStatus(order) {
  const items = (order.rounds || [])
    .flatMap((round) => round.items || [])
    .filter((item) => !item.voided)

  if (Number(order.refundDue || 0) > 0.005 || order.status === 'refund_due') return 'REEMBOLSO PENDIENTE'
  if (!items.length) return 'TOMANDO PEDIDO'
  if (order.status === 'waiting_food') return 'PAGADO · ESPERANDO COMIDA'
  if (order.status === 'ready') return 'PEDIDO LISTO'
  if (order.status === 'pay') return 'POR COBRAR'
  if (items.every((item) => item.prepStatus === 'delivered')) {
    return order.paymentStatus === 'paid' ? 'PAGADO · ENTREGADO' : 'POR COBRAR'
  }
  if (items.every((item) => ['ready', 'delivered'].includes(item.prepStatus))) return 'PEDIDO LISTO'
  if (items.some((item) => item.prepStatus === 'preparing')) return 'EN PREPARACIÓN'
  return 'ENVIADO'
}

function visualStatus(order) {
  const items = (order.rounds || [])
    .flatMap((round) => round.items || [])
    .filter((item) => !item.voided)

  if (Number(order.refundDue || 0) > 0.005 || order.status === 'refund_due') return 'refund_due'
  if (!items.length) return 'opening'
  if (order.status === 'ready') return 'ready'
  if (order.status === 'pay') return 'pay'
  if (order.status === 'waiting_food') return 'waiting_food'
  return 'occupied'
}

function statusStyle(status) {
  if (status === 'opening') return { borderColor: '#2f6fed', boxShadow: 'inset 0 0 0 1px #2f6fed' }
  if (status === 'occupied') return { borderColor: '#d64545', boxShadow: 'inset 0 0 0 1px #d64545' }
  if (status === 'waiting_food') return { borderColor: '#5b6fc7', boxShadow: 'inset 0 0 0 1px #5b6fc7' }
  if (status === 'refund_due') return { borderColor: '#b84b4b', boxShadow: 'inset 0 0 0 1px #b84b4b' }
  return undefined
}

export default function QuickServicePage({ onStartQuickOrder, onOpenQuickOrder }) {
  const auth = useAuth()
  const {
    state,
    formatMoney,
    releaseEmptyQuickOrder,
  } = useRestaurant()
  const [creating, setCreating] = useState(false)
  const [releasingOrderId, setReleasingOrderId] = useState(null)
  const manualQuickIdentity = state.settings.allowPager !== false

  const activeOrders = useMemo(
    () => state.orders
      .filter((order) => (
        order.mode === 'quick'
        && !['closed', 'cancelled', 'merged'].includes(order.status)
      ))
      .slice()
      .sort((a, b) => (b.created || 0) - (a.created || 0)),
    [state.orders],
  )

  async function createOrder() {
    if (creating) return
    setCreating(true)
    try {
      const result = await onStartQuickOrder?.()
      if (result?.ok === false) {
        window.alert(result.message || 'No se pudo crear el pedido rápido.')
      }
    } finally {
      setCreating(false)
    }
  }

  function openOrder(order) {
    const result = onOpenQuickOrder?.(order.id)
    if (result?.ok === false) {
      window.alert(result.message || 'No se pudo abrir el pedido rápido.')
    }
  }

  async function releaseOrder(order) {
    const hasSentItems = (order.rounds || []).some((round) => (
      (round.items || []).some((item) => !item.voided)
    ))
    if (hasSentItems) {
      window.alert('Este pedido ya tiene productos enviados y no puede liberarse como vacío.')
      return
    }

    const identifier = quickServiceIdentity(order, { manual: manualQuickIdentity })

    if (!window.confirm(`¿Deseas liberar ${identifier}? Todavía no tiene productos enviados.`)) return

    setReleasingOrderId(order.id)
    try {
      const result = await releaseEmptyQuickOrder(order.id)
      if (!result?.ok) {
        window.alert(result?.message || 'No se pudo liberar el pedido rápido.')
      }
    } finally {
      setReleasingOrderId(null)
    }
  }

  return (
    <section className="view active">
      <div className="hero tables-hero">
        <div>
          <h2>Servicio rápido</h2>
          <p>
            {manualQuickIdentity
              ? 'Cada pedido funciona como una cuenta independiente identificada por número o nombre del cliente.'
              : 'Cada pedido recibe un número de turno automático que se reinicia después del cierre de turno.'}
          </p>
        </div>
        <button className="btn primary quick-service-entry" onClick={createOrder} disabled={creating}>
          <span className="quick-service-icon">⚡</span>
          <span>
            <b>{creating ? 'Creando…' : 'Nuevo pedido rápido'}</b>
            <small>{manualQuickIdentity ? 'Número o nombre del cliente' : 'Turno automático'}</small>
          </span>
        </button>
      </div>

      <div className="card">
        <div className="section-title">
          <div>
            <h3>Pedidos rápidos activos</h3>
            <p className="muted">Selecciona una tarjeta para continuar agregando productos o cobrar.</p>
          </div>
          <span className="badge">{activeOrders.length} activos</span>
        </div>

        {activeOrders.length ? (
          <div className="tables quick-orders-grid">
            {activeOrders.map((order) => {
              const status = visualStatus(order)
              const hasSentItems = (order.rounds || []).some((round) => (
                (round.items || []).some((item) => !item.voided)
              ))
              const identifier = quickServiceIdentity(order, { manual: manualQuickIdentity })
              const openedAt = formatTime(order.created)
              const responsible = shortName(order.openedByName)
              const canRelease = !hasSentItems && (order.openedByMe || auth.can('tables.manage'))

              return (
                <div className="table-shell" key={order.id}>
                  <button
                    className={`table quick-order-card ${status}`}
                    style={statusStyle(status)}
                    onClick={() => openOrder(order)}
                  >
                    <div className="table-head quick-order-head">
                      <b>{identifier}</b>
                    </div>
                    <small className="quick-order-number">{orderNumberLabel(order)}</small>
                    <small className="table-time">
                      ◷ {openedAt ? `Abierto a las ${openedAt}` : 'Hora de apertura sin registrar'}
                    </small>
                    {hasSentItems && (
                      <strong className="table-account-total">{formatMoney(orderTotal(order))}</strong>
                    )}
                    <span className="table-status">{orderStatus(order)}</span>
                    {responsible && (
                      <small className="table-attendant" title={order.openedByName}>
                        {responsible}
                      </small>
                    )}
                  </button>

                  {canRelease && (
                    <button
                      className="table-release-btn"
                      onClick={() => releaseOrder(order)}
                      disabled={releasingOrderId === order.id}
                    >
                      {releasingOrderId === order.id ? 'Liberando…' : 'Liberar pedido'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="empty-block">
            No hay pedidos rápidos activos. Pulsa “Nuevo pedido rápido” para comenzar.
          </div>
        )}
      </div>
    </section>
  )
}
