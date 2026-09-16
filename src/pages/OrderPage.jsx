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

export default function OrderPage({ onNavigate }) {
  const restaurant = useRestaurant()
  const {
    products, orderMode, currentTableId, currentOrder, draft, pager, setPager, setOrderMode,
    addProduct, changeDraftQuantity, removeDraft, updateDraftNote, sendDraft, voidSentItem,
    markRoundDelivered, transferCurrentTable, joinTable, state,
  } = restaurant
  const [category, setCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [noteLine, setNoteLine] = useState(null)
  const [noteText, setNoteText] = useState('')

  const filteredProducts = useMemo(() => products.filter((product) => (
    (category === 'all' || product.category === category)
    && product.name.toLowerCase().includes(search.toLowerCase())
  )), [products, category, search])

  const draftTotal = draft.reduce((sum, line) => sum + line.price * line.quantity, 0)
  const accountTotal = (currentOrder ? orderTotal(currentOrder) : 0) + draftTotal
  const tableLabel = currentOrder?.tableIds?.length
    ? `Mesa ${currentOrder.tableIds.join(' + ')}`
    : currentTableId ? `Mesa ${currentTableId}` : 'Mesa —'

  function handleSend() {
    const result = sendDraft({ prepaid: false })
    if (!result.ok) window.alert(result.message)
  }

  function handleQuickPay() {
    const result = sendDraft({ prepaid: true, paymentMethod: 'cash/card' })
    if (!result.ok) return window.alert(result.message)
    onNavigate('kitchen')
  }

  function transferTable() {
    const destination = window.prompt('Mover la cuenta a la mesa número:')
    if (!destination) return
    const result = transferCurrentTable(destination)
    if (!result.ok) window.alert(result.message)
  }

  function joinAnotherTable() {
    const destination = window.prompt('Número de la mesa libre que quieres unir a esta cuenta:')
    if (!destination) return
    const result = joinTable(destination)
    if (!result.ok) window.alert(result.message)
  }

  return (
    <section className="view active">
      <div className="hero">
        <div>
          <h2>{orderMode === 'quick' ? 'Servicio rápido · Prepago' : currentTableId ? `${currentOrder ? 'Continuar cuenta' : 'Abrir cuenta'} · Mesa ${currentTableId}` : 'Toma de pedido'}</h2>
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
        {orderMode === 'table' && <button className="btn" onClick={transferTable}>⇄ Cambiar mesa</button>}
        {orderMode === 'table' && <button className="btn" onClick={() => onNavigate('cashier')}>✂ Dividir / pago parcial</button>}
        {orderMode === 'table' && <button className="btn" onClick={joinAnotherTable}>⊕ Unir mesa</button>}
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
          <div className="section-title"><h3>{orderMode === 'quick' ? 'Nueva orden' : 'Cuenta abierta'}</h3><span className="badge">{orderMode === 'quick' ? 'Prepago' : tableLabel}</span></div>
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
    </section>
  )
}
