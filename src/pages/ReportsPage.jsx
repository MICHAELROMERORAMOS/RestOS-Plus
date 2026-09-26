import React, { useMemo, useState } from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import { loadSalesReport } from '../services/reportService.js'

function toDateInput(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function todayRange() {
  const today = toDateInput(new Date())
  return { startDate: today, endDate: today }
}

function weekRange() {
  const now = new Date()
  const day = now.getDay()
  const mondayOffset = day === 0 ? -6 : 1 - day
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset)
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  return { startDate: toDateInput(monday), endDate: toDateInput(sunday) }
}

function formatDate(value) {
  if (!value) return ''
  return new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00Z`))
}

function methodLabel(method) {
  const labels = { cash: 'Efectivo', card: 'Tarjeta', transfer: 'Transferencia' }
  return labels[method] || String(method || 'Otro')
}

export default function ReportsPage() {
  const { activeLocation, formatMoney } = useRestaurant()
  const [selection, setSelection] = useState(null)
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const paymentTotal = useMemo(
    () => (report?.paymentMethods || []).reduce((sum, item) => sum + Number(item.amount || 0), 0),
    [report],
  )

  const maxDailySales = useMemo(
    () => Math.max(0, ...(report?.daily || []).map((item) => Number(item.sales || 0))),
    [report],
  )

  async function runReport(type, range) {
    setSelection(type)
    setReport(null)
    setError('')
    setLoading(true)
    try {
      const data = await loadSalesReport(activeLocation?.id, range.startDate, range.endDate)
      setReport(data)
    } catch (err) {
      setError(err?.message || 'No se pudo generar el reporte.')
    } finally {
      setLoading(false)
    }
  }

  function selectToday() {
    runReport('today', todayRange())
  }

  function selectWeek() {
    runReport('week', weekRange())
  }

  function selectCustom() {
    setSelection('custom')
    setReport(null)
    setError('')
  }

  function generateCustom() {
    if (!customStart || !customEnd) {
      setError('Selecciona la fecha inicial y la fecha final.')
      return
    }
    if (customStart > customEnd) {
      setError('La fecha inicial no puede ser posterior a la fecha final.')
      return
    }
    runReport('custom', { startDate: customStart, endDate: customEnd })
  }

  return (
    <section className="view active">
      <div className="hero">
        <div>
          <h2>Reportes</h2>
          <p>Selecciona un período. Los datos se consultan únicamente cuando generas un reporte.</p>
        </div>
      </div>

      <div className="report-periods">
        <button className={`report-period ${selection === 'today' ? 'active' : ''}`} onClick={selectToday}>
          <span>📅</span><b>Reporte del día</b><small>Ventas de hoy</small>
        </button>
        <button className={`report-period ${selection === 'week' ? 'active' : ''}`} onClick={selectWeek}>
          <span>📆</span><b>Reporte semanal</b><small>Lunes a domingo</small>
        </button>
        <button className={`report-period ${selection === 'custom' ? 'active' : ''}`} onClick={selectCustom}>
          <span>🗓️</span><b>Rango de fechas</b><small>Período personalizado</small>
        </button>
      </div>

      {selection === 'custom' && (
        <div className="card report-range">
          <label><span>Fecha inicial</span><input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} /></label>
          <label><span>Fecha final</span><input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} /></label>
          <button className="btn primary" onClick={generateCustom} disabled={loading}>Generar reporte</button>
        </div>
      )}

      {error && <div className="notice warn section-gap">{error}</div>}
      {loading && <div className="card empty-block section-gap">Generando reporte…</div>}

      {!selection && !loading && (
        <div className="card placeholder compact-placeholder section-gap">
          <div><div className="icon">📊</div><h3>Selecciona un período</h3><p>Ventas, ticket promedio, productos, métodos de pago y rendimiento aparecerán aquí.</p></div>
        </div>
      )}

      {report && !loading && (
        <div className="report-results">
          <div className="report-heading">
            <div><b>Período analizado</b><span>{formatDate(report.startDate)} — {formatDate(report.endDate)}</span></div>
            <small>{Number(report.tickets || 0)} facturas pagadas</small>
          </div>

          <div className="grid report-kpis">
            <div className="card stat"><span className="label">Ventas</span><strong>{formatMoney(Number(report.sales || 0))}</strong><small>Facturas pagadas no anuladas</small></div>
            <div className="card stat"><span className="label">Ticket promedio</span><strong>{formatMoney(Number(report.averageTicket || 0))}</strong><small>Promedio por factura pagada</small></div>
            <div className="card stat"><span className="label">Facturas</span><strong>{Number(report.tickets || 0)}</strong><small>Incluidas en el período</small></div>
            <div className="card stat"><span className="label">Devolución/cambio</span><strong>{formatMoney(Number(report.refunds || 0))}</strong><small>Refund due registrado</small></div>
          </div>

          <div className="grid report-columns">
            <div className="card">
              <div className="section-title"><h3>Top de productos</h3><span className="badge">Top 10</span></div>
              <div className="report-list">
                {(report.topProducts || []).map((item, index) => (
                  <div className="report-product" key={`${item.product_id || item.name}-${index}`}>
                    <span className="report-rank">{index + 1}</span>
                    <div><b>{item.name}</b><small>{Number(item.quantity || 0)} unidades</small></div>
                    <strong>{formatMoney(Number(item.sales || 0))}</strong>
                  </div>
                ))}
                {!report.topProducts?.length && <div className="empty-inline">No hay productos vendidos en este período.</div>}
              </div>
            </div>

            <div className="card">
              <div className="section-title"><h3>Métodos de pago</h3></div>
              <div className="report-list">
                {(report.paymentMethods || []).map((item) => {
                  const amount = Number(item.amount || 0)
                  const percentage = paymentTotal > 0 ? (amount / paymentTotal) * 100 : 0
                  return (
                    <div className="payment-method-row" key={item.method}>
                      <div><b>{methodLabel(item.method)}</b><small>{percentage.toFixed(1)}% del total cobrado</small></div>
                      <strong>{formatMoney(amount)}</strong>
                    </div>
                  )
                })}
                {!report.paymentMethods?.length && <div className="empty-inline">No hay pagos registrados en este período.</div>}
              </div>
            </div>
          </div>

          <div className="card report-performance">
            <div className="section-title"><div><h3>Rendimiento</h3><small className="muted">Comportamiento de ventas dentro del período</small></div></div>
            <div className="performance-bars">
              {(report.daily || []).map((item) => {
                const sales = Number(item.sales || 0)
                const width = maxDailySales > 0 ? Math.max(4, (sales / maxDailySales) * 100) : 0
                return (
                  <div className="performance-row" key={item.day}>
                    <span>{formatDate(item.day)}</span>
                    <div className="performance-track"><i style={{ width: `${width}%` }} /></div>
                    <strong>{formatMoney(sales)}</strong>
                    <small>{Number(item.tickets || 0)} tickets</small>
                  </div>
                )
              })}
              {!report.daily?.length && <div className="empty-inline">No hay ventas para mostrar rendimiento.</div>}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
