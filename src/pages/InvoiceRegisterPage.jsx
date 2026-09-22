import React, { useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import { listPaidInvoices } from '../services/invoiceRegisterService.js'

function serviceMode(row) {
  if (row.serviceMode) return row.serviceMode
  if (row.delivery) return 'delivery'
  if ((row.tables || []).length || (row.tableIds || []).length) return 'table'
  return 'quick'
}

function serviceLabel(row) {
  const mode = serviceMode(row)
  if (mode === 'table') return 'Mesa'
  if (mode === 'delivery') return 'Domicilio'
  return 'Servicio rápido'
}

function tableText(row) {
  const names = (row.tables || []).map((table) => table.name || table.code).filter(Boolean)
  if (names.length) return names.join(' + ')
  if ((row.tableIds || []).length) return row.tableIds.join(' + ')
  return ''
}

function customerName(row) {
  return row.billingCustomer?.name || row.customer?.name || row.delivery?.customerName || ''
}

function originDescription(row) {
  if (serviceMode(row) === 'table') return tableText(row) || 'Mesa sin identificar'
  if (serviceMode(row) === 'delivery') return customerName(row) || 'Cliente sin nombre'
  return `Orden #${row.orderNumber}`
}

function OriginSummary({ invoice, compact = false }) {
  const name = customerName(invoice)
  const table = tableText(invoice)
  const delivery = invoice.delivery || {}

  return (
    <div className={`invoice-origin-summary ${compact ? 'compact' : ''}`}>
      <div className="invoice-origin-main">
        <span className="badge origin-badge">{serviceLabel(invoice)}</span>
        <strong>{originDescription(invoice)}</strong>
      </div>
      {!compact && (
        <div className="invoice-origin-details">
          {table && <span>🪑 Mesa: {table}</span>}
          {name && <span>👤 Cliente: {name}</span>}
          {serviceMode(invoice) === 'delivery' && delivery.address && <span>📍 {delivery.address}{delivery.neighborhood ? ` · ${delivery.neighborhood}` : ''}{delivery.city ? ` · ${delivery.city}` : ''}</span>}
          {serviceMode(invoice) === 'delivery' && delivery.phone && <span>📱 {delivery.phone}</span>}
        </div>
      )}
      {compact && name && <div className="invoice-origin-details"><span>👤 {name}</span></div>}
    </div>
  )
}

function BillingCustomerSummary({ invoice }) {
  const customer = invoice.billingCustomer

  if (!customer) {
    return (
      <div className="invoice-billing-customer consumer-final">
        <div><b>Factura a consumidor final</b><small>No se solicitaron datos personales para esta factura.</small></div>
      </div>
    )
  }

  return (
    <div className="invoice-billing-customer">
      <div className="invoice-billing-heading">
        <span>FACTURADA A</span>
        <b>{customer.name}</b>
      </div>
      <div className="invoice-billing-details">
        <span><b>{customer.documentType}</b> {customer.documentNumber}</span>
        {customer.phone && <span>📱 {customer.phone}</span>}
        {customer.email && <span>✉ {customer.email}</span>}
        {customer.address && <span>📍 {customer.address}{customer.city ? ` · ${customer.city}` : ''}</span>}
      </div>
    </div>
  )
}

export default function InvoiceRegisterPage() {
  const { formatMoney } = useRestaurant()
  const auth = useAuth()
  const restaurantId = auth.userContext?.membership?.restaurant_id
  const [filters, setFilters] = useState({ from: '', to: '', status: 'all' })
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(null)
  const [hasSearched, setHasSearched] = useState(false)

  async function load(event) {
    event?.preventDefault()

    if (!filters.from || !filters.to) {
      return window.alert('Selecciona la fecha inicial y la fecha final.')
    }

    if (filters.from > filters.to) {
      return window.alert('La fecha inicial no puede ser posterior a la fecha final.')
    }

    setLoading(true)
    setSelected(null)
    try {
      setRows(await listPaidInvoices(restaurantId, filters))
      setHasSearched(true)
    } catch (error) {
      window.alert(error.message)
    } finally {
      setLoading(false)
    }
  }

  function clearSearch() {
    setFilters({ from: '', to: '', status: 'all' })
    setRows([])
    setSelected(null)
    setHasSearched(false)
  }

  return (
    <section className="view active invoice-register-view">
      <div className="hero">
        <div>
          <h2>Facturas cobradas</h2>
          <p>Consulta las facturas válidas y anuladas, identificando mesa, domicilio o servicio rápido antes de abrir el detalle.</p>
        </div>
      </div>

      <div className="card invoice-filter-card">
        <div className="invoice-filter-heading">
          <div>
            <h3>Consultar por fecha</h3>
            <p>La lista permanecerá vacía hasta que selecciones un rango y pulses “Consultar facturas”.</p>
          </div>
        </div>

        <form className="invoice-filter-form" onSubmit={load}>
          <label className="invoice-filter-field">
            <span>Fecha inicial</span>
            <input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
          </label>

          <label className="invoice-filter-field">
            <span>Fecha final</span>
            <input type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
          </label>

          <label className="invoice-filter-field">
            <span>Estado de la factura</span>
            <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
              <option value="all">Todas las facturas</option>
              <option value="valid">Solo válidas</option>
              <option value="voided">Solo anuladas</option>
            </select>
          </label>

          <div className="invoice-filter-actions">
            {hasSearched && <button type="button" className="btn" onClick={clearSearch}>Limpiar</button>}
            <button className="btn primary" type="submit" disabled={loading || !restaurantId || !filters.from || !filters.to}>
              {loading ? 'Consultando…' : 'Consultar facturas'}
            </button>
          </div>
        </form>
      </div>

      <div className="card section-gap">
        <div className="section-title"><div><h3>Registro de facturas</h3><p className="muted">El origen del pedido aparece en la columna “Servicio”.</p></div>{hasSearched && <span className="badge">{rows.length} resultados</span>}</div>
        {loading ? <div className="empty-inline">Consultando facturas…</div> : !hasSearched ? (
          <div className="invoice-search-empty">
            <span>Consulta bajo demanda</span>
            <h4>Selecciona las fechas para cargar las facturas</h4>
            <p>Al entrar en esta ventana no se realiza ninguna consulta de facturas a Supabase.</p>
          </div>
        ) : rows.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Factura</th><th>Servicio / origen</th><th>Fecha</th><th>Productos</th><th>Subtotal</th><th>IVA</th><th>Total</th><th>Estado</th><th /></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td><b>{row.invoiceNumber}</b><small>Orden #{row.orderNumber}</small></td>
                    <td><OriginSummary invoice={row} compact /></td>
                    <td>{new Date(row.issuedAt).toLocaleString('es-CO')}</td>
                    <td>{(row.items || []).reduce((total, item) => total + Number(item.quantity || 0), 0)}</td>
                    <td>{formatMoney(row.subtotal)}</td>
                    <td>{formatMoney(row.taxTotal)}</td>
                    <td><b>{formatMoney(row.total)}</b><small>Pagado {formatMoney(row.paidTotal || row.total)}</small></td>
                    <td><span className={`badge ${row.voided ? 'danger-badge' : 'ok-badge'}`}>{row.voided ? 'Anulada' : 'Válida'}</span></td>
                    <td><button className="mini" onClick={() => setSelected(row)}>Ver detalle</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty-inline">No hay facturas para el rango y estado seleccionados.</div>}
      </div>

      {selected && (
        <div className="modal open invoice-detail-modal" onClick={() => setSelected(null)}>
          <div className="modal-card invoice-detail-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-title"><div><h3>{selected.invoiceNumber}</h3><p className="muted">Orden #{selected.orderNumber} · {new Date(selected.issuedAt).toLocaleString('es-CO')} · {selected.voided ? 'Anulada' : 'Válida'}</p></div><button className="btn" onClick={() => setSelected(null)}>×</button></div>
            <OriginSummary invoice={selected} />
            <BillingCustomerSummary invoice={selected} />
            <div className="list invoice-detail-lines">{(selected.items || []).map((item, index) => <div className="row" key={index}><span>{item.quantity} × {item.name}<small>IVA {item.taxRate || 0}% · {formatMoney(item.unitPrice)} c/u</small></span><b>{formatMoney(item.amount)}</b></div>)}</div>
            <div className="totals"><div>Subtotal <b>{formatMoney(selected.subtotal)}</b></div><div>IVA <b>{formatMoney(selected.taxTotal)}</b></div><div>Total <b>{formatMoney(selected.total)}</b></div><div>Valor pagado <b>{formatMoney(selected.paidTotal || selected.total)}</b></div></div>
          </div>
        </div>
      )}
    </section>
  )
}
