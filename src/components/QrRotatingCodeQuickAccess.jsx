import React, { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import './QrRotatingCodeQuickAccess.css'

const remainingSeconds = date => Math.max(0, Math.ceil((new Date(date).getTime() - Date.now()) / 1000))

export default function QrRotatingCodeQuickAccess({ locationId, locationName, onClose }) {
  const [codeInfo, setCodeInfo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [remaining, setRemaining] = useState(0)

  const refresh = useCallback(async () => {
    if (!locationId || !supabase) return
    setLoading(true)
    const { data, error: requestError } = await supabase.rpc('get_qr_attention_display', {
      p_location_id: locationId,
    })
    if (requestError) {
      setError(requestError.message || 'No se pudo obtener el código QR.')
    } else {
      setCodeInfo(data)
      setError('')
      setRemaining(data?.enabled ? remainingSeconds(data.expiresAt) : 0)
    }
    setLoading(false)
  }, [locationId])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const onEscape = event => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [onClose])
  useEffect(() => {
    if (!codeInfo?.enabled) return undefined
    const timer = setInterval(() => {
      const next = remainingSeconds(codeInfo.expiresAt)
      setRemaining(next)
      if (next === 0 && !loading) void refresh()
    }, 1000)
    return () => clearInterval(timer)
  }, [codeInfo?.expiresAt, codeInfo?.enabled, loading, refresh])

  const time = String(Math.floor(remaining / 60)).padStart(2, '0') + ':' + String(remaining % 60).padStart(2, '0')
  return <div className="qr-code-quick-overlay" role="presentation" onClick={onClose}>
    <section className="qr-code-quick-panel" role="dialog" aria-modal="true" aria-labelledby="qr-code-quick-title" onClick={event => event.stopPropagation()}>
      <div className="qr-code-quick-top">
        <span>RestOS<span>+</span></span>
        <button type="button" aria-label="Cerrar código" onClick={onClose}>×</button>
      </div>
      <div className="qr-code-quick-inner">
        <p className="qr-code-quick-eyebrow">{locationName || 'Sucursal'}</p>
        <h2 id="qr-code-quick-title">Código de atención QR</h2>
        {loading && !codeInfo ? <p>Generando código de la sucursal…</p> : null}
        {error && <p className="qr-code-quick-error" role="alert">{error}</p>}
        {!loading && codeInfo?.enabled === false && <p className="qr-code-quick-error">La atención QR está desactivada. Actívala en Configuración de sucursal → Menú QR público.</p>}
        {codeInfo?.enabled && <>
          <div className="qr-code-quick-number" aria-label={'Código ' + codeInfo.code}>{codeInfo.code}</div>
          <p>El cliente escanea el QR de su mesa y escribe estos seis números.</p>
          <div className="qr-code-quick-countdown"><span>Próximo código en</span><strong>{time}</strong></div>
          <small>El código es común a las mesas de esta sucursal y se renueva cada 20 minutos.</small>
        </>}
        <div className="qr-code-quick-actions">
          {codeInfo?.enabled && <button className="btn" type="button" onClick={() => navigator.clipboard?.writeText?.(codeInfo.code)}>Copiar código</button>}
          <button className="btn primary" type="button" onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </section>
  </div>
}
