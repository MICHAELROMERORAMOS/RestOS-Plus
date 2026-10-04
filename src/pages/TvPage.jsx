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
  if (items.some((item) => item.prepStatus === 'preparing')) return 'preparing'
  if (items.some((item) => item.prepStatus === 'new')) return 'sent'
  if (items.some((item) => item.prepStatus === 'ready')) return 'ready'
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
  return (
    <article style={{
      borderRadius: 18, padding: '18px 20px', background: 'rgba(255,255,255,.09)',
      border: '1px solid rgba(255,255,255,.14)', borderLeft: `6px solid ${meta.accent}`,
      boxShadow: '0 12px 28px rgba(0,0,0,.16)',
    }}>
      <div style={{ fontSize: 'clamp(24px, 2.6vw, 42px)', fontWeight: 900, lineHeight: 1.05, overflowWrap: 'anywhere' }}>
        {pickupIdentity(order, tableLabel)}
      </div>
      <div style={{ marginTop: 9, opacity: .72, fontSize: 14, fontWeight: 700 }}>{meta.detail}</div>
      {status === 'ready' && order.mode === 'table' ? (
        <button
          type="button"
          disabled={delivering}
          onClick={() => onDeliver(order)}
          style={{
            width: '100%', marginTop: 14, minHeight: 46, border: 0, borderRadius: 12,
            cursor: delivering ? 'wait' : 'pointer', fontSize: 16, fontWeight: 900,
            background: '#22c55e', color: '#052e16', opacity: delivering ? .65 : 1,
          }}
        >
          {delivering ? 'Entregando…' : 'Entregar'}
        </button>
      ) : null}
    </article>
  )
}

export default function TvPage({ standalone = false }) {
  const { state, tableLabel, refreshOperationalData, remoteLoading, activeLocation, markRoundDelivered } = useRestaurant()
  const [now, setNow] = useState(() => new Date())
  const [deliveringOrderId, setDeliveringOrderId] = useState(null)
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

  const deliverReadyTableOrder = async (order) => {
    if (!order || order.mode !== 'table' || deliveringOrderId) return

    const readyRounds = (order.rounds || []).filter((round) => {
      const items = (round.items || []).filter((item) => !item.voided)
      return items.length && items.some((item) => item.prepStatus === 'ready')
    })
    if (!readyRounds.length) return

    const identity = pickupIdentity(order, tableLabel)
    const confirmed = window.confirm(`¿Confirmas que ${identity} ya fue entregado? Se quitará de la lista de pedidos listos.`)
    if (!confirmed) return

    setDeliveringOrderId(order.id)
    try {
      for (const round of readyRounds) {
        const result = await markRoundDelivered(order.id, round.id)
        if (result?.ok === false) throw new Error(result.message || 'No se pudo marcar el pedido como entregado.')
      }
      await refreshOperationalData?.()
    } catch (error) {
      window.alert(error?.message || 'No se pudo marcar el pedido como entregado.')
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
                  ? board[status].map((order) => <OrderCard key={`${status}-${order.serverId || order.id}`} order={order} status={status} tableLabel={tableLabel} onDeliver={deliverReadyTableOrder} delivering={deliveringOrderId === order.id} />)
                  : <div style={{ padding: '24px 10px', textAlign: 'center', opacity: .42, fontWeight: 700 }}>Sin pedidos</div>}
              </div>
            </section>
          ))}
        </div>
      </div>
    </section>
  )
}
