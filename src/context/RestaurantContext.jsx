import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { DEMO_PRODUCTS } from '../data/demoProducts.js'
import { createInitialDemoState } from '../data/demoState.js'
import { useAuth } from './AuthContext.jsx'
import {
  createTable as createRemoteTable,
  createZone as createRemoteZone,
  importLocalStructure,
  loadRestaurantStructure,
  updateTable as updateRemoteTable,
  updateZone as updateRemoteZone,
} from '../services/restaurantStructureService.js'
import { loadMenuCatalog } from '../services/menuService.js'

const RestaurantContext = createContext(null)
const STORAGE_KEY = 'restos-plus-demo-state-v3'
const OLD_STORAGE_KEYS = ['restos-plus-demo-state-v2', 'restos-demo']

function cleanName(value) {
  return String(value || '').trim()
}

function sameName(left, right) {
  return cleanName(left).localeCompare(cleanName(right), undefined, { sensitivity: 'accent' }) === 0
}

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
    zones: Array.isArray(raw.zones) ? raw.zones.map((zone, index) => ({
      id: zone.id || makeId(),
      name: cleanName(zone.name),
      displayOrder: zone.displayOrder ?? index,
      active: zone.active !== false,
    })) : initial.zones,
    tables: Array.isArray(raw.tables) ? raw.tables.map((table) => ({
      ...table,
      id: table.id || makeId(),
      name: cleanName(table.name || table.code),
      zoneId: table.zoneId || null,
      capacity: Number(table.capacity || 2),
      active: table.active !== false,
      status: table.status || 'free',
      openedAt: table.openedAt || null,
      releasedAt: table.releasedAt || null,
    })) : initial.tables,
    reservations: Array.isArray(raw.reservations) ? raw.reservations : initial.reservations,
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

function orderHasPendingPreparation(order) {
  return (order.rounds || [])
    .flatMap((round) => round.items || [])
    .filter((item) => !item.voided)
    .some((item) => !['ready', 'delivered'].includes(item.prepStatus))
}

