import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

export default function QrMenuSettings({ locationId, canManage }) {
  const [enabled, setEnabled] = useState(false)
  const [authMode, setAuthMode] = useState('required')
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
    ]).then(([menuResult, authResult]) => {
      if (!active) return
      setError(menuResult.error?.message || authResult.error?.message || '')
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
          { value: 'required', label: 'Obligatoria', help: 'Google o Apple y PIN de mesa para pedir.' },
          { value: 'optional', label: 'Opcional', help: 'El cliente puede iniciar sesión o pedir solo con el PIN.' },
          { value: 'disabled', label: 'Desactivada', help: 'No se pide acceso con Google o Apple; se mantiene el PIN.' },
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
    {error && <p role="alert" style={{color:'var(--danger)'}}>{error}</p>}
    {locationId && <div style={{overflowWrap:'anywhere',marginTop:15}}>
      <small>Enlace público:</small><p><a href={url} target="_blank" rel="noreferrer">{url}</a></p>
      <button className="btn" type="button" onClick={() => navigator.clipboard.writeText(url)}>Copiar enlace</button>
      <button className="btn" style={{marginLeft:8}} type="button" onClick={() => window.open(url,'_blank','noopener,noreferrer')}>Vista del cliente</button>
    </div>}
  </div>
}
