import React, { useEffect, useMemo, useState } from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { CURRENCY_OPTIONS } from '../lib/currency.js'
import { loadCompanyProfile, saveCompanyProfile } from '../services/invoiceRegisterService.js'
import {
  loadBranchStationSettings,
  saveBranchStationSetting,
  setDefaultBranchStation,
} from '../services/stationSettingsService.js'

function SettingsSection({
  title,
  description,
  icon,
  children,
  defaultOpen = false,
  badge = null,
}) {
  return (
    <details className="settings-section" open={defaultOpen || undefined}>
      <summary className="settings-section-toggle">
        <span className="settings-section-icon" aria-hidden="true">{icon}</span>
        <span className="settings-section-copy">
          <b>{title}</b>
          {description && <small>{description}</small>}
        </span>
        {badge && <span className="badge settings-section-badge">{badge}</span>}
        <span className="settings-section-chevron" aria-hidden="true">⌄</span>
      </summary>

      <div className="settings-section-content">
        {children}
      </div>
    </details>
  )
}

export default function SettingsPage() {
  const {
    state,
    addZone, updateZone, deleteZone,
    addTable, updateTable, deleteTable,
    activeLocation, remoteLoading, remoteError,
    setCurrency,
    setInventoryStockControl,
    setOperationalBehavior,
    refreshMenu,
  } = useRestaurant()
  const auth = useAuth()
  const canManageTables = auth.can('tables.manage')
  const canManageSettings = auth.can('settings.manage')
  const settings = state.settings
  const companyRestaurantId = auth.userContext?.membership?.restaurant_id || null
  const [company, setCompany] = useState({ restaurant_id: companyRestaurantId, legal_name: '', trade_name: '', nit: '', verification_digit: '', tax_regime: '', tax_responsibilities: '', address: '', city: '', department: '', phone: '', email: '', invoice_prefix: 'FAC', resolution_number: '', resolution_date: '', resolution_range_start: '', resolution_range_end: '', footer_text: '' })
  const [companySaving, setCompanySaving] = useState(false)
  useEffect(() => { if (companyRestaurantId) loadCompanyProfile(companyRestaurantId).then((saved) => saved && setCompany(saved)).catch(() => {}) }, [companyRestaurantId])
  async function saveCompany() { if (!canManageSettings || !companyRestaurantId) return; setCompanySaving(true); try { setCompany(await saveCompanyProfile({ ...company, restaurant_id: companyRestaurantId })) } catch (e) { window.alert(e.message) } finally { setCompanySaving(false) } }

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
  const [currencySaving, setCurrencySaving] = useState(false)
  const [inventoryControlSaving, setInventoryControlSaving] = useState(false)
  const [operationSaving, setOperationSaving] = useState(false)
  const [stationSettings, setStationSettings] = useState([])
  const [stationLoading, setStationLoading] = useState(false)
  const [stationSavingType, setStationSavingType] = useState('')
  const [defaultStationSaving, setDefaultStationSaving] = useState(false)

  async function refreshStationSettings() {
    if (!activeLocation?.id || auth.isDesignMode) {
      setStationSettings([])
      return
    }

    setStationLoading(true)
    try {
      setStationSettings(await loadBranchStationSettings(activeLocation.id))
    } catch (error) {
      window.alert(error?.message || 'No se pudieron cargar las estaciones de preparación.')
    } finally {
      setStationLoading(false)
    }
  }

  useEffect(() => {
    refreshStationSettings()
  }, [activeLocation?.id, auth.isDesignMode])

  async function saveStation(station, patch) {
    if (!canManageSettings || !activeLocation?.id) return

    const activeStations = stationSettings.filter((item) => item.active)
    const defaultStation = stationSettings.find((item) => item.isDefault && item.active) || null
    const next = {
      active: patch.active ?? station.active,
      outputMode: patch.outputMode ?? station.outputMode,
    }

    if (station.active && next.active === false) {
      if (activeStations.length <= 1) {
        window.alert('Cada sucursal debe conservar al menos una estación activa.')
        return
      }

      if (station.isDefault) {
        window.alert('Antes de apagar esta estación, selecciona otra estación activa como predeterminada.')
        return
      }

      const confirmed = window.confirm(
        `¿Apagar la estación “${station.name}”?\n\nMientras esté apagada, sus nuevas comandas se enviarán automáticamente a “${defaultStation?.name || 'la estación predeterminada'}”. Al volver a encenderla, RestOS+ restaurará su ruta normal.`,
      )
      if (!confirmed) return
    }

    setStationSavingType(station.stationType)
    try {
      await saveBranchStationSetting({
        locationId: activeLocation.id,
        stationType: station.stationType,
        active: next.active,
        outputMode: next.outputMode,
      })

      await Promise.all([
        refreshStationSettings(),
        refreshMenu(),
      ])
    } catch (error) {
      window.alert(error?.message || 'No se pudo guardar la estación.')
    } finally {
      setStationSavingType('')
    }
  }

  async function makeDefaultStation(station) {
    if (!canManageSettings || !activeLocation?.id || !station.active || station.isDefault) return

    setDefaultStationSaving(true)
    try {
      await setDefaultBranchStation({
        locationId: activeLocation.id,
        stationType: station.stationType,
      })

      await Promise.all([
        refreshStationSettings(),
        refreshMenu(),
      ])
    } catch (error) {
      window.alert(error?.message || 'No se pudo cambiar la estación predeterminada.')
    } finally {
      setDefaultStationSaving(false)
    }
  }

  async function changeCurrency(event) {
    const code = event.target.value
    setCurrencySaving(true)
    const result = await setCurrency(code)
    setCurrencySaving(false)
    if (!result.ok) window.alert(result.message)
  }

  async function changeInventoryControl(event) {
    const enabled = event.target.checked
    setInventoryControlSaving(true)
    const result = await setInventoryStockControl(enabled)
    setInventoryControlSaving(false)
    if (!result.ok) window.alert(result.message)
  }

  async function changeManualQuickIdentity(event) {
    const allowPager = event.target.checked
    setOperationSaving(true)
    const result = await setOperationalBehavior({ allowPager })
    setOperationSaving(false)
    if (!result.ok) window.alert(result.message)
  }

  async function submitZone(event) {
    event.preventDefault()
    const result = await addZone(zoneName)
    if (!result.ok) return window.alert(result.message)
    setZoneName('')
    if (!tableZoneId) setTableZoneId(result.zone.id)
  }

  async function submitTable(event) {
    event.preventDefault()
    const result = await addTable({ zoneId: tableZoneId, name: tableName, capacity: tableCapacity })
    if (!result.ok) return window.alert(result.message)
    setTableName('')
    setTableCapacity(2)
  }

  async function saveZoneEdit() {
    const result = await updateZone(editingZone.id, editingZone.name)
    if (!result.ok) return window.alert(result.message)
    setEditingZone(null)
  }

  async function saveTableEdit() {
    const result = await updateTable(editingTable.id, {
      name: editingTable.name,
      zoneId: editingTable.zoneId,
      capacity: editingTable.capacity,
    })
    if (!result.ok) return window.alert(result.message)
    setEditingTable(null)
  }

  async function confirmDeleteZone(zone) {
    if (!window.confirm(`¿Eliminar el área “${zone.name}”? Solo se eliminará de la operación; su ID histórico se conserva.`)) return
    const result = await deleteZone(zone.id)
    if (!result.ok) window.alert(result.message)
  }

  async function confirmDeleteTable(table) {
    if (!window.confirm(`¿Eliminar “${table.name}”? Los pedidos históricos seguirán vinculados a su ID.`)) return
    const result = await deleteTable(table.id)
    if (!result.ok) window.alert(result.message)
  }

  return (
    <section className="view active">
      <div className="hero"><div><h2>Configuración</h2><p>Restaurante, operación, salones/áreas, mesas, pagos e integraciones.</p></div></div>

      <SettingsSection
        title="Operación e integraciones"
        description="Moneda, identificación de servicio rápido, preparación e inventario."
        icon="⚙️"
        defaultOpen
      >
        <div className="grid two">
        <div className="card">
          <h3>Operación</h3>
          <div className="settings-form">
            <label>
              <span>Moneda del restaurante</span>
              <select
                value={settings.currency || 'EUR'}
                onChange={changeCurrency}
                disabled={!canManageSettings || currencySaving}
              >
                {CURRENCY_OPTIONS.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code} · {currency.name}
                  </option>
                ))}
              </select>
              <small>
                {currencySaving
                  ? 'Guardando en Supabase…'
                  : canManageSettings
                    ? 'Se aplica a precios, caja, pagos, reportes y pedidos.'
                    : 'Solo Owner / usuarios con settings.manage pueden cambiarla.'}
              </small>
            </label>

            <label className="toggle-row operational-setting-row">
              <span>
                <b>Permitir número / identificación manual</b>
                <small>
                  {operationSaving
                    ? 'Guardando en Supabase…'
                    : settings.allowPager !== false
                      ? 'Activo: en Servicio rápido se escribe un número o el nombre del cliente.'
                      : 'Desactivado: RestOS+ asigna automáticamente Turno 1, 2, 3… y reinicia el consecutivo después de cada cierre de turno.'}
                </small>
              </span>
              <input
                type="checkbox"
                checked={settings.allowPager !== false}
                onChange={changeManualQuickIdentity}
                disabled={!canManageSettings || operationSaving}
              />
            </label>

            <label className="toggle-row inventory-control-toggle">
              <span>
                <b>Bloquear productos sin insumos suficientes</b>
                <small>
                  {inventoryControlSaving
                    ? 'Guardando en Supabase…'
                    : settings.blockInsufficientInventory !== false
                      ? 'Activo: bloquea el producto cuando la receta o el inventario directo no alcanzan para otra unidad.'
                      : 'Desactivado: permite vender aunque el stock disponible sea insuficiente.'}
                </small>
              </span>
              <input
                type="checkbox"
                checked={settings.blockInsufficientInventory !== false}
                onChange={changeInventoryControl}
                disabled={!canManageSettings || inventoryControlSaving}
              />
            </label>
          </div>
        </div>

        <div className="card">
          <h3>Integraciones</h3>
          <div className="list">
            <div className="row"><b>Salida de estaciones</b><span className="badge ok-badge">Pantalla / Impresora</span></div>
            <div className="row"><b>Instagram / Facebook</b><span className="badge">Pendiente API</span></div>
            <div className="row"><b>Base de datos</b><span className="badge ok-badge">Supabase · conectado</span></div>
            <div className="row"><b>Sucursal operativa</b><span className="badge">{activeLocation?.name || (remoteLoading ? 'Cargando…' : 'Sin sucursal')}</span></div>
            <div className="row"><b>Mesas / zonas</b><span className={`badge ${!remoteError ? 'ok-badge' : ''}`}>{remoteError ? 'Error de sincronización' : 'Guardado en Supabase'}</span></div>
            <div className="row"><b>Moneda</b><span className="badge ok-badge">{settings.currency || 'EUR'} · Supabase</span></div>
            <div className="row"><b>Usuarios y login</b><span className={`badge ${auth.isSupabaseConfigured ? 'ok-badge' : ''}`}>{auth.isSupabaseConfigured ? 'Cliente configurado' : 'Pendiente .env'}</span></div>
            <div className="row"><b>Aprobación de usuarios</b><span className="badge">Por rol y membresía</span></div>
          </div>
          <div className="notice warn">Que el cliente Supabase esté configurado no significa que Auth esté listo: todavía debes activar plantillas OTP, URLs y Google desde el panel de Supabase.</div>
        </div>
      </div>
      </SettingsSection>

      <SettingsSection
        title="Estaciones de preparación"
        description="Activa únicamente las estaciones que usa esta sucursal y define si trabajan con pantalla o impresora."
        icon="🍳"
        badge={activeLocation ? `${stationSettings.filter((station) => station.active).length} activas` : 'Sin sucursal'}
        defaultOpen
      >
        {!activeLocation ? (
          <div className="notice warn">Selecciona primero una sucursal para configurar sus estaciones.</div>
        ) : (
          <>
            <div className="section-title">
              <div>
                <h3>{activeLocation.name}</h3>
                <p className="muted">
                  El Catálogo maestro solo podrá asignar productos a estaciones que estén encendidas en esta sucursal.
                </p>
              </div>
              <span className="badge">{canManageSettings ? 'Administrador' : 'Solo lectura'}</span>
            </div>

            {stationLoading ? (
              <div className="empty-inline">Cargando estaciones…</div>
            ) : (
              <div className="station-settings-grid section-gap">
                {stationSettings.map((station) => {
                  const saving = stationSavingType === station.stationType
                  return (
                    <article className={`station-setting-card ${station.active ? 'active' : 'inactive'}`} key={station.stationType}>
                      <div className="station-setting-head">
                        <span className="station-setting-icon">{station.icon}</span>
                        <div>
                          <h4>{station.name}</h4>
                          <small>
                            {station.active ? 'Estación encendida' : 'Estación apagada'}
                            {station.isDefault ? ' · Predeterminada' : ''}
                          </small>
                        </div>
                        <label className="station-setting-switch">
                          <input
                            type="checkbox"
                            checked={station.active}
                            disabled={!canManageSettings || saving || defaultStationSaving || (station.active && station.isDefault)}
                            onChange={(event) => saveStation(station, { active: event.target.checked })}
                            title={station.active && station.isDefault ? 'Selecciona otra estación predeterminada antes de apagar esta.' : ''}
                          />
                          <span>{station.active ? 'ON' : 'OFF'}</span>
                        </label>
                      </div>

                      {station.active && (
                        <>
                          <div className="station-default-choice">
                            <span>Estación de respaldo</span>
                            <button
                              type="button"
                              className={station.isDefault ? 'active' : ''}
                              disabled={!canManageSettings || saving || defaultStationSaving || station.isDefault}
                              onClick={() => makeDefaultStation(station)}
                            >
                              {station.isDefault ? '★ Predeterminada' : '☆ Usar como predeterminada'}
                            </button>
                            <small>
                              {station.isDefault
                                ? 'Las comandas de una estación apagada o fuera de servicio se enviarán aquí.'
                                : 'Solo puede existir una estación predeterminada por sucursal.'}
                            </small>
                          </div>

                          <div className="station-output-choice">
                          <span>Salida de comandas</span>
                          <div className="station-output-buttons">
                            <button
                              type="button"
                              className={station.outputMode === 'screen' ? 'active' : ''}
                              disabled={!canManageSettings || saving}
                              onClick={() => saveStation(station, { outputMode: 'screen' })}
                            >
                              🖥️ Pantalla
                            </button>
                            <button
                              type="button"
                              className={station.outputMode === 'printer' ? 'active' : ''}
                              disabled={!canManageSettings || saving}
                              onClick={() => saveStation(station, { outputMode: 'printer' })}
                            >
                              🖨️ Impresora
                            </button>
                          </div>
                          <small>
                            {station.outputMode === 'screen'
                              ? 'Las comandas se trabajan desde la pantalla de esta estación.'
                              : 'La estación queda definida para impresión. La vinculación de la impresora física se realizará desde la integración de impresoras.'}
                          </small>
                        </div>
                        </>
                      )}

                      {saving && <div className="station-setting-saving">Guardando en Supabase…</div>}
                    </article>
                  )
                })}
              </div>
            )}

            <div className="notice section-gap">
              Siempre debe existir al menos una estación activa y exactamente una predeterminada. Si una estación no predeterminada se apaga, sus comandas se desvían temporalmente a la predeterminada y vuelven a su estación normal cuando esta se reactiva.
            </div>
          </>
        )}
      </SettingsSection>

      <SettingsSection
        title="Empresa y facturación"
        description="Datos fiscales, identificación del negocio y consecutivos internos de factura."
        icon="🧾"
      >
        <div className="card section-gap"><div className="section-title"><div><h3>Datos de empresa — Colombia</h3><p className="muted">Se utilizarán en la vista previa y en el registro interno de facturas.</p></div><span className="badge">Configuración fiscal interna</span></div><div className="grid two settings-form"><label><span>Razón social</span><input value={company.legal_name} onChange={e=>setCompany({...company,legal_name:e.target.value})}/></label><label><span>Nombre comercial</span><input value={company.trade_name} onChange={e=>setCompany({...company,trade_name:e.target.value})}/></label><label><span>NIT</span><input value={company.nit} onChange={e=>setCompany({...company,nit:e.target.value})}/></label><label><span>Dígito de verificación</span><input value={company.verification_digit} onChange={e=>setCompany({...company,verification_digit:e.target.value})}/></label><label><span>Régimen</span><input value={company.tax_regime} onChange={e=>setCompany({...company,tax_regime:e.target.value})}/></label><label><span>Responsabilidades tributarias</span><input value={company.tax_responsibilities} onChange={e=>setCompany({...company,tax_responsibilities:e.target.value})}/></label><label><span>Dirección</span><input value={company.address} onChange={e=>setCompany({...company,address:e.target.value})}/></label><label><span>Ciudad</span><input value={company.city} onChange={e=>setCompany({...company,city:e.target.value})}/></label><label><span>Departamento</span><input value={company.department} onChange={e=>setCompany({...company,department:e.target.value})}/></label><label><span>Teléfono</span><input value={company.phone} onChange={e=>setCompany({...company,phone:e.target.value})}/></label><label><span>Correo</span><input type="email" value={company.email} onChange={e=>setCompany({...company,email:e.target.value})}/></label><label><span>Prefijo interno</span><input value={company.invoice_prefix} onChange={e=>setCompany({...company,invoice_prefix:e.target.value})}/></label><label><span>Resolución / autorización</span><input value={company.resolution_number} onChange={e=>setCompany({...company,resolution_number:e.target.value})}/></label><label><span>Fecha de resolución</span><input type="date" value={company.resolution_date||''} onChange={e=>setCompany({...company,resolution_date:e.target.value})}/></label><label><span>Consecutivo inicial</span><input type="number" value={company.resolution_range_start||''} onChange={e=>setCompany({...company,resolution_range_start:e.target.value})}/></label><label><span>Consecutivo final</span><input type="number" value={company.resolution_range_end||''} onChange={e=>setCompany({...company,resolution_range_end:e.target.value})}/></label><label className="span-two"><span>Texto del pie de factura</span><textarea value={company.footer_text} onChange={e=>setCompany({...company,footer_text:e.target.value})}/></label></div><button className="btn primary" disabled={!canManageSettings||companySaving} onClick={saveCompany}>{companySaving?'Guardando…':'Guardar datos de empresa'}</button></div>
      </SettingsSection>

      <SettingsSection
        title="Salones, áreas y mesas"
        description="Crea y administra la distribución física del restaurante."
        icon="▦"
        badge={`${activeTables.length} mesas`}
      >
        {!canManageTables && (
          <div className="notice section-gap">Tu rol puede consultar mesas, pero no crear ni modificar zonas o mesas.</div>
        )}

        <div className="grid two section-gap">
        <div className="card">
          <div className="section-title"><div><h3>Salones / áreas</h3><p className="muted">Ej.: Terraza, Salón 1, Salón 2. El nombre del área no se puede repetir.</p></div><span className="badge">{activeZones.length} activas</span></div>
          <form className="settings-form" onSubmit={submitZone}>
            <label><span>Nueva área</span><input disabled={!canManageTables || remoteLoading} value={zoneName} onChange={(event) => setZoneName(event.target.value)} placeholder="Ej. Terraza" /></label>
            <button className="btn primary" type="submit" disabled={!canManageTables || remoteLoading}>＋ Agregar área</button>
          </form>
          <div className="list section-gap">
            {activeZones.length ? activeZones.map((zone) => {
              const tableCount = activeTables.filter((table) => table.zoneId === zone.id).length
              return (
                <div className="row" key={zone.id}>
                  <div><b>{zone.name}</b><small>{tableCount} {tableCount === 1 ? 'mesa' : 'mesas'}</small></div>
                  <div className="line-actions">
                    {canManageTables && <button className="mini" onClick={() => setEditingZone({ ...zone })}>Editar</button>}
                    {canManageTables && <button className="mini danger" onClick={() => confirmDeleteZone(zone)}>Eliminar</button>}
                  </div>
                </div>
              )
            }) : <div className="empty-inline">Todavía no hay salones o áreas. Crea primero un área.</div>}
          </div>
        </div>

        <div className="card">
          <div className="section-title"><div><h3>Mesas</h3><p className="muted">El nombre puede repetirse en áreas diferentes. Cada mesa conserva un ID interno permanente.</p></div><span className="badge">{activeTables.length} activas</span></div>
          <form className="settings-form" onSubmit={submitTable}>
            <label><span>Área</span><select disabled={!canManageTables || remoteLoading} value={tableZoneId} onChange={(event) => setTableZoneId(event.target.value)}><option value="">Selecciona un área</option>{activeZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
            <label><span>Nombre o número de mesa</span><input disabled={!canManageTables || remoteLoading} value={tableName} onChange={(event) => setTableName(event.target.value)} placeholder="Ej. Mesa 3" /></label>
            <label><span>Capacidad</span><input disabled={!canManageTables || remoteLoading} type="number" min="1" value={tableCapacity} onChange={(event) => setTableCapacity(event.target.value)} /></label>
            <button className="btn primary" type="submit" disabled={!canManageTables || remoteLoading || !activeZones.length}>＋ Agregar mesa</button>
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
                    {canManageTables && <button className="mini" onClick={() => setEditingTable({ ...table })}>Editar</button>}
                    {canManageTables && <button className="mini danger" onClick={() => confirmDeleteTable(table)}>Eliminar</button>}
                  </div>
                </div>
              ))}</div> : <div className="empty-inline">Esta área todavía no tiene mesas.</div>}
            </div>
          )
        }) : <div className="empty-inline">No hay mesas configuradas.</div>}
      </div>
      </SettingsSection>

      <SettingsSection
        title="Tipos de servicio"
        description="Referencia rápida del comportamiento de mesa y servicio rápido."
        icon="🍽️"
      >
        <div className="grid two section-gap">
        <div className="card"><h3>Servicio de mesa</h3><p className="muted">Pedido abierto mientras la mesa permanezca ocupada. Cada envío crea una comanda/ronda. Los productos enviados quedan bloqueados y las nuevas adiciones se envían aparte.</p></div>
        <div className="card"><h3>Servicio rápido / Prepago</h3><p className="muted">Se cobra antes de preparar. Puede usar un número manual, turno automático o nombre del cliente según la configuración.</p></div>
      </div>
      </SettingsSection>

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
