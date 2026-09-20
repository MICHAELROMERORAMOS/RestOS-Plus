import React, { useMemo } from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'

function formatTime(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('es', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export default function TablesPage({ onOpenTable }) {
  const { state, getTableVisualStatus } = useRestaurant()
  const labels = {
    free: 'LIBRE',
    reserved: 'RESERVADA',
    occupied: 'OCUPADA',
    ready: 'PEDIDO LISTO',
    pay: 'POR COBRAR',
  }

  const activeZones = useMemo(
    () => state.zones.filter((zone) => zone.active !== false).sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)),
    [state.zones],
  )

  const statusStyle = (status) => {
    if (status === 'free') return { borderColor: '#2f9e44', boxShadow: 'inset 0 0 0 1px #2f9e44' }
    if (status === 'reserved') return { borderColor: '#e0a800', boxShadow: 'inset 0 0 0 1px #e0a800' }
    if (status === 'occupied') return { borderColor: '#d64545', boxShadow: 'inset 0 0 0 1px #d64545' }
    return undefined
  }

  function tableTimeText(table, status) {
    const isOpen = ['occupied', 'ready', 'pay'].includes(status)
    const value = isOpen ? table.openedAt : table.releasedAt
    const time = formatTime(value)
    if (!time) return isOpen ? 'Hora de apertura sin registrar' : 'Hora de liberación sin registrar'
    return isOpen ? `Abierta a las ${time}` : `Liberada a las ${time}`
  }

  return (
    <section className="view active">
      <div className="hero"><div><h2>Mesas y salones</h2><p>Las mesas se muestran dentro del área a la que pertenecen. Toca una mesa para abrir o continuar su pedido.</p></div></div>

      {!activeZones.length && (
        <div className="card"><div className="empty-inline">No hay mesas configuradas. Ve a Configuración → Salones / áreas y mesas para crear la distribución del restaurante.</div></div>
      )}

      {activeZones.map((zone) => {
        const tables = state.tables.filter((table) => table.active !== false && table.zoneId === zone.id)
        return (
          <div className="card section-gap" key={zone.id}>
            <div className="section-title"><h3>{zone.name}</h3><span className="badge">{tables.length} {tables.length === 1 ? 'mesa' : 'mesas'}</span></div>
            {tables.length ? (
              <div className="tables">
                {tables.map((table) => {
                  const status = getTableVisualStatus(table.id)
                  return (
                    <button className={`table ${status}`} style={statusStyle(status)} key={table.id} onClick={() => onOpenTable(table.id)}>
                      <div className="table-head">
                        <b>{table.name}</b>
                        <small className="table-capacity">{table.capacity} puestos</small>
                      </div>
                      <small className="table-time">◷ {tableTimeText(table, status)}</small>
                      <span className="table-status">{labels[status] || status}</span>
                    </button>
                  )
                })}
              </div>
            ) : <div className="empty-inline">Esta área todavía no tiene mesas.</div>}
          </div>
        )
      })}
    </section>
  )
}
