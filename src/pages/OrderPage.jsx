import React, { useEffect, useMemo, useState } from 'react'
import SplitBillModal from '../components/payments/SplitBillModal.jsx'
import { useRestaurant, orderBalance, orderHasInvoice, orderPaidTotal, orderTotal } from '../context/RestaurantContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import {
  consumeAccountVoidAuthorization,
  createKitchenVoidRequest,
  listMyKitchenVoidRequests,
  markKitchenVoidRequestApplied,
  requestAccountVoidAuthorization,
  sendAccountVoidConfirmation,
} from '../services/voidAuthorizationService.js'

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
  const auth = useAuth()
  const canCharge = auth.can('payments.create')
  const canRequestUnpaidVoid = auth.can('orders.void.request_unpaid')
  const canVoidPartialAccount = auth.can('orders.account_void.authorized')
  const restaurantId = auth.userContext?.membership?.restaurant_id || null
  const {
    products, formatMoney, orderMode, currentTableId, currentOrder, currentDelivery, draft, pager, setPager, setOrderMode,
    addProduct, changeDraftQuantity, removeDraft, updateDraftNote, sendDraft,
    applyKitchenApprovedVoidRequest, voidPaidTableAccount,
    markRoundDelivered, transferCurrentTable, joinTable, recordPayments, state,
    tableLabel: getTableLabel, getTableTransferStatus,
  } = restaurant
  const [category, setCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [noteLine, setNoteLine] = useState(null)
  const [noteText, setNoteText] = useState('')
  const [tableAction, setTableAction] = useState(null)
  const [targetZoneId, setTargetZoneId] = useState('')
  const [targetTableId, setTargetTableId] = useState('')
  const [showCharge, setShowCharge] = useState(false)
  const [showSplit, setShowSplit] = useState(false)
  const [chargeAmount, setChargeAmount] = useState('')
  const [chargeMethod, setChargeMethod] = useState('card')
  const [myVoidRequests, setMyVoidRequests] = useState([])
  const [showUnpaidVoidRequest, setShowUnpaidVoidRequest] = useState(false)
  const [unpaidVoidSelected, setUnpaidVoidSelected] = useState({})
  const [unpaidVoidReason, setUnpaidVoidReason] = useState('')
  const [unpaidVoidBusy, setUnpaidVoidBusy] = useState(false)

  const [showAccountVoid, setShowAccountVoid] = useState(false)
  const [accountVoidReason, setAccountVoidReason] = useState('')
  const [accountVoidRequestId, setAccountVoidRequestId] = useState(null)
  const [accountVoidCode, setAccountVoidCode] = useState('')
  const [accountVoidExpiresAt, setAccountVoidExpiresAt] = useState(null)
  const [accountVoidBusy, setAccountVoidBusy] = useState(false)

  const categoryOptions = useMemo(
    () => Array.from(new Set(
      products
        .filter((product) => product.available !== false)
        .map((product) => product.category || 'Sin categoría'),
    )).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' })),
    [products],
  )

  const filteredProducts = useMemo(() => products.filter((product) => (
    product.available !== false
    && (category === 'all' || product.category === category)
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
  const currentOrderTotal = currentOrder ? orderTotal(currentOrder) : 0
  const currentTableLabel = currentTableId ? getTableLabel(currentTableId) : 'Mesa —'
  const deliveryInfo = currentOrder?.delivery || currentDelivery
  const accountTableLabel = currentOrder?.tableIds?.length
    ? currentOrder.tableIds.map((id) => getTableLabel(id)).join(' + ')
    : currentTableLabel
  const tableOrders = useMemo(() => {
    if (orderMode !== 'table' || !currentTableId) return []
    return state.orders
      .filter((order) => (
        order.mode === 'table'
        && (order.tableIds || []).includes(currentTableId)
        && !['closed', 'cancelled', 'merged'].includes(order.status)
        && (order.rounds?.length || 0) > 0
      ))
      .sort((a, b) => (a.created || 0) - (b.created || 0))
  }, [state.orders, orderMode, currentTableId])

  const tableAccountTotal = tableOrders.reduce((sum, order) => sum + orderTotal(order), 0)
  const tableAccountPaid = tableOrders.reduce((sum, order) => sum + orderPaidTotal(order), 0)
  const tableAccountBalance = tableOrders.reduce((sum, order) => sum + orderBalance(order), 0)
  const tableRefundDue = tableOrders.reduce((sum, order) => sum + Number(order.refundDue || 0), 0)
  const currentOrderPaid = currentOrder ? orderPaidTotal(currentOrder) : 0
  const accountHasPayment = orderMode === 'table'
    ? tableAccountPaid > 0.005
    : currentOrderPaid > 0.005
  const accountTotal = (orderMode === 'table' ? tableAccountTotal : currentOrderTotal) + draftTotal
  const tableAccountFullyPaid = orderMode === 'table'
    && tableAccountTotal > 0.005
    && tableAccountBalance <= 0.005
  const tableAccountPartiallyPaid = orderMode === 'table'
    && tableAccountPaid > 0.005
    && tableAccountBalance > 0.005
  const tableAccountUnpaid = orderMode === 'table'
    && tableAccountPaid <= 0.005

  const requestableItems = useMemo(() => (
    (currentOrder?.rounds || []).flatMap((round) => (
      (round.items || [])
        .filter((item) => !item.voided && item.prepStatus !== 'delivered')
        .map((item) => ({
          roundId: round.id,
          lineId: item.lineId,
          name: item.name,
          quantity: Number(item.quantity || 0),
          amount: Number(item.price || 0) * Number(item.quantity || 0),
        }))
    ))
  ), [currentOrder])

  const accountVoidItems = useMemo(() => (
    tableOrders.flatMap((order) => (
      (order.rounds || []).flatMap((round) => (
        (round.items || [])
          .filter((item) => !item.voided)
          .map((item) => ({
            orderId: order.id,
            roundId: round.id,
            lineId: item.lineId,
            name: item.name,
            quantity: Number(item.quantity || 0),
            amount: Number(item.price || 0) * Number(item.quantity || 0),
          }))
      ))
    ))
  ), [tableOrders])

  const accountVoidRef = tableOrders.length
    ? tableOrders.map((order) => order.id).join('+')
    : (currentOrder?.id || '')

  const latestVoidRequestByLine = useMemo(() => {
    const map = new Map()

    ;(myVoidRequests || []).forEach((request) => {
      ;(request.items || []).forEach((item) => {
        if (!map.has(String(item.lineId))) map.set(String(item.lineId), request)
      })
    })

    return map
  }, [myVoidRequests])

  function allocateTablePayment(requestedAmount) {
    let remaining = Math.min(Number(requestedAmount || 0), tableAccountBalance)
    const allocations = []

    for (const order of tableOrders) {
      if (remaining <= 0.005) break
      const balance = orderBalance(order)
      if (balance <= 0.005) continue
      const amount = Math.min(balance, remaining)
      allocations.push({ orderId: order.id, amount })
      remaining -= amount
    }

    return allocations
  }

  function openChargeModal() {
    if (!canCharge) return window.alert('Tu rol no tiene permiso para cobrar cuentas.')
    if (!currentTableId || !tableOrders.length) return window.alert('No hay una cuenta enviada para cobrar en esta mesa.')
    if (tableAccountBalance <= 0.005) return window.alert('La cuenta de esta mesa ya está pagada.')

    if (draft.length) {
      const continueAnyway = window.confirm(
        'Hay productos nuevos SIN ENVIAR. Esos productos todavía no forman parte del saldo a cobrar. ¿Quieres cobrar únicamente lo ya enviado?',
      )
      if (!continueAnyway) return
    }

    setChargeAmount(tableAccountBalance.toFixed(2))
    setChargeMethod('card')
    setShowCharge(true)
  }

  function openSplitModal() {
    if (!canCharge) return window.alert('Tu rol no tiene permiso para dividir o cobrar cuentas.')
    if (!currentTableId || !tableOrders.length) return window.alert('No hay una cuenta enviada para dividir en esta mesa.')
    if (tableAccountBalance <= 0.005) return window.alert('La cuenta de esta mesa ya está pagada.')

    if (draft.length) {
      const continueAnyway = window.confirm(
        'Hay productos nuevos SIN ENVIAR. Esos productos todavía no forman parte de la cuenta que vas a dividir. ¿Quieres continuar con lo ya enviado?',
      )
      if (!continueAnyway) return
    }

    setShowCharge(false)
    setShowSplit(true)
  }

  async function refreshMyVoidRequests({ applyApproved = true, silent = false } = {}) {
    if (!restaurantId || !currentOrder?.id || !canRequestUnpaidVoid) {
      setMyVoidRequests([])
      return
    }

    try {
      const requests = await listMyKitchenVoidRequests(restaurantId, currentOrder.id)
      setMyVoidRequests(requests)

      if (applyApproved && !accountHasPayment) {
        for (const request of requests) {
          if (request.status !== 'approved' || request.applied_at) continue

          const result = applyKitchenApprovedVoidRequest(currentOrder.id, request)
          if (!result.ok) continue

          try {
            await markKitchenVoidRequestApplied(request.id)
          } catch {
            // The local void is already applied; the next refresh can retry the acknowledgement.
          }
        }
      }
    } catch (error) {
      if (!silent) window.alert(error?.message || 'No se pudieron consultar las solicitudes de anulación.')
    }
  }

  useEffect(() => {
    if (!restaurantId || !currentOrder?.id || !canRequestUnpaidVoid) {
      setMyVoidRequests([])
      return undefined
    }

    refreshMyVoidRequests()
    const timer = window.setInterval(() => {
      refreshMyVoidRequests({ silent: true })
    }, 5000)

    return () => window.clearInterval(timer)
  }, [restaurantId, currentOrder?.id, canRequestUnpaidVoid, accountHasPayment])

  function openUnpaidVoidRequest() {
    if (!currentOrder || !tableAccountUnpaid) return
    if (!canRequestUnpaidVoid) return window.alert('Tu rol no puede solicitar anulaciones a Cocina.')
    if (!requestableItems.length) return window.alert('No hay productos enviados disponibles para solicitar anulación.')

    setUnpaidVoidSelected({})
    setUnpaidVoidReason('')
    setShowUnpaidVoidRequest(true)
  }

  function toggleUnpaidVoidLine(lineId) {
    setUnpaidVoidSelected((current) => ({
      ...current,
      [lineId]: !current[lineId],
    }))
  }

  async function submitUnpaidVoidRequest() {
    if (!currentOrder || !restaurantId) return

    if (!tableAccountUnpaid) {
      return window.alert('La cuenta ya tiene pagos. La anulación debe pasar al flujo de cuenta completa con administrador.')
    }

    const items = requestableItems.filter((item) => unpaidVoidSelected[item.lineId])
    if (!items.length) return window.alert('Selecciona al menos un producto.')
    if (unpaidVoidReason.trim().length < 4) return window.alert('Escribe un motivo claro para la solicitud.')

    setUnpaidVoidBusy(true)
    try {
      await createKitchenVoidRequest({
        restaurantId,
        orderRef: currentOrder.id,
        tableLabel: accountTableLabel,
        items,
        reason: unpaidVoidReason.trim(),
      })

      setShowUnpaidVoidRequest(false)
      setUnpaidVoidSelected({})
      setUnpaidVoidReason('')
      await refreshMyVoidRequests({ applyApproved: false, silent: true })
    } catch (error) {
      window.alert(error?.message || 'No se pudo enviar la solicitud a Cocina.')
    } finally {
      setUnpaidVoidBusy(false)
    }
  }

  function openAccountVoid() {
    if (!tableAccountPartiallyPaid || !tableOrders.length) return

    if (!canVoidPartialAccount) {
      return window.alert('Tu rol no puede solicitar la anulación de una cuenta parcialmente pagada.')
    }

    if (tableOrders.some((order) => orderHasInvoice(order))) {
      return window.alert('La cuenta tiene una factura emitida y requiere el flujo fiscal correspondiente.')
    }

    setShowAccountVoid(true)
    setAccountVoidReason('')
    setAccountVoidRequestId(null)
    setAccountVoidCode('')
    setAccountVoidExpiresAt(null)
  }

  function closeAccountVoid() {
    if (accountVoidBusy) return
    setShowAccountVoid(false)
    setAccountVoidReason('')
    setAccountVoidRequestId(null)
    setAccountVoidCode('')
    setAccountVoidExpiresAt(null)
  }

  async function requestAccountVoidCode() {
    if (!restaurantId || !accountVoidRef) return
    if (!tableAccountPartiallyPaid) {
      return window.alert('Esta cuenta ya no está parcialmente pagada.')
    }
    if (accountVoidReason.trim().length < 4) {
      return window.alert('Escribe un motivo claro para anular la cuenta completa.')
    }

    setAccountVoidBusy(true)
    try {
      const result = await requestAccountVoidAuthorization({
        restaurantId,
        orderRef: accountVoidRef,
        tableLabel: accountTableLabel,
        amountPaid: tableAccountPaid,
        reason: accountVoidReason.trim(),
      })

      setAccountVoidRequestId(result.requestId)
      setAccountVoidExpiresAt(result.expiresAt || null)
      setAccountVoidCode('')
    } catch (error) {
      window.alert(error?.message || 'No se pudo enviar el código al administrador.')
    } finally {
      setAccountVoidBusy(false)
    }
  }

  async function confirmAccountVoidCode() {
    if (!accountVoidRequestId || !tableAccountPartiallyPaid) return

    const code = accountVoidCode.trim()
    if (!/^\d{6}$/.test(code)) {
      return window.alert('Introduce el código de 6 dígitos enviado al administrador.')
    }

    setAccountVoidBusy(true)

    try {
      const auditId = await consumeAccountVoidAuthorization({
        requestId: accountVoidRequestId,
        code,
        orderRef: accountVoidRef,
        tableLabel: accountTableLabel,
        items: accountVoidItems,
        reason: accountVoidReason.trim(),
        amountPaid: tableAccountPaid,
      })

      const result = voidPaidTableAccount(
        tableOrders.map((order) => order.id),
        {
          reason: accountVoidReason.trim(),
          auditId,
          authorizationRequestId: accountVoidRequestId,
        },
      )

      if (!result.ok) throw new Error(result.message)

      let emailWarning = ''
      try {
        await sendAccountVoidConfirmation(auditId)
      } catch (error) {
        emailWarning = `\n\nLa cuenta fue anulada, pero no se pudo enviar el correo de confirmación: ${error?.message || 'error de correo'}`
      }

      setAccountVoidBusy(false)
      setShowAccountVoid(false)
      setAccountVoidReason('')
      setAccountVoidRequestId(null)
      setAccountVoidCode('')
      setAccountVoidExpiresAt(null)

      window.alert(
        `Cuenta completa anulada. Reembolso pendiente: ${formatMoney(result.refundDue)}.${emailWarning}`,
      )
    } catch (error) {
      window.alert(error?.message || 'El código no pudo validar la anulación de la cuenta.')
    } finally {
      setAccountVoidBusy(false)
    }
  }

  function confirmCharge() {
    if (!canCharge) return window.alert('Tu rol no tiene permiso para cobrar cuentas.')

    const amount = Number(String(chargeAmount).replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0) return window.alert('Introduce un importe válido.')
    if (amount > tableAccountBalance + 0.005) return window.alert('El importe supera el saldo pendiente de la mesa.')

    const allocations = allocateTablePayment(amount)
    if (!allocations.length) return window.alert('No hay saldo pendiente para cobrar.')

    const confirmed = window.confirm(
      `¿Confirmar cobro de ${formatMoney(amount)} para ${accountTableLabel}?\n\nMétodo: ${chargeMethod === 'cash' ? 'Efectivo' : 'Tarjeta'}`,
    )
    if (!confirmed) return

    const result = recordPayments(allocations, chargeMethod)
    if (!result.ok) return window.alert(result.message)

    setShowCharge(false)
    setChargeAmount('')
  }

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
          <h2>{
            orderMode === 'quick'
              ? 'Servicio rápido · Prepago'
              : orderMode === 'delivery'
                ? `Domicilio · ${deliveryInfo?.customerName || 'Nuevo cliente'}`
                : currentTableId
                  ? `${currentOrder ? 'Continuar cuenta' : 'Abrir cuenta'} · ${currentTableLabel}`
                  : 'Pedido'
          }</h2>
          <p>{
            orderMode === 'delivery'
              ? 'Pedido a domicilio. Los productos se envían a Cocina/Bar y conservan los datos de entrega.'
              : 'Una cuenta puede tener varias comandas. Solo los productos nuevos se envían en cada ronda.'
          }</p>
        </div>
      </div>

      <div className="order-category-filter" role="group" aria-label="Categorías del menú">
        <button
          type="button"
          className={`order-category-btn ${category === 'all' ? 'active' : ''}`}
          aria-pressed={category === 'all'}
          onClick={() => setCategory('all')}
        >
          Todas
        </button>

        {categoryOptions.map((categoryName) => (
          <button
            type="button"
            key={categoryName}
            className={`order-category-btn ${category === categoryName ? 'active' : ''}`}
            aria-pressed={category === categoryName}
            onClick={() => setCategory(categoryName)}
          >
            {categoryName}
          </button>
        ))}
      </div>

      <div className="order-tools">
        <input
          className="order-product-search"
          value={search}
          placeholder="Buscar producto…"
          onChange={(event) => setSearch(event.target.value)}
        />
        {orderMode === 'table' && <button className="btn" disabled={!currentTableId} onClick={() => openTableSelector('transfer')}>⇄ Cambiar mesa</button>}
        {orderMode === 'table' && canCharge && (
          <button className="btn pay-inline-btn" disabled={!tableOrders.length || tableAccountBalance <= 0.005} onClick={openChargeModal}>
            💳 Cobrar mesa
          </button>
        )}
        {orderMode === 'table' && canCharge && (
          <button className="btn" disabled={!tableOrders.length || tableAccountBalance <= 0.005} onClick={openSplitModal}>
            ✂ Dividir cuenta
          </button>
        )}
        {orderMode === 'table' && <button className="btn" disabled={!currentOrder} onClick={() => openTableSelector('join')}>⊕ Unir mesa</button>}
      </div>

      <div className="order-layout">
        <div className="card">
          <div className="section-title"><h3>Menú</h3><span className="badge">Toca para agregar</span></div>
          <div className="products">
            {filteredProducts.length ? filteredProducts.map((product) => (
              <button className="product" key={product.id} onClick={() => addProduct(product)}>
                <strong>{product.name}</strong>
                <small>{product.category} · {product.station === 'bar' ? '🍸 Bar' : '🍳 Cocina'}</small>
                <em>{formatMoney(product.price)}</em>
              </button>
            )) : (
              <div className="empty-inline">No hay productos activos que coincidan con este filtro.</div>
            )}
          </div>
        </div>

        <div className="card order-cart">
          <div className="section-title">
            <h3>{orderMode === 'quick' ? 'Nueva orden' : orderMode === 'delivery' ? 'Pedido a domicilio' : 'Cuenta abierta'}</h3>
            <span className="badge">
              {orderMode === 'quick' ? 'Prepago' : orderMode === 'delivery' ? (deliveryInfo?.customerName || 'Domicilio') : accountTableLabel}
            </span>
          </div>
          {orderMode === 'quick' && (
            <div className="quickpay"><b>Servicio rápido</b><input value={pager} onChange={(event) => setPager(event.target.value)} placeholder="Pager / turno (opcional)" /></div>
          )}

          {orderMode === 'delivery' && deliveryInfo && (
            <div className="delivery-order-summary">
              <div>
                <b>🚚 {deliveryInfo.customerName}</b>
                <span>{deliveryInfo.address}</span>
                <small>{deliveryInfo.neighborhood} · {deliveryInfo.city}</small>
              </div>
              <div>
                <b>📱 {deliveryInfo.phone}</b>
                {deliveryInfo.email && <small>✉ {deliveryInfo.email}</small>}
              </div>
            </div>
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
                  <div className="sent-price">
                    <strong>{formatMoney(item.price * item.quantity)}</strong>

                    {!item.voided && tableAccountUnpaid && latestVoidRequestByLine.get(String(item.lineId))?.status === 'pending' && (
                      <span className="void-request-state pending">Pendiente Cocina</span>
                    )}

                    {!item.voided && tableAccountUnpaid && latestVoidRequestByLine.get(String(item.lineId))?.status === 'approved' && (
                      <span className="void-request-state approved">Aprobada · aplicando</span>
                    )}

                    {!item.voided && tableAccountUnpaid && latestVoidRequestByLine.get(String(item.lineId))?.status === 'rejected' && (
                      <span className="void-request-state rejected">Rechazada</span>
                    )}

                    {item.voided && item.voidReason && (
                      <small className="voided-reason">Motivo: {item.voidReason}</small>
                    )}
                  </div>
                </div>
              ))}
              {roundStatus(round) === 'LISTA' && <button className="btn" onClick={() => markRoundDelivered(currentOrder.id, round.id)}>✓ Marcar comanda entregada</button>}
            </div>
          ))}

          {orderMode === 'table' && tableAccountUnpaid && canRequestUnpaidVoid && requestableItems.length > 0 && (
            <button className="btn void-request-main full" onClick={openUnpaidVoidRequest}>
              ⚠ Solicitar anulación de productos a Cocina
            </button>
          )}

          {orderMode === 'table' && tableAccountPartiallyPaid && canVoidPartialAccount && (
            <button className="btn danger-outline full" onClick={openAccountVoid}>
              🔐 Anular cuenta completa con autorización
            </button>
          )}

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
                    <strong className="line-total">{formatMoney(line.price * line.quantity)}</strong>
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="empty-inline">No hay productos nuevos por enviar</div>}

          <div className="order-summary">
            <div className="row plain"><b>Total cuenta</b><strong>{formatMoney(accountTotal)}</strong></div>
            {orderMode === 'table' && tableOrders.length > 0 && (
              <>
                <div className="row plain"><span>Pagado</span><strong>{formatMoney(tableAccountPaid)}</strong></div>
                <div className="row plain"><b>Saldo pendiente</b><strong>{formatMoney(tableAccountBalance)}</strong></div>
                {tableRefundDue > 0.005 && (
                  <div className="row plain refund-due-row"><b>Reembolso pendiente</b><strong>{formatMoney(tableRefundDue)}</strong></div>
                )}
              </>
            )}
          </div>
          {orderMode === 'table' && canCharge && tableOrders.length > 0 && !tableAccountFullyPaid && (
            <button
              className="btn payment-from-order full"
              disabled={tableAccountBalance <= 0.005}
              onClick={openChargeModal}
            >
              💳 Cobrar mesa desde esta pantalla
            </button>
          )}
          {orderMode === 'quick' ? (
            <button className="btn primary full action-main" disabled={!draft.length} onClick={handleQuickPay}>💳 Cobrar y enviar a preparación</button>
          ) : (
            <button className="btn primary full action-main" disabled={!draft.length} onClick={handleSend}>
              {orderMode === 'delivery' ? '🚚 Enviar domicilio a preparación' : 'Enviar nuevos productos'}
            </button>
          )}
          {orderMode === 'quick' && <div className="notice">En servicio rápido el pedido se cobra antes de enviarse a Cocina/Bar.</div>}
          {orderMode === 'delivery' && <div className="notice">El domicilio quedará identificado con los datos del cliente en Cocina/Bar y en el módulo Domicilios.</div>}
        </div>
      </div>

      {showUnpaidVoidRequest && currentOrder && (
        <div className="modal open controlled-void-modal" onClick={() => !unpaidVoidBusy && setShowUnpaidVoidRequest(false)}>
          <div className="modal-card controlled-void-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div>
                <h3>⚠ Solicitar anulación a Cocina</h3>
                <p className="muted">La solicitud no anula nada hasta que Cocina la apruebe.</p>
              </div>
              <button className="btn" disabled={unpaidVoidBusy} onClick={() => setShowUnpaidVoidRequest(false)}>×</button>
            </div>

            <div className="void-request-product-list">
              {requestableItems.map((item) => (
                <label className="void-request-product" key={item.lineId}>
                  <input
                    type="checkbox"
                    checked={Boolean(unpaidVoidSelected[item.lineId])}
                    onChange={() => toggleUnpaidVoidLine(item.lineId)}
                  />
                  <span>
                    <b>{item.quantity} × {item.name}</b>
                    <small>{formatMoney(item.amount)}</small>
                  </span>
                </label>
              ))}
            </div>

            <label className="controlled-void-reason">
              <span>Motivo *</span>
              <textarea
                value={unpaidVoidReason}
                onChange={(event) => setUnpaidVoidReason(event.target.value)}
                placeholder="Explica por qué se solicita la anulación"
              />
            </label>

            <div className="notice">
              Cocina verá la mesa/orden, los productos seleccionados, quién solicita la anulación y el motivo.
            </div>

            <button className="btn primary full" disabled={unpaidVoidBusy} onClick={submitUnpaidVoidRequest}>
              {unpaidVoidBusy ? 'Enviando solicitud…' : 'Enviar solicitud a Cocina'}
            </button>
          </div>
        </div>
      )}

      {showAccountVoid && (
        <div className="modal open controlled-void-modal" onClick={closeAccountVoid}>
          <div className="modal-card controlled-void-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div>
                <h3>🔐 Anular cuenta completa</h3>
                <p className="muted">La cuenta tiene un pago parcial y requiere autorización del administrador.</p>
              </div>
              <button className="btn" disabled={accountVoidBusy} onClick={closeAccountVoid}>×</button>
            </div>

            <div className="account-void-summary">
              <div><span>Total actual</span><strong>{formatMoney(tableAccountTotal)}</strong></div>
              <div><span>Pagado</span><strong>{formatMoney(tableAccountPaid)}</strong></div>
              <div><span>Saldo</span><strong>{formatMoney(tableAccountBalance)}</strong></div>
              <div className="refund"><span>Reembolso si se anula</span><strong>{formatMoney(tableAccountPaid)}</strong></div>
            </div>

            <div className="account-void-products">
              {accountVoidItems.map((item) => (
                <div key={`${item.orderId}:${item.lineId}`}>
                  <span>{item.quantity} × {item.name}</span>
                  <strong>{formatMoney(item.amount)}</strong>
                </div>
              ))}
            </div>

            <label className="controlled-void-reason">
              <span>Motivo de anulación de la cuenta *</span>
              <textarea
                value={accountVoidReason}
                disabled={Boolean(accountVoidRequestId) || accountVoidBusy}
                onChange={(event) => setAccountVoidReason(event.target.value)}
                placeholder="Explica por qué debe anularse la cuenta completa"
              />
            </label>

            {!accountVoidRequestId ? (
              <>
                <div className="notice warn">
                  Se enviará un código de 6 dígitos al Owner / Super Admin. El código autoriza la anulación de la cuenta completa y caduca en 10 minutos.
                </div>
                <button className="btn primary full" disabled={accountVoidBusy} onClick={requestAccountVoidCode}>
                  {accountVoidBusy ? 'Enviando código…' : 'Enviar código al administrador'}
                </button>
              </>
            ) : (
              <>
                <div className="notice">
                  Código enviado.
                  {accountVoidExpiresAt ? ` Válido hasta ${new Date(accountVoidExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : ''}
                </div>

                <label className="void-code-field">
                  <span>Código de autorización</span>
                  <input
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength="6"
                    value={accountVoidCode}
                    onChange={(event) => setAccountVoidCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                  />
                </label>

                <div className="notice warn">
                  Al validar se anularán todos los productos de la cuenta. El importe ya pagado quedará como <b>Reembolso pendiente</b> y el administrador recibirá un correo de confirmación con el detalle.
                </div>

                <button className="btn primary full" disabled={accountVoidBusy || accountVoidCode.length !== 6} onClick={confirmAccountVoidCode}>
                  {accountVoidBusy ? 'Validando…' : 'Validar código y anular cuenta'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {showCharge && (
        <div className="modal open" onClick={() => setShowCharge(false)}>
          <div className="modal-card order-payment-modal" onClick={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div>
                <h3>💳 Cobrar · {accountTableLabel}</h3>
                <p className="muted">Cuenta consolidada de la mesa</p>
              </div>
              <button className="btn" onClick={() => setShowCharge(false)}>×</button>
            </div>

            <div className="order-payment-totals">
              <div><span>Total</span><strong>{formatMoney(tableAccountTotal)}</strong></div>
              <div><span>Pagado</span><strong>{formatMoney(tableAccountPaid)}</strong></div>
              <div className="balance"><span>Saldo</span><strong>{formatMoney(tableAccountBalance)}</strong></div>
            </div>

            {draft.length > 0 && (
              <div className="notice warn">
                Hay productos sin enviar por {formatMoney(draftTotal)}. No están incluidos en este cobro hasta que los envíes a preparación.
              </div>
            )}

            <div className="settings-form">
              <label>
                <span>Importe a cobrar</span>
                <input
                  inputMode="decimal"
                  value={chargeAmount}
                  onChange={(event) => setChargeAmount(event.target.value)}
                />
              </label>

              <label>
                <span>Método de pago</span>
                <select value={chargeMethod} onChange={(event) => setChargeMethod(event.target.value)}>
                  <option value="card">Tarjeta</option>
                  <option value="cash">Efectivo</option>
                </select>
              </label>
            </div>

            <div className="order-payment-shortcuts">
              <button className="btn" onClick={() => setChargeAmount((tableAccountBalance / 2).toFixed(2))}>½ saldo</button>
              <button className="btn" onClick={() => setChargeAmount(tableAccountBalance.toFixed(2))}>Saldo completo</button>
              <button className="btn" onClick={openSplitModal}>✂ Dividir cuenta</button>
            </div>

            <button className="btn primary full" onClick={confirmCharge}>Confirmar cobro</button>
          </div>
        </div>
      )}

      {showSplit && tableOrders.length > 0 && (
        <SplitBillModal
          orders={tableOrders}
          tableText={accountTableLabel}
          onClose={() => setShowSplit(false)}
        />
      )}

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
