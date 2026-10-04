import React, { useEffect, useMemo, useState } from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'

const STATUS_META = {
  sent: { label: 'Enviados a preparación', detail: 'Enviado a preparación', accent: '#94a3b8' },
  preparing: { label: 'Preparando', detail: 'En preparación', accent: '#f59e0b' },
  ready: { label: 'Listos', detail: 'Listo para recoger', accent: '#22c55e' },
}

function activeItems(order) {
  return (order?.rounds || []).flatMap((round) => round.items || []).filter((item) => !item.voided)
}

function displayStatus(order) {
  const items = activeItems(order)
  if (!items.length) return null

  const pending = items.filter((item) => item.prepStatus !== 'delivered')
  if (!pending.length) return null

  // An order is ready only when every remaining item is ready. Delivered items
  // from an earlier partial handoff must not prevent a table from reaching Listos.
  if (pending.every((item) => item.prepStatus === 'ready')) return 'ready'
  if (pending.some((item) => item.prepStatus === 'preparing')) return 'preparing'
  if (pending.some((item) => item.prepStatus === 'new')) return 'sent'
  return null
}

function pickupIdentity(order, tableLabel) {
  if (order.mode === 'table') {
    const labels = (order.tableIds || []).map((tableId) => tableLabel(tableId)).filter(Boolean)
    return labels.length ? labels.join(' + ') : `Mesa · #${order.id}`
  }
  const customerName = String(order.customerName || '').trim()
  if (customerName) return customerName
  const pager = String(order.pager || '').trim()
  if (pager) return `Turno ${pager}`
  return `Turno ${order.id}`
}

function OrderCard({ order, status, tableLabel, onDeliver, delivering }) {
  const meta = STATUS_META[status]
  const canDeliver = status === 'ready'
  return (
    <article
      role={canDeliver ? 'button' : undefined}
      tabIndex={canDeliver ? 0 : undefined}
      onClick={canDeliver && !delivering ? () => onDeliver(order) : undefined}
      onKeyDown={canDeliver && !delivering ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onDeliver(order)
        }
      } : undefined}
      style={{
        borderRadius: 18, padding: '18px 20px', background: 'rgba(255,255,255,.09)',
        border: '1px solid rgba(255,255,255,.14)', borderLeft: `6px solid ${meta.accent}`,
        boxShadow: '0 12px 28px rgba(0,0,0,.16)',
        cursor: canDeliver ? (delivering ? 'wait' : 'pointer') : 'default',
        opacity: delivering ? .65 : 1,
        touchAction: canDeliver ? 'manipulation' : 'auto',
      }}
    >
      <div style={{ fontSize: 'clamp(24px, 2.6vw, 42px)', fontWeight: 900, lineHeight: 1.05, overflowWrap: 'anywhere' }}>
        {pickupIdentity(order, tableLabel)}
      </div>
      <div style={{ marginTop: 9, opacity: .72, fontSize: 14, fontWeight: 700 }}>{meta.detail}</div>
      {canDeliver ? (
        <div style={{ marginTop: 12, fontSize: 13, fontWeight: 900, color: '#86efac' }}>
          {delivering ? 'Entregando…' : 'Toca el pedido para entregar'}
        </div>
      ) : null}
    </article>
  )
}

