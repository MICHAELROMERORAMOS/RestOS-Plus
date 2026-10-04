import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import { loadOperationalHistory } from '../services/operationalService.js'

const STATUS_META = {
  sent: { label: 'Enviados', detail: 'Enviado a preparación', accent: '#94a3b8' },
  preparing: { label: 'Preparando', detail: 'En preparación', accent: '#f59e0b' },
  ready: { label: 'Listos', detail: 'Listo para recoger', accent: '#22c55e' },
  delivered: { label: 'Entregados', detail: 'Entregado', accent: '#38bdf8' },
}

function activeItems(order) {
  return (order?.rounds || []).flatMap((round) => round.items || []).filter((item) => !item.voided)
}

function displayStatus(order) {
  const items = activeItems(order)
  if (!items.length) return null
  if (items.every((item) => item.prepStatus === 'delivered')) return 'delivered'
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

function OrderCard({ order, status, tableLabel }) {
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
    </article>
  )
}

export default function TvPage({ standalone = false }) {
  const auth = useAuth()
  const { state, tableLabel, refreshOperationalData, remoteLoading, activeLocation } = useRestaurant()
  const [now, setNow] = useState(() => new Date())
  const [historyOrders, setHistoryOrders] = useState([])
  const restaurantId = auth.userContext?.membership?.restaurant_id || null

  const refreshHistory = useCallback(async () => {
    if (!restaurantId || !activeLocation?.id) return
    try {
      const result = await loadOperationalHistory(restaurantId, activeLocation.id, { limit: 30 })
      setHistoryOrders(result.orders || [])
    } catch {
      // The live operational board remains usable even if recent history cannot be loaded.
    }
  }, [restaurantId, activeLocation?.id])

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
    refreshHistory()
    const timer = window.setInterval(() => {
      setNow(new Date())
      refreshOperationalData?.()
      refreshHistory()
    }, 15000)
    return () => window.clearInterval(timer)
  }, [refreshOperationalData, refreshHistory])

  const board = useMemo(() => {
    const groups = { sent: [], preparing: [], ready: [], delivered: [] }
    ;(state.orders || []).filter((order) => ['table', 'quick'].includes(order.mode)).forEach((order) => {
      const status = displayStatus(order)
      if (status) groups[status].push(order)
    })

    const activeIds = new Set((state.orders || []).map((order) => String(order.serverId || '')))
    historyOrders
      .filter((order) => ['table', 'quick'].includes(order.mode))
      .filter((order) => !activeIds.has(String(order.serverId || '')))
      .filter((order) => activeItems(order).length && activeItems(order).every((item) => item.prepStatus === 'delivered'))
      .slice(0, 12)
      .forEach((order) => groups.delivered.push(order))

    Object.values(groups).forEach((orders) => orders.sort((a, b) => Number(a.created || 0) - Number(b.created || 0)))
    return groups
  }, [state.orders, historyOrders])

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

        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 'clamp(10px, 1.4vw, 20px)' }}>
          {Object.entries(STATUS_META).map(([status, meta]) => (
            <section key={status} style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderRadius: 20, background: 'rgba(255,255,255,.045)', border: '1px solid rgba(255,255,255,.09)', overflow: 'hidden' }}>
              <header style={{ padding: '16px 18px', borderBottom: `3px solid ${meta.accent}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <h2 style={{ margin: 0, fontSize: 'clamp(18px, 2vw, 28px)' }}>{meta.label}</h2>
                <strong style={{ minWidth: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: 999, background: 'rgba(255,255,255,.12)' }}>{board[status].length}</strong>
              </header>
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
                {board[status].length
                  ? board[status].map((order) => <OrderCard key={`${status}-${order.serverId || order.id}`} order={order} status={status} tableLabel={tableLabel} />)
                  : <div style={{ padding: '24px 10px', textAlign: 'center', opacity: .42, fontWeight: 700 }}>Sin pedidos</div>}
              </div>
            </section>
          ))}
        </div>
      </div>
    </section>
  )
}
