import React, { useMemo, useState } from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'

export default function StationPage({ station }) {
  const { stationJobs, advanceStationRound, tableLabel } = useRestaurant()
  const [showSummary, setShowSummary] = useState(false)
  const jobs = stationJobs(station)
  const isBar = station === 'bar'
  const label = isBar ? 'Bar Display' : 'Kitchen Display'
  const stationName = isBar ? 'Bar' : 'Cocina'
  const icon = isBar ? '🍸' : '🍳'

  const preparationSummary = useMemo(() => {
    const totals = new Map()

    jobs.forEach(({ items }) => {
      items.forEach((item) => {
        const key = item.productId || item.name
        const current = totals.get(key) || {
          key,
          name: item.name,
          total: 0,
          newQty: 0,
          preparingQty: 0,
        }

        const quantity = Number(item.quantity || 0)
        current.total += quantity

        if (item.prepStatus === 'preparing') current.preparingQty += quantity
        else current.newQty += quantity

        totals.set(key, current)
      })
    })

    return Array.from(totals.values()).sort((a, b) => (
      a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
    ))
  }, [jobs])

  const totalPendingUnits = preparationSummary.reduce((sum, item) => sum + item.total, 0)

  return (
    <section className={`view active station-view ${isBar ? 'bar-station' : 'kitchen-station'}`}>
      <div className="hero station-hero">
        <div>
          <h2>{label}</h2>
          <p>Solo aparecen productos asignados a {stationName}.</p>
        </div>

        <button
          className="btn primary station-summary-button"
          onClick={() => setShowSummary(true)}
        >
          ∑ Resumen de preparación
          <span>{totalPendingUnits} unidad{totalPendingUnits === 1 ? '' : 'es'}</span>
        </button>
      </div>

      <div className="kds kds-large">
        {jobs.length ? jobs.map(({ order, round, items, status }) => (
          <article className="card ticket kds-ticket" key={`${order.id}-${round.id}`}>
            <div className="section-title kds-ticket-head">
              <div>
                <h3>{
                  order.tableIds?.length
                    ? order.tableIds.map((id) => tableLabel(id)).join(' + ')
                    : order.mode === 'delivery'
                      ? `🚚 Domicilio · ${order.delivery?.customerName || `Orden #${order.id}`}`
                      : `Orden #${order.id}`
                }</h3>
                <small>
                  Orden #{order.id} · Comanda {round.id} · {items.length} producto{items.length === 1 ? '' : 's'}
                  {order.mode === 'delivery' && order.delivery?.address ? ` · ${order.delivery.address}` : ''}
                </small>
              </div>
              <span className="badge">#{order.id} · C{round.id}</span>
            </div>

            <div className={`time kds-state ${status === 'preparing' ? 'preparing' : 'new'}`}>
              {status === 'new' ? 'NUEVO' : 'PREPARANDO'}
            </div>

            {order.pager && <div className="badge">Pager / turno {order.pager}</div>}

            <div className="station-job-items kds-item-list">
              {items.map((item) => (
                <div className="kds-line kds-product-row" key={item.lineId}>
                  <span className="kds-qty">{item.quantity}×</span>
                  <div className="kds-product-copy">
                    <b>{item.name}</b>
                    {item.note && <small>↳ {item.note}</small>}
                  </div>
                </div>
              ))}
            </div>

            <button
              className={`btn kds-action ${status === 'preparing' ? 'primary' : ''}`}
              onClick={() => advanceStationRound(order.id, round.id, station)}
            >
              {status === 'new' ? `${icon} Empezar preparación` : '✓ Marcar productos listos'}
            </button>
          </article>
        )) : (
          <div className="card placeholder kds-empty">
            <div>
              <div className="icon">✓</div>
              <h3>Sin comandas pendientes</h3>
              <p>Los nuevos envíos para {isBar ? 'bar' : 'cocina'} aparecerán aquí automáticamente.</p>
            </div>
          </div>
        )}
      </div>

      {showSummary && (
        <div className="modal open station-summary-modal" onClick={() => setShowSummary(false)}>
          <div className="modal-card station-summary-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-title station-summary-head">
              <div>
                <h3>{icon} Resumen de {stationName}</h3>
                <p>
                  {totalPendingUnits} unidad{totalPendingUnits === 1 ? '' : 'es'} pendiente{totalPendingUnits === 1 ? '' : 's'}
                  {' · '}{jobs.length} comanda{jobs.length === 1 ? '' : 's'}
                </p>
              </div>
              <button className="btn" onClick={() => setShowSummary(false)}>×</button>
            </div>

            {preparationSummary.length ? (
              <div className="station-summary-list">
                {preparationSummary.map((item) => (
                  <div className="station-summary-row" key={item.key}>
                    <div className="station-summary-quantity">{item.total}×</div>
                    <div className="station-summary-copy">
                      <b>{item.name}</b>
                      <small>
                        {item.newQty > 0 && `${item.newQty} nueva${item.newQty === 1 ? '' : 's'}`}
                        {item.newQty > 0 && item.preparingQty > 0 ? ' · ' : ''}
                        {item.preparingQty > 0 && `${item.preparingQty} preparando`}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-block">No hay productos pendientes de preparación.</div>
            )}

            <button className="btn primary full station-summary-close" onClick={() => setShowSummary(false)}>
              Cerrar resumen
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
