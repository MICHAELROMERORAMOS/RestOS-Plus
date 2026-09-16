import React from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'

export default function TablesPage({ onOpenTable }) {
  const { state } = useRestaurant()
  const labels = { free: 'LIBRE', occupied: 'CUENTA ABIERTA', ready: 'PEDIDO LISTO', pay: 'POR COBRAR' }
  return (
    <section className="view active">
      <div className="hero"><div><h2>Mesas y salón</h2><p>Toca una mesa para abrir o continuar su pedido.</p></div></div>
      <div className="card">
        <div className="tables">
          {state.tables.map((table) => (
            <button className={`table ${table.status}`} key={table.id} onClick={() => onOpenTable(table.id)}>
              <b>Mesa {String(table.id).padStart(2, '0')}</b>
              <span>{labels[table.status] || table.status}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
