import React, { useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { orderHasInvoice, orderPaidTotal, useRestaurant } from '../context/RestaurantContext.jsx'
import { logUnpaidKitchenVoid } from '../services/voidAuthorizationService.js'

export default function StationPage({ station }) {
  const auth = useAuth()
  const { stationJobs, advanceStationRound, tableLabel, voidSentItem, formatMoney } = useRestaurant()
  const [showSummary, setShowSummary] = useState(false)
  const [voidTarget, setVoidTarget] = useState(null)
  const [voidReason, setVoidReason] = useState('')
  const [voidBusy, setVoidBusy] = useState(false)

  const jobs = stationJobs(station)
  const isBar = station === 'bar'
  const label = isBar ? 'Bar Display' : 'Kitchen Display'
  const stationName = isBar ? 'Bar' : 'Cocina'
  const icon = isBar ? '🍸' : '🍳'
  const canVoidUnpaid = station === 'kitchen' && auth.can('orders.void.unpaid')
  const restaurantId = auth.userContext?.membership?.restaurant_id || null

  const preparationSummary = useMemo(() => {
    const totals = new Map()

    jobs.forEach(({ items }) => {
      items.forEach((item) => {
        const key = item.productId || item.name
        const current = totals.get(key) || {
          key,
          name: item.name,
          total: 0,
          newQty: 0,
          preparingQty: 0,
        }

        const quantity = Number(item.quantity || 0)
        current.total += quantity

        if (item.prepStatus === 'preparing') current.preparingQty += quantity
        else current.newQty += quantity

        totals.set(key, current)
      })
    })

    return Array.from(totals.values()).sort((a, b) => (
      a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
    ))
  }, [jobs])

  const totalPendingUnits = preparationSummary.reduce((sum, item) => sum + item.total, 0)

  function openKitchenVoid(order, round, item) {
    if (!canVoidUnpaid) return

    if (orderHasInvoice(order)) {
      return window.alert(
        'Esta orden ya tiene factura emitida. No se puede anular desde Cocina; requiere corrección fiscal / nota de crédito.',
      )
    }

    if (orderPaidTotal(order) > 0.005) {
      return window.alert(
        'Esta orden ya tiene un pago asociado. Cocina no puede anularla directamente; se requiere autorización del administrador.',
      )
    }

    setVoidTarget({ order, round, item })
    setVoidReason('')
  }

  function closeKitchenVoid() {
    if (voidBusy) return
    setVoidTarget(null)
    setVoidReason('')
  }

  async function confirmKitchenVoid() {
    if (!voidTarget || !restaurantId) return

    const reason = voidReason.trim()
    if (reason.length < 4) {
      return window.alert('Escribe un motivo claro para la anulación.')
    }

    const { order, round, item } = voidTarget

    setVoidBusy(true)
    try {
      const auditId = await logUnpaidKitchenVoid({
        restaurantId,
        orderRef: order.id,
        lineRef: item.lineId,
        itemName: item.name,
        amount: Number(item.price || 0) * Number(item.quantity || 0),
        reason,
      })

      const result = voidSentItem(order.id, round.id, item.lineId, {
        method: 'kitchen_unpaid',
        reason,
        auditId,
      })

      if (!result.ok) throw new Error(result.message)

      setVoidTarget(null)
      setVoidReason('')
    } catch (error) {
      window.alert(error?.message || 'No se pudo registrar la anulación.')
    } finally {
      setVoidBusy(false)
    }
  }

  return (
    <section className={`view active station-view ${isBar ? 'bar-station' : 'kitchen-station'}`}>
      <div className="hero station-hero">
        <div>
          <h2>{label}</h2>
          <p>Solo aparecen productos asignados a {stationName}.</p>
        </div>

        <button
          className="btn primary station-summary-button"
          onClick={() => setShowSummary(true)}
        >
          ∑ Resumen de preparación
          <span>{totalPendingUnits} unidad{totalPendingUnits === 1 ? '' : 'es'}</span>
        </button>
      </div>

      {station === 'kitchen' && (
        <div className="notice kitchen-void-rule">
          Cocina puede anular productos enviados únicamente mientras la orden no tenga pagos.
          Si existe cualquier pago, la anulación requiere código del Owner / Super Admin.
        </div>
      )}

      <div className="kds kds-large">
        {jobs.length ? jobs.map(({ order, round, items, status }) => {
          const orderPaid = orderPaidTotal(order) > 0.005
          const invoiced = orderHasInvoice(order)

          return (
            <article className="card ticket kds-ticket" key={`${order.id}-${round.id}`}>
              <div className="section-title kds-ticket-head">
                <div>
                  <h3>{
                    order.tableIds?.length
                      ? order.tableIds.map((id) => tableLabel(id)).join(' + ')
                      : order.mode === 'delivery'
                        ? `🚚 Domicilio · ${order.delivery?.customerName || `Orden #${order.id}`}`
                        : `Orden #${order.id}`
                  }</h3>
                  <small>
                    Orden #{order.id} · Comanda {round.id} · {items.length} producto{items.length === 1 ? '' : 's'}
                    {order.mode === 'delivery' && order.delivery?.address ? ` · ${order.delivery.address}` : ''}
                  </small>
                </div>
                <span className="badge">#{order.id} · C{round.id}</span>
              </div>

              <div className={`time kds-state ${status === 'preparing' ? 'preparing' : 'new'}`}>
                {status === 'new' ? 'NUEVO' : 'PREPARANDO'}
              </div>

              {order.pager && <div className="badge">Pager / turno {order.pager}</div>}

              <div className="station-job-items kds-item-list">
                {items.map((item) => (
                  <div className="kds-line kds-product-row kds-product-row-controlled" key={item.lineId}>
                    <span className="kds-qty">{item.quantity}×</span>
                    <div className="kds-product-copy">
                      <b>{item.name}</b>
                      {item.note && <small>↳ {item.note}</small>}
                      <small>{formatMoney(Number(item.price || 0) * Number(item.quantity || 0))}</small>

                      {station === 'kitchen' && orderPaid && (
                        <span className="void-lock">🔒 Pagado · requiere autorización del administrador</span>
                      )}

                      {station === 'kitchen' && invoiced && (
                        <span className="void-lock critical">🔒 Factura emitida · corrección fiscal obligatoria</span>
                      )}
                    </div>

                    {canVoidUnpaid && !orderPaid && !invoiced && (
                      <button
                        className="mini danger kds-void-btn"
                        onClick={() => openKitchenVoid(order, round, item)}
                      >
                        Anular
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <button
                className={`btn kds-action ${status === 'preparing' ? 'primary' : ''}`}
                onClick={() => advanceStationRound(order.id, round.id, station)}
              >
                {status === 'new' ? `${icon} Empezar preparación` : '✓ Marcar productos listos'}
              </button>
            </article>
          )
        }) : (
          <div className="card placeholder kds-empty">
            <div>
              <div className="icon">✓</div>
              <h3>Sin comandas pendientes</h3>
              <p>Los nuevos envíos para {isBar ? 'bar' : 'cocina'} aparecerán aquí automáticamente.</p>
            </div>
          </div>
        )}
      </div>

      {showSummary && (
        <div className="modal open station-summary-modal" onClick={() => setShowSummary(false)}>
          <div className="modal-card station-summary-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-title station-summary-head">
              <div>
                <h3>{icon} Resumen de {stationName}</h3>
                <p>
                  {totalPendingUnits} unidad{totalPendingUnits === 1 ? '' : 'es'} pendiente{totalPendingUnits === 1 ? '' : 's'}
                  {' · '}{jobs.length} comanda{jobs.length === 1 ? '' : 's'}
                </p>
              </div>
              <button className="btn" onClick={() => setShowSummary(false)}>×</button>
            </div>

            {preparationSummary.length ? (
              <div className="station-summary-list">
                {preparationSummary.map((item) => (
                  <div className="station-summary-row" key={item.key}>
                    <div className="station-summary-quantity">{item.total}×</div>
                    <div className="station-summary-copy">
                      <b>{item.name}</b>
                      <small>
                        {item.newQty > 0 && `${item.newQty} nueva${item.newQty === 1 ? '' : 's'}`}
                        {item.newQty > 0 && item.preparingQty > 0 ? ' · ' : ''}
                        {item.preparingQty > 0 && `${item.preparingQty} preparando`}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-block">No hay productos pendientes de preparación.</div>
            )}

            <button className="btn primary full station-summary-close" onClick={() => setShowSummary(false)}>
              Cerrar resumen
            </button>
          </div>
        </div>
      )}

      {voidTarget && (
        <div className="modal open" onClick={closeKitchenVoid}>
          <div className="modal-card controlled-void-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div>
                <h3>⚠ Anular producto</h3>
                <p className="muted">Esta acción queda registrada en Supabase.</p>
              </div>
              <button className="btn" disabled={voidBusy} onClick={closeKitchenVoid}>×</button>
            </div>

            <div className="controlled-void-product">
              <b>{voidTarget.item.quantity} × {voidTarget.item.name}</b>
              <strong>{formatMoney(Number(voidTarget.item.price || 0) * Number(voidTarget.item.quantity || 0))}</strong>
            </div>

            <label className="controlled-void-reason">
              <span>Motivo de la anulación *</span>
              <textarea
                value={voidReason}
                onChange={(event) => setVoidReason(event.target.value)}
                placeholder="Ej. Cliente cambió el pedido antes de terminar la preparación"
                autoFocus
              />
            </label>

            <div className="notice warn">
              Solo procede porque esta orden todavía no tiene pagos registrados.
            </div>

            <button className="btn primary full" disabled={voidBusy} onClick={confirmKitchenVoid}>
              {voidBusy ? 'Registrando anulación…' : 'Confirmar anulación'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
