import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

export default function QrMenuSettings({ locationId, canManage }) {
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    if (!locationId || !supabase) return
    setBusy(true)
    supabase.rpc('manage_qr_menu', { p_location_id: locationId })
      .then(({data,error:err}) => { if (!active) return; if (err) setError(err.message); else {setError('');setEnabled(data?.enabled === true)} })
      .finally(() => { if(active) setBusy(false) })
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
  return <div className="card" style={{marginBottom:18}}>
    <h3>📱 Menú QR público</h3>
    <p style={{color:'var(--muted)'}}>Publica una carta de solo lectura para esta sucursal. Los clientes no necesitan iniciar sesión. Todavía no permite realizar pedidos.</p>
    <label className="toggle-row operational-setting-row">
      <span><b>Publicar menú de esta sucursal</b><small>Los productos activos y sus precios serán visibles públicamente.</small></span>
      <input type="checkbox" checked={enabled} disabled={!locationId || !canManage || busy} onChange={toggle} />
    </label>
    {error && <p role="alert" style={{color:'var(--danger)'}}>{error}</p>}
    {locationId && <div style={{overflowWrap:'anywhere',marginTop:15}}>
      <small>Enlace público:</small><p><a href={url} target="_blank" rel="noreferrer">{url}</a></p>
      <button className="btn" type="button" onClick={() => navigator.clipboard.writeText(url)}>Copiar enlace</button>
      <button className="btn" style={{marginLeft:8}} type="button" onClick={() => window.open(url,'_blank','noopener,noreferrer')}>Vista del cliente</button>
    </div>}
  </div>
}
