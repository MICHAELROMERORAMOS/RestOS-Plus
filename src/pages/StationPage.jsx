import React from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'

export default function StationPage({ station }) {
  const { stationJobs, advanceStationRound } = useRestaurant()
  const jobs = stationJobs(station)
  const isBar = station === 'bar'
  const label = isBar ? 'Bar Display' : 'Kitchen Display'
  const icon = isBar ? '🍸' : '🍳'

  return (
    <section className="view active">
      <div className="hero"><div><h2>{label}</h2><p>Solo aparecen productos asignados a {isBar ? 'Bar' : 'Cocina'}.</p></div></div>
      <div className="kds">
        {jobs.length ? jobs.map(({ order, round, items, status }) => (
          <div className="card ticket" key={`${order.id}-${round.id}`}>
            <div className="section-title">
              <h3>{order.tableIds?.length ? `Mesa ${order.tableIds.join(' + ')}` : `Orden #${order.id}`}</h3>
              <span className="badge">#{order.id} · C{round.id}</span>
            </div>
            <div className="time">{status === 'new' ? 'NUEVO' : 'PREPARANDO'}</div>
            {order.pager && <div className="badge">Pager / turno {order.pager}</div>}
            <div className="station-job-items">
              {items.map((item) => (
                <div className="kds-line" key={item.lineId}>
                  {item.quantity} × <b>{item.name}</b>
                  {item.note && <small>↳ {item.note}</small>}
                </div>
              ))}
            </div>
            <button className={`btn ${status === 'preparing' ? 'primary' : ''}`} onClick={() => advanceStationRound(order.id, round.id, station)}>
              {status === 'new' ? `${icon} Empezar preparación` : '✓ Marcar productos listos'}
            </button>
          </div>
        )) : (
          <div className="card placeholder kds-empty"><div><div className="icon">✓</div><h3>Sin comandas pendientes</h3><p>Los nuevos envíos para {isBar ? 'bar' : 'cocina'} aparecerán aquí automáticamente.</p></div></div>
        )}
      </div>
    </section>
  )
}
