import React from 'react'
import { useRestaurant, orderBalance } from '../context/RestaurantContext.jsx'

function TableButton({ table, zoneName, status, onOpen }) {
  const labels = { free: 'LIBRE', reserved: 'RESERVADA', occupied: 'CUENTA ABIERTA', ready: 'PEDIDO LISTO', pay: 'POR COBRAR' }
  const style = status === 'free'
    ? { borderColor: '#22c55e' }
    : status === 'reserved'
      ? { borderColor: '#eab308' }
      : status === 'occupied'
        ? { borderColor: '#ef4444' }
        : undefined
  return (
    <button className={`table ${status}`} style={style} onClick={() => onOpen(table.id)}>
      <b>{table.name}</b>
      <small>{zoneName}</small>
      <span>{labels[status] || status}</span>
    </button>
  )
}

export default function DashboardPage({ onNavigate, onOpenTable, onNewOrder }) {
  const { state, resetDemo, getTableVisualStatus } = useRestaurant()
  const activeTables = state.tables.filter((table) => table.active !== false)
  const activeZones = state.zones.filter((zone) => zone.active !== false)
  const zoneNameById = Object.fromEntries(activeZones.map((zone) => [zone.id, zone.name]))
  const occupied = activeTables.filter((table) => ['occupied', 'ready', 'pay'].includes(getTableVisualStatus(table.id))).length
  const activeOrders = state.orders.filter((order) => !['closed', 'cancelled', 'merged'].includes(order.status)).length
  const toPay = state.orders.filter((order) => order.mode === 'table' && orderBalance(order) > 0.005 && (order.rounds?.length || 0) > 0).length

  return (
    <section className="view active">
      <div className="hero">
        <div><h2>Buenos días 👋</h2><p>Vista general de la operación del restaurante.</p></div>
        <button className="btn" onClick={() => window.confirm('¿Restablecer todos los datos de demostración?') && resetDemo()}>Restablecer demo</button>
      </div>
      <div className="grid stats">
        <div className="card stat"><span className="label">Mesas ocupadas</span><strong>{occupied} / {activeTables.length}</strong><small>Estado en tiempo real</small></div>
        <div className="card stat"><span className="label">Pedidos activos</span><strong>{activeOrders}</strong><small>Cocina, bar y salón</small></div>
        <div className="card stat"><span className="label">Por cobrar</span><strong>{toPay}</strong><small>Cuentas pendientes</small></div>
        <div className="card stat"><span className="label">Ventas del día</span><strong>€{state.sales.toFixed(2)}</strong><small>Pagos registrados</small></div>
      </div>
      <div className="grid two" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="section-title"><h3>Estado del salón</h3><button className="btn" onClick={() => onNavigate('tables')}>Ver mesas</button></div>
          {activeTables.length ? (
            <div className="tables">{activeTables.slice(0, 8).map((table) => <TableButton key={table.id} table={table} zoneName={zoneNameById[table.zoneId] || 'Sin área'} status={getTableVisualStatus(table.id)} onOpen={onOpenTable} />)}</div>
          ) : (
            <div className="empty-inline">No hay mesas configuradas. Créelas desde Configuración.</div>
          )}
        </div>
        <div className="card">
          <div className="section-title"><h3>Acciones rápidas</h3></div>
          <div className="quick">
            <button onClick={onNewOrder}><span className="bigico">🧾</span>Tomar pedido</button>
            <button onClick={() => onNavigate('cashier')}><span className="bigico">💳</span>Cobrar mesa</button>
            <button onClick={() => onNavigate('kitchen')}><span className="bigico">🍳</span>Cocina</button>
            <button onClick={() => onNavigate('inventory')}><span className="bigico">📦</span>Inventario</button>
          </div>
          <div className="section-title" style={{ marginTop: 22 }}><h3>Actividad</h3></div>
          <div className="list">
            {state.activity.slice(-5).reverse().map((activity, index) => (
              <div className="row" key={`${activity}-${index}`}><div><b>{activity}</b><small>Actividad demo</small></div></div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
