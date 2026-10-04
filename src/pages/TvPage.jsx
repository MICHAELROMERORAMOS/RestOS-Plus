import React, { useEffect, useMemo, useState } from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'

function orderIsReadyForPickup(order) {
  if (!order || !['table', 'quick'].includes(order.mode)) return false
  if (['closed', 'cancelled', 'merged', 'refund_due'].includes(order.status)) return false

  const items = (order.rounds || [])
    .flatMap((round) => round.items || [])
    .filter((item) => !item.voided)

  if (!items.length) return false

  const hasReadyItem = items.some((item) => item.prepStatus === 'ready')
  const nothingStillPreparing = items.every((item) => (
    item.prepStatus === 'ready' || item.prepStatus === 'delivered'
  ))

  return hasReadyItem && nothingStillPreparing
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

export default function TvPage({ standalone = false }) {
  const {
    state,
    tableLabel,
    refreshOperationalData,
    remoteLoading,
    activeLocation,
  } = useRestaurant()
  const [now, setNow] = useState(() => new Date())

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
    const timer = window.setInterval(() => setNow(new Date()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshOperationalData?.()
    }, 30000)
    return () => window.clearInterval(timer)
  }, [refreshOperationalData, activeLocation?.id])

  const readyOrders = useMemo(
    () => (state.orders || [])
      .filter(orderIsReadyForPickup)
      .sort((left, right) => Number(left.created || 0) - Number(right.created || 0)),
    [state.orders],
  )

  const restaurantName = state.settings.restaurantName || 'RestOS+'
  const branchName = activeLocation?.name || ''
  const timeLabel = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })

  return (
    <section className="view active" style={standalone ? { width: '100vw', height: '100dvh', margin: 0, padding: 0, overflow: 'hidden' } : undefined}>
      <div style={{
        width: standalone ? '100vw' : undefined,
        height: standalone ? '100dvh' : undefined,
        minHeight: standalone ? '100dvh' : 'calc(100vh - 110px)',
        boxSizing: 'border-box',
        borderRadius: standalone ? 0 : 24,
        padding: 'clamp(20px, 3vw, 42px)',
        background: 'linear-gradient(145deg, rgba(15,23,42,.98), rgba(30,41,59,.98))',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
        overflow: 'hidden',
      }}>
        <header style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 24,
          borderBottom: '1px solid rgba(255,255,255,.14)',
          paddingBottom: 22,
        }}>
          <div>
            <div style={{ opacity: .72, fontSize: 16, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' }}>
              {restaurantName}{branchName ? ` · ${branchName}` : ''}
            </div>
            <h1 style={{ margin: '6px 0 0', fontSize: 'clamp(34px, 5vw, 68px)', lineHeight: 1, letterSpacing: '-.04em' }}>
              Listos para recoger
            </h1>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontSize: 'clamp(28px, 3vw, 44px)', fontWeight: 800 }}>{timeLabel}</div>
            <div style={{ opacity: .65, marginTop: 4 }}>
              {remoteLoading ? 'Actualizando…' : `${readyOrders.length} ${readyOrders.length === 1 ? 'pedido listo' : 'pedidos listos'}`}
            </div>
          </div>
        </header>

        {readyOrders.length ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
            gap: 'clamp(14px, 2vw, 24px)',
            alignContent: 'start',
          }}>
            {readyOrders.map((order) => {
              const identity = pickupIdentity(order, tableLabel)
              const isTable = order.mode === 'table'
              return (
                <article
                  key={order.serverId || order.id}
                  style={{
                    minHeight: 170,
                    borderRadius: 22,
                    padding: '24px 26px',
                    background: 'rgba(255,255,255,.10)',
                    border: '1px solid rgba(255,255,255,.16)',
                    boxShadow: '0 16px 40px rgba(0,0,0,.18)',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{
                    display: 'inline-flex',
                    alignSelf: 'flex-start',
                    padding: '7px 11px',
                    borderRadius: 999,
                    background: 'rgba(255,255,255,.12)',
                    fontSize: 13,
                    fontWeight: 800,
                    letterSpacing: '.08em',
                    textTransform: 'uppercase',
                  }}>
                    {isTable ? 'Mesa' : 'Recogida'}
                  </div>
                  <div style={{
                    marginTop: 20,
                    fontSize: 'clamp(36px, 4.5vw, 64px)',
                    fontWeight: 900,
                    lineHeight: 1,
                    letterSpacing: '-.035em',
                    overflowWrap: 'anywhere',
                  }}>
                    {identity}
                  </div>
                  <div style={{ marginTop: 14, fontSize: 16, fontWeight: 700, opacity: .72 }}>
                    Tu pedido está listo
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          <div style={{
            flex: 1,
            minHeight: 320,
            display: 'grid',
            placeItems: 'center',
            textAlign: 'center',
            opacity: .78,
          }}>
            <div>
              <div style={{ fontSize: 'clamp(52px, 8vw, 96px)', lineHeight: 1 }}>✓</div>
              <h2 style={{ fontSize: 'clamp(26px, 3vw, 42px)', margin: '18px 0 8px' }}>Estamos preparando tus pedidos</h2>
              <p style={{ margin: 0, fontSize: 18 }}>Aquí aparecerá tu mesa, turno o nombre cuando esté listo.</p>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
