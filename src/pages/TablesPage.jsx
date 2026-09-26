import React, { useMemo, useState } from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'

function formatTime(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('es', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export default function TablesPage({ onOpenTable, onQuickService }) {
  const {
    state, getTableVisualStatus, formatMoney, orderTotal, tableSessionForTable, getTableDraftCount,
    canReleaseTableDraftSession, abandonTableDraftSession,
  } = useRestaurant()
  const [pendingTable, setPendingTable] = useState(null)
  const [openingTable, setOpeningTable] = useState(false)
  const [releasingTableId, setReleasingTableId] = useState(null)
  const labels = {
    free: 'LIBRE',
    reserved: 'RESERVADA',
    occupied: 'OCUPADA',
    opening: 'TOMANDO PEDIDO',
    ready: 'PEDIDO LISTO',
    pay: 'POR COBRAR',
    waiting_food: 'PAGADA · ESPERANDO COMIDA',
    refund_due: 'REEMBOLSO PENDIENTE',
  }

  const activeZones = useMemo(
    () => state.zones.filter((zone) => zone.active !== false).sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)),
    [state.zones],
  )

  const statusStyle = (status) => {
    if (status === 'free') return { borderColor: '#2f9e44', boxShadow: 'inset 0 0 0 1px #2f9e44' }
    if (status === 'reserved') return { borderColor: '#e0a800', boxShadow: 'inset 0 0 0 1px #e0a800' }
    if (status === 'occupied') return { borderColor: '#d64545', boxShadow: 'inset 0 0 0 1px #d64545' }
    if (status === 'opening') return { borderColor: '#2f6fed', boxShadow: 'inset 0 0 0 1px #2f6fed' }
    if (status === 'waiting_food') return { borderColor: '#5b6fc7', boxShadow: 'inset 0 0 0 1px #5b6fc7' }
    if (status === 'refund_due') return { borderColor: '#b84b4b', boxShadow: 'inset 0 0 0 1px #b84b4b' }
    return undefined
  }

  function tableTimeText(table, status) {
    if (status === 'opening') {
      const session = tableSessionForTable(table.id)
      const time = formatTime(session?.claimedAt)
      return time ? `Tomando pedido desde las ${time}` : 'Tomando pedido ahora'
    }

    const isOpen = ['occupied', 'ready', 'pay', 'waiting_food', 'refund_due'].includes(status)

    const relatedOrders = state.orders
      .filter((order) => order.mode === 'table' && (order.tableIds || []).includes(table.id))
      .sort((a, b) => (b.created || 0) - (a.created || 0))

    const openOrder = relatedOrders.find((order) => !['closed', 'cancelled', 'merged'].includes(order.status))
    const lastClosedOrder = relatedOrders.find((order) => order.status === 'closed' && order.closedAt)

    const value = isOpen
      ? (table.openedAt || openOrder?.created)
      : (table.releasedAt || lastClosedOrder?.closedAt)

    const time = formatTime(value)
    if (!time) return isOpen ? 'Hora de apertura sin registrar' : 'Hora de liberación sin registrar'
    return isOpen ? `Abierta a las ${time}` : `Liberada a las ${time}`
  }

  function sentAccountTotal(tableId) {
    const relatedOrders = state.orders.filter((order) => (
      order.mode === 'table'
      && (order.tableIds || []).includes(tableId)
      && !['closed', 'cancelled', 'merged'].includes(order.status)
      && (order.rounds || []).some((round) => (
        (round.items || []).some((item) => !item.voided)
      ))
    ))

    if (!relatedOrders.length) return null
    return relatedOrders.reduce((sum, order) => sum + Number(orderTotal(order) || 0), 0)
  }

  async function openExistingOrClaimedTable(table) {
    const result = await onOpenTable(table.id, { confirmed: true })
    if (result?.ok === false && !result?.cancelled) {
      window.alert(result.message || 'No se pudo abrir la mesa.')
    }
    return result
  }

  function handleTableClick(table) {
    const status = getTableVisualStatus(table.id)
    const session = tableSessionForTable(table.id)

    if (status === 'free') {
      setPendingTable(table)
      return
    }

    if (status === 'opening' && !session?.claimedByMe) {
      window.alert('Esta mesa ya está siendo atendida por otro usuario.')
      return
    }

    openExistingOrClaimedTable(table)
  }

  async function releaseMyTable(table) {
    const session = tableSessionForTable(table.id)
    if (!canReleaseTableDraftSession(table.id)) {
      window.alert('No tienes permiso para liberar esta mesa.')
      return
    }

    const draftCount = getTableDraftCount(table.id)
    const isOwnSession = Boolean(session?.claimedByMe)

    let message = '¿Deseas liberar esta mesa? Aún no se ha enviado ningún pedido.'
    if (isOwnSession && draftCount > 0) {
      message = `Esta mesa tiene ${draftCount} producto${draftCount === 1 ? '' : 's'} sin enviar. Si la liberas, ese borrador se eliminará. ¿Deseas continuar?`
    } else if (!isOwnSession) {
      message = `Esta mesa está siendo atendida por ${session?.attendantName || 'otro usuario'} y todavía no tiene una orden enviada. Si la liberas, se cancelará esa toma de pedido. ¿Deseas continuar?`
    }

    if (!window.confirm(message)) return

    setReleasingTableId(table.id)
    try {
      const result = await abandonTableDraftSession(table.id, { discardDraft: true })
      if (!result?.ok) {
        window.alert(result?.message || 'No se pudo liberar la mesa.')
      }
    } finally {
      setReleasingTableId(null)
    }
  }

  async function confirmOpenTable() {
    if (!pendingTable || openingTable) return
    setOpeningTable(true)
    try {
      const result = await onOpenTable(pendingTable.id, { confirmed: true })
      if (result?.ok) {
        setPendingTable(null)
      } else if (!result?.cancelled) {
        window.alert(result?.message || 'No se pudo abrir la mesa.')
      }
    } finally {
      setOpeningTable(false)
    }
  }

  return (
    <section className="view active">
      <div className="hero tables-hero">
        <div>
          <h2>Mesas y salones</h2>
          <p>Selecciona una mesa para abrir o continuar su pedido. Para ventas sin mesa utiliza Servicio rápido.</p>
        </div>
        {onQuickService && (
          <button className="btn primary quick-service-entry" onClick={onQuickService}>
            <span className="quick-service-icon">⚡</span>
            <span>
              <b>Servicio rápido</b>
              <small>Prepago · sin mesa</small>
            </span>
          </button>
        )}
      </div>

      {!activeZones.length && (
        <div className="card"><div className="empty-inline">No hay mesas configuradas. Ve a Configuración → Salones / áreas y mesas para crear la distribución del restaurante.</div></div>
      )}

      {activeZones.map((zone) => {
        const tables = state.tables.filter((table) => table.active !== false && table.zoneId === zone.id)
        return (
          <div className="card section-gap" key={zone.id}>
            <div className="section-title"><h3>{zone.name}</h3><span className="badge">{tables.length} {tables.length === 1 ? 'mesa' : 'mesas'}</span></div>
            {tables.length ? (
              <div className="tables">
                {tables.map((table) => {
                  const status = getTableVisualStatus(table.id)
                  const sentTotal = sentAccountTotal(table.id)
                  const draftCount = getTableDraftCount(table.id)
                  const session = tableSessionForTable(table.id)
                  const blockedByOther = status === 'opening' && !session?.claimedByMe
                  const canReleaseDraft = status === 'opening'
                    && canReleaseTableDraftSession(table.id)
                  return (
                    <div className="table-shell" key={table.id}>
                      <button
                        className={`table ${status}`}
                        style={statusStyle(status)}
                        onClick={() => handleTableClick(table)}
                        aria-label={blockedByOther ? `${table.name}, otro usuario está tomando el pedido` : table.name}
                      >
                        {session?.attendantName && (
                          <small className="table-attendant" title={session.attendantName}>
                            Atiende: {session.attendantName}
                          </small>
                        )}
                        <div className="table-head">
                          <b>{table.name}</b>
                          <small className="table-capacity">{table.capacity} puestos</small>
                        </div>
                        <small className="table-time">◷ {tableTimeText(table, status)}</small>
                        {sentTotal !== null && (
                          <strong className="table-account-total">{formatMoney(sentTotal)}</strong>
                        )}
                        {draftCount > 0 && (
                          <small className="table-draft-count">
                            🛒 {draftCount} {draftCount === 1 ? 'producto' : 'productos'} sin enviar
                          </small>
                        )}
                        <span className="table-status">{labels[status] || status}</span>
                      </button>
                      {canReleaseDraft && (
                        <button
                          className="table-release-btn"
                          onClick={() => releaseMyTable(table)}
                          disabled={releasingTableId === table.id}
                        >
                          {releasingTableId === table.id ? 'Liberando…' : 'Liberar mesa'}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : <div className="empty-inline">Esta área todavía no tiene mesas.</div>}
          </div>
        )
      })}
      <div className={`modal ${pendingTable ? 'open' : ''}`} onClick={() => !openingTable && setPendingTable(null)}>
        <div className="modal-card table-open-modal" onClick={(event) => event.stopPropagation()}>
          <div className="table-open-icon">🍽️</div>
          <h3>Abrir {pendingTable?.name || 'mesa'}</h3>
          <p>
            {pendingTable && getTableDraftCount(pendingTable.id) > 0
              ? `Esta mesa tiene ${getTableDraftCount(pendingTable.id)} producto${getTableDraftCount(pendingTable.id) === 1 ? '' : 's'} sin enviar guardado${getTableDraftCount(pendingTable.id) === 1 ? '' : 's'}. ¿Deseas continuar el pedido?`
              : '¿Deseas abrir esta mesa para tomar el pedido? Mientras la estés atendiendo, los demás usuarios verán que el pedido ya se está tomando.'}
          </p>
          <div className="table-open-actions">
            <button className="btn" onClick={() => setPendingTable(null)} disabled={openingTable}>
              Cancelar
            </button>
            <button className="btn primary" onClick={confirmOpenTable} disabled={openingTable}>
              {openingTable ? 'Abriendo…' : 'Abrir mesa'}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
