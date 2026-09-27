import React, { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import {
  closeCurrentShift,
  loadCurrentShift,
  loadShiftHistory,
} from '../services/shiftService.js'

function formatDateTime(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('es', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function blockerRows(blockers) {
  return [
    ['Pedidos activos', blockers?.activeOrders || 0],
    ['Productos pendientes en Cocina / Bar', blockers?.pendingKitchenBarItems || 0],
    ['Pedidos sin cobrar', blockers?.unpaidOrders || 0],
    ['Mesas ocupadas', blockers?.occupiedTables || 0],
    ['Mesas en toma de pedido', blockers?.tableOrderSessions || 0],
    ['Pedidos rápidos activos', blockers?.quickOrders || 0],
    ['Domicilios activos', blockers?.deliveryOrders || 0],
    ['Reembolsos pendientes', blockers?.refundDueOrders || 0],
  ].filter(([, count]) => count > 0)
}

export default function ShiftClosePage() {
  const auth = useAuth()
  const {
    activeLocation,
    formatMoney,
    refreshOperationalSummary,
  } = useRestaurant()

  const restaurantId = auth.userContext?.membership?.restaurant_id || null
  const canClose = auth.can('shifts.close')

  const [shift, setShift] = useState(null)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [closing, setClosing] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [lastClosed, setLastClosed] = useState(null)

  const blockers = useMemo(() => blockerRows(shift?.blockers), [shift])

  async function refresh() {
    if (!restaurantId || !activeLocation?.id || auth.isDesignMode) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')
    try {
      const [current, previous] = await Promise.all([
        loadCurrentShift(restaurantId, activeLocation.id),
        loadShiftHistory(restaurantId, activeLocation.id, 10),
      ])
      setShift(current)
      setHistory(previous)
    } catch (err) {
      setError(err?.message || 'No se pudo cargar el turno actual.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [restaurantId, activeLocation?.id, auth.isDesignMode])

  async function closeShift() {
    if (!shift || closing || !canClose) return

    if (!shift.blockers?.canClose) {
      window.alert('No se puede cerrar el turno mientras existan operaciones pendientes.')
      return
    }

    const confirmed = window.confirm(
      `¿Cerrar el turno #${shift.shiftNumber}?\n\nCobros: ${formatMoney(shift.salesTotal)}\nReembolsos: ${formatMoney(shift.refundTotal)}\nNeto del turno: ${formatMoney(shift.netSalesTotal)}\nPagos: ${shift.paymentCount}\nFacturas: ${shift.invoiceCount}\n\nSe abrirá inmediatamente un nuevo turno con contadores en cero. Las ventas históricas NO se eliminan.`,
    )
    if (!confirmed) return

    setClosing(true)
    setError('')
    try {
      const result = await closeCurrentShift(
        restaurantId,
        activeLocation.id,
        note.trim(),
      )

      setLastClosed(result.closedShift)
      setShift(result.currentShift)
      setNote('')
      setHistory((previous) => [
        result.closedShift,
        ...previous.filter((item) => item.id !== result.closedShift?.id),
      ].filter(Boolean).slice(0, 10))

      await refreshOperationalSummary(activeLocation)
    } catch (err) {
      const message = String(err?.message || '')
      if (message.includes('SHIFT_HAS_PENDING_OPERATIONS')) {
        setError('El cierre fue bloqueado porque aparecieron operaciones pendientes. Actualiza la pantalla y complétalas antes de cerrar.')
      } else {
        setError(message || 'No se pudo cerrar el turno.')
      }
      await refresh()
    } finally {
      setClosing(false)
    }
  }

  if (auth.isDesignMode) {
    return (
      <section className="view active">
        <div className="hero"><div><h2>Cierre de turno</h2><p>Disponible al ingresar con Supabase.</p></div></div>
        <div className="card empty-block">El cierre real de turno está deshabilitado en Modo diseño.</div>
      </section>
    )
  }

  return (
    <section className="view active shift-close-view">
      <div className="hero">
        <div>
          <h2>Cierre de turno</h2>
          <p>Cierra el período operativo actual sin borrar ventas, facturas ni historial.</p>
        </div>
        <button className="btn" onClick={refresh} disabled={loading || closing}>↻ Actualizar</button>
      </div>

      {error && <div className="notice warn">{error}</div>}

      {lastClosed && (
        <div className="notice ok shift-closed-notice">
          Turno #{lastClosed.shiftNumber} cerrado correctamente por {lastClosed.closedByName || 'usuario'}.
          El turno #{shift?.shiftNumber} comenzó con ventas en cero.
        </div>
      )}

      {loading ? (
        <div className="card empty-block">Cargando turno…</div>
      ) : !shift ? (
        <div className="card empty-block">No se encontró un turno operativo.</div>
      ) : (
        <>
          <div className="grid stats shift-kpis">
            <div className="card stat">
              <span className="label">Turno actual</span>
              <strong>#{shift.shiftNumber}</strong>
              <small>Abierto {formatDateTime(shift.openedAt)}</small>
            </div>
            <div className="card stat">
              <span className="label">Ventas netas del turno</span>
              <strong>{formatMoney(shift.netSalesTotal)}</strong>
              <small>{formatMoney(shift.salesTotal)} cobrados · {formatMoney(shift.refundTotal)} reembolsados</small>
            </div>
            <div className="card stat">
              <span className="label">Facturas</span>
              <strong>{shift.invoiceCount}</strong>
              <small>Emitidas durante este turno</small>
            </div>
            <div className="card stat">
              <span className="label">Pedidos cerrados</span>
              <strong>{shift.completedOrderCount}</strong>
              <small>Completados en este turno</small>
            </div>
          </div>

          <div className="grid two section-gap shift-columns">
            <div className="card">
              <div className="section-title">
                <div>
                  <h3>Desglose de pagos</h3>
                  <p className="muted">Solo pagos registrados dentro del turno actual.</p>
                </div>
              </div>
              <div className="list">
                <div className="row"><span>Efectivo cobrado</span><b>{formatMoney(shift.cashTotal)}</b></div>
                <div className="row"><span>Efectivo devuelto</span><b>- {formatMoney(shift.cashRefundTotal)}</b></div>
                <div className="row"><span>Tarjeta cobrada</span><b>{formatMoney(shift.cardTotal)}</b></div>
                <div className="row"><span>Tarjeta devuelta</span><b>- {formatMoney(shift.cardRefundTotal)}</b></div>
                <div className="row"><span>Transferencias / Nequi cobrados</span><b>{formatMoney(shift.transferTotal)}</b></div>
                <div className="row"><span>Transferencias / Nequi devueltos</span><b>- {formatMoney(shift.transferRefundTotal)}</b></div>
                <div className="row"><span>Otros cobros</span><b>{formatMoney(shift.otherTotal)}</b></div>
                <div className="row"><span>Otros reembolsos</span><b>- {formatMoney(shift.otherRefundTotal)}</b></div>
                <div className="row shift-total-row"><b>Neto del turno</b><strong>{formatMoney(shift.netSalesTotal)}</strong></div>
              </div>
            </div>

            <div className="card">
              <div className="section-title">
                <div>
                  <h3>Validación antes del cierre</h3>
                  <p className="muted">El turno solo puede cerrarse con la operación completamente limpia.</p>
                </div>
                <span className={`badge ${shift.blockers?.canClose ? 'ok-badge' : ''}`}>
                  {shift.blockers?.canClose ? 'LISTO PARA CERRAR' : 'BLOQUEADO'}
                </span>
              </div>

              {shift.blockers?.canClose ? (
                <div className="shift-ready">
                  ✓ No hay mesas ocupadas, cuentas pendientes, pedidos activos ni comandas sin entregar.
                </div>
              ) : (
                <div className="shift-blockers">
                  {blockers.map(([label, count]) => (
                    <div className="shift-blocker-row" key={label}>
                      <span>{label}</span>
                      <b>{count}</b>
                    </div>
                  ))}
                </div>
              )}

              <label className="shift-note">
                <span>Nota de cierre (opcional)</span>
                <textarea
                  rows="3"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Ej. Cierre normal, caja verificada."
                  disabled={closing}
                />
              </label>

              {!canClose && (
                <div className="notice warn">Tu rol puede consultar el turno, pero no cerrarlo.</div>
              )}

              <button
                className="btn primary full shift-close-button"
                disabled={closing || !canClose || !shift.blockers?.canClose}
                onClick={closeShift}
              >
                {closing ? 'Cerrando turno…' : `Cerrar turno #${shift.shiftNumber} y abrir siguiente`}
              </button>
            </div>
          </div>

          <div className="card section-gap">
            <div className="section-title">
              <div>
                <h3>Últimos cierres</h3>
                <p className="muted">Los cierres quedan guardados; nunca se eliminan las ventas históricas.</p>
              </div>
            </div>

            {history.length ? (
              <div className="shift-history">
                {history.map((item) => (
                  <div className="shift-history-row" key={item.id}>
                    <div>
                      <b>Turno #{item.shiftNumber}</b>
                      <small>{formatDateTime(item.openedAt)} → {formatDateTime(item.closedAt)}</small>
                    </div>
                    <div>
                      <small>Cerrado por</small>
                      <b>{item.closedByName || '—'}</b>
                    </div>
                    <div>
                      <small>Pagos</small>
                      <b>{item.paymentCount}</b>
                    </div>
                    <div>
                      <small>Ventas</small>
                      <strong>{formatMoney(item.netSalesTotal)}</strong>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-inline">Todavía no hay turnos cerrados.</div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
