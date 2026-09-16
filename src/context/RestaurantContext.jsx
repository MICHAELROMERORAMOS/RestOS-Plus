import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { DEMO_PRODUCTS } from '../data/demoProducts.js'
import { createInitialDemoState } from '../data/demoState.js'

const RestaurantContext = createContext(null)
const STORAGE_KEY = 'restos-plus-demo-state-v2'
const LEGACY_STORAGE_KEY = 'restos-demo'

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function normalizeStoredState(raw) {
  if (!raw) return createInitialDemoState()
  const initial = createInitialDemoState()
  return {
    ...initial,
    ...raw,
    tables: Array.isArray(raw.tables) && raw.tables.length ? raw.tables : initial.tables,
    orders: (raw.orders || []).map((order) => ({
      ...order,
      tableIds: order.tableIds || (order.table ? [order.table] : []),
      payments: order.payments || (order.paid ? [{ id: makeId(), amount: order.total || 0, method: order.payment || 'legacy', created: order.created || Date.now() }] : []),
      rounds: (order.rounds || []).map((round, roundIndex) => ({
        ...round,
        id: round.id ?? roundIndex + 1,
        items: (round.items || []).map((item) => ({
          ...item,
          name: item.name || item.n,
          price: item.price ?? item.p ?? 0,
          quantity: item.quantity ?? item.q ?? 1,
          station: item.station || item.d || 'kitchen',
          prepStatus: item.prepStatus || (round.status === 'preparing' ? 'preparing' : round.status === 'ready' ? 'ready' : 'new'),
          lineId: item.lineId || makeId(),
          voided: Boolean(item.voided),
        })),
      })),
    })),
    settings: { ...initial.settings, ...(raw.settings || {}) },
  }
}

function loadInitialState() {
  try {
    const current = localStorage.getItem(STORAGE_KEY)
    if (current) return normalizeStoredState(JSON.parse(current))
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (legacy) return normalizeStoredState(JSON.parse(legacy))
  } catch {
    // Corrupted demo data should never prevent the app from starting.
  }
  return createInitialDemoState()
}

export function orderTotal(order) {
  return (order.rounds || [])
    .flatMap((round) => round.items || [])
    .filter((item) => !item.voided)
    .reduce((sum, item) => sum + item.price * item.quantity, 0)
}