export default function TvPage({ standalone = false }) {
  const { state, tableLabel, refreshOperationalData, remoteLoading, activeLocation, markRoundDelivered } = useRestaurant()
  const [now, setNow] = useState(() => new Date())
  const [deliveringOrderId, setDeliveringOrderId] = useState(null)
  const [deliveryCandidate, setDeliveryCandidate] = useState(null)
  const [deliveryError, setDeliveryError] = useState('')
  useEffect(() => {
    if (!standalone) return undefined
    document.documentElement.style.background = '#0f172a'
    document.body.style.margin = '0'
    document.body.style.background = '#0f172a'
    document.body.style.overflow = 'hidden'
    return () => {
      document.documentElement.style.background = ''
      document.body.style.margin = ''
      document.body.style.background = ''
      document.body.style.overflow = ''
    }
  }, [standalone])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date())
      refreshOperationalData?.()
    }, 15000)
    return () => window.clearInterval(timer)
  }, [refreshOperationalData, activeLocation?.id])

  const board = useMemo(() => {
    const groups = { sent: [], preparing: [], ready: [] }
    ;(state.orders || []).filter((order) => ['table', 'quick'].includes(order.mode)).forEach((order) => {
      const status = displayStatus(order)
      if (status) groups[status].push(order)
    })


    Object.values(groups).forEach((orders) => orders.sort((a, b) => Number(a.created || 0) - Number(b.created || 0)))
    return groups
  }, [state.orders])

  const requestDelivery = (order) => {
    if (!order || !['table', 'quick'].includes(order.mode) || deliveringOrderId) return
    setDeliveryError('')
    setDeliveryCandidate(order)
  }

  const cancelDelivery = () => {
    if (deliveringOrderId) return
    setDeliveryError('')
    setDeliveryCandidate(null)
  }

  const confirmDelivery = async () => {
    const order = deliveryCandidate
    if (!order || deliveringOrderId) return

    const readyRounds = (order.rounds || []).filter((round) => {
      const items = (round.items || []).filter((item) => !item.voided && item.prepStatus !== 'delivered')
      return items.length && items.every((item) => item.prepStatus === 'ready')
    })
    if (!readyRounds.length) {
      setDeliveryError('Este pedido ya no tiene productos listos pendientes de entrega.')
      return
    }

    setDeliveryError('')
    setDeliveringOrderId(order.id)
    try {
      for (const round of readyRounds) {
        const result = await markRoundDelivered(order.id, round.id)
        if (result?.ok === false) throw new Error(result.message || 'No se pudo marcar el pedido como entregado.')
      }
      await refreshOperationalData?.()
      setDeliveryCandidate(null)
    } catch (error) {
      setDeliveryError(error?.message || 'No se pudo marcar el pedido como entregado.')
    } finally {
      setDeliveringOrderId(null)
    }
  }

  const restaurantName = state.settings.restaurantName || 'RestOS+'
  const branchName = activeLocation?.name || ''
  const timeLabel = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
  const totalVisible = Object.values(board).reduce((sum, orders) => sum + orders.length, 0)

  return (
    <section className="view active" style={standalone ? { width: '100vw', height: '100dvh', margin: 0, padding: 0, overflow: 'hidden' } : undefined}>
      <div style={{
        width: standalone ? '100vw' : undefined, height: standalone ? '100dvh' : undefined,
        minHeight: standalone ? '100dvh' : 'calc(100vh - 110px)', boxSizing: 'border-box',
        borderRadius: standalone ? 0 : 24, padding: 'clamp(16px, 2.2vw, 32px)',
        background: 'linear-gradient(145deg, rgba(15,23,42,.99), rgba(30,41,59,.99))',
        color: '#fff', display: 'flex', flexDirection: 'column', gap: 20, overflow: 'hidden',
      }}>
        <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, borderBottom: '1px solid rgba(255,255,255,.14)', paddingBottom: 16 }}>
          <div>
            <div style={{ opacity: .68, fontSize: 14, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase' }}>
              {restaurantName}{branchName ? ` · ${branchName}` : ''}
            </div>
            <h1 style={{ margin: '5px 0 0', fontSize: 'clamp(30px, 4vw, 56px)', lineHeight: 1 }}>Estado de pedidos</h1>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontSize: 'clamp(26px, 3vw, 40px)', fontWeight: 900 }}>{timeLabel}</div>
            <div style={{ opacity: .62, marginTop: 3 }}>{remoteLoading ? 'Actualizando…' : `${totalVisible} pedidos`}</div>
          </div>
        </header>

        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 'clamp(10px, 1.4vw, 20px)' }}>
          {Object.entries(STATUS_META).map(([status, meta]) => (
            <section key={status} style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderRadius: 20, background: 'rgba(255,255,255,.045)', border: '1px solid rgba(255,255,255,.09)', overflow: 'hidden' }}>
              <header style={{ padding: '16px 18px', borderBottom: `3px solid ${meta.accent}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <h2 style={{ margin: 0, fontSize: 'clamp(18px, 2vw, 28px)' }}>{meta.label}</h2>
                <strong style={{ minWidth: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: 999, background: 'rgba(255,255,255,.12)' }}>{board[status].length}</strong>
              </header>
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
                {board[status].length
                  ? board[status].map((order) => <OrderCard key={`${status}-${order.serverId || order.id}`} order={order} status={status} tableLabel={tableLabel} onDeliver={requestDelivery} delivering={deliveringOrderId === order.id} />)
                  : <div style={{ padding: '24px 10px', textAlign: 'center', opacity: .42, fontWeight: 700 }}>Sin pedidos</div>}
              </div>
            </section>
          ))}
        </div>
      </div>

      {deliveryCandidate ? (
        <div
          role="presentation"
          onClick={cancelDelivery}
          style={{
            position: 'fixed', inset: 0, zIndex: 10000, display: 'grid', placeItems: 'center',
            padding: 20, background: 'rgba(2,6,23,.78)', backdropFilter: 'blur(8px)',
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delivery-confirm-title"
            onClick={(event) => event.stopPropagation()}
            style={{
              width: 'min(92vw, 480px)', borderRadius: 24, padding: 26,
              background: 'linear-gradient(145deg, #172033, #111827)', color: '#fff',
              border: '1px solid rgba(255,255,255,.14)', boxShadow: '0 28px 80px rgba(0,0,0,.48)',
            }}
          >
            <div style={{
              width: 58, height: 58, borderRadius: 18, display: 'grid', placeItems: 'center',
              background: 'rgba(34,197,94,.14)', color: '#86efac', fontSize: 30, fontWeight: 900,
            }}>✓</div>
            <h2 id="delivery-confirm-title" style={{ margin: '18px 0 8px', fontSize: 28 }}>
              Confirmar entrega
            </h2>
            <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 8 }}>
              {pickupIdentity(deliveryCandidate, tableLabel)}
            </div>
            <p style={{ margin: 0, color: '#cbd5e1', lineHeight: 1.55 }}>
              Confirma únicamente cuando el pedido haya sido entregado al cliente. Al confirmar se quitará de la lista de pedidos listos.
            </p>
            {deliveryError ? (
              <div style={{ marginTop: 16, padding: '11px 13px', borderRadius: 12, background: 'rgba(239,68,68,.14)', color: '#fecaca', fontWeight: 700 }}>
                {deliveryError}
              </div>
            ) : null}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 24 }}>
              <button
                type="button"
                disabled={Boolean(deliveringOrderId)}
                onClick={cancelDelivery}
                style={{ minHeight: 50, borderRadius: 13, border: '1px solid rgba(255,255,255,.16)', background: 'rgba(255,255,255,.07)', color: '#fff', fontSize: 16, fontWeight: 800, cursor: 'pointer' }}
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={Boolean(deliveringOrderId)}
                onClick={confirmDelivery}
                style={{ minHeight: 50, borderRadius: 13, border: 0, background: '#22c55e', color: '#052e16', fontSize: 16, fontWeight: 900, cursor: deliveringOrderId ? 'wait' : 'pointer', opacity: deliveringOrderId ? .7 : 1 }}
              >
                {deliveringOrderId ? 'Entregando…' : 'Sí, entregar'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
