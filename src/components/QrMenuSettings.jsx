import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

export default function QrMenuSettings({ locationId, canManage }) {
  const [enabled, setEnabled] = useState(false)
  const [authMode, setAuthMode] = useState('required')
  const [attention, setAttention] = useState({enabled:false,call_waiter:true,request_drink:true,request_bill:true,order_status:true})
  const [ownerCanChange, setOwnerCanChange] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    if (!locationId || !supabase) return
    setBusy(true)
    Promise.all([
      supabase.rpc('manage_qr_menu', { p_location_id: locationId }),
      supabase.rpc('manage_qr_customer_auth', { p_location_id: locationId }),
      supabase.rpc('manage_qr_attention_settings', { p_location_id: locationId }),
    ]).then(([menuResult, authResult, attentionResult]) => {
      if (!active) return
      setError(menuResult.error?.message || authResult.error?.message || attentionResult.error?.message || '')
      if (!attentionResult.error && attentionResult.data) setAttention(attentionResult.data)
      if (!menuResult.error) setEnabled(menuResult.data?.enabled === true)
      if (!authResult.error) {
        setAuthMode(authResult.data?.mode || 'required')
        setOwnerCanChange(authResult.data?.ownerCanChange === true)
      }
    }).finally(() => { if(active) setBusy(false) })
    return () => { active = false }
  }, [locationId])
  const url = locationId ? new URL('/menu/' + locationId, window.location.origin).toString() : ''
  async function toggle(event) {
    const next = event.target.checked
    setBusy(true)
    setError('')
    const { data, error: err } = await supabase.rpc('manage_qr_menu', { p_location_id: locationId, p_enabled: next })
    if (err) setError(err.message)
    else setEnabled(data?.enabled === true)
    setBusy(false)
  }
  async function changeAuthMode(mode) {
    if (!ownerCanChange || busy || !locationId) return
    setBusy(true)
    setError('')
    const { data, error: err } = await supabase.rpc('manage_qr_customer_auth', {
      p_location_id: locationId, p_mode: mode,
    })
    if (err) setError(err.message)
    else setAuthMode(data?.mode || 'required')
    setBusy(false)
  }
  async function changeAttention(setting, value) {
    if (!canManage || busy || !locationId) return
    setBusy(true);setError('')
    const { data, error: err } = await supabase.rpc('manage_qr_attention_settings', {
      p_location_id: locationId, p_changes: {[setting]:value},
    })
    if (err) setError(err.message)
    else if (data) setAttention(data)
    setBusy(false)
  }
  return <div className="card" style={{marginBottom:18}}>
    <h3>📱 Menú QR público</h3>
    <p style={{color:'var(--muted)'}}>Publica el menú digital de esta sucursal. La carta siempre puede consultarse sin iniciar sesión; el propietario decide cómo se autentican los clientes para pedir.</p>
    <label className="toggle-row operational-setting-row">
      <span><b>Publicar menú de esta sucursal</b><small>Los productos activos y sus precios serán visibles públicamente.</small></span>
      <input type="checkbox" checked={enabled} disabled={!locationId || !canManage || busy} onChange={toggle} />
    </label>
    <div className="qr-auth-settings">
      <div className="qr-auth-settings-head">
        <b>Autenticación de clientes QR</b>
        <small>Solo el propietario puede modificarla. Se aplica únicamente a esta sucursal.</small>
      </div>
      <div className="qr-auth-mode-options" role="radiogroup" aria-label="Autenticación para realizar pedidos QR">
        {[
          { value: 'required', label: 'Obligatoria', help: 'Código general de 6 dígitos y acceso con Google o Apple para pedir.' },
          { value: 'optional', label: 'Opcional', help: 'El código de 6 dígitos siempre se utiliza; Google o Apple son opcionales.' },
          { value: 'disabled', label: 'Desactivada', help: 'Solo se requiere el código general de 6 dígitos, sin Google ni Apple.' },
        ].map(item => (
          <label className={`qr-auth-mode-card ${authMode === item.value ? 'selected' : ''}`} key={item.value}>
            <input type="radio" name="qr-customer-auth-mode" checked={authMode === item.value}
              onChange={() => changeAuthMode(item.value)} disabled={!locationId || !ownerCanChange || busy} />
            <span><b>{item.label}</b><small>{item.help}</small></span>
          </label>
        ))}
      </div>
      {authMode !== 'disabled' && <p className="qr-auth-provider-note">
        Google y Apple requieren configurar sus proveedores OAuth y las URL de retorno en Supabase Auth antes de que los clientes puedan utilizarlos.
      </p>}
    </div>
    <div className="qr-attention-settings-panel">
      <div className="qr-auth-settings-head">
        <b>🔔 Acceso QR único y funciones del cliente</b>
        <small>El cliente escanea el QR de su mesa e introduce un código numérico de seis cifras mostrado en la pantalla de la sucursal. El código cambia cada 20 minutos.</small>
      </div>
      <label className="toggle-row operational-setting-row">
        <span><b>Activar acceso QR de 6 dígitos</b><small>Es necesario para solicitar atención y realizar pedidos desde el celular. El menú público sigue siendo consultable.</small></span>
        <input type="checkbox" checked={attention.enabled} disabled={!locationId || !canManage || busy} onChange={event=>changeAttention('enabled',event.target.checked)}/>
      </label>
      {attention.enabled && <div className="qr-attention-feature-settings">
        {[
          ['call_waiter','🙋 Llamar al mesero','Envía una alerta al personal de sala'],
          ['request_drink','🥤 Solicitar bebida','Avisa que el cliente quiere ordenar una bebida'],
          ['request_bill','🧾 Pedir la cuenta','Avisa al personal; no realiza cobros'],
          ['order_status','📋 Estado del pedido','Solo permite consultar solicitudes privadas del propio cliente'],
        ].map(([key,label,description])=>(
          <label className="toggle-row operational-setting-row" key={key}>
            <span><b>{label}</b><small>{description}</small></span>
            <input type="checkbox" checked={Boolean(attention[key])} disabled={!canManage || busy} onChange={event=>changeAttention(key,event.target.checked)}/>
          </label>
        ))}
      </div>}
      <p className="qr-auth-provider-note">El mismo código abre las funciones de atención y «Realizar pedido» cuando el menú y la mesa lo permiten. Se consulta en «🔐 Código QR» desde Mesas, Caja y otras ventanas autorizadas. Ya no se utiliza un PIN diferente por mesa.</p>
    </div>
    {error && <p role="alert" style={{color:'var(--danger)'}}>{error}</p>}
    {locationId && <div style={{overflowWrap:'anywhere',marginTop:15}}>
      <small>Enlace público:</small><p><a href={url} target="_blank" rel="noreferrer">{url}</a></p>
      <button className="btn" type="button" onClick={() => navigator.clipboard.writeText(url)}>Copiar enlace</button>
      <button className="btn" style={{marginLeft:8}} type="button" onClick={() => window.open(url,'_blank','noopener,noreferrer')}>Vista del cliente</button>
    </div>}
  </div>
}
