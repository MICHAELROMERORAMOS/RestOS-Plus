import React, { useEffect, useState } from 'react'
import { createInvoicePdf } from '../../lib/invoicePdf.js'

export default function InvoicePreviewModal({ invoices, currencyCode, onClose }) {
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    let objectUrl = ''
    createInvoicePdf(invoices, currencyCode)
      .then((pdf) => {
        if (!active) return
        objectUrl = URL.createObjectURL(pdf.blob)
        setPreview({ ...pdf, url: objectUrl })
      })
      .catch((reason) => active && setError(reason?.message || 'No se pudo generar el PDF.'))
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [invoices, currencyCode])

  function download() {
    const link = document.createElement('a')
    if (!preview) return
    link.href = preview.url
    link.download = preview.filename
    link.click()
  }

  function print() {
    document.getElementById('invoice-pdf-preview')?.contentWindow?.print()
  }

  return (
    <div className="modal open invoice-preview-modal" onClick={onClose}>
      <div className="modal-card invoice-preview-card" onClick={(event) => event.stopPropagation()}>
        <div className="section-title">
          <div>
            <h3>Vista previa de factura</h3>
            <p className="muted">{invoices.map((invoice) => invoice.invoiceNumber).join(' · ')}</p>
          </div>
          <div className="invoice-preview-actions">
            <button className="btn" onClick={print}>Imprimir</button>
            <button className="btn primary" onClick={download}>Descargar PDF</button>
            <button className="btn" onClick={onClose}>×</button>
          </div>
        </div>
        {error && <div className="notice warn">{error}</div>}
        {!preview && !error && <div className="empty-block">Generando vista previa…</div>}
        {preview && <iframe id="invoice-pdf-preview" className="invoice-preview-frame" src={preview.url} title="Vista previa de factura PDF" />}
      </div>
    </div>
  )
}