export function RestaurantProvider({ children }) {
  const auth = useAuth()
  const [state, setState] = useState(loadInitialState)
  const initialLocalStructure = useRef({
    zones: state.zones || [],
    tables: state.tables || [],
  })
  const [products, setProducts] = useState(DEMO_PRODUCTS)
  const [menuCategories, setMenuCategories] = useState([])
  const [menuStations, setMenuStations] = useState([])
  const [activeLocation, setActiveLocation] = useState(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState('')
  const [orderMode, setOrderModeState] = useState(state.settings.defaultOrderMode || 'table')
  const [currentTableId, setCurrentTableId] = useState(null)
  const [currentOrderId, setCurrentOrderId] = useState(null)
  const [draft, setDraft] = useState([])
  const [pager, setPager] = useState('')
  const [currentDelivery, setCurrentDelivery] = useState(null)

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

  const restaurantId = auth.userContext?.membership?.restaurant_id || null

  const applyRemoteStructure = useCallback((structure) => {
    setState((previous) => {
      const previousById = new Map((previous.tables || []).map((table) => [table.id, table]))
      const next = {
        ...previous,
        zones: structure.zones,
        tables: structure.tables.map((table) => {
          const existing = previousById.get(table.id)
          return {
            ...table,
            status: existing?.status || 'free',
            openedAt: existing?.openedAt || null,
            releasedAt: existing?.releasedAt || null,
          }
        }),
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const refreshMenu = useCallback(async (locationOverride = null) => {
    if (auth.isDesignMode) {
      setProducts(DEMO_PRODUCTS)
      setMenuCategories([])
      setMenuStations([])
      return { ok: true }
    }

    const location = locationOverride || activeLocation
    if (!restaurantId || !location?.id) {
      setProducts([])
      setMenuCategories([])
      setMenuStations([])
      return { ok: false, message: 'No hay restaurante o sucursal activa.' }
    }

    try {
      const catalog = await loadMenuCatalog(restaurantId, location.id)
      setProducts(catalog.products)
      setMenuCategories(catalog.categories)
      setMenuStations(catalog.stations)
      return { ok: true, catalog }
    } catch (error) {
      setRemoteError(error?.message || 'No se pudo cargar el menú desde Supabase.')
      return { ok: false, message: error?.message || 'No se pudo cargar el menú.' }
    }
  }, [auth.isDesignMode, restaurantId, activeLocation])

  const refreshRemoteData = useCallback(async () => {
    if (auth.isDesignMode) {
      setProducts(DEMO_PRODUCTS)
      setRemoteError('')
      return { ok: true }
    }

    if (auth.mode !== 'authenticated' || !restaurantId) return { ok: false }

    setRemoteLoading(true)
    setRemoteError('')

    try {
      let structure = await loadRestaurantStructure(restaurantId)

      const localZones = initialLocalStructure.current.zones.filter((zone) => zone.active !== false)
      const localTables = initialLocalStructure.current.tables.filter((table) => table.active !== false)

      if (
        structure.location
        && structure.zones.length === 0
        && structure.tables.length === 0
        && localZones.length > 0
      ) {
        await importLocalStructure(structure.location.id, localZones, localTables)
        structure = await loadRestaurantStructure(restaurantId)
      }

      setActiveLocation(structure.location)
      applyRemoteStructure(structure)

      if (structure.location) {
        const catalog = await loadMenuCatalog(restaurantId, structure.location.id)
        setProducts(catalog.products)
        setMenuCategories(catalog.categories)
        setMenuStations(catalog.stations)
      } else {
        setProducts([])
        setMenuCategories([])
        setMenuStations([])
      }

      return { ok: true }
    } catch (error) {
      const message = error?.message || 'No se pudieron cargar los datos operativos desde Supabase.'
      setRemoteError(message)
      return { ok: false, message }
    } finally {
      setRemoteLoading(false)
    }
  }, [auth.isDesignMode, auth.mode, restaurantId, applyRemoteStructure])

  useEffect(() => {
    if (auth.isDesignMode) {
      setProducts(DEMO_PRODUCTS)
      return
    }

    if (auth.mode === 'authenticated' && restaurantId) {
      refreshRemoteData()
    }
  }, [auth.mode, auth.isDesignMode, restaurantId, refreshRemoteData])

  const openOrderForTable = useCallback((tableId, source = state) => source.orders.find((order) => (
    order.mode === 'table'
    && (order.tableIds || []).includes(tableId)
    && !['closed', 'merged', 'cancelled'].includes(order.status)
  )), [state])

  const currentOrder = useMemo(
    () => state.orders.find((order) => order.id === currentOrderId) || null,
    [state.orders, currentOrderId],
  )

  const tableLabel = useCallback((tableId, source = state) => {
    const table = source.tables.find((item) => item.id === tableId)
    if (!table) return 'Mesa eliminada'
    const zone = source.zones.find((item) => item.id === table.zoneId)
    return zone ? `${zone.name} · ${table.name}` : table.name
  }, [state])

  const reservationForTable = useCallback((tableId, source = state) => (
    (source.reservations || []).find((reservation) => (
      reservation.tableId === tableId
      && ['pending', 'confirmed'].includes(reservation.status)
    )) || null
  ), [state])

  const getTableTransferStatus = useCallback((tableId, source = state) => {
    const table = source.tables.find((item) => item.id === tableId)
    if (!table || table.active === false) return 'unavailable'
    if (openOrderForTable(tableId, source)) return 'occupied'
    if (reservationForTable(tableId, source)) return 'reserved'
    return 'free'
  }, [state, openOrderForTable, reservationForTable])

  const getTableVisualStatus = useCallback((tableId, source = state) => {
    const table = source.tables.find((item) => item.id === tableId)
    if (!table || table.active === false) return 'unavailable'
    if (openOrderForTable(tableId, source)) {
      return ['ready', 'pay', 'waiting_food'].includes(table.status) ? table.status : 'occupied'
    }
    if (reservationForTable(tableId, source)) return 'reserved'
    return 'free'
  }, [state, openOrderForTable, reservationForTable])

  const addZone = useCallback(async (name) => {
    const cleaned = cleanName(name)
    if (!cleaned) return { ok: false, message: 'Escribe un nombre para el salón o área.' }

    const duplicate = state.zones.some((zone) => zone.active !== false && sameName(zone.name, cleaned))
    if (duplicate) return { ok: false, message: 'Ya existe un salón o área con ese nombre.' }

    if (auth.isDesignMode || !activeLocation?.id) {
      const zone = { id: makeId(), name: cleaned, displayOrder: state.zones.length, active: true }
      updateState((previous) => ({ ...previous, zones: [...previous.zones, zone] }))
      return { ok: true, zone }
    }

    try {
      const zone = await createRemoteZone(activeLocation.id, cleaned, state.zones.length)
      updateState((previous) => ({ ...previous, zones: [...previous.zones, zone] }))
      return { ok: true, zone }
    } catch (error) {
      return {
        ok: false,
        message: error?.code === '23505'
          ? 'Ya existe un salón o área con ese nombre.'
          : (error?.message || 'No se pudo guardar el área en Supabase.'),
      }
    }
  }, [state.zones, updateState, auth.isDesignMode, activeLocation])

  const updateZone = useCallback(async (zoneId, name) => {
    const cleaned = cleanName(name)
    if (!cleaned) return { ok: false, message: 'El nombre del salón o área no puede quedar vacío.' }

    const duplicate = state.zones.some((zone) => (
      zone.id !== zoneId && zone.active !== false && sameName(zone.name, cleaned)
    ))
    if (duplicate) return { ok: false, message: 'Ya existe un salón o área con ese nombre.' }

    if (auth.isDesignMode || !activeLocation?.id) {
      updateState((previous) => ({
        ...previous,
        zones: previous.zones.map((zone) => zone.id === zoneId ? { ...zone, name: cleaned } : zone),
      }))
      return { ok: true }
    }

    try {
      const zone = await updateRemoteZone(zoneId, { name: cleaned })
      updateState((previous) => ({
        ...previous,
        zones: previous.zones.map((item) => item.id === zoneId ? { ...item, ...zone } : item),
      }))
      return { ok: true, zone }
    } catch (error) {
      return { ok: false, message: error?.message || 'No se pudo actualizar el área.' }
    }
  }, [state.zones, updateState, auth.isDesignMode, activeLocation])

  const deleteZone = useCallback(async (zoneId) => {
    const activeTables = state.tables.filter((table) => table.active !== false && table.zoneId === zoneId)
    if (activeTables.length) {
      return { ok: false, message: 'No puedes eliminar el área mientras tenga mesas activas. Elimina o mueve primero esas mesas.' }
    }

    if (!auth.isDesignMode && activeLocation?.id) {
      try {
        await updateRemoteZone(zoneId, { active: false })
      } catch (error) {
        return { ok: false, message: error?.message || 'No se pudo desactivar el área.' }
      }
    }

    updateState((previous) => ({
      ...previous,
      zones: previous.zones.map((zone) => zone.id === zoneId ? { ...zone, active: false } : zone),
    }))
    return { ok: true }
  }, [state.tables, updateState, auth.isDesignMode, activeLocation])

  const addTable = useCallback(async ({ zoneId, name, capacity = 2 }) => {
    const cleaned = cleanName(name)
    const zone = state.zones.find((item) => item.id === zoneId && item.active !== false)

    if (!zone) return { ok: false, message: 'Selecciona un salón o área válido.' }
    if (!cleaned) return { ok: false, message: 'Escribe el nombre o número de la mesa.' }

    const duplicate = state.tables.some((table) => (
      table.active !== false && table.zoneId === zoneId && sameName(table.name, cleaned)
    ))
    if (duplicate) return { ok: false, message: `Ya existe ${cleaned} dentro de ${zone.name}.` }

    let table
    if (auth.isDesignMode || !activeLocation?.id) {
      table = {
        id: makeId(),
        zoneId,
        name: cleaned,
        capacity: Math.max(1, Number(capacity) || 2),
        active: true,
      }
    } else {
      try {
        table = await createRemoteTable({
          locationId: activeLocation.id,
          zoneId,
          name: cleaned,
          capacity,
        })
      } catch (error) {
        return {
          ok: false,
          message: error?.code === '23505'
            ? `Ya existe ${cleaned} dentro de ${zone.name}.`
            : (error?.message || 'No se pudo guardar la mesa en Supabase.'),
        }
      }
    }

    table = {
      ...table,
      status: 'free',
      openedAt: null,
      releasedAt: Date.now(),
    }

    updateState((previous) => ({ ...previous, tables: [...previous.tables, table] }))
    return { ok: true, table }
  }, [state.zones, state.tables, updateState, auth.isDesignMode, activeLocation])

  const updateTable = useCallback(async (tableId, patch) => {
    const current = state.tables.find((table) => table.id === tableId && table.active !== false)
    if (!current) return { ok: false, message: 'La mesa no existe o está eliminada.' }

    const zoneId = patch.zoneId ?? current.zoneId
    const name = cleanName(patch.name ?? current.name)
    const zone = state.zones.find((item) => item.id === zoneId && item.active !== false)

    if (!zone) return { ok: false, message: 'Selecciona un salón o área válido.' }
    if (!name) return { ok: false, message: 'El nombre de la mesa no puede quedar vacío.' }

    const duplicate = state.tables.some((table) => (
      table.id !== tableId
      && table.active !== false
      && table.zoneId === zoneId
      && sameName(table.name, name)
    ))
    if (duplicate) return { ok: false, message: `Ya existe ${name} dentro de ${zone.name}.` }

    let remotePatch = {
      zoneId,
      name,
      capacity: Math.max(1, Number(patch.capacity ?? current.capacity) || 2),
    }

    if (!auth.isDesignMode && activeLocation?.id) {
      try {
        remotePatch = await updateRemoteTable(tableId, remotePatch)
      } catch (error) {
        return { ok: false, message: error?.message || 'No se pudo actualizar la mesa.' }
      }
    }

    updateState((previous) => ({
      ...previous,
      tables: previous.tables.map((table) => table.id === tableId ? {
        ...table,
        ...remotePatch,
        zoneId,
        name,
        capacity: Math.max(1, Number(patch.capacity ?? table.capacity) || 2),
      } : table),
    }))

    return { ok: true }
  }, [state.tables, state.zones, updateState, auth.isDesignMode, activeLocation])

  const deleteTable = useCallback(async (tableId) => {
    const table = state.tables.find((item) => item.id === tableId && item.active !== false)
    if (!table) return { ok: false, message: 'La mesa no existe o ya fue eliminada.' }
    if (openOrderForTable(tableId)) return { ok: false, message: 'No puedes eliminar una mesa con una cuenta abierta.' }
    if (reservationForTable(tableId)) return { ok: false, message: 'No puedes eliminar una mesa con una reserva activa.' }

    if (!auth.isDesignMode && activeLocation?.id) {
      try {
        await updateRemoteTable(tableId, { active: false })
      } catch (error) {
        return { ok: false, message: error?.message || 'No se pudo desactivar la mesa.' }
      }
    }

    updateState((previous) => ({
      ...previous,
      tables: previous.tables.map((item) => item.id === tableId ? { ...item, active: false, status: 'free' } : item),
    }))

    if (currentTableId === tableId) setCurrentTableId(null)
    return { ok: true }
  }, [
    state.tables, openOrderForTable, reservationForTable, currentTableId, updateState,
    auth.isDesignMode, activeLocation,
  ])

  const setOrderMode = useCallback((mode) => {
    setOrderModeState(mode)
    setDraft([])
    setPager('')
    setCurrentOrderId(null)
    if (mode !== 'table') setCurrentTableId(null)
    if (mode !== 'delivery') setCurrentDelivery(null)
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
    setCurrentDelivery(null)
  }, [state.orders])

  const startDelivery = useCallback((delivery) => {
    const normalized = {
      customerId: delivery?.customerId || null,
      customerName: cleanName(delivery?.customerName),
      address: cleanName(delivery?.address),
      phone: cleanName(delivery?.phone),
      email: cleanName(delivery?.email) || null,
      neighborhood: cleanName(delivery?.neighborhood),
      city: cleanName(delivery?.city),
    }

    if (!normalized.customerName || !normalized.address || !normalized.phone || !normalized.neighborhood || !normalized.city) {
      return { ok: false, message: 'Completa nombre, dirección, celular, barrio y ciudad.' }
    }

    let createdOrderId = null
    updateState((previous) => {
      createdOrderId = previous.nextOrder
      const order = {
        id: createdOrderId,
        mode: 'delivery',
        tableIds: [],
        pager: null,
        delivery: normalized,
        deliveryStatus: 'pending',
        rounds: [],
        status: 'draft',
        created: Date.now(),
        payments: [],
        closedAt: null,
      }

      return {
        ...previous,
        nextOrder: previous.nextOrder + 1,
        orders: [...previous.orders, order],
        activity: [...previous.activity, `Domicilio #${createdOrderId} creado · ${normalized.customerName}`],
      }
    })

    setOrderModeState('delivery')
    setCurrentTableId(null)
    setCurrentOrderId(createdOrderId)
    setDraft([])
    setPager('')
    setCurrentDelivery(normalized)
    return { ok: true, orderId: createdOrderId }
  }, [updateState])

  const openDelivery = useCallback((orderId) => {
    const order = state.orders.find((item) => item.id === orderId && item.mode === 'delivery')
    if (!order) return { ok: false, message: 'El domicilio no existe.' }

    setOrderModeState('delivery')
    setCurrentTableId(null)
    setCurrentOrderId(order.id)
    setDraft([])
    setPager('')
    setCurrentDelivery(order.delivery || null)
    return { ok: true }
  }, [state.orders])

  const startNewOrder = useCallback(() => {
    const free = state.tables.find((table) => table.active !== false && getTableTransferStatus(table.id) === 'free')
    if (free) openTable(free.id)
    else {
      setOrderModeState('table')
      setCurrentTableId(null)
      setCurrentOrderId(null)
      setDraft([])
    }
    return free?.id || null
  }, [state.tables, openTable, getTableTransferStatus])

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
    const existingById = source.orders.find((order) => order.id === currentOrderId)
    if (existingById) return { order: existingById, source }

    const existingByTable = orderMode === 'table' && currentTableId
      ? source.orders.find((order) => (
        order.mode === 'table'
        && (order.tableIds || []).includes(currentTableId)
        && !['closed', 'merged', 'cancelled'].includes(order.status)
      ))
      : null

    if (existingByTable) return { order: existingByTable, source }

    const order = {
      id: source.nextOrder,
      mode: orderMode,
      tableIds: orderMode === 'table' && currentTableId ? [currentTableId] : [],
      pager: orderMode === 'quick' ? (pager.trim() || null) : null,
      delivery: orderMode === 'delivery' ? currentDelivery : null,
      deliveryStatus: orderMode === 'delivery' ? 'pending' : null,
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
          order.tableIds.includes(table.id)
            ? { ...table, status: 'occupied', openedAt: order.created, releasedAt: table.releasedAt || null }
            : table
        )),
      },
    }
  }, [currentOrderId, currentTableId, orderMode, pager, currentDelivery])

  const sendDraft = useCallback(({ prepaid = false, paymentMethod = 'cash' } = {}) => {
    if (!draft.length) return { ok: false, message: 'Añade productos nuevos antes de enviar.' }
    if (orderMode === 'table' && !currentTableId) return { ok: false, message: 'Selecciona una mesa.' }
    if (orderMode === 'delivery' && (!currentDelivery?.customerName || !currentDelivery?.address || !currentDelivery?.phone || !currentDelivery?.neighborhood || !currentDelivery?.city)) {
      return { ok: false, message: 'Faltan datos obligatorios del domicilio.' }
    }
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
        tables: ensured.source.tables.map((table) => (
          updatedOrder.tableIds?.includes(table.id)
            ? { ...table, status: 'occupied', openedAt: table.openedAt || updatedOrder.created || Date.now() }
            : table
        )),
        sales: ensured.source.sales + salesIncrease,
        activity: [
          ...ensured.source.activity,
          `Comanda ${newRound.id} · Orden #${order.id}${order.tableIds?.length ? ` · Mesa ${order.tableIds.join(' + ')}` : order.mode === 'delivery' ? ` · Domicilio ${order.delivery?.customerName || ''}` : ''}${prepaid ? ' · cobrada' : ''}`,
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
        nextOrders = nextOrders.map((order) => {
          if (order.id !== orderId) return order

          if (order.status === 'waiting_food' && orderBalance(order) <= 0.005) {
            return {
              ...order,
              status: 'closed',
              closedAt: Date.now(),
            }
          }

          return {
            ...order,
            status: order.status === 'closed' ? 'closed' : (orderBalance(order) <= 0.005 ? 'ready' : 'pay'),
          }
        })
      }

      const refreshed = nextOrders.find((order) => order.id === orderId)
      const tables = previous.tables.map((table) => {
        if (!refreshed?.tableIds?.includes(table.id)) return table

        if (allPrepared && refreshed.status === 'closed') {
          return { ...table, status: 'free', releasedAt: Date.now() }
        }

        if (allPrepared) {
          return { ...table, status: orderBalance(refreshed) <= 0.005 ? 'ready' : 'pay' }
        }

        if (refreshed.status === 'waiting_food') {
          return { ...table, status: 'waiting_food' }
        }

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
    const destination = String(destinationId || '')
    if (!currentTableId || !destination || destination === currentTableId) {
      return { ok: false, message: 'Selecciona una mesa destino válida.' }
    }
    const destinationTable = state.tables.find((table) => table.id === destination && table.active !== false)
    if (!destinationTable) return { ok: false, message: 'La mesa destino no existe o está desactivada.' }

    const destinationStatus = getTableTransferStatus(destination)
    if (destinationStatus === 'occupied') {
      return { ok: false, message: 'La mesa destino está ocupada y no puede seleccionarse.' }
    }
    if (destinationStatus === 'unavailable') {
      return { ok: false, message: 'La mesa destino no está disponible.' }
    }

    const fromLabel = tableLabel(currentTableId)
    const toLabel = tableLabel(destination)

    updateState((previous) => ({
      ...previous,
      orders: previous.orders.map((order) => order.id !== currentOrderId ? order : {
        ...order,
        tableIds: (order.tableIds || []).map((id) => id === currentTableId ? destination : id),
      }),
      tables: previous.tables.map((table) => {
        if (table.id === currentTableId) return { ...table, status: 'free', releasedAt: Date.now() }
        if (table.id === destination && currentOrderId) return { ...table, status: 'occupied', openedAt: Date.now() }
        return table
      }),
      activity: [...previous.activity, `Cuenta movida de ${fromLabel} a ${toLabel}`],
    }))
    setCurrentTableId(destination)
    return { ok: true, reserved: destinationStatus === 'reserved' }
  }, [currentTableId, currentOrderId, state.tables, getTableTransferStatus, tableLabel, updateState])

  const joinTable = useCallback((destinationId) => {
    const destination = String(destinationId || '')
    const order = state.orders.find((item) => item.id === currentOrderId)
    if (!order || !destination) return { ok: false, message: 'Abre primero una cuenta de mesa.' }
    if (order.tableIds.includes(destination)) return { ok: false, message: 'Esa mesa ya forma parte de la cuenta.' }

    const status = getTableTransferStatus(destination)
    if (status === 'occupied') {
      return { ok: false, message: 'La mesa destino ya tiene otra cuenta abierta.' }
    }
    if (status === 'unavailable') return { ok: false, message: 'La mesa destino no está disponible.' }

    updateState((previous) => ({
      ...previous,
      orders: previous.orders.map((candidate) => candidate.id === order.id ? {
        ...candidate,
        tableIds: [...candidate.tableIds, destination],
      } : candidate),
      tables: previous.tables.map((table) => (
        table.id === destination ? { ...table, status: 'occupied', openedAt: Date.now() } : table
      )),
      activity: [...previous.activity, `${tableLabel(destination)} unida a Orden #${order.id}`],
    }))
    return { ok: true, reserved: status === 'reserved' }
  }, [state.orders, currentOrderId, getTableTransferStatus, tableLabel, updateState])

  const recordPayments = useCallback((allocations, method = 'card') => {
    const normalized = (Array.isArray(allocations) ? allocations : [])
      .map((allocation) => ({
        orderId: allocation.orderId,
        amount: Number(allocation.amount || 0),
        itemAllocations: Array.isArray(allocation.itemAllocations) ? allocation.itemAllocations : [],
      }))
      .filter((allocation) => allocation.orderId != null && allocation.amount > 0)

    if (!normalized.length) return { ok: false, message: 'No hay importes válidos para cobrar.' }
    if (!['cash', 'card'].includes(method)) return { ok: false, message: 'Método de pago inválido.' }

    const requestedByOrder = new Map(normalized.map((allocation) => [allocation.orderId, allocation]))
    let expectedApplied = 0

    for (const allocation of normalized) {
      const order = state.orders.find((candidate) => candidate.id === allocation.orderId)
      if (!order) continue
      expectedApplied += Math.min(orderBalance(order), allocation.amount)
    }

    if (expectedApplied <= 0.005) return { ok: false, message: 'La cuenta ya está pagada.' }

    updateState((previous) => {
      let appliedTotal = 0
      const affectedTableIds = new Set()

      const orders = previous.orders.map((order) => {
        const allocation = requestedByOrder.get(order.id)
        if (!allocation) return order

        const balanceBefore = orderBalance(order)
        const applied = Math.min(balanceBefore, allocation.amount)
        if (applied <= 0.005) return order

        appliedTotal += applied
        ;(order.tableIds || []).forEach((tableId) => affectedTableIds.add(tableId))

        const payments = [...(order.payments || []), {
          id: makeId(),
          amount: applied,
          method,
          created: Date.now(),
          type: 'payment',
          itemAllocations: allocation.itemAllocations,
        }]

        const totalPaid = payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
        const paidInFull = totalPaid + 0.005 >= orderTotal(order)
        const waitingForFood = paidInFull && orderHasPendingPreparation(order)

        return {
          ...order,
          payments,
          status: paidInFull ? (waitingForFood ? 'waiting_food' : 'closed') : order.status,
          closedAt: paidInFull && !waitingForFood ? Date.now() : order.closedAt,
        }
      })

      const tables = previous.tables.map((table) => {
        if (!affectedTableIds.has(table.id)) return table

        const activeOrders = orders.filter((order) => (
          order.mode === 'table'
          && (order.tableIds || []).includes(table.id)
          && !['closed', 'merged', 'cancelled'].includes(order.status)
        ))

        if (!activeOrders.length) {
          return { ...table, status: 'free', releasedAt: Date.now() }
        }

        const hasBalance = activeOrders.some((order) => orderBalance(order) > 0.005)
        const hasPendingFood = activeOrders.some((order) => orderHasPendingPreparation(order))

        if (!hasBalance && hasPendingFood) {
          return { ...table, status: 'waiting_food' }
        }

        if (hasBalance && !hasPendingFood) {
          return { ...table, status: 'pay' }
        }

        return { ...table, status: 'occupied' }
      })

      return {
        ...previous,
        orders,
        tables,
        sales: previous.sales + appliedTotal,
        activity: [
          ...previous.activity,
          `Cobro registrado · €${appliedTotal.toFixed(2)} · ${normalized.length} cuenta${normalized.length === 1 ? '' : 's'} interna${normalized.length === 1 ? '' : 's'}`,
        ],
      }
    })

    return { ok: true, applied: expectedApplied }
  }, [state.orders, updateState])

  const recordPayment = useCallback((orderId, amount, method = 'card') => (
    recordPayments([{ orderId, amount }], method)
  ), [recordPayments])

  const updateSettings = useCallback((patch) => {
    updateState((previous) => ({ ...previous, settings: { ...previous.settings, ...patch } }))
  }, [updateState])

  const resetDemo = useCallback(() => {
    const fresh = createInitialDemoState()
    OLD_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key))
    persist(fresh)
    setOrderModeState(fresh.settings.defaultOrderMode)
    setCurrentTableId(null)
    setCurrentOrderId(null)
    setDraft([])
    setPager('')
    setCurrentDelivery(null)
    if (auth.isDesignMode) {
      setProducts(DEMO_PRODUCTS)
      setMenuCategories([])
      setMenuStations([])
    }
  }, [persist, auth.isDesignMode])

  const stationJobs = useCallback((station) => {
    const jobs = []
    state.orders.forEach((order) => {
      order.rounds?.forEach((round) => {
        const items = round.items.filter((item) => !item.voided && item.station === station && !['ready', 'delivered'].includes(item.prepStatus))
        if (items.length) jobs.push({ order, round, items, status: deriveRoundStatus(round, station) })
      })
    })

    return jobs.sort((left, right) => {
      const leftArrival = Number(left.round?.created || left.order?.created || 0)
      const rightArrival = Number(right.round?.created || right.order?.created || 0)

      if (leftArrival !== rightArrival) return leftArrival - rightArrival
      if (Number(left.order?.id || 0) !== Number(right.order?.id || 0)) {
        return Number(left.order?.id || 0) - Number(right.order?.id || 0)
      }
      return Number(left.round?.id || 0) - Number(right.round?.id || 0)
    })
  }, [state.orders])

  const value = useMemo(() => ({
    state,
    products,
    menuCategories,
    menuStations,
    activeLocation,
    remoteLoading,
    remoteError,
    refreshMenu,
    refreshRemoteData,
    orderMode,
    currentTableId,
    currentOrderId,
    currentOrder,
    currentDelivery,
    draft,
    pager,
    setPager,
    setOrderMode,
    openTable,
    startDelivery,
    openDelivery,
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
    tableLabel,
    getTableTransferStatus,
    getTableVisualStatus,
    addZone,
    updateZone,
    deleteZone,
    addTable,
    updateTable,
    deleteTable,
    recordPayment,
    recordPayments,
    updateSettings,
    resetDemo,
    stationJobs,
    openOrderForTable,
    orderTotal,
    orderPaidTotal,
    orderBalance,
  }), [
    state, products, menuCategories, menuStations, activeLocation, remoteLoading, remoteError,
    refreshMenu, refreshRemoteData, orderMode, currentTableId, currentOrderId, currentOrder, currentDelivery, draft, pager,
    setOrderMode, openTable, startDelivery, openDelivery, startNewOrder, addProduct, changeDraftQuantity, removeDraft,
    updateDraftNote, sendDraft, voidSentItem, advanceStationRound, markRoundDelivered,
    transferCurrentTable, joinTable, tableLabel, getTableTransferStatus, getTableVisualStatus,
    addZone, updateZone, deleteZone, addTable, updateTable, deleteTable,
    recordPayment, recordPayments, updateSettings, resetDemo, stationJobs, openOrderForTable,
  ])

  return <RestaurantContext.Provider value={value}>{children}</RestaurantContext.Provider>
}

export function useRestaurant() {
  const context = useContext(RestaurantContext)
  if (!context) throw new Error('useRestaurant must be used inside RestaurantProvider')
  return context
}
