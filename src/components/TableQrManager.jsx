import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import './TableQrManager.css'

const qrImage = (url, size = 230) =>
  'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size +
  '&margin=16&format=png&data=' + encodeURIComponent(url)

export default function TableQrManager({ locationId, tables, canManage }) {
  const [codes, setCodes] = useState([])
  const [loading, setLoading] = useState(false)
  const [rotating, setRotating] = useState('')
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(null)
  useEffect(() => {
    let active = true
    if (!locationId || !canManage || !supabase) { setCodes([]); return }
    setLoading(true)
    supabase.rpc('manage_table_qr_codes', { p_location_id: locationId })
      .then(({data,error:err}) => {
        if (!active) return
        if (err) setError(err.message)
        else { setCodes(data?.tables || []); setError('') }
      })
      .finally(() => { if(active) setLoading(false) })
    return () => { active = false }
  }, [locationId, canManage, tables.map(t => t.id).join(',')])

  const urlFor = record => new URL('/menu/' + record.locationId + '?t=' + record.token, window.location.origin).toString()
  async function regenerate(record) {
    if (!window.confirm('¿Regenerar el QR de ' + record.tableName + '? El código impreso anteriormente dejará de identificar esta mesa y deberás imprimir uno nuevo.')) return
    setRotating(record.tableId)
    setError('')
    const { data, error: err } = await supabase.rpc('manage_table_qr_codes', {
      p_location_id: locationId, p_table_id: record.tableId, p_regenerate: true,
    })
    if (err) setError(err.message)
    else {
      setCodes(data?.tables || [])
      setPreview(null)
    }
    setRotating('')
  }
  function printOne(record) {
    setPreview(record)
    // Print only after the printable card has rendered.
    setTimeout(() => window.print(), 100)
  }
  const active = new Set(tables.map(t => t.id))
  const visible = codes.filter(row => active.has(row.tableId))
  return <div className="card section-gap table-qr-manager">
    <div className="section-title"><div>
      <h3>QR por mesa</h3>
      <p className="muted">Un código único para cada mesa. Permite consultar la carta sin iniciar sesión.</p>
    </div><span className="badge">{visible.length} códigos</span></div>
    <div className="notice">
      <b>Seguridad:</b> el QR identifica la mesa, pero no abre una cuenta ni autoriza pedidos por sí solo.
      El acceso para pedir tendrá una sesión temporal que se invalidará al cerrar y cobrar la cuenta.
    </div>
    {!canManage && <p className="muted">Necesitas permisos para administrar mesas y sus códigos QR.</p>}
    {error && <p role="alert" className="notice warn">{error}</p>}
    {loading && <p className="muted">Preparando códigos QR…</p>}
    <div className="table-qr-list">
      {visible.map(record => <div className="table-qr-row" key={record.tableId}>
        <div className="table-qr-ident"><b>{record.tableName}</b><small>{record.zoneName}</small></div>
        <div className="table-qr-actions">
          <button type="button" className="mini" onClick={() => setPreview(record)}>Ver QR</button>
          <button type="button" className="mini" onClick={() => printOne(record)}>Imprimir</button>
          <button type="button" className="mini" onClick={() => navigator.clipboard.writeText(urlFor(record)).catch(() => window.prompt('Copia este enlace',urlFor(record)))}>Copiar enlace</button>
          <button type="button" className="mini danger" disabled={rotating===record.tableId} onClick={() => regenerate(record)}>{rotating===record.tableId?'Generando…':'Regenerar'}</button>
        </div>
      </div>)}
    </div>
    {preview && <div className="modal open table-qr-modal" role="dialog" aria-modal="true" aria-label={'Código QR ' + preview.tableName}>
      <div className="modal-card">
        <div className="section-title table-qr-modal-head"><h3>Código QR de mesa</h3><button className="btn" type="button" onClick={() => setPreview(null)}>×</button></div>
        <div className="table-qr-printable">
          <strong className="table-qr-brand">MENÚ DIGITAL</strong>
          <h2>{preview.tableName}</h2>
          <p>{preview.zoneName}</p>
          <img width="230" height="230" src={qrImage(urlFor(preview))} alt={'Código QR para ' + preview.tableName}/>
          <p>Escanea para ver nuestra carta</p>
          <small>Powered by RestOS+</small>
        </div>
        <div className="table-qr-modal-actions">
          <button className="btn primary" type="button" onClick={() => window.print()}>Imprimir QR</button>
          <button className="btn" type="button" onClick={() => setPreview(null)}>Cerrar</button>
        </div>
      </div>
    </div>}
  </div>
}
