import React,{useEffect,useState} from 'react'
import {supabase} from '../lib/supabase.js'
import './QrGuestOperations.css'
export default function QrGuestOperations({locationId,tables}){
 const [selected,setSelected]=useState('')
 const [session,setSession]=useState(null)
 const [requests,setRequests]=useState([])
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 const [printPin,setPrintPin]=useState(false)
 useEffect(()=>{setSelected('');setSession(null);setRequests([])},[locationId])
 async function loadRequests(){
  if(!locationId)return
  const {data,error:err}=await supabase.rpc('manage_qr_guest_requests',{p_location_id:locationId})
  if(err)setError(err.message);else setRequests(data?.requests||[])
 }
 useEffect(()=>{loadRequests();const timer=setInterval(loadRequests,15000);return ()=>clearInterval(timer)},[locationId])
 async function action(name){
  if(!selected)return
  setBusy(true);setError('')
  const {data,error:err}=await supabase.rpc('manage_qr_guest_session',{p_table_id:selected,p_action:name})
  if(err)setError(err.message);else setSession(data)
  setBusy(false)
 }
 async function choose(id){
  setSelected(id);setSession(null);setError('')
  if(!id)return
  const {data,error:err}=await supabase.rpc('manage_qr_guest_session',{p_table_id:id,p_action:'read'})
  if(err)setError(err.message);else setSession(data)
 }
 function printAccessCode(){setPrintPin(true);setTimeout(()=>{window.print();setPrintPin(false)},150)}
 async function review(req,status){
  setBusy(true);setError('')
  const {error:err}=await supabase.rpc('manage_qr_guest_requests',{p_location_id:locationId,p_request_id:req.id,p_action:status})
  if(err)setError(err.message)
  await loadRequests();setBusy(false)
 }
 return <div className="card section-gap">
  <h3>Pedidos solicitados mediante QR</h3>
  <p className="muted">El personal prepara un PIN numérico de 4 dígitos para cada mesa libre y lo deja sobre la mesa. El cliente escanea su QR, introduce el PIN y abre la cuenta automáticamente. Las solicitudes llegan aquí para que las confirmes y se envíen a preparación.</p>
  <div className="settings-form">
   <label><span>Mesa</span><select value={selected} onChange={e=>choose(e.target.value)}><option value="">Selecciona la mesa</option>{tables.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
  </div>
  {selected&&<div className="notice">
   <b>{session?.active?(session.claimed?'Mesa abierta por el cliente':'PIN listo para entregar'):'Sesión QR inactiva'}</b>
   {session?.active&&<div style={{marginTop:8}}>PIN para entregar al cliente: <strong style={{fontSize:20,letterSpacing:2}}>{session.code}</strong><br/><small>Expira: {new Date(session.expiresAt).toLocaleString()}</small></div>}
   <div className="line-actions" style={{marginTop:10}}>
    <button type="button" className="btn primary" disabled={busy||session?.active} onClick={()=>action('open')}>Generar PIN para esta mesa</button>
    {session?.active && <button type="button" className="btn" onClick={printAccessCode}>Imprimir PIN</button>}
    <button type="button" className="btn" disabled={busy||!session?.active} onClick={()=>action('close')}>Cerrar sesión QR</button>
   </div>
  </div>}
  {printPin&&session?.active&&<div className="qr-pin-printable"><h2>{tables.find(t=>t.id===selected)?.name || 'Mesa'}</h2><p>PIN para abrir tu mesa</p><strong>{session.code}</strong><p>Escanea el QR impreso de tu mesa e introduce este PIN de 4 números.</p><small>Válido solo para el servicio actual · RestOS+</small></div>}
  {error&&<div role="alert" className="notice warn">{error}</div>}
  <div className="section-title section-gap"><h4>Solicitudes por revisar ({requests.length})</h4><button className="mini" onClick={loadRequests}>Actualizar</button></div>
  <div className="list">{requests.map(req=><div className="row" key={req.id} style={{alignItems:'start',gap:12}}>
   <div><b>{req.tableName}</b><small>{new Date(req.createdAt).toLocaleTimeString()}</small>{req.items.map((p,i)=><div key={i} style={{fontSize:13,marginTop:5}}>{p.quantity} × {p.name}</div>)}<strong>Total solicitado: {req.total}</strong></div>
   <div className="line-actions"><button className="mini" disabled={busy} onClick={()=>review(req,'reviewed')}>Confirmar y enviar a preparación</button><button className="mini danger" disabled={busy} onClick={()=>review(req,'rejected')}>Rechazar</button></div>
  </div>)}{!requests.length&&<p className="muted">Sin solicitudes pendientes.</p>}</div>
  <div className="notice">Al confirmar, RestOS+ registra los productos en la cuenta de la mesa, envía la comanda a su estación de preparación y aplica el control de inventario. Comprueba los alérgenos con el cliente antes de confirmar.</div>
 </div>
}
