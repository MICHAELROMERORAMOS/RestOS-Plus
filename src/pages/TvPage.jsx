import React, { useEffect, useMemo, useState } from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import { quickServiceIdentity } from '../lib/quickOrderIdentity.js'

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

function pickupIdentity(order, tableLabel, manualQuickIdentity) {
  if (order.mode === 'table') {
    const labels = (order.tableIds || []).map((tableId) => tableLabel(tableId)).filter(Boolean)
    return labels.length ? labels.join(' + ') : `Mesa · #${order.id}`
  }
  return quickServiceIdentity(order, { manual: manualQuickIdentity })
}

function OrderCard({ order, status, tableLabel, manualQuickIdentity, onDeliver, delivering }) {
  const meta = STATUS_META[status]
  const canDeliver = status === 'ready'
  const identity = pickupIdentity(order, tableLabel, manualQuickIdentity)
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
        minHeight: 46,
        borderRadius: 10,
        padding: '6px 9px',
        background: 'rgba(255,255,255,.09)',
        border: '1px solid rgba(255,255,255,.13)',
        borderLeft: `4px solid ${meta.accent}`,
        boxShadow: '0 5px 14px rgba(0,0,0,.12)',
        cursor: canDeliver ? (delivering ? 'wait' : 'pointer') : 'default',
        opacity: delivering ? .65 : 1,
        touchAction: canDeliver ? 'manipulation' : 'auto',
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) auto',
        gap: 8,
        alignItems: 'center',
      }}
    >
      <div
        title={identity}
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 'clamp(16px, 1.55vw, 24px)',
          fontWeight: 900,
          lineHeight: 1.05,
        }}
      >
        {identity}
      </div>
      <div style={{
        minWidth: 72,
        textAlign: 'right',
        opacity: canDeliver ? 1 : .68,
        fontSize: 'clamp(8px, .72vw, 10px)',
        lineHeight: 1.1,
        fontWeight: 900,
        color: canDeliver ? '#86efac' : '#e2e8f0',
        textTransform: 'uppercase',
      }}>
        {delivering ? 'ENTREGANDO…' : canDeliver ? 'ENTREGAR' : meta.detail}
      </div>
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
  const manualQuickIdentity = state.settings.allowPager !== false
  const timeLabel = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
  const totalVisible = Object.values(board).reduce((sum, orders) => sum + orders.length, 0)

  return (
    <section className="view active" style={standalone ? { width: '100vw', height: '100dvh', margin: 0, padding: 0, overflow: 'hidden' } : undefined}>
      <div style={{
        width: standalone ? '100vw' : undefined, height: standalone ? '100dvh' : undefined,
        minHeight: standalone ? '100dvh' : 'calc(100vh - 110px)', boxSizing: 'border-box',
        borderRadius: standalone ? 0 : 18, padding: 'clamp(8px, 1vw, 14px)',
        background: 'linear-gradient(145deg, rgba(15,23,42,.99), rgba(30,41,59,.99))',
        color: '#fff', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden',
      }}>
        <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, borderBottom: '1px solid rgba(255,255,255,.14)', paddingBottom: 7 }}>
          <div>
            <div style={{ opacity: .68, fontSize: 'clamp(9px, .8vw, 11px)', fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase' }}>
              {restaurantName}{branchName ? ` · ${branchName}` : ''}
            </div>
            <h1 style={{ margin: '2px 0 0', fontSize: 'clamp(23px, 2.7vw, 38px)', lineHeight: 1 }}>Estado de pedidos</h1>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontSize: 'clamp(20px, 2.1vw, 30px)', fontWeight: 900 }}>{timeLabel}</div>
            <div style={{ opacity: .62, marginTop: 1, fontSize: 10 }}>{remoteLoading ? 'Actualizando…' : `${totalVisible} pedidos`}</div>
          </div>
        </header>

        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 'clamp(6px, .7vw, 10px)' }}>
          {Object.entries(STATUS_META).map(([status, meta]) => (
            <section key={status} style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderRadius: 12, background: 'rgba(255,255,255,.045)', border: '1px solid rgba(255,255,255,.09)', overflow: 'hidden' }}>
              <header style={{ padding: '7px 9px', borderBottom: `2px solid ${meta.accent}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <h2 style={{ margin: 0, fontSize: 'clamp(13px, 1.45vw, 20px)', lineHeight: 1.1 }}>{meta.label}</h2>
                <strong style={{ minWidth: 25, height: 25, display: 'grid', placeItems: 'center', borderRadius: 999, background: 'rgba(255,255,255,.12)', fontSize: 11 }}>{board[status].length}</strong>
              </header>
              <div style={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 5, overflowY: 'auto', scrollbarWidth: 'thin' }}>
                {board[status].length
                  ? board[status].map((order) => <OrderCard key={`${status}-${order.serverId || order.id}`} order={order} status={status} tableLabel={tableLabel} manualQuickIdentity={manualQuickIdentity} onDeliver={requestDelivery} delivering={deliveringOrderId === order.id} />)
                  : <div style={{ padding: '18px 8px', textAlign: 'center', opacity: .42, fontSize: 11, fontWeight: 700 }}>Sin pedidos</div>}
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
              {pickupIdentity(deliveryCandidate, tableLabel, manualQuickIdentity)}
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
