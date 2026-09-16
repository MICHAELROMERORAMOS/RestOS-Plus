import React, { useMemo, useState } from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'

export default function SettingsPage() {
  const {
    state, updateSettings,
    addZone, updateZone, deleteZone,
    addTable, updateTable, deleteTable,
  } = useRestaurant()
  const auth = useAuth()
  const settings = state.settings

  const activeZones = useMemo(
    () => state.zones.filter((zone) => zone.active !== false).sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)),
    [state.zones],
  )
  const activeTables = useMemo(
    () => state.tables.filter((table) => table.active !== false),
    [state.tables],
  )

  const [zoneName, setZoneName] = useState('')
  const [tableName, setTableName] = useState('')
  const [tableZoneId, setTableZoneId] = useState('')
  const [tableCapacity, setTableCapacity] = useState(2)
  const [editingZone, setEditingZone] = useState(null)
  const [editingTable, setEditingTable] = useState(null)

  function submitZone(event) {
    event.preventDefault()
    const result = addZone(zoneName)
    if (!result.ok) return window.alert(result.message)
    setZoneName('')
    if (!tableZoneId) setTableZoneId(result.zone.id)
  }

  function submitTable(event) {
    event.preventDefault()
    const result = addTable({ zoneId: tableZoneId, name: tableName, capacity: tableCapacity })
    if (!result.ok) return window.alert(result.message)
    setTableName('')
    setTableCapacity(2)
  }

  function saveZoneEdit() {
    const result = updateZone(editingZone.id, editingZone.name)
    if (!result.ok) return window.alert(result.message)
    setEditingZone(null)
  }

  function saveTableEdit() {
    const result = updateTable(editingTable.id, {
      name: editingTable.name,
      zoneId: editingTable.zoneId,
      capacity: editingTable.capacity,
    })
    if (!result.ok) return window.alert(result.message)
    setEditingTable(null)
  }

  function confirmDeleteZone(zone) {
    if (!window.confirm(`¿Eliminar el área “${zone.name}”? Solo se eliminará de la operación; su ID histórico se conserva.`)) return
    const result = deleteZone(zone.id)
    if (!result.ok) window.alert(result.message)
  }

  function confirmDeleteTable(table) {
    if (!window.confirm(`¿Eliminar “${table.name}”? Los pedidos históricos seguirán vinculados a su ID.`)) return
    const result = deleteTable(table.id)
    if (!result.ok) window.alert(result.message)
  }

  return (
    <section className="view active">
      <div className="hero"><div><h2>Configuración</h2><p>Restaurante, operación, salones/áreas, mesas, pagos e integraciones.</p></div></div>

      <div className="grid two">
        <div className="card">
          <h3>Operación</h3>
          <div className="settings-form">
            <label><span>Nombre del restaurante</span><input value={settings.restaurantName} onChange={(event) => updateSettings({ restaurantName: event.target.value })} /></label>
            <label><span>Moneda</span><select value={settings.currency} onChange={(event) => updateSettings({ currency: event.target.value, currencySymbol: event.target.value === 'EUR' ? '€' : event.target.value === 'USD' ? '$' : '£' })}><option value="EUR">EUR (€)</option><option value="USD">USD ($)</option><option value="GBP">GBP (£)</option></select></label>
            <label><span>Modo predeterminado</span><select value={settings.defaultOrderMode} onChange={(event) => updateSettings({ defaultOrderMode: event.target.value })}><option value="table">Servicio de mesa / cuenta abierta</option><option value="quick">Servicio rápido / prepago</option></select></label>
            <label><span>Identificador servicio rápido</span><select value={settings.quickIdentifier} onChange={(event) => updateSettings({ quickIdentifier: event.target.value })}><option value="order">Número consecutivo de orden</option><option value="pager">Pager / vibrador</option><option value="turn">Número de turno</option><option value="name">Nombre del cliente</option></select></label>
            <label className="toggle-row"><span>Permitir pager / turno manual</span><input type="checkbox" checked={settings.allowPager} onChange={(event) => updateSettings({ allowPager: event.target.checked })} /></label>
            <label className="toggle-row"><span>Separar Cocina / Bar</span><input type="checkbox" checked={settings.splitStations} onChange={(event) => updateSettings({ splitStations: event.target.checked })} /></label>
          </div>
        </div>

        <div className="card">
          <h3>Integraciones</h3>
          <div className="list">
            <div className="row"><b>Impresoras</b><span className="badge">Pendiente</span></div>
            <div className="row"><b>Instagram / Facebook</b><span className="badge">Pendiente API</span></div>
            <div className="row"><b>Base de datos</b><span className="badge">Supabase · RestOS+</span></div>
            <div className="row"><b>Usuarios y login</b><span className={`badge ${auth.isSupabaseConfigured ? 'ok-badge' : ''}`}>{auth.isSupabaseConfigured ? 'Cliente configurado' : 'Pendiente .env'}</span></div>
            <div className="row"><b>Aprobación de usuarios</b><span className="badge">Por rol y membresía</span></div>
          </div>
          <div className="notice warn">Que el cliente Supabase esté configurado no significa que Auth esté listo: todavía debes activar plantillas OTP, URLs y Google desde el panel de Supabase.</div>
        </div>
      </div>

      <div className="grid two section-gap">
        <div className="card">
          <div className="section-title"><div><h3>Salones / áreas</h3><p className="muted">Ej.: Terraza, Salón 1, Salón 2. El nombre del área no se puede repetir.</p></div><span className="badge">{activeZones.length} activas</span></div>
          <form className="settings-form" onSubmit={submitZone}>
            <label><span>Nueva área</span><input value={zoneName} onChange={(event) => setZoneName(event.target.value)} placeholder="Ej. Terraza" /></label>
            <button className="btn primary" type="submit">＋ Agregar área</button>
          </form>
          <div className="list section-gap">
            {activeZones.length ? activeZones.map((zone) => {
              const tableCount = activeTables.filter((table) => table.zoneId === zone.id).length
              return (
                <div className="row" key={zone.id}>
                  <div><b>{zone.name}</b><small>{tableCount} {tableCount === 1 ? 'mesa' : 'mesas'}</small></div>
                  <div className="line-actions">
                    <button className="mini" onClick={() => setEditingZone({ ...zone })}>Editar</button>
                    <button className="mini danger" onClick={() => confirmDeleteZone(zone)}>Eliminar</button>
                  </div>
                </div>
              )
            }) : <div className="empty-inline">Todavía no hay salones o áreas. Crea primero un área.</div>}
          </div>
        </div>

        <div className="card">
          <div className="section-title"><div><h3>Mesas</h3><p className="muted">El nombre puede repetirse en áreas diferentes. Cada mesa conserva un ID interno permanente.</p></div><span className="badge">{activeTables.length} activas</span></div>
          <form className="settings-form" onSubmit={submitTable}>
            <label><span>Área</span><select value={tableZoneId} onChange={(event) => setTableZoneId(event.target.value)}><option value="">Selecciona un área</option>{activeZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
            <label><span>Nombre o número de mesa</span><input value={tableName} onChange={(event) => setTableName(event.target.value)} placeholder="Ej. Mesa 3" /></label>
            <label><span>Capacidad</span><input type="number" min="1" value={tableCapacity} onChange={(event) => setTableCapacity(event.target.value)} /></label>
            <button className="btn primary" type="submit" disabled={!activeZones.length}>＋ Agregar mesa</button>
          </form>
          {!activeZones.length && <div className="notice warn">Crea primero un salón o área para poder agregar mesas.</div>}
        </div>
      </div>

      <div className="card section-gap">
        <div className="section-title"><h3>Mesas configuradas</h3><span className="badge">Por área</span></div>
        {activeZones.length ? activeZones.map((zone) => {
          const zoneTables = activeTables.filter((table) => table.zoneId === zone.id)
          return (
            <div key={zone.id} className="section-gap">
              <div className="sent-head"><span>{zone.name.toUpperCase()}</span><span>{zoneTables.length} MESAS</span></div>
              {zoneTables.length ? <div className="list">{zoneTables.map((table) => (
                <div className="row" key={table.id}>
                  <div><b>{table.name}</b><small>{table.capacity} puestos · ID {table.id.slice(0, 8)}…</small></div>
                  <div className="line-actions">
                    <button className="mini" onClick={() => setEditingTable({ ...table })}>Editar</button>
                    <button className="mini danger" onClick={() => confirmDeleteTable(table)}>Eliminar</button>
                  </div>
                </div>
              ))}</div> : <div className="empty-inline">Esta área todavía no tiene mesas.</div>}
            </div>
          )
        }) : <div className="empty-inline">No hay mesas configuradas.</div>}
      </div>

      <div className="grid two section-gap">
        <div className="card"><h3>Servicio de mesa</h3><p className="muted">Pedido abierto mientras la mesa permanezca ocupada. Cada envío crea una comanda/ronda. Los productos enviados quedan bloqueados y las nuevas adiciones se envían aparte.</p></div>
        <div className="card"><h3>Servicio rápido / Prepago</h3><p className="muted">Se cobra antes de preparar. Puede usar número consecutivo, pager, turno o nombre de cliente según la configuración.</p></div>
      </div>

      {editingZone && (
        <div className="modal open">
          <div className="modal-card">
            <div className="section-title"><h3>Editar salón / área</h3><button className="btn" onClick={() => setEditingZone(null)}>×</button></div>
            <div className="settings-form"><label><span>Nombre</span><input value={editingZone.name} onChange={(event) => setEditingZone({ ...editingZone, name: event.target.value })} /></label></div>
            <button className="btn primary full" onClick={saveZoneEdit}>Guardar cambios</button>
          </div>
        </div>
      )}

      {editingTable && (
        <div className="modal open">
          <div className="modal-card">
            <div className="section-title"><h3>Editar mesa</h3><button className="btn" onClick={() => setEditingTable(null)}>×</button></div>
            <div className="settings-form">
              <label><span>Nombre o número</span><input value={editingTable.name} onChange={(event) => setEditingTable({ ...editingTable, name: event.target.value })} /></label>
              <label><span>Área</span><select value={editingTable.zoneId} onChange={(event) => setEditingTable({ ...editingTable, zoneId: event.target.value })}>{activeZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
              <label><span>Capacidad</span><input type="number" min="1" value={editingTable.capacity} onChange={(event) => setEditingTable({ ...editingTable, capacity: event.target.value })} /></label>
            </div>
            <div className="notice">El ID interno no cambia aunque modifiques el nombre o muevas la mesa a otra área.</div>
            <button className="btn primary full" onClick={saveTableEdit}>Guardar cambios</button>
          </div>
        </div>
      )}
    </section>
  )
}
