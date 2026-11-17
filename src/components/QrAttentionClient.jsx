import React, { useCallback, useEffect, useState } from 'react'
import { guestSupabase as supabase } from '../lib/guestSupabase.js'
import './QrAttentionClient.css'

const ACTIONS = [
  { id: 'call_waiter', icon: '🙋', title: 'Llamar al mesero', text: 'Necesito atención en mi mesa' },
  { id: 'request_drink', icon: '🥤', title: 'Solicitar una bebida', text: 'Quiero pedir otra bebida' },
  { id: 'request_bill', icon: '🧾', title: 'Pedir la cuenta', text: 'Estoy listo para pagar' },
  { id: 'order_status', icon: '📋', title: 'Estado del pedido', text: 'Consultar mis pedidos' },
]

export default function QrAttentionClient({ locationId, qrToken, table, orderSnapshot, onShowMenu }) {
  const [settings, setSettings] = useState(null)
  const [code, setCode] = useState('')
  const [token, setToken] = useState('')
  const [requests, setRequests] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [showStatus, setShowStatus] = useState(false)
  const key = `restosplus:qr-attention:${locationId}:${qrToken}`

  const refresh = useCallback(async (sessionToken) => {
    if (!sessionToken) return
    const { data, error: requestError } = await supabase.rpc('qr_attention_customer_action', {
      p_location_id: locationId, p_qr_token: qrToken, p_session_token: sessionToken,
    })
    if (requestError || !data?.ok) {
      setToken('')
      try { sessionStorage.removeItem(key) } catch {}
      return
    }
    setSettings(previous => ({ ...previous, ...data.actions, enabled: true }))
    setRequests(data.requests || [])
  }, [locationId, qrToken, key])

  useEffect(() => {
    let active = true
    supabase.rpc('get_qr_attention_public_settings', {
      p_location_id: locationId, p_qr_token: qrToken,
    }).then(({data}) => {
      if (active) setSettings(data || { enabled: false })
    })
    return () => { active = false }
  }, [locationId, qrToken])

  useEffect(() => {
    let saved
    try {
      saved = JSON.parse(sessionStorage.getItem(key) || 'null')
    } catch { saved = null }
    if (saved?.token && saved?.expiresAt > Date.now()) {
      setToken(saved.token)
      void refresh(saved.token)
    } else {
      try { sessionStorage.removeItem(key) } catch {}
    }
  }, [key, refresh])

  async function verifyCode(event) {
    event.preventDefault()
    if (!/^[0-9]{6}$/.test(code) || busy) return
    setBusy(true);setError('');setMessage('')
    const { data, error: requestError } = await supabase.rpc('authorize_qr_attention', {
      p_location_id: locationId, p_qr_token: qrToken, p_code: code,
    })
    if (requestError || !data?.ok) setError(data?.message || 'No pudimos verificar el código. Inténtalo de nuevo.')
    else {
      setToken(data.token)
      setSettings(previous => ({ ...previous, ...data.actions, enabled: true }))
      setCode('')
      try { sessionStorage.setItem(key, JSON.stringify({token:data.token,expiresAt:Date.now()+4*60*60*1000})) } catch {}
      setMessage('Acceso a los servicios de tu mesa activado.')
      await refresh(data.token)
    }
    setBusy(false)
  }

  async function requestAction(action) {
    if (busy || !token) return
    if (action === 'order_status') { setShowStatus(true); return }
    setBusy(true);setError('');setMessage('')
    const { data, error: requestError } = await supabase.rpc('qr_attention_customer_action', {
      p_location_id: locationId, p_qr_token: qrToken, p_session_token: token, p_action: action,
    })
    if (requestError || !data?.ok) setError(data?.message || 'No se pudo enviar la solicitud.')
    else {
      setRequests(data.requests || [])
      setMessage('Solicitud enviada. El personal de esta sucursal recibirá el aviso.')
    }
    setBusy(false)
  }

  if (!settings?.enabled || !table) return null
  return (
    <section className="qr-attention-client">
      <div className="qr-attention-topline"><span>ATENCIÓN EN TU MESA</span><b>{table.zoneName} · {table.tableName}</b></div>
      {!token ? (
        <form className="qr-attention-gate" onSubmit={verifyCode}>
          <div className="qr-attention-gate-icon" aria-hidden="true">🔐</div>
          <h2>Bienvenido a tu mesa</h2>
          <p>Introduce el código de seis números que aparece en la pantalla del restaurante.</p>
          <label htmlFor="qr-attention-access">Código de acceso</label>
          <input id="qr-attention-access" className="qr-attention-pin" type="text" inputMode="numeric" pattern="[0-9]{6}"
            maxLength={6} autoComplete="one-time-code" placeholder="000000" value={code}
            onChange={event => setCode(event.target.value.replace(/\D/g,'').slice(0,6))} />
          <button type="submit" className="qr-attention-primary" disabled={busy || code.length!==6}>{busy ? 'Verificando…' : 'Acceder a mi mesa'}</button>
          <small>El código se renueva cada 20 minutos y sirve para las mesas de esta sucursal.</small>
        </form>
      ) : (
        <>
          <div className="qr-attention-welcome"><div><h2>¿En qué podemos ayudarte?</h2><p>Selecciona una opción. Nuestro personal recibirá tu solicitud.</p></div><span aria-label="Acceso válido">✓</span></div>
          <div className="qr-attention-actions">
            {ACTIONS.filter(a => settings[a.id]).map(action => (
              <button key={action.id} type="button" className="qr-attention-action" disabled={busy} onClick={() => requestAction(action.id)}>
                <span className="qr-attention-action-icon" aria-hidden="true">{action.icon}</span>
                <b>{action.title}</b><small>{action.text}</small>
              </button>
            ))}
          </div>
          {showStatus && <div className="qr-attention-status">
            <b>Estado de tu pedido</b>
            {orderSnapshot?.requests?.length
              ? <div className="qr-attention-private-orders">
                  {orderSnapshot.requests.map(request => <div key={request.id} className="qr-attention-private-order">
                    <strong>{request.status === 'reviewed' ? 'En preparación' : request.status === 'rejected' ? 'Rechazado' : 'Pendiente de confirmación'}</strong>
                    {(request.items || []).map((item, index) => <p key={index}>{item.quantity} × {item.name}: {item.status === 'served' ? 'Entregado' : item.status === 'ready' ? 'Listo' : item.status === 'preparing' ? 'Preparando' : item.status === 'sent' ? 'Enviado' : 'En proceso'}</p>)}
                  </div>)}
                </div>
              : <p>Para consultar un pedido debes haberlo realizado desde esta misma visita. El código general no permite consultar cuentas ajenas.</p>}
            <button type="button" onClick={() => setShowStatus(false)}>Entendido</button>
          </div>}
          {requests.filter(r => r.status === 'pending' || r.status === 'acknowledged').length > 0 && (
            <div className="qr-attention-sent"><b>Solicitudes en curso</b>
              {requests.filter(r => ['pending','acknowledged'].includes(r.status)).map(r => (
                <div key={r.id}><span>{ACTIONS.find(a=>a.id===r.action)?.title || 'Atención'}</span><small>{r.status === 'acknowledged' ? 'El personal la ha visto' : 'Enviada'}</small></div>
              ))}
              <button type="button" onClick={() => refresh(token)}>Actualizar estado</button>
            </div>
          )}
        </>
      )}
      {message && <p className="qr-attention-feedback success" role="status">{message}</p>}
      {error && <p className="qr-attention-feedback error" role="alert">{error}</p>}
      <button className="qr-attention-menu-link" type="button" onClick={onShowMenu}>Ver menú y productos</button>
    </section>
  )
}
