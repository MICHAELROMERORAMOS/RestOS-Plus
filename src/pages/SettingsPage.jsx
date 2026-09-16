import React from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'

export default function SettingsPage() {
  const { state, updateSettings } = useRestaurant()
  const auth = useAuth()
  const settings = state.settings
  return (
    <section className="view active">
      <div className="hero"><div><h2>Configuración</h2><p>Restaurante, modalidad de servicio, impuestos, mesas, pagos, impresión e integraciones.</p></div></div>
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
        <div className="card"><h3>Servicio de mesa</h3><p className="muted">Pedido abierto mientras la mesa permanezca ocupada. Cada envío crea una comanda/ronda. Los productos enviados quedan bloqueados y las nuevas adiciones se envían aparte.</p></div>
        <div className="card"><h3>Servicio rápido / Prepago</h3><p className="muted">Se cobra antes de preparar. Puede usar número consecutivo, pager, turno o nombre de cliente según la configuración.</p></div>
      </div>
    </section>
  )
}
