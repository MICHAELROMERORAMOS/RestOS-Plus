import React, { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import './QrAttentionStaff.css'

const labels = {
  call_waiter: { icon:'🙋', title:'Solicita atención', detail:'Acercarse a la mesa' },
  request_drink: { icon:'🥤', title:'Solicita una bebida', detail:'El cliente quiere pedir una bebida' },
  request_bill: { icon:'🧾', title:'Solicita la cuenta', detail:'El cliente desea pagar' },
}
const getCountdown = deadline => deadline ? Math.max(0,Math.ceil((new Date(deadline).getTime()-Date.now())/1000)) : 0

export default function QrAttentionStaff({ locationId }) {
  const [settings,setSettings] = useState(null)
  const [requests,setRequests] = useState([])
  const [error,setError] = useState('')
  const [notice,setNotice] = useState('')
  const [display,setDisplay] = useState(null)
  const [remaining,setRemaining] = useState(0)
  const [busy,setBusy] = useState(false)
  const [connected,setConnected] = useState(false)
  const screen = useRef(null)
  const refreshId = useRef(0)
  const refreshRequests = useCallback(async () => {
    if (!locationId) return
    const epoch=++refreshId.current
    const {data,error:err} = await supabase.rpc('manage_qr_attention_requests',{p_location_id:locationId})
    if(epoch!==refreshId.current)return
    if(err)setError(err.message)
    else {setRequests(data?.requests || []);setError('')}
  },[locationId])
  const loadSettings = useCallback(async () => {
    if (!locationId) return
    const {data,error:err}=await supabase.rpc('manage_qr_attention_settings',{p_location_id:locationId})
    if(!err)setSettings(data)
  },[locationId])

  useEffect(()=>{
    setRequests([]);setSettings(null);setDisplay(null);setNotice('')
    if(!locationId)return
    void refreshRequests()
    void loadSettings()
    // Only staff screens subscribe. QR customer devices do not open Realtime sockets.
    const channel=supabase.channel('restos-attention-'+locationId)
      .on('postgres_changes',{event:'*',schema:'public',table:'qr_attention_requests',filter:'location_id=eq.'+locationId},
        ()=>{if(document.visibilityState==='visible') void refreshRequests()})
      .subscribe(status=>setConnected(status==='SUBSCRIBED'))
    const onFocus=()=>{void refreshRequests();void loadSettings()}
    window.addEventListener('focus',onFocus)
    return ()=>{++refreshId.current;window.removeEventListener('focus',onFocus);void supabase.removeChannel(channel)}
  },[locationId,refreshRequests,loadSettings])

  const refreshDisplay = useCallback(async () => {
    if(!locationId)return
    const {data,error:err}=await supabase.rpc('get_qr_attention_display',{p_location_id:locationId})
    if(err){setError(err.message);return}
    setDisplay(data)
    setRemaining(getCountdown(data?.expiresAt))
  },[locationId])

  useEffect(()=>{
    if(!display?.enabled)return undefined
    const id=window.setInterval(()=>{
      const current=getCountdown(display.expiresAt)
      setRemaining(current)
      if(current===0)void refreshDisplay()
    },1000)
    return ()=>window.clearInterval(id)
  },[display?.expiresAt,display?.enabled,refreshDisplay])

  async function openDisplay(){
    await refreshDisplay()
    if(screen.current?.requestFullscreen) {
      try { await screen.current.requestFullscreen() } catch { /* Fallback: in-app expanded panel */ }
    }
  }
  async function closeDisplay(){
    if(document.fullscreenElement){try{await document.exitFullscreen()}catch{}}
    setDisplay(null)
  }
  async function processRequest(id,status){
    if(busy)return
    setBusy(true);setError('');setNotice('')
    const {error:err}=await supabase.rpc('manage_qr_attention_requests',{
      p_location_id:locationId,p_request_id:id,p_status:status,
    })
    if(err)setError(err.message)
    else setNotice(status==='acknowledged'?'Solicitud marcada como vista.':'Solicitud finalizada.')
    await refreshRequests()
    setBusy(false)
  }
  const enabled=Boolean(settings?.enabled)
  return <section className="qr-attention-staff card">
    <div className="qr-attention-staff-head">
      <div><span className="qr-attention-staff-eyebrow">ATENCIÓN QR</span><h3>Solicitudes de atención</h3><p>Alertas de clientes organizadas por sucursal y mesa.</p></div>
      <div className="qr-attention-staff-tools">
        <span className={connected?'qr-attention-online':'qr-attention-offline'}>{connected?'● Avisos en vivo':'○ Reconectando'}</span>
        {enabled && <button className="btn" type="button" onClick={openDisplay}>▣ Mostrar código en pantalla</button>}
        <button className="btn" type="button" onClick={()=>refreshRequests()}>↻ Actualizar</button>
      </div>
    </div>
    {!enabled && <p className="qr-attention-staff-empty">La atención QR está desactivada. Puedes habilitarla en Configuraciones de la sucursal.</p>}
    {error && <div className="notice warn" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {enabled && <>
      <div className="qr-attention-staff-count"><b>{requests.length}</b> solicitudes pendientes o en atención</div>
      {!requests.length && <p className="qr-attention-staff-empty">No hay solicitudes pendientes.</p>}
      <div className="qr-attention-staff-grid">{requests.map(r=>(
        <article className="qr-attention-staff-item" key={r.id}>
          <div className="qr-attention-staff-item-title"><span className="qr-attention-staff-emoji">{labels[r.action]?.icon || '🔔'}</span><div><b>{r.zoneName ? r.zoneName+' · ' : ''}{r.tableName}</b><small>{new Date(r.createdAt).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'})}</small></div></div>
          <strong>{labels[r.action]?.title || 'Solicitud de atención'}</strong>
          <p>{labels[r.action]?.detail || ''}</p>
          <div className="qr-attention-staff-item-controls">
            {r.status==='pending'&&<button disabled={busy} type="button" onClick={()=>processRequest(r.id,'acknowledged')}>Marcar vista</button>}
            <button disabled={busy} type="button" onClick={()=>processRequest(r.id,'completed')}>✓ Atendida</button>
          </div>
        </article>
      ))}</div>
    </>}
    {display && <div className="qr-attention-display" ref={screen} role="dialog" aria-modal="true" aria-label="Código de atención de la sucursal">
      <div className="qr-attention-display-content">
        <div className="qr-attention-display-brand">RestOS<span>+</span></div>
        <div className="qr-attention-display-label">CÓDIGO PARA SOLICITAR ATENCIÓN</div>
        <div className="qr-attention-display-code">{display.enabled ? display.code : '— — —'}</div>
        <p>{display.enabled ? 'Escanea el QR de tu mesa e introduce estos seis números.' : 'El servicio QR está desactivado.'}</p>
        {display.enabled && <div className="qr-attention-display-timer">Nuevo código en <b>{String(Math.floor(remaining/60)).padStart(2,'0')}:{String(remaining%60).padStart(2,'0')}</b></div>}
        <button type="button" onClick={closeDisplay} className="qr-attention-display-close">Cerrar pantalla</button>
      </div>
    </div>}
  </section>
}