export function orderPaidTotal(order) {
  return (order.payments || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
}

export function orderBalance(order) {
  return Math.max(0, orderTotal(order) - orderPaidTotal(order))
}

function deriveRoundStatus(round, station = null) {
  const items = (round.items || []).filter((item) => !item.voided && (!station || item.station === station))
  if (!items.length) return 'empty'
  if (items.every((item) => item.prepStatus === 'delivered')) return 'delivered'
  if (items.every((item) => ['ready', 'delivered'].includes(item.prepStatus))) return 'ready'
  if (items.some((item) => item.prepStatus === 'preparing')) return 'preparing'
  return 'new'
}

export function RestaurantProvider({ children }) {
  const [state, setState] = useState(loadInitialState)
  const [orderMode, setOrderModeState] = useState(state.settings.defaultOrderMode || 'table')
  const [currentTableId, setCurrentTableId] = useState(null)
  const [currentOrderId, setCurrentOrderId] = useState(null)
  const [draft, setDraft] = useState([])
  const [pager, setPager] = useState('')

  const persist = useCallback((next) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    setState(next)
  }, [])

  const updateState = useCallback((recipe) => {
    setState((previous) => {
      const next = typeof recipe === 'function' ? recipe(previous) : recipe
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const openOrderForTable = useCallback((tableId, source = state) => source.orders.find((order) => (
    order.mode === 'table'
    && (order.tableIds || []).includes(tableId)
    && !['closed', 'merged', 'cancelled'].includes(order.status)
  )), [state])

  const currentOrder = useMemo(
    () => state.orders.find((order) => order.id === currentOrderId) || null,
    [state.orders, currentOrderId],
  )

  const setOrderMode = useCallback((mode) => {
    setOrderModeState(mode)
    setDraft([])
    setPager('')
    setCurrentOrderId(null)
    if (mode === 'quick') setCurrentTableId(null)
  }, [])

  const openTable = useCallback((tableId) => {
    const existing = state.orders.find((order) => (
      order.mode === 'table'
      && (order.tableIds || []).includes(tableId)
      && !['closed', 'merged', 'cancelled'].includes(order.status)
    ))
    setOrderModeState('table')
    setCurrentTableId(tableId)
    setCurrentOrderId(existing?.id || null)
    setDraft([])
    setPager('')
  }, [state.orders])

  const startNewOrder = useCallback(() => {
    const free = state.tables.find((table) => table.status === 'free')
    if (free) openTable(free.id)
    else {
      setOrderModeState('table')
      setCurrentTableId(null)
      setCurrentOrderId(null)
      setDraft([])
    }
    return free?.id || null
  }, [state.tables, openTable])

  const addProduct = useCallback((product) => {
    if (!product?.available) return
    setDraft((lines) => {
      const index = lines.findIndex((line) => line.productId === product.id && !line.note)
      if (index >= 0) {
        return lines.map((line, lineIndex) => lineIndex === index ? { ...line, quantity: line.quantity + 1 } : line)
      }
      return [...lines, {
        draftId: makeId(),
        productId: product.id,
        name: product.name,
        price: product.price,
        station: product.station,
        category: product.category,
        quantity: 1,
        note: '',
      }]
    })
  }, [])

  const changeDraftQuantity = useCallback((draftId, delta) => {
    setDraft((lines) => lines
      .map((line) => line.draftId === draftId ? { ...line, quantity: line.quantity + delta } : line)
      .filter((line) => line.quantity > 0))
  }, [])

  const removeDraft = useCallback((draftId) => {
    setDraft((lines) => lines.filter((line) => line.draftId !== draftId))
  }, [])

  const updateDraftNote = useCallback((draftId, note) => {
    setDraft((lines) => lines.map((line) => line.draftId === draftId ? { ...line, note: note.trim() } : line))
  }, [])

  const ensureOrder = useCallback((source, { prepaid = false } = {}) => {
    const existing = source.orders.find((order) => order.id === currentOrderId)
    if (existing) return { order: existing, source }

    const order = {
      id: source.nextOrder,
      mode: orderMode,
      tableIds: orderMode === 'table' && currentTableId ? [currentTableId] : [],
      pager: orderMode === 'quick' ? (pager.trim() || null) : null,
      rounds: [],
      status: prepaid ? 'preparing' : 'open',
      created: Date.now(),
      payments: [],
      closedAt: null,
    }

    return {
      order,
      source: {
        ...source,
        nextOrder: source.nextOrder + 1,
        orders: [...source.orders, order],
        tables: source.tables.map((table) => (
          order.tableIds.includes(table.id) ? { ...table, status: 'occupied' } : table
        )),
      },
    }
  }, [currentOrderId, currentTableId, orderMode, pager])

  const sendDraft = useCallback(({ prepaid = false, paymentMethod = 'cash' } = {}) => {
    if (!draft.length) return { ok: false, message: 'Añade productos nuevos antes de enviar.' }
    if (orderMode === 'table' && !currentTableId) return { ok: false, message: 'Selecciona una mesa.' }
    if (orderMode === 'quick' && !prepaid) return { ok: false, message: 'El servicio rápido debe cobrarse antes de enviar a preparación.' }

    let createdOrderId = currentOrderId
    updateState((previous) => {
      const ensured = ensureOrder(previous, { prepaid })
      const order = ensured.order
      createdOrderId = order.id
      const newRound = {
        id: (order.rounds?.length || 0) + 1,
        created: Date.now(),
        items: draft.map((line) => ({
          lineId: makeId(),
          productId: line.productId,
          name: line.name,
          price: line.price,
          station: line.station,
          category: line.category,
          quantity: line.quantity,
          note: line.note,
          prepStatus: 'new',
          voided: false,
        })),
      }
      const subtotal = draft.reduce((sum, line) => sum + line.price * line.quantity, 0)
      let updatedOrder = {
        ...order,
        rounds: [...(order.rounds || []), newRound],
        status: prepaid ? 'preparing' : 'open',
      }
      let salesIncrease = 0
      if (prepaid) {
        updatedOrder = {
          ...updatedOrder,
          payments: [...(updatedOrder.payments || []), {
            id: makeId(), amount: subtotal, method: paymentMethod, created: Date.now(), type: 'payment',
          }],
        }
        salesIncrease = subtotal
      }
      return {
        ...ensured.source,
        orders: ensured.source.orders.map((candidate) => candidate.id === order.id ? updatedOrder : candidate),
        tables: ensured.source.tables.map((table) => (updatedOrder.tableIds?.includes(table.id) ? { ...table, status: 'occupied' } : table)),
        sales: ensured.source.sales + salesIncrease,
        activity: [
          ...ensured.source.activity,
          `Comanda ${newRound.id} · Orden #${order.id}${order.tableIds?.length ? ` · Mesa ${order.tableIds.join(' + ')}` : ''}${prepaid ? ' · cobrada' : ''}`,
        ],
      }
    })
    setCurrentOrderId(createdOrderId)
    setDraft([])
    return { ok: true, orderId: createdOrderId }
  }, [draft, orderMode, currentTableId, currentOrderId, updateState, ensureOrder])

  const voidSentItem = useCallback((orderId, roundId, lineId) => {
    updateState((previous) => ({
      ...previous,
      orders: previous.orders.map((order) => {
        if (order.id !== orderId) return order
        const target = order.rounds.flatMap((round) => round.items).find((item) => item.lineId === lineId)
        return {
          ...order,
          rounds: order.rounds.map((round) => round.id !== roundId ? round : {
            ...round,
            items: round.items.map((item) => item.lineId === lineId ? { ...item, voided: true, voidedAt: Date.now() } : item),
          }),
          lastEvent: target ? `Anulado: ${target.name}` : order.lastEvent,
        }
      }),
      activity: [...previous.activity, `Producto anulado · Orden #${orderId}`],
    }))
  }, [updateState])

  const advanceStationRound = useCallback((orderId, roundId, station) => {
    updateState((previous) => {
      let nextOrders = previous.orders.map((order) => {
        if (order.id !== orderId) return order
        return {
          ...order,
          rounds: order.rounds.map((round) => {
            if (round.id !== roundId) return round
            const relevant = round.items.filter((item) => !item.voided && item.station === station)
            const stationStatus = deriveRoundStatus(round, station)
            const nextStatus = stationStatus === 'new' ? 'preparing' : 'ready'
            if (!relevant.length || stationStatus === 'ready' || stationStatus === 'delivered') return round
            return {
              ...round,
              items: round.items.map((item) => (
                !item.voided && item.station === station ? { ...item, prepStatus: nextStatus } : item
              )),
            }
          }),
        }
      })

      const changedOrder = nextOrders.find((order) => order.id === orderId)
      const allPrepared = changedOrder.rounds
        .flatMap((round) => round.items)
        .filter((item) => !item.voided)
        .every((item) => ['ready', 'delivered'].includes(item.prepStatus))

      if (allPrepared) {
        nextOrders = nextOrders.map((order) => order.id === orderId ? {
          ...order,
          status: order.status === 'closed' ? 'closed' : (orderBalance(order) <= 0.005 ? 'ready' : 'pay'),
        } : order)
      }

      const refreshed = nextOrders.find((order) => order.id === orderId)
      const tables = previous.tables.map((table) => {
        if (!refreshed?.tableIds?.includes(table.id)) return table
        if (allPrepared) return { ...table, status: orderBalance(refreshed) <= 0.005 ? 'ready' : 'pay' }
        return { ...table, status: 'occupied' }
      })

      return {
        ...previous,
        orders: nextOrders,
        tables,
        activity: allPrepared
          ? [...previous.activity, `Orden #${orderId} lista para entregar / cobrar`]
          : previous.activity,
      }
    })
  }, [updateState])

  const markRoundDelivered = useCallback((orderId, roundId) => {
    updateState((previous) => ({
      ...previous,
      orders: previous.orders.map((order) => order.id !== orderId ? order : {
        ...order,
        rounds: order.rounds.map((round) => round.id !== roundId ? round : {
          ...round,
          items: round.items.map((item) => (!item.voided && item.prepStatus === 'ready') ? { ...item, prepStatus: 'delivered' } : item),
        }),
      }),
      activity: [...previous.activity, `Comanda ${roundId} entregada · Orden #${orderId}`],
    }))
  }, [updateState])

  const transferCurrentTable = useCallback((destinationId) => {
    const destination = Number(destinationId)
    if (!currentTableId || !destination || destination === currentTableId) return { ok: false, message: 'Selecciona una mesa destino válida.' }
    const destinationTable = state.tables.find((table) => table.id === destination)
    if (!destinationTable) return { ok: false, message: 'La mesa destino no existe.' }
    if (openOrderForTable(destination)) return { ok: false, message: 'La mesa destino ya tiene una cuenta abierta.' }

    updateState((previous) => ({
      ...previous,
      orders: previous.orders.map((order) => order.id !== currentOrderId ? order : {
        ...order,
        tableIds: (order.tableIds || []).map((id) => id === currentTableId ? destination : id),
      }),
      tables: previous.tables.map((table) => {
        if (table.id === currentTableId) return { ...table, status: 'free' }
        if (table.id === destination && currentOrderId) return { ...table, status: 'occupied' }
        return table
      }),
      activity: [...previous.activity, `Cuenta movida de Mesa ${currentTableId} a Mesa ${destination}`],
    }))
    setCurrentTableId(destination)
    return { ok: true }
  }, [currentTableId, currentOrderId, state.tables, openOrderForTable, updateState])

  const joinTable = useCallback((destinationId) => {
    const destination = Number(destinationId)
    const order = state.orders.find((item) => item.id === currentOrderId)
    if (!order || !destination) return { ok: false, message: 'Abre primero una cuenta de mesa.' }
    if (order.tableIds.includes(destination)) return { ok: false, message: 'Esa mesa ya forma parte de la cuenta.' }
    const existing = openOrderForTable(destination)
    if (existing && existing.id !== order.id) return { ok: false, message: 'La mesa destino ya tiene otra cuenta. La fusión de dos cuentas completas se añadirá en Caja.' }

    updateState((previous) => ({
      ...previous,
      orders: previous.orders.map((candidate) => candidate.id === order.id ? {
        ...candidate,
        tableIds: [...candidate.tableIds, destination],
      } : candidate),
      tables: previous.tables.map((table) => table.id === destination ? { ...table, status: 'occupied' } : table),
      activity: [...previous.activity, `Mesa ${destination} unida a Orden #${order.id}`],
    }))
    return { ok: true }
  }, [state.orders, currentOrderId, openOrderForTable, updateState])

  const recordPayment = useCallback((orderId, amount, method = 'card') => {
    const numericAmount = Number(amount)
    const target = state.orders.find((order) => order.id === orderId)
    if (!target || numericAmount <= 0) return { ok: false, message: 'Importe inválido.' }
    const balanceBefore = orderBalance(target)
    const applied = Math.min(balanceBefore, numericAmount)
    if (applied <= 0) return { ok: false, message: 'La cuenta ya está pagada.' }

    updateState((previous) => {
      const orders = previous.orders.map((order) => {
        if (order.id !== orderId) return order
        const payments = [...(order.payments || []), { id: makeId(), amount: applied, method, created: Date.now(), type: 'payment' }]
        const totalPaid = payments.reduce((sum, payment) => sum + payment.amount, 0)
        const paidInFull = totalPaid + 0.005 >= orderTotal(order)
        return {
          ...order,
          payments,
          status: paidInFull ? 'closed' : order.status,
          closedAt: paidInFull ? Date.now() : order.closedAt,
        }
      })
      const refreshed = orders.find((order) => order.id === orderId)
      const closed = refreshed?.status === 'closed'
      return {
        ...previous,
        orders,
        sales: previous.sales + applied,
        tables: previous.tables.map((table) => (
          closed && refreshed.tableIds?.includes(table.id) ? { ...table, status: 'free' } : table
        )),
        activity: [...previous.activity, `${closed ? 'Cuenta cerrada' : 'Pago parcial'} · Orden #${orderId} · €${applied.toFixed(2)}`],
      }
    })
    return { ok: true, applied }
  }, [state.orders, updateState])

  const updateSettings = useCallback((patch) => {
    updateState((previous) => ({ ...previous, settings: { ...previous.settings, ...patch } }))
  }, [updateState])

  const resetDemo = useCallback(() => {
    const fresh = createInitialDemoState()
    localStorage.removeItem(LEGACY_STORAGE_KEY)
    persist(fresh)
    setOrderModeState(fresh.settings.defaultOrderMode)
    setCurrentTableId(null)
    setCurrentOrderId(null)
    setDraft([])
    setPager('')
  }, [persist])

  const stationJobs = useCallback((station) => {
    const jobs = []
    state.orders.forEach((order) => {
      order.rounds?.forEach((round) => {
        const items = round.items.filter((item) => !item.voided && item.station === station && !['ready', 'delivered'].includes(item.prepStatus))
        if (items.length) jobs.push({ order, round, items, status: deriveRoundStatus(round, station) })
      })
    })
    return jobs
  }, [state.orders])

  const value = useMemo(() => ({
    state,
    products: DEMO_PRODUCTS,
    orderMode,
    currentTableId,
    currentOrderId,
    currentOrder,
    draft,
    pager,
    setPager,
    setOrderMode,
    openTable,
    startNewOrder,
    addProduct,
    changeDraftQuantity,
    removeDraft,
    updateDraftNote,
    sendDraft,
    voidSentItem,
    advanceStationRound,
    markRoundDelivered,
    transferCurrentTable,
    joinTable,
    recordPayment,
    updateSettings,
    resetDemo,
    stationJobs,
    openOrderForTable,
    orderTotal,
    orderPaidTotal,
    orderBalance,
  }), [
    state, orderMode, currentTableId, currentOrderId, currentOrder, draft, pager,
    setOrderMode, openTable, startNewOrder, addProduct, changeDraftQuantity, removeDraft,
    updateDraftNote, sendDraft, voidSentItem, advanceStationRound, markRoundDelivered,
    transferCurrentTable, joinTable, recordPayment, updateSettings, resetDemo, stationJobs, openOrderForTable,
  ])

  return <RestaurantContext.Provider value={value}>{children}</RestaurantContext.Provider>
}

export function useRestaurant() {
  const context = useContext(RestaurantContext)
  if (!context) throw new Error('useRestaurant must be used inside RestaurantProvider')
  return context
}
