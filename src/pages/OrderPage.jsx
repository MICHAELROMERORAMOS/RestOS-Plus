import React, { useMemo, useState } from 'react'
import { useRestaurant, orderTotal } from '../context/RestaurantContext.jsx'

const roundStatus = (round) => {
  const items = round.items.filter((item) => !item.voided)
  if (!items.length) return 'ANULADA'
  if (items.every((item) => item.prepStatus === 'delivered')) return 'ENTREGADA'
  if (items.every((item) => ['ready', 'delivered'].includes(item.prepStatus))) return 'LISTA'
  if (items.some((item) => item.prepStatus === 'preparing')) return 'PREPARANDO'
  return 'ENVIADA'
}

const availabilityLabel = {
  free: 'LIBRE',
  reserved: 'RESERVADA',
  occupied: 'OCUPADA',
  unavailable: 'NO DISPONIBLE',
}

const availabilityIcon = {
  free: '🟢',
  reserved: '🟡',
  occupied: '🔴',
  unavailable: '⚫',
}

export default function OrderPage({ onNavigate }) {
  const restaurant = useRestaurant()
  const {
    products, orderMode, currentTableId, currentOrder, draft, pager, setPager, setOrderMode,
    addProduct, changeDraftQuantity, removeDraft, updateDraftNote, sendDraft, voidSentItem,
    markRoundDelivered, transferCurrentTable, joinTable, state,
    tableLabel: getTableLabel, getTableTransferStatus,
  } = restaurant
  const [category, setCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [noteLine, setNoteLine] = useState(null)
  const [noteText, setNoteText] = useState('')
  const [tableAction, setTableAction] = useState(null)
  const [targetZoneId, setTargetZoneId] = useState('')
  const [targetTableId, setTargetTableId] = useState('')

  const filteredProducts = useMemo(() => products.filter((product) => (
    (category === 'all' || product.category === category)
    && product.name.toLowerCase().includes(search.toLowerCase())
  )), [products, category, search])

  const activeZones = useMemo(
    () => state.zones.filter((zone) => zone.active !== false).sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)),
    [state.zones],
  )

  const targetTables = useMemo(() => state.tables.filter((table) => (
    table.active !== false
    && table.zoneId === targetZoneId
    && table.id !== currentTableId
    && !(currentOrder?.tableIds || []).includes(table.id)
  )), [state.tables, targetZoneId, currentTableId, currentOrder])

  const draftTotal = draft.reduce((sum, line) => sum + line.price * line.quantity, 0)
  const accountTotal = (currentOrder ? orderTotal(currentOrder) : 0) + draftTotal
  const currentTableLabel = currentTableId ? getTableLabel(currentTableId) : 'Mesa —'
  const accountTableLabel = currentOrder?.tableIds?.length
    ? currentOrder.tableIds.map((id) => getTableLabel(id)).join(' + ')
    : currentTableLabel

  function handleSend() {
    const result = sendDraft({ prepaid: false })
    if (!result.ok) window.alert(result.message)
  }

  function handleQuickPay() {
    const result = sendDraft({ prepaid: true, paymentMethod: 'cash/card' })
    if (!result.ok) return window.alert(result.message)
    onNavigate('kitchen')
  }

  function openTableSelector(action) {
    if (!currentTableId) return window.alert('Selecciona primero una mesa de origen.')
    if (action === 'join' && !currentOrder) return window.alert('Abre primero una cuenta antes de unir otra mesa.')
    setTableAction(action)
    setTargetZoneId('')
    setTargetTableId('')
  }

  function closeTableSelector() {
    setTableAction(null)
    setTargetZoneId('')
    setTargetTableId('')
  }

  function confirmTableAction() {
    if (!targetZoneId || !targetTableId) return window.alert('Selecciona el área y la mesa destino.')
    const status = getTableTransferStatus(targetTableId)
    if (status === 'occupied') return window.alert('Esa mesa está ocupada y no puede seleccionarse.')
    if (status === 'unavailable') return window.alert('Esa mesa no está disponible.')

    if (status === 'reserved') {
      const accepted = window.confirm('La mesa seleccionada está RESERVADA. ¿Quieres usarla de todas formas?')
      if (!accepted) return
    }

    const result = tableAction === 'join'
      ? joinTable(targetTableId)
      : transferCurrentTable(targetTableId)

    if (!result.ok) return window.alert(result.message)
    closeTableSelector()
  }

  return (
    <section className="view active">
      <div className="hero">
        <div>
          <h2>{orderMode === 'quick' ? 'Servicio rápido · Prepago' : currentTableId ? `${currentOrder ? 'Continuar cuenta' : 'Abrir cuenta'} · ${currentTableLabel}` : 'Toma de pedido'}</h2>
          <p>Una cuenta puede tener varias comandas. Solo los productos nuevos se envían en cada ronda.</p>
        </div>
      </div>

      <div className="order-mode">
        <button className={`seg ${orderMode === 'table' ? 'active' : ''}`} onClick={() => setOrderMode('table')}>🍽️ Servicio de mesa</button>
        <button className={`seg ${orderMode === 'quick' ? 'active' : ''}`} onClick={() => setOrderMode('quick')}>⚡ Servicio rápido / Prepago</button>
      </div>

      <div className="order-tools">
        <select value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="all">Todas las categorías</option><option>Comida</option><option>Bebidas</option><option>Postres</option>
        </select>
        <input value={search} placeholder="Buscar producto…" onChange={(event) => setSearch(event.target.value)} />
        {orderMode === 'table' && <button className="btn" disabled={!currentTableId} onClick={() => openTableSelector('transfer')}>⇄ Cambiar mesa</button>}
        {orderMode === 'table' && <button className="btn" onClick={() => onNavigate('cashier')}>✂ Dividir / pago parcial</button>}
        {orderMode === 'table' && <button className="btn" disabled={!currentOrder} onClick={() => openTableSelector('join')}>⊕ Unir mesa</button>}
      </div>

      <div className="order-layout">
        <div className="card">
          <div className="section-title"><h3>Menú</h3><span className="badge">Toca para agregar</span></div>
          <div className="products">
            {filteredProducts.map((product) => (
              <button className="product" key={product.id} onClick={() => addProduct(product)}>
                <strong>{product.name}</strong>
                <small>{product.category} · {product.station === 'bar' ? '🍸 Bar' : '🍳 Cocina'}</small>
                <em>€{product.price.toFixed(2)}</em>
              </button>
            ))}
          </div>
        </div>

        <div className="card order-cart">
          <div className="section-title"><h3>{orderMode === 'quick' ? 'Nueva orden' : 'Cuenta abierta'}</h3><span className="badge">{orderMode === 'quick' ? 'Prepago' : accountTableLabel}</span></div>
          {orderMode === 'quick' && (
            <div className="quickpay"><b>Servicio rápido</b><input value={pager} onChange={(event) => setPager(event.target.value)} placeholder="Pager / turno (opcional)" /></div>
          )}

          {(currentOrder?.rounds || []).map((round) => (
            <div className="sent-block" key={round.id}>
              <div className="sent-head"><span>COMANDA {round.id} · {new Date(round.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span>{roundStatus(round)}</span></div>
              {round.items.map((item) => (
                <div className={`sent-line ${item.voided ? 'voided' : ''}`} key={item.lineId}>
                  <div>
                    <b>{item.quantity} × {item.name}</b>
                    {item.note && <small>↳ {item.note}</small>}
                    <span className="station">{item.station === 'bar' ? 'BAR' : 'COCINA'} · {item.prepStatus.toUpperCase()} · bloqueado</span>
                  </div>
                  <div className="sent-price"><strong>€{(item.price * item.quantity).toFixed(2)}</strong>{!item.voided && <button className="mini danger" onClick={() => window.confirm('Este producto ya fue enviado. Se registrará como ANULADO, no se eliminará del historial.') && voidSentItem(currentOrder.id, round.id, item.lineId)}>Anular</button>}</div>
                </div>
              ))}
              {roundStatus(round) === 'LISTA' && <button className="btn" onClick={() => markRoundDelivered(currentOrder.id, round.id)}>✓ Marcar comanda entregada</button>}
            </div>
          ))}

          {draft.length ? (
            <div>
              <div className="sent-head"><span>NUEVOS · SIN ENVIAR</span><span>EDITABLE</span></div>
              {draft.map((line) => (
                <div className="draft-line" key={line.draftId}>
                  <div>
                    <b>{line.name}</b>
                    <small>{line.station === 'bar' ? '🍸 Bar' : '🍳 Cocina'}{line.note ? ` · ${line.note}` : ''}</small>
                    <div className="line-actions">
                      <button className="mini" onClick={() => { setNoteLine(line); setNoteText(line.note || '') }}>✎ Nota</button>
                      <button className="mini danger" onClick={() => removeDraft(line.draftId)}>× Quitar</button>
                    </div>
                  </div>
                  <div>
                    <div className="qty"><button onClick={() => changeDraftQuantity(line.draftId, -1)}>−</button><b>{line.quantity}</b><button onClick={() => changeDraftQuantity(line.draftId, 1)}>+</button></div>
                    <strong className="line-total">€{(line.price * line.quantity).toFixed(2)}</strong>
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="empty-inline">No hay productos nuevos por enviar</div>}

          <div className="order-summary"><div className="row plain"><b>Total cuenta</b><strong>€{accountTotal.toFixed(2)}</strong></div></div>
          {orderMode === 'table' ? (
            <button className="btn primary full action-main" disabled={!draft.length} onClick={handleSend}>Enviar nuevos productos</button>
          ) : (
            <button className="btn primary full action-main" disabled={!draft.length} onClick={handleQuickPay}>💳 Cobrar y enviar a preparación</button>
          )}
          {orderMode === 'quick' && <div className="notice">En servicio rápido el pedido se cobra antes de enviarse a Cocina/Bar.</div>}
        </div>
      </div>

      {noteLine && (
        <div className="modal open">
          <div className="modal-card">
            <div className="section-title"><h3>Nota / modificadores</h3><button className="btn" onClick={() => setNoteLine(null)}>×</button></div>
            <p className="muted">Ej.: sin cebolla, término medio, extra queso.</p>
            <textarea value={noteText} onChange={(event) => setNoteText(event.target.value)} />
            <button className="btn primary full" onClick={() => { updateDraftNote(noteLine.draftId, noteText); setNoteLine(null) }}>Guardar nota</button>
          </div>
        </div>
      )}

      {tableAction && (
        <div className="modal open">
          <div className="modal-card">
            <div className="section-title">
              <div><h3>{tableAction === 'join' ? 'Unir otra mesa' : 'Cambiar de mesa'}</h3><p className="muted">Origen: {currentTableLabel}</p></div>
              <button className="btn" onClick={closeTableSelector}>×</button>
            </div>

            <div className="settings-form">
              <label>
                <span>1. Salón / área destino</span>
                <select value={targetZoneId} onChange={(event) => { setTargetZoneId(event.target.value); setTargetTableId('') }}>
                  <option value="">Selecciona un área</option>
                  {activeZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
                </select>
              </label>

              <label>
                <span>2. Mesa destino</span>
                <select value={targetTableId} disabled={!targetZoneId} onChange={(event) => setTargetTableId(event.target.value)}>
                  <option value="">Selecciona una mesa</option>
                  {targetTables.map((table) => {
                    const status = getTableTransferStatus(table.id)
                    return <option key={table.id} value={table.id} disabled={status === 'occupied' || status === 'unavailable'}>{availabilityIcon[status]} {table.name} — {availabilityLabel[status]}</option>
                  })}
                </select>
              </label>
            </div>

            {targetZoneId && !targetTables.length && <div className="empty-inline">No hay otras mesas activas en esta área.</div>}
            <div className="notice">🟢 Libre: seleccionable · 🟡 Reservada: seleccionable con confirmación · 🔴 Ocupada: visible pero bloqueada</div>
            <button className="btn primary full" disabled={!targetTableId} onClick={confirmTableAction}>{tableAction === 'join' ? 'Unir mesa seleccionada' : 'Confirmar cambio de mesa'}</button>
          </div>
        </div>
      )}
    </section>
  )
}
