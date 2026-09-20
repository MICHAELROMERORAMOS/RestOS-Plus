import React from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'

export default function StationPage({ station }) {
  const { stationJobs, advanceStationRound, tableLabel } = useRestaurant()
  const jobs = stationJobs(station)
  const isBar = station === 'bar'
  const label = isBar ? 'Bar Display' : 'Kitchen Display'
  const icon = isBar ? '🍸' : '🍳'

  return (
    <section className="view active">
      <div className="hero">
        <div>
          <h2>{label}</h2>
          <p>Solo aparecen productos asignados a {isBar ? 'Bar' : 'Cocina'}.</p>
        </div>
      </div>

      <div className="kds kds-large">
        {jobs.length ? jobs.map(({ order, round, items, status }) => (
          <article className="card ticket kds-ticket" key={`${order.id}-${round.id}`}>
            <div className="section-title kds-ticket-head">
              <div>
                <h3>{order.tableIds?.length ? order.tableIds.map((id) => tableLabel(id)).join(' + ') : `Orden #${order.id}`}</h3>
                <small>Orden #{order.id} · Comanda {round.id} · {items.length} producto{items.length === 1 ? '' : 's'}</small>
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
    </section>
  )
}
