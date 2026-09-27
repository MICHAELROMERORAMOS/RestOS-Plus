import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { DEMO_PRODUCTS } from '../data/demoProducts.js'
import { createInitialDemoState } from '../data/demoState.js'
import { useAuth } from './AuthContext.jsx'
import {
  createTable as createRemoteTable,
  createZone as createRemoteZone,
  loadRestaurantStructure,
  updateTable as updateRemoteTable,
  updateZone as updateRemoteZone,
} from '../services/restaurantStructureService.js'
import { loadMenuCatalog } from '../services/menuService.js'
import { loadProductInventoryAvailability } from '../services/inventoryService.js'
import { formatMoneyValue } from '../lib/currency.js'
import {
  loadRestaurantSettings,
  saveInventoryStockControl,
  saveOperationalBehaviorSettings,
  saveRestaurantCurrency,
} from '../services/settingsService.js'
import {
  advanceStationRoundRemote,
  claimTableOrderSession as claimTableOrderSessionRemote,
  createDeliveryOrderRemote,
  createQuickOrderRemote,
  isOperationalOrder,
  joinOrderTableRemote,
  loadOperationalOrdersByIds,
  loadOperationalState,
  loadOperationalSummary,
  loadTableOrderSessions,
  markRoundServedRemote,
  recordOrderPaymentsRemote,
  releaseEmptyQuickOrderRemote,
  releaseTableOrderSession as releaseTableOrderSessionRemote,
  sendOrderRoundRemote,
  subscribeOperationalChanges,
  touchTableOrderSession as touchTableOrderSessionRemote,
  transferOrderTableRemote,
  updateQuickOrderIdentityRemote,
  unsubscribeOperationalChanges,
} from '../services/operationalService.js'

const RestaurantContext = createContext(null)
const STORAGE_KEY = 'restos-plus-demo-state-v3'
const OLD_STORAGE_KEYS = ['restos-plus-demo-state-v2', 'restos-demo']
const TABLE_DRAFT_STORAGE_PREFIX = 'restos-plus-table-drafts-v1'
const ACTIVE_LOCATION_STORAGE_PREFIX = 'restos-plus-active-location-v1'
const TABLE_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000

function loadStoredTableDrafts(storageKey) {
  if (!storageKey) return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}')
    const now = Date.now()
    const next = {}

    Object.entries(parsed || {}).forEach(([tableId, entry]) => {
      const updatedAt = Number(entry?.updatedAt || 0)
      const items = Array.isArray(entry?.items) ? entry.items : []
      if (!items.length) return
      if (!updatedAt || now - updatedAt > TABLE_DRAFT_MAX_AGE_MS) return
      next[tableId] = { items, updatedAt }
    })

    localStorage.setItem(storageKey, JSON.stringify(next))
    return next
  } catch {
    localStorage.removeItem(storageKey)
    return {}
  }
}

function storeTableDrafts(storageKey, drafts) {
  if (!storageKey) return
  try {
    localStorage.setItem(storageKey, JSON.stringify(drafts || {}))
  } catch {
    // A local draft must never break order taking if browser storage is unavailable.
  }
}

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

function paymentErrorMessage(error) {
  const message = String(error?.message || '')

  if (message.includes('Customer document or phone is already assigned')) {
    return 'El documento o el celular ya pertenece a otro cliente. Verifica los datos antes de cobrar.'
  }
  if (message.includes('Customer does not belong to this restaurant')) {
    return 'El cliente seleccionado no pertenece a este restaurante. Búscalo nuevamente por celular.'
  }
  if (message.includes('Not allowed to register payment')) {
    return 'Tu usuario no tiene permiso para registrar este cobro.'
  }

  return message || 'No se pudo registrar el pago en Supabase.'
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
  if (order?.serverTotal != null && Number.isFinite(Number(order.serverTotal))) {
    return Number(order.serverTotal)
  }

  return (order.rounds || [])
    .flatMap((round) => round.items || [])
    .filter((item) => !item.voided)
    .reduce((sum, item) => sum + item.price * item.quantity, 0)
}

export function orderPaidTotal(order) {
  if (order?.paidTotal != null && Number.isFinite(Number(order.paidTotal))) {
    return Number(order.paidTotal)
  }
  return (order.payments || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
}

export function orderBalance(order) {
  return Math.max(0, orderTotal(order) - orderPaidTotal(order))
}

export function orderHasInvoice(order) {
  return Boolean(order?.invoiceIssuedAt || order?.invoiceNumber || order?.invoiceId)
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

function syncOperationalTableStatuses(tables, orders) {
  const now = Date.now()

  return (tables || []).map((table) => {
    const related = (orders || [])
      .filter((order) => order.mode === 'table' && (order.tableIds || []).includes(table.id))
      .slice()
      .sort((a, b) => (b.created || 0) - (a.created || 0))

    const open = related.find((order) => !['closed', 'cancelled', 'merged'].includes(order.status))

    if (open) {
      const status = ['pay', 'waiting_food', 'refund_due', 'ready'].includes(open.status)
        ? open.status
        : 'occupied'

      return {
        ...table,
        status,
        openedAt: open.created || table.openedAt || now,
        releasedAt: table.releasedAt || null,
      }
    }

    const lastClosed = related.find((order) => ['closed', 'cancelled'].includes(order.status))
    return {
      ...table,
      status: 'free',
      openedAt: null,
      releasedAt: lastClosed?.closedAt || table.releasedAt || null,
    }
  })
}

function orderIdFromRealtimePayload(payload) {
  const row = payload?.new && Object.keys(payload.new).length ? payload.new : payload?.old
  if (!row) return null

  if (payload.table === 'orders') return row.id || null
  if (['order_table_links', 'order_rounds', 'order_items', 'payments'].includes(payload.table)) {
    return row.order_id || null
  }

  return null
}

export function RestaurantProvider({ children }) {
  const auth = useAuth()
  const [state, setState] = useState(loadInitialState)
  const operationalRefreshTimer = useRef(null)
  const inventoryRefreshTimer = useRef(null)
  const pendingOperationalOrderIds = useRef(new Set())
  const draftContextTableIdRef = useRef(null)
  const draftContextServiceKeyRef = useRef(null)
  const [products, setProducts] = useState(DEMO_PRODUCTS)
  const [menuCategories, setMenuCategories] = useState([])
  const [menuStations, setMenuStations] = useState([])
  const [locations, setLocations] = useState([])
  const [activeLocation, setActiveLocation] = useState(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState('')
  const [operationalSummary, setOperationalSummary] = useState({
    salesToday: 0,
    shiftSales: 0,
    shiftNumber: null,
    shiftOpenedAt: null,
    completedOrdersToday: 0,
    tableReleases: [],
  })
  const [voidRequestsVersion, setVoidRequestsVersion] = useState(0)
  const [tableOrderSessions, setTableOrderSessions] = useState([])
  const [tableDrafts, setTableDrafts] = useState({})
  const [inventoryAvailability, setInventoryAvailability] = useState({
    enforcementEnabled: true,
    byProduct: {},
    generatedAt: null,
  })
  const [orderMode, setOrderModeState] = useState(state.settings.defaultOrderMode || 'table')
  const [currentTableId, setCurrentTableId] = useState(null)
  const [currentOrderId, setCurrentOrderId] = useState(null)
  const [draft, setDraft] = useState([])
  const [pager, setPager] = useState('')
  const [quickCustomerName, setQuickCustomerName] = useState('')
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
  const activeLocationStorageKey = useMemo(() => {
    const userId = auth.userContext?.id || (auth.isDesignMode ? 'design-user' : null)
    if (!userId || !restaurantId) return null
    return `${ACTIVE_LOCATION_STORAGE_PREFIX}:${restaurantId}:${userId}`
  }, [auth.userContext?.id, auth.isDesignMode, restaurantId])

  const draftStorageKey = useMemo(() => {
    const userId = auth.userContext?.id || (auth.isDesignMode ? 'design-user' : null)
    const scopedRestaurant = restaurantId || (auth.isDesignMode ? 'design-restaurant' : null)
    const scopedLocation = activeLocation?.id || (auth.isDesignMode ? 'design-location' : null)
    if (!userId || !scopedRestaurant || !scopedLocation) return null
    return `${TABLE_DRAFT_STORAGE_PREFIX}:${scopedRestaurant}:${scopedLocation}:${userId}`
  }, [auth.userContext?.id, auth.isDesignMode, restaurantId, activeLocation?.id])

  useEffect(() => {
    draftContextTableIdRef.current = null
    setTableDrafts(loadStoredTableDrafts(draftStorageKey))
  }, [draftStorageKey])

  const saveTableDraftMap = useCallback((recipe) => {
    setTableDrafts((previous) => {
      const next = typeof recipe === 'function' ? recipe(previous) : recipe
      storeTableDrafts(draftStorageKey, next)
      return next
    })
  }, [draftStorageKey])

  const clearStoredTableDraft = useCallback((tableId) => {
    if (!tableId) return
    saveTableDraftMap((previous) => {
      if (!previous[String(tableId)]) return previous
      const next = { ...previous }
      delete next[String(tableId)]
      return next
    })
  }, [saveTableDraftMap])

  const tableDraftForTable = useCallback((tableId) => (
    tableDrafts[String(tableId)]?.items || []
  ), [tableDrafts])

  const getTableDraftCount = useCallback((tableId) => (
    tableDraftForTable(tableId).reduce(
      (sum, item) => sum + Math.max(0, Number(item.quantity || 0)),
      0,
    )
  ), [tableDraftForTable])

  useEffect(() => {
    if (
      orderMode !== 'table'
      || !currentTableId
      || draftContextTableIdRef.current !== currentTableId
    ) {
      return
    }

    saveTableDraftMap((previous) => {
      const key = String(currentTableId)
      const existing = previous[key]
      if (!draft.length) {
        if (!existing) return previous
        const next = { ...previous }
        delete next[key]
        return next
      }

      return {
        ...previous,
        [key]: {
          items: draft,
          updatedAt: Date.now(),
        },
      }
    })
  }, [draft, orderMode, currentTableId, saveTableDraftMap])

  useEffect(() => {
    if (!['quick', 'delivery'].includes(orderMode) || !currentOrderId) return

    const key = `${orderMode}:${currentOrderId}`
    if (draftContextServiceKeyRef.current !== key) return

    saveTableDraftMap((previous) => {
      const existing = previous[key]
      if (!draft.length) {
        if (!existing) return previous
        const next = { ...previous }
        delete next[key]
        return next
      }

      return {
        ...previous,
        [key]: {
          items: draft,
          updatedAt: Date.now(),
        },
      }
    })
  }, [draft, orderMode, currentOrderId, saveTableDraftMap])

  useEffect(() => {
    const staleTableIds = Object.entries(tableDrafts)
      .filter(([tableId, entry]) => {
        const table = state.tables.find((candidate) => String(candidate.id) === String(tableId))
        const releasedAt = Number(table?.releasedAt || 0)
        return releasedAt > Number(entry?.updatedAt || 0)
      })
      .map(([tableId]) => tableId)

    if (!staleTableIds.length) return

    const staleSet = new Set(staleTableIds)
    saveTableDraftMap((previous) => {
      const next = { ...previous }
      staleTableIds.forEach((tableId) => delete next[tableId])
      return next
    })

    if (currentTableId && staleSet.has(String(currentTableId))) {
      setDraft([])
    }
  }, [state.tables, tableDrafts, currentTableId, saveTableDraftMap])

  const canLoadInventoryAvailability = auth.isDesignMode
    || auth.can('orders.create')
    || auth.can('inventory.view')
    || auth.can('inventory.manage')

  const currencyCode = state.settings.currency || 'EUR'
  const formatMoney = useCallback(
    (value) => formatMoneyValue(value, currencyCode),
    [currencyCode],
  )

  const applyRemoteSettings = useCallback((remoteSettings) => {
    if (!remoteSettings) return

    updateState((previous) => ({
      ...previous,
      settings: {
        ...previous.settings,
        currency: remoteSettings.currency_code || previous.settings.currency,
        allowPager: remoteSettings.pager_enabled !== false,
        splitStations: remoteSettings.separate_kitchen_bar !== false,
        blockInsufficientInventory: remoteSettings.block_insufficient_inventory !== false,
      },
    }))
  }, [updateState])

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

  const applyOperationalOrders = useCallback((orders, summary = null) => {
    const operationalOrders = (orders || []).filter(isOperationalOrder)
    const releasedByTableId = new Map(
      (summary?.tableReleases || []).map((release) => [release.tableId, release.releasedAt]),
    )

    if (summary) setOperationalSummary(summary)

    setState((previous) => {
      const tablesWithReleaseTimes = previous.tables.map((table) => ({
        ...table,
        releasedAt: releasedByTableId.get(table.id) || table.releasedAt || null,
      }))
      const next = {
        ...previous,
        orders: operationalOrders,
        tables: syncOperationalTableStatuses(tablesWithReleaseTimes, operationalOrders),
        sales: summary ? Number(summary.shiftSales ?? summary.salesToday ?? 0) : previous.sales,
      }

      if (auth.isDesignMode) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      }

      return next
    })
  }, [auth.isDesignMode])

  const applyOperationalOrderPatches = useCallback((patches) => {
    if (!patches?.length) return

    setState((previous) => {
      const patchByServerId = new Map(
        patches.map((order) => [String(order.serverId), order]),
      )
      const seen = new Set()
      const orders = previous.orders.map((order) => {
        const patch = patchByServerId.get(String(order.serverId))
        if (!patch) return order
        seen.add(String(order.serverId))
        return isOperationalOrder(patch) ? patch : null
      }).filter(Boolean)

      patches.forEach((order) => {
        if (!seen.has(String(order.serverId)) && isOperationalOrder(order)) orders.push(order)
      })

      orders.sort((a, b) => (a.created || 0) - (b.created || 0))

      const releaseByTableId = new Map()
      patches.filter((order) => !isOperationalOrder(order)).forEach((order) => {
        ;(order.tableIds || []).forEach((tableId) => {
          const releasedAt = order.closedAt || Date.now()
          const current = releaseByTableId.get(tableId) || 0
          if (releasedAt > current) releaseByTableId.set(tableId, releasedAt)
        })
      })

      const tablesWithReleaseTimes = previous.tables.map((table) => (
        releaseByTableId.has(table.id)
          ? { ...table, releasedAt: releaseByTableId.get(table.id) }
          : table
      ))

      return {
        ...previous,
        orders,
        tables: syncOperationalTableStatuses(tablesWithReleaseTimes, orders),
      }
    })
  }, [])

  const applyOperationalSummary = useCallback((summary) => {
    if (!summary) return
    setOperationalSummary(summary)

    const releasedByTableId = new Map(
      (summary.tableReleases || []).map((release) => [release.tableId, release.releasedAt]),
    )

    setState((previous) => {
      const tables = previous.tables.map((table) => ({
        ...table,
        releasedAt: releasedByTableId.get(table.id) || table.releasedAt || null,
      }))

      return {
        ...previous,
        sales: Number(summary.shiftSales ?? summary.salesToday ?? 0),
        tables: syncOperationalTableStatuses(tables, previous.orders),
      }
    })
  }, [])

  const refreshTableOrderSessions = useCallback(async (locationOverride = null) => {
    if (auth.isDesignMode) return { ok: true, sessions: tableOrderSessions }

    const location = locationOverride || activeLocation
    if (!restaurantId || !location?.id) {
      setTableOrderSessions([])
      return { ok: false, message: 'No hay sucursal activa.' }
    }

    try {
      const sessions = await loadTableOrderSessions(restaurantId, location.id)
      setTableOrderSessions(sessions)
      return { ok: true, sessions }
    } catch (error) {
      const message = error?.message || 'No se pudo actualizar el estado de toma de pedidos.'
      setRemoteError(message)
      return { ok: false, message }
    }
  }, [auth.isDesignMode, restaurantId, activeLocation])

  const refreshOperationalData = useCallback(async (locationOverride = null) => {
    if (auth.isDesignMode) return { ok: true }

    const location = locationOverride || activeLocation
    if (!restaurantId || !location?.id) {
      applyOperationalOrders([])
      return { ok: false, message: 'No hay sucursal activa.' }
    }

    try {
      const operational = await loadOperationalState(restaurantId, location.id)
      applyOperationalOrders(operational.orders, operational.summary)
      return { ok: true, operational }
    } catch (error) {
      const message = error?.message || 'No se pudieron sincronizar los pedidos con Supabase.'
      setRemoteError(message)
      return { ok: false, message }
    }
  }, [auth.isDesignMode, restaurantId, activeLocation, applyOperationalOrders])

  const refreshOperationalSummary = useCallback(async (locationOverride = null) => {
    if (auth.isDesignMode) return { ok: true }

    const location = locationOverride || activeLocation
    if (!restaurantId || !location?.id) return { ok: false, message: 'No hay sucursal activa.' }

    try {
      const summary = await loadOperationalSummary(restaurantId, location.id)
      applyOperationalSummary(summary)
      return { ok: true, summary }
    } catch (error) {
      const message = error?.message || 'No se pudo actualizar el resumen operativo.'
      setRemoteError(message)
      return { ok: false, message }
    }
  }, [auth.isDesignMode, restaurantId, activeLocation, applyOperationalSummary])

  const refreshOperationalOrdersByIds = useCallback(async (orderIds, locationOverride = null) => {
    if (auth.isDesignMode) return { ok: true }

    const location = locationOverride || activeLocation
    const ids = Array.from(new Set((orderIds || []).filter(Boolean)))

    if (!ids.length) return { ok: true, orders: [] }
    if (!restaurantId || !location?.id) {
      return { ok: false, message: 'No hay sucursal activa.' }
    }

    try {
      const operational = await loadOperationalOrdersByIds(restaurantId, location.id, ids)
      applyOperationalOrderPatches(operational.orders)
      return { ok: true, orders: operational.orders }
    } catch (error) {
      const message = error?.message || 'No se pudo actualizar la orden desde Supabase.'
      setRemoteError(message)
      return { ok: false, message }
    }
  }, [
    auth.isDesignMode,
    restaurantId,
    activeLocation,
    applyOperationalOrderPatches,
  ])

  const refreshInventoryAvailability = useCallback(async (locationOverride = null) => {
    if (auth.isDesignMode) {
      setInventoryAvailability({
        enforcementEnabled: state.settings.blockInsufficientInventory !== false,
        byProduct: {},
        generatedAt: null,
      })
      return { ok: true }
    }

    if (!canLoadInventoryAvailability) {
      setInventoryAvailability({ enforcementEnabled: true, byProduct: {}, generatedAt: null })
      return { ok: true, skipped: true }
    }

    const location = locationOverride || activeLocation
    if (!restaurantId || !location?.id) {
      setInventoryAvailability({ enforcementEnabled: true, byProduct: {}, generatedAt: null })
      return { ok: false, message: 'No hay restaurante o sucursal activa.' }
    }

    try {
      const availability = await loadProductInventoryAvailability(restaurantId, location.id)
      setInventoryAvailability(availability)
      return { ok: true, availability }
    } catch (error) {
      const message = error?.message || 'No se pudo actualizar la disponibilidad de productos.'
      setRemoteError(message)
      return { ok: false, message }
    }
  }, [
    auth.isDesignMode,
    canLoadInventoryAvailability,
    restaurantId,
    activeLocation,
    state.settings.blockInsufficientInventory,
  ])

  const refreshMenu = useCallback(async (locationOverride = null) => {
    if (auth.isDesignMode) {
      setProducts(DEMO_PRODUCTS)
      setMenuCategories([])
      setMenuStations([])
      setInventoryAvailability({
        enforcementEnabled: state.settings.blockInsufficientInventory !== false,
        byProduct: {},
        generatedAt: null,
      })
      return { ok: true }
    }

    const location = locationOverride || activeLocation
    if (!restaurantId || !location?.id) {
      setProducts([])
      setMenuCategories([])
      setMenuStations([])
      setInventoryAvailability({ enforcementEnabled: true, byProduct: {}, generatedAt: null })
      return { ok: false, message: 'No hay restaurante o sucursal activa.' }
    }

    try {
      const [catalog, availability] = await Promise.all([
        loadMenuCatalog(restaurantId, location.id),
        canLoadInventoryAvailability
          ? loadProductInventoryAvailability(restaurantId, location.id)
          : Promise.resolve({ enforcementEnabled: true, byProduct: {}, generatedAt: null }),
      ])
      setProducts(catalog.products)
      setMenuCategories(catalog.categories)
      setMenuStations(catalog.stations)
      setInventoryAvailability(availability)
      return { ok: true, catalog, availability }
    } catch (error) {
      setRemoteError(error?.message || 'No se pudo cargar el menú desde Supabase.')
      return { ok: false, message: error?.message || 'No se pudo cargar el menú.' }
    }
  }, [
    auth.isDesignMode,
    canLoadInventoryAvailability,
    restaurantId,
    activeLocation,
    state.settings.blockInsufficientInventory,
  ])

  const refreshRemoteData = useCallback(async (locationIdOverride = null) => {
    if (auth.isDesignMode) {
      setProducts(DEMO_PRODUCTS)
      setRemoteError('')
      return { ok: true }
    }

    if (auth.mode !== 'authenticated' || !restaurantId) return { ok: false }

    setRemoteLoading(true)
    setRemoteError('')

    try {
      let preferredLocationId = locationIdOverride
      if (!preferredLocationId && activeLocationStorageKey) {
        try {
          preferredLocationId = localStorage.getItem(activeLocationStorageKey)
        } catch {
          preferredLocationId = null
        }
      }

      const [initialStructure, remoteSettings] = await Promise.all([
        loadRestaurantStructure(restaurantId, preferredLocationId),
        loadRestaurantSettings(restaurantId),
      ])
      let structure = initialStructure
      applyRemoteSettings(remoteSettings)

      setLocations(structure.locations || [])
      setActiveLocation(structure.location)

      if (structure.location?.id && activeLocationStorageKey) {
        try {
          localStorage.setItem(activeLocationStorageKey, structure.location.id)
        } catch {
          // Branch preference is non-critical.
        }
      }

      applyRemoteStructure(structure)

      if (structure.location) {
        const [catalog, operational, availability, tableSessions] = await Promise.all([
          loadMenuCatalog(restaurantId, structure.location.id),
          loadOperationalState(restaurantId, structure.location.id),
          canLoadInventoryAvailability
            ? loadProductInventoryAvailability(restaurantId, structure.location.id)
            : Promise.resolve({ enforcementEnabled: true, byProduct: {}, generatedAt: null }),
          loadTableOrderSessions(restaurantId, structure.location.id),
        ])
        setProducts(catalog.products)
        setMenuCategories(catalog.categories)
        setMenuStations(catalog.stations)
        setInventoryAvailability(availability)
        setTableOrderSessions(tableSessions)
        applyOperationalOrders(operational.orders, operational.summary)
      } else {
        setProducts([])
        setMenuCategories([])
        setMenuStations([])
        setInventoryAvailability({ enforcementEnabled: true, byProduct: {}, generatedAt: null })
        setTableOrderSessions([])
        applyOperationalOrders([])
      }

      return { ok: true, location: structure.location, locations: structure.locations || [] }
    } catch (error) {
      const message = error?.message || 'No se pudieron cargar los datos operativos desde Supabase.'
      setRemoteError(message)
      return { ok: false, message }
    } finally {
      setRemoteLoading(false)
    }
  }, [
    auth.isDesignMode,
    auth.mode,
    auth.permissions,
    canLoadInventoryAvailability,
    restaurantId,
    activeLocationStorageKey,
    applyRemoteStructure,
    applyRemoteSettings,
    applyOperationalOrders,
  ])

  const switchLocation = useCallback(async (locationId) => {
    if (!locationId || String(locationId) === String(activeLocation?.id || '')) {
      return { ok: true, location: activeLocation }
    }

    const target = locations.find((location) => String(location.id) === String(locationId))
    if (!target) {
      const result = { ok: false, message: 'No tienes acceso a esa sucursal o ya no está activa.' }
      window.alert(result.message)
      return result
    }

    const hasActiveCurrentOrder = Boolean(
      currentOrderId
      && state.orders.some((order) => String(order.id) === String(currentOrderId)),
    )
    const hasCurrentTableSession = Boolean(
      currentTableId
      && tableOrderSessions.some((session) => (
        String(session.tableId) === String(currentTableId)
        && session.claimedByMe
      )),
    )

    if (draft.length > 0 || hasActiveCurrentOrder || hasCurrentTableSession) {
      const result = {
        ok: false,
        message: 'Termina o abandona la toma de pedido actual antes de cambiar de sucursal.',
      }
      window.alert(result.message)
      return result
    }

    draftContextTableIdRef.current = null
    draftContextServiceKeyRef.current = null
    setCurrentTableId(null)
    setCurrentOrderId(null)
    setCurrentDelivery(null)
    setDraft([])
    setPager('')
    setQuickCustomerName('')
    setOrderModeState('table')
    const result = await refreshRemoteData(target.id)
    if (!result.ok) window.alert(result.message || 'No se pudo cambiar de sucursal.')
    return result
  }, [
    activeLocation,
    locations,
    currentOrderId,
    currentTableId,
    draft.length,
    state.orders,
    tableOrderSessions,
    refreshRemoteData,
  ])

  useEffect(() => {
    if (auth.isDesignMode) {
      setProducts(DEMO_PRODUCTS)
      setInventoryAvailability({
        enforcementEnabled: state.settings.blockInsufficientInventory !== false,
        byProduct: {},
        generatedAt: null,
      })
      return
    }

    if (auth.mode === 'authenticated' && restaurantId) {
      setOperationalSummary({ salesToday: 0, completedOrdersToday: 0, tableReleases: [] })
      setVoidRequestsVersion(0)
      setTableOrderSessions([])
      setState((previous) => ({
        ...previous,
        orders: [],
        tables: (previous.tables || []).map((table) => ({
          ...table,
          status: 'free',
          openedAt: null,
        })),
      }))
      refreshRemoteData()
    }
  }, [
    auth.mode,
    auth.isDesignMode,
    restaurantId,
    refreshRemoteData,
    state.settings.blockInsufficientInventory,
  ])

  useEffect(() => {
    if (
      auth.isDesignMode
      || auth.mode !== 'authenticated'
      || !restaurantId
      || !activeLocation?.id
    ) {
      return undefined
    }

    const channel = subscribeOperationalChanges(restaurantId, activeLocation.id, (payload) => {
      if (payload.table === 'kitchen_void_requests') {
        setVoidRequestsVersion((version) => version + 1)
        return
      }

      if (payload.table === 'table_order_sessions') {
        if (payload.eventType === 'DELETE') {
          const releasedTableId = payload.old?.table_id || null
          if (releasedTableId) {
            clearStoredTableDraft(releasedTableId)
            if (
              String(currentTableId || '') === String(releasedTableId)
              && draftContextTableIdRef.current === releasedTableId
            ) {
              setDraft([])
            }
          }
        }
        refreshTableOrderSessions(activeLocation).catch(() => {})
        return
      }

      if (payload.table === 'inventory_availability_events') {
        if (inventoryRefreshTimer.current) {
          window.clearTimeout(inventoryRefreshTimer.current)
        }

        inventoryRefreshTimer.current = window.setTimeout(() => {
          refreshInventoryAvailability(activeLocation).catch(() => {})
        }, 180)
        return
      }

      const orderId = orderIdFromRealtimePayload(payload)
      if (!orderId) return

      if (payload.table === 'payments') {
        refreshOperationalSummary(activeLocation).catch(() => {})
      }

      if (payload.table === 'orders' || payload.table === 'order_table_links') {
        refreshTableOrderSessions(activeLocation).catch(() => {})
      }

      pendingOperationalOrderIds.current.add(orderId)

      if (operationalRefreshTimer.current) {
        window.clearTimeout(operationalRefreshTimer.current)
      }

      operationalRefreshTimer.current = window.setTimeout(() => {
        const orderIds = Array.from(pendingOperationalOrderIds.current)
        pendingOperationalOrderIds.current.clear()
        refreshOperationalOrdersByIds(orderIds, activeLocation).catch(() => {})
      }, 180)
    })

    return () => {
      if (operationalRefreshTimer.current) {
        window.clearTimeout(operationalRefreshTimer.current)
        operationalRefreshTimer.current = null
      }
      if (inventoryRefreshTimer.current) {
        window.clearTimeout(inventoryRefreshTimer.current)
        inventoryRefreshTimer.current = null
      }
      pendingOperationalOrderIds.current.clear()
      unsubscribeOperationalChanges(channel).catch(() => {})
    }
  }, [
    auth.isDesignMode,
    auth.mode,
    restaurantId,
    activeLocation?.id,
    refreshOperationalOrdersByIds,
    refreshOperationalSummary,
    refreshInventoryAvailability,
    refreshTableOrderSessions,
    clearStoredTableDraft,
    currentTableId,
    auth.permissions,
  ])

  const tableSessionForTable = useCallback((tableId) => (
    tableOrderSessions.find((session) => (
      session.tableId === tableId
      && (!session.lastSeenAt || Date.now() - session.lastSeenAt < 5 * 60 * 1000)
    )) || null
  ), [tableOrderSessions])

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
    if (tableSessionForTable(tableId)) return 'occupied'
    if (reservationForTable(tableId, source)) return 'reserved'
    return 'free'
  }, [state, openOrderForTable, reservationForTable, tableSessionForTable])

  const getTableVisualStatus = useCallback((tableId, source = state) => {
    const table = source.tables.find((item) => item.id === tableId)
    if (!table || table.active === false) return 'unavailable'
    if (openOrderForTable(tableId, source)) {
      return ['ready', 'pay', 'waiting_food', 'refund_due'].includes(table.status) ? table.status : 'occupied'
    }
    if (tableSessionForTable(tableId)) return 'opening'
    if (reservationForTable(tableId, source)) return 'reserved'
    return 'free'
  }, [state, openOrderForTable, reservationForTable, tableSessionForTable])

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
    if (tableSessionForTable(tableId)) return { ok: false, message: 'No puedes eliminar una mesa mientras alguien está tomando un pedido.' }
    if (tableDraftForTable(tableId).length) return { ok: false, message: 'No puedes eliminar una mesa que tiene productos pendientes sin enviar.' }
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
    state.tables, openOrderForTable, tableSessionForTable, tableDraftForTable, reservationForTable,
    currentTableId, updateState, auth.isDesignMode, activeLocation,
  ])

  const setOrderMode = useCallback((mode) => {
    setOrderModeState(mode)
    setDraft([])
    setPager('')
    setQuickCustomerName('')
    setCurrentOrderId(null)
    draftContextServiceKeyRef.current = null
    if (mode !== 'table') setCurrentTableId(null)
    if (mode !== 'delivery') setCurrentDelivery(null)
  }, [])

  const openTable = useCallback(async (tableId) => {
    const table = state.tables.find((item) => item.id === tableId && item.active !== false)
    if (!table) return { ok: false, message: 'La mesa no existe o está desactivada.' }

    if (currentTableId && currentTableId !== tableId) {
      const previousSession = tableSessionForTable(currentTableId)
      const previousDraft = tableDraftForTable(currentTableId)
      const previousOrder = openOrderForTable(currentTableId)

      if (previousSession?.claimedByMe && !previousDraft.length && !previousOrder) {
        if (auth.isDesignMode) {
          setTableOrderSessions((sessions) => sessions.filter((session) => session.tableId !== currentTableId))
        } else {
          releaseTableOrderSessionRemote(currentTableId).catch(() => {})
        }
      }
    }

    const existing = state.orders.find((order) => (
      order.mode === 'table'
      && (order.tableIds || []).includes(tableId)
      && !['closed', 'merged', 'cancelled'].includes(order.status)
    ))

    if (!existing) {
      const currentSession = tableSessionForTable(tableId)
      if (currentSession && !currentSession.claimedByMe) {
        return {
          ok: false,
          message: 'Esta mesa ya está siendo abierta por otro usuario para tomar un pedido.',
        }
      }

      if (auth.isDesignMode) {
        if (!currentSession) {
          const now = Date.now()
          setTableOrderSessions((sessions) => [
            ...sessions.filter((session) => session.tableId !== tableId),
            {
              tableId,
              claimedAt: now,
              lastSeenAt: now,
              claimedByMe: true,
              attendantName: auth.userContext?.name || 'Usuario',
              sessionType: 'draft',
            },
          ])
        }
      } else {
        if (!restaurantId || !activeLocation?.id) {
          return { ok: false, message: 'No hay restaurante o sucursal activa.' }
        }

        try {
          const claimed = await claimTableOrderSessionRemote(
            restaurantId,
            activeLocation.id,
            tableId,
          )

          if (!claimed.ok) {
            if (claimed.status === 'occupied') {
              await refreshOperationalData(activeLocation)
              return { ok: false, message: 'La mesa ya tiene una cuenta abierta.' }
            }
            if (claimed.status === 'claimed_by_other') {
              await refreshTableOrderSessions(activeLocation)
              return {
                ok: false,
                message: 'Esta mesa ya está siendo abierta por otro usuario para tomar un pedido.',
              }
            }
            return { ok: false, message: 'No se pudo reservar la mesa para tomar el pedido.' }
          }

          setTableOrderSessions((sessions) => [
            ...sessions.filter((session) => session.tableId !== tableId),
            {
              ...claimed,
              attendantName: claimed.attendantName || auth.userContext?.name || 'Usuario',
              sessionType: claimed.sessionType || 'draft',
            },
          ])
        } catch (error) {
          return {
            ok: false,
            message: error?.message || 'No se pudo abrir la mesa para tomar el pedido.',
          }
        }
      }
    }

    const restoredDraft = tableDraftForTable(tableId)
    draftContextTableIdRef.current = tableId
    setOrderModeState('table')
    setCurrentTableId(tableId)
    setCurrentOrderId(existing?.id || null)
    setDraft(restoredDraft)
    setPager('')
    setQuickCustomerName('')
    setCurrentDelivery(null)
    draftContextServiceKeyRef.current = null
    return { ok: true, existing: Boolean(existing), restoredDraftCount: restoredDraft.length }
  }, [
    state.tables,
    state.orders,
    currentTableId,
    tableSessionForTable,
    tableDraftForTable,
    openOrderForTable,
    auth.isDesignMode,
    restaurantId,
    activeLocation,
    refreshOperationalData,
    refreshTableOrderSessions,
  ])

  const touchTableDraftSession = useCallback(async (tableId = currentTableId) => {
    if (!tableId) return false

    if (auth.isDesignMode) {
      const now = Date.now()
      setTableOrderSessions((sessions) => sessions.map((session) => (
        session.tableId === tableId && session.claimedByMe
          ? { ...session, lastSeenAt: now }
          : session
      )))
      return true
    }

    try {
      return await touchTableOrderSessionRemote(tableId)
    } catch {
      return false
    }
  }, [auth.isDesignMode, currentTableId])

  const releaseTableDraftSession = useCallback(async (tableId = currentTableId) => {
    if (!tableId) return false

    if (auth.isDesignMode) {
      setTableOrderSessions((sessions) => sessions.filter((session) => (
        session.tableId !== tableId
        || !session.claimedByMe
        || session.sessionType === 'order'
      )))
      return true
    }

    try {
      const released = await releaseTableOrderSessionRemote(tableId)
      if (released) {
        setTableOrderSessions((sessions) => sessions.filter((session) => (
          session.tableId !== tableId || session.sessionType === 'order'
        )))
      }
      return released
    } catch {
      return false
    }
  }, [auth.isDesignMode, currentTableId])

  const canReleaseTableDraftSession = useCallback((tableId) => {
    const session = tableSessionForTable(tableId)
    if (!session || session.sessionType !== 'draft') return false
    if (openOrderForTable(tableId)) return false
    return session.claimedByMe || auth.can('tables.manage')
  }, [tableSessionForTable, openOrderForTable, auth.permissions])

  const abandonTableDraftSession = useCallback(async (tableId, { discardDraft = false } = {}) => {
    if (!tableId) return { ok: false, message: 'Mesa inválida.' }

    const session = tableSessionForTable(tableId)
    if (!session || session.sessionType !== 'draft') {
      return { ok: false, message: 'Esta mesa ya no está en toma de pedido.' }
    }
    const canManageTables = auth.can('tables.manage')
    if (!session.claimedByMe && !canManageTables) {
      return {
        ok: false,
        message: 'Solo quien abrió la mesa, un supervisor o el owner pueden liberarla.',
      }
    }
    if (openOrderForTable(tableId)) {
      return { ok: false, message: 'La mesa ya tiene una orden enviada y no puede liberarse desde aquí.' }
    }

    const pendingCount = getTableDraftCount(tableId)
    if (pendingCount > 0 && !discardDraft) {
      return { ok: false, needsConfirmation: true, draftCount: pendingCount }
    }

    let released = false
    try {
      released = await releaseTableDraftSession(tableId)
    } catch (error) {
      return { ok: false, message: error?.message || 'No se pudo liberar la mesa.' }
    }
    if (!released) {
      return { ok: false, message: 'No se pudo liberar la mesa. Actualiza e inténtalo nuevamente.' }
    }

    clearStoredTableDraft(tableId)

    if (currentTableId === tableId) {
      draftContextTableIdRef.current = null
      setCurrentTableId(null)
      setCurrentOrderId(null)
      setDraft([])
      setPager('')
      setCurrentDelivery(null)
    }

    return { ok: true, discardedDraftCount: pendingCount }
  }, [
    tableSessionForTable,
    openOrderForTable,
    getTableDraftCount,
    releaseTableDraftSession,
    clearStoredTableDraft,
    currentTableId,
  ])

  useEffect(() => {
    const keepAliveTableIds = tableOrderSessions
      .filter((session) => (
        session.sessionType === 'draft'
        && session.claimedByMe
        && (
          session.tableId === currentTableId
          || tableDraftForTable(session.tableId).length > 0
        )
      ))
      .map((session) => session.tableId)

    if (!keepAliveTableIds.length) return undefined

    const heartbeat = window.setInterval(() => {
      if (auth.isDesignMode) {
        const now = Date.now()
        setTableOrderSessions((sessions) => sessions.map((session) => (
          keepAliveTableIds.includes(session.tableId) && session.claimedByMe
            ? { ...session, lastSeenAt: now }
            : session
        )))
        return
      }

      Promise.all(
        keepAliveTableIds.map((tableId) => touchTableOrderSessionRemote(tableId).catch(() => false)),
      ).catch(() => {})
    }, 60_000)

    return () => window.clearInterval(heartbeat)
  }, [
    auth.isDesignMode,
    currentTableId,
    tableOrderSessions,
    tableDraftForTable,
  ])

  const startQuickOrder = useCallback(async () => {
    if (!auth.isDesignMode) {
      if (!restaurantId || !activeLocation?.id) {
        return { ok: false, message: 'No hay restaurante o sucursal activa.' }
      }

      try {
        const created = await createQuickOrderRemote({
          restaurantId,
          locationId: activeLocation.id,
        })

        const orderNumber = Number(created?.order_number)
        if (!Number.isFinite(orderNumber)) {
          throw new Error('Supabase no devolvió un número de pedido válido.')
        }

        setOrderModeState('quick')
        setCurrentTableId(null)
        setCurrentOrderId(orderNumber)
        setPager(String(created?.pager_number || ''))
        setQuickCustomerName('')
        setCurrentDelivery(null)
        draftContextServiceKeyRef.current = `quick:${orderNumber}`
        setDraft(tableDrafts[`quick:${orderNumber}`]?.items || [])
        await refreshOperationalOrdersByIds([created.id], activeLocation)

        return { ok: true, orderId: orderNumber }
      } catch (error) {
        return { ok: false, message: error?.message || 'No se pudo crear el pedido rápido.' }
      }
    }

    let createdOrderId = null
    updateState((previous) => {
      createdOrderId = previous.nextOrder
      const order = {
        id: createdOrderId,
        mode: 'quick',
        tableIds: [],
        pager: null,
        customerName: '',
        rounds: [],
        status: 'draft',
        created: Date.now(),
        payments: [],
        refundDue: 0,
        invoiceIssuedAt: null,
        invoiceNumber: null,
        closedAt: null,
        openedByName: auth.userContext?.name || 'Usuario',
        openedByMe: true,
      }

      return {
        ...previous,
        nextOrder: previous.nextOrder + 1,
        orders: [...previous.orders, order],
      }
    })

    setOrderModeState('quick')
    setCurrentTableId(null)
    setCurrentOrderId(createdOrderId)
    setPager('')
    setQuickCustomerName('')
    setCurrentDelivery(null)
    draftContextServiceKeyRef.current = `quick:${createdOrderId}`
    setDraft(tableDrafts[`quick:${createdOrderId}`]?.items || [])
    return { ok: true, orderId: createdOrderId }
  }, [
    auth.isDesignMode,
    auth.userContext?.name,
    restaurantId,
    activeLocation,
    refreshOperationalOrdersByIds,
    tableDrafts,
    updateState,
  ])

  const startDelivery = useCallback(async (delivery) => {
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

    if (!auth.isDesignMode) {
      if (!restaurantId || !activeLocation?.id) {
        return { ok: false, message: 'No hay restaurante o sucursal activa.' }
      }

      try {
        const created = await createDeliveryOrderRemote({
          restaurantId,
          locationId: activeLocation.id,
          customerId: normalized.customerId,
          customerName: normalized.customerName,
          delivery: normalized,
        })

        const orderNumber = Number(created?.order_number)
        if (!Number.isFinite(orderNumber)) {
          throw new Error('Supabase no devolvió un número de pedido válido.')
        }

        setOrderModeState('delivery')
        setCurrentTableId(null)
        setCurrentOrderId(orderNumber)
        setPager('')
        setQuickCustomerName('')
        setCurrentDelivery(normalized)
        draftContextServiceKeyRef.current = `delivery:${orderNumber}`
        setDraft(tableDrafts[`delivery:${orderNumber}`]?.items || [])
        await refreshOperationalOrdersByIds([created.id], activeLocation)

        return { ok: true, orderId: orderNumber }
      } catch (error) {
        return { ok: false, message: error?.message || 'No se pudo crear el domicilio en Supabase.' }
      }
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
        refundDue: 0,
        invoiceIssuedAt: null,
        invoiceNumber: null,
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
    setPager('')
    setQuickCustomerName('')
    setCurrentDelivery(normalized)
    draftContextServiceKeyRef.current = `delivery:${createdOrderId}`
    setDraft(tableDrafts[`delivery:${createdOrderId}`]?.items || [])
    return { ok: true, orderId: createdOrderId }
  }, [
    auth.isDesignMode,
    restaurantId,
    activeLocation,
    refreshOperationalOrdersByIds,
    updateState,
    tableDrafts,
  ])

  const updateQuickOrderIdentity = useCallback(async ({ pager: nextPager = '', customerName: nextCustomerName = '' } = {}) => {
    if (state.settings.allowPager === false) {
      return {
        ok: false,
        message: 'Este restaurante usa turnos automáticos. El identificador no se edita manualmente.',
      }
    }

    const normalizedPager = cleanName(nextPager)
    const normalizedCustomer = cleanName(nextCustomerName)

    if (normalizedPager && normalizedCustomer) {
      return { ok: false, message: 'Usa número de pager o nombre del cliente, no ambos.' }
    }
    if (orderMode !== 'quick' || !currentOrderId) {
      return { ok: false, message: 'No hay un pedido rápido abierto.' }
    }

    setPager(normalizedPager)
    setQuickCustomerName(normalizedCustomer)

    if (auth.isDesignMode) {
      updateState((previous) => ({
        ...previous,
        orders: previous.orders.map((order) => order.id === currentOrderId
          ? { ...order, pager: normalizedPager || null, customerName: normalizedCustomer }
          : order),
      }))
      return { ok: true }
    }

    const order = state.orders.find((item) => item.id === currentOrderId && item.mode === 'quick')
    if (!order?.serverId) {
      return { ok: false, message: 'El pedido rápido todavía no está sincronizado.' }
    }

    try {
      await updateQuickOrderIdentityRemote({
        orderServerId: order.serverId,
        pager: normalizedPager,
        customerName: normalizedCustomer,
      })
      await refreshOperationalOrdersByIds([order.serverId], activeLocation)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error?.message || 'No se pudo guardar la identificación del pedido rápido.' }
    }
  }, [
    orderMode,
    currentOrderId,
    auth.isDesignMode,
    state.orders,
    updateState,
    refreshOperationalOrdersByIds,
    activeLocation,
    state.settings.allowPager,
  ])

  const releaseEmptyQuickOrder = useCallback(async (orderId) => {
    const order = state.orders.find((item) => item.id === orderId && item.mode === 'quick')
    if (!order) return { ok: false, message: 'El pedido rápido no existe o ya fue cerrado.' }

    const hasSentItems = (order.rounds || []).some((round) => (
      (round.items || []).some((item) => !item.voided)
    ))
    if (hasSentItems) {
      return { ok: false, message: 'Este pedido ya tiene productos enviados y no puede liberarse como vacío.' }
    }

    const allowed = order.openedByMe || auth.can('tables.manage')
    if (!allowed) {
      return { ok: false, message: 'Solo quien creó el pedido, un supervisor o el owner pueden liberarlo vacío.' }
    }

    if (auth.isDesignMode) {
      updateState((previous) => ({
        ...previous,
        orders: previous.orders.map((candidate) => candidate.id === orderId
          ? { ...candidate, status: 'cancelled', closedAt: Date.now() }
          : candidate),
      }))
    } else {
      if (!order.serverId) return { ok: false, message: 'El pedido no está sincronizado.' }
      try {
        const released = await releaseEmptyQuickOrderRemote(order.serverId)
        if (!released) return { ok: false, message: 'El pedido ya no estaba disponible para liberar.' }
        await refreshOperationalOrdersByIds([order.serverId], activeLocation)
      } catch (error) {
        return { ok: false, message: error?.message || 'No se pudo liberar el pedido rápido.' }
      }
    }

    const key = `quick:${orderId}`
    saveTableDraftMap((previous) => {
      if (!previous[key]) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })

    if (currentOrderId === orderId && orderMode === 'quick') {
      setDraft([])
      setPager('')
      setQuickCustomerName('')
      setCurrentOrderId(null)
      draftContextServiceKeyRef.current = null
    }

    return { ok: true }
  }, [
    state.orders,
    auth.permissions,
    auth.isDesignMode,
    updateState,
    refreshOperationalOrdersByIds,
    activeLocation,
    saveTableDraftMap,
    currentOrderId,
    orderMode,
  ])

  const openQuickOrder = useCallback((orderId) => {
    const order = state.orders.find((item) => item.id === orderId && item.mode === 'quick')
    if (!order) return { ok: false, message: 'El pedido rápido no existe o ya fue cerrado.' }

    const draftKey = `quick:${order.id}`
    setOrderModeState('quick')
    setCurrentTableId(null)
    setCurrentOrderId(order.id)
    setPager(order.pager || '')
    setQuickCustomerName(order.customerName || '')
    setCurrentDelivery(null)
    draftContextServiceKeyRef.current = draftKey
    setDraft(tableDrafts[draftKey]?.items || [])
    return { ok: true }
  }, [state.orders, tableDrafts])

  const openDelivery = useCallback((orderId) => {
    const order = state.orders.find((item) => item.id === orderId && item.mode === 'delivery')
    if (!order) return { ok: false, message: 'El domicilio no existe.' }

    const draftKey = `delivery:${order.id}`
    setOrderModeState('delivery')
    setCurrentTableId(null)
    setCurrentOrderId(order.id)
    setPager('')
    setQuickCustomerName('')
    setCurrentDelivery(order.delivery || null)
    draftContextServiceKeyRef.current = draftKey
    setDraft(tableDrafts[draftKey]?.items || [])
    return { ok: true }
  }, [state.orders, tableDrafts])

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
      customerName: orderMode === 'quick' ? quickCustomerName.trim() : '',
      delivery: orderMode === 'delivery' ? currentDelivery : null,
      deliveryStatus: orderMode === 'delivery' ? 'pending' : null,
      rounds: [],
      status: prepaid ? 'preparing' : 'open',
      created: Date.now(),
      payments: [],
      refundDue: 0,
      invoiceIssuedAt: null,
      invoiceNumber: null,
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
  }, [currentOrderId, currentTableId, orderMode, pager, quickCustomerName, currentDelivery])

  const sendDraft = useCallback(async ({ prepaid = false, paymentMethod = 'cash' } = {}) => {
    if (!draft.length) return { ok: false, message: 'Añade productos nuevos antes de enviar.' }
    if (orderMode === 'table' && !currentTableId) return { ok: false, message: 'Selecciona una mesa.' }
    if (orderMode === 'delivery' && (!currentDelivery?.customerName || !currentDelivery?.address || !currentDelivery?.phone || !currentDelivery?.neighborhood || !currentDelivery?.city)) {
      return { ok: false, message: 'Faltan datos obligatorios del domicilio.' }
    }
    if (
      orderMode === 'quick'
      && state.settings.allowPager !== false
      && !pager.trim()
      && !quickCustomerName.trim()
    ) {
      return { ok: false, message: 'Digita el número del pager o el nombre del cliente antes de enviar.' }
    }
    if (
      orderMode === 'quick'
      && state.settings.allowPager !== false
      && pager.trim()
      && quickCustomerName.trim()
    ) {
      return { ok: false, message: 'Usa número de pager o nombre del cliente, no ambos.' }
    }
    if (!auth.isDesignMode) {
      if (!restaurantId || !activeLocation?.id) {
        return { ok: false, message: 'No hay restaurante o sucursal activa.' }
      }

      const existingOrder = state.orders.find((order) => order.id === currentOrderId)
        || (orderMode === 'table' && currentTableId ? openOrderForTable(currentTableId) : null)

      try {
        const result = await sendOrderRoundRemote({
          orderServerId: existingOrder?.serverId || null,
          restaurantId,
          locationId: activeLocation.id,
          mode: orderMode,
          tableIds: orderMode === 'table'
            ? (existingOrder?.tableIds?.length ? existingOrder.tableIds : [currentTableId])
            : [],
          customerId: orderMode === 'delivery' ? (currentDelivery?.customerId || null) : null,
          customerName: orderMode === 'delivery'
            ? (currentDelivery?.customerName || null)
            : orderMode === 'quick'
              ? (quickCustomerName.trim() || null)
              : null,
          delivery: orderMode === 'delivery' ? currentDelivery : null,
          pager: orderMode === 'quick' ? (pager.trim() || null) : null,
          items: draft,
          prepaid,
          paymentMethod,
        })

        const orderNumber = Number(result?.order_number)
        if (!Number.isFinite(orderNumber)) {
          throw new Error('Supabase no devolvió un número de pedido válido.')
        }

        setCurrentOrderId(orderNumber)
        setDraft([])
        await Promise.all([
          refreshOperationalOrdersByIds([result.order_id], activeLocation),
          refreshInventoryAvailability(activeLocation),
        ])
        if (prepaid) await refreshOperationalSummary(activeLocation)
        return { ok: true, orderId: orderNumber }
      } catch (error) {
        await refreshInventoryAvailability(activeLocation)
        const message = String(error?.message || '')
        if (message.includes('Table session is no longer active')) {
          clearStoredTableDraft(currentTableId)
          setDraft([])
          return {
            ok: false,
            message: 'Esta mesa fue liberada mientras tomabas el pedido. Ábrela nuevamente antes de enviar productos.',
          }
        }
        return { ok: false, message: message || 'No se pudo enviar la comanda a Supabase.' }
      }
    }

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
  }, [
    draft, orderMode, currentTableId, currentOrderId, updateState, ensureOrder,
    auth.isDesignMode, restaurantId, activeLocation, state.orders, state.settings.allowPager, currentDelivery, pager, quickCustomerName,
    openOrderForTable, refreshOperationalOrdersByIds, refreshOperationalSummary,
    refreshInventoryAvailability, clearStoredTableDraft,
  ])

  const applyKitchenApprovedVoidRequest = useCallback((orderId, request) => {
    const order = state.orders.find((candidate) => candidate.id === orderId)
    if (!order) return { ok: false, message: 'La orden no existe.' }
    if (orderPaidTotal(order) > 0.005) {
      return { ok: false, message: 'La cuenta ya tiene pagos y no puede aplicar una aprobación de Cocina.' }
    }
    if (orderHasInvoice(order)) {
      return { ok: false, message: 'La orden ya tiene factura emitida.' }
    }

    if (!auth.isDesignMode) {
      return {
        ok: true,
        appliedCount: (request?.items || []).length,
        remote: true,
      }
    }

    const lineIds = new Set((request?.items || []).map((item) => String(item.lineId || '')))
    if (!lineIds.size) return { ok: false, message: 'La solicitud no contiene productos.' }

    const reason = cleanName(request?.reason) || 'Aprobado por Cocina'
    let appliedCount = 0

    updateState((previous) => ({
      ...previous,
      orders: previous.orders.map((candidate) => {
        if (candidate.id !== orderId) return candidate

        return {
          ...candidate,
          rounds: candidate.rounds.map((round) => ({
            ...round,
            items: round.items.map((item) => {
              if (item.voided || !lineIds.has(String(item.lineId))) return item
              appliedCount += 1
              return {
                ...item,
                voided: true,
                voidedAt: Date.now(),
                voidReason: reason,
                voidMethod: 'kitchen_approved',
                voidRequestId: request?.id || null,
              }
            }),
          })),
          lastEvent: `Anulación aprobada por Cocina · ${appliedCount || lineIds.size} producto(s)`,
        }
      }),
      activity: [
        ...previous.activity,
        `Cocina aprobó anulación · Orden #${orderId} · ${reason}`,
      ],
    }))

    return { ok: true, appliedCount }
  }, [state.orders, updateState, auth.isDesignMode])

  const voidPaidTableAccount = useCallback(async (orderIds, options = {}) => {
    const targetIds = new Set((orderIds || []).map((id) => id))
    const orders = state.orders.filter((order) => targetIds.has(order.id))
    if (!orders.length) return { ok: false, message: 'No se encontró la cuenta.' }

    const total = orders.reduce((sum, order) => sum + orderTotal(order), 0)
    const paid = orders.reduce((sum, order) => sum + orderPaidTotal(order), 0)
    const balance = Math.max(0, total - paid)

    if (paid <= 0.005) {
      return { ok: false, message: 'Esta cuenta no tiene pagos; debe solicitarse la anulación a Cocina.' }
    }
    const fullyPaid = balance <= 0.005

    if (fullyPaid && !options.allowFullyPaid) {
      return { ok: false, message: 'La cuenta ya está pagada completamente y requiere autorización exclusiva del administrador.' }
    }

    if (!fullyPaid && options.allowFullyPaid) {
      return { ok: false, message: 'Esta autorización corresponde a una cuenta ya cobrada, no a una cuenta parcial.' }
    }

    if (!options.auditId) {
      return { ok: false, message: 'Falta la autorización del administrador.' }
    }

    const reason = cleanName(options.reason)
    if (!reason) return { ok: false, message: 'Debes registrar el motivo de la anulación.' }

    if (!auth.isDesignMode) {
      await refreshOperationalOrdersByIds(
        orders.map((order) => order.serverId).filter(Boolean),
        activeLocation,
      )
      return { ok: true, refundDue: paid, remote: true }
    }

    const affectedTables = new Set(orders.flatMap((order) => order.tableIds || []))

    updateState((previous) => ({
      ...previous,
      orders: previous.orders.map((order) => {
        if (!targetIds.has(order.id)) return order
        const orderPaid = orderPaidTotal(order)

        const hadInvoice = orderHasInvoice(order)

        return {
          ...order,
          refundDue: orderPaid,
          status: orderPaid > 0.005 ? 'refund_due' : 'cancelled',
          accountVoidedAt: Date.now(),
          invoiceVoidedAt: hadInvoice ? Date.now() : (order.invoiceVoidedAt || null),
          fiscalCorrectionRequired: hadInvoice,
          accountVoidReason: reason,
          accountVoidAuditId: options.auditId,
          accountVoidAuthorizationRequestId: options.authorizationRequestId || null,
          rounds: order.rounds.map((round) => ({
            ...round,
            items: round.items.map((item) => item.voided ? item : {
              ...item,
              voided: true,
              voidedAt: Date.now(),
              voidReason: reason,
              voidMethod: 'admin_account',
              voidAuditId: options.auditId,
              voidAuthorizationRequestId: options.authorizationRequestId || null,
            }),
          })),
          lastEvent: 'Cuenta completa anulada con autorización del administrador',
        }
      }),
      tables: previous.tables.map((table) => (
        !fullyPaid && affectedTables.has(table.id)
          ? { ...table, status: 'refund_due' }
          : table
      )),
      activity: [
        ...previous.activity,
        `${fullyPaid ? 'Cuenta cobrada anulada' : 'Cuenta completa anulada'} · Reembolso pendiente ${formatMoney(paid)} · ${reason}`,
      ],
    }))

    return { ok: true, refundDue: paid }
  }, [
    state.orders, updateState, formatMoney, auth.isDesignMode,
    refreshOperationalOrdersByIds, activeLocation,
  ])

  const advanceStationRound = useCallback(async (orderId, roundId, station) => {
    if (!auth.isDesignMode) {
      const order = state.orders.find((candidate) => candidate.id === orderId)
      const round = order?.rounds?.find((candidate) => candidate.id === roundId)

      if (!order?.serverId || !round?.serverId) {
        return { ok: false, message: 'No se encontró la comanda sincronizada.' }
      }

      try {
        await advanceStationRoundRemote(order.serverId, round.serverId, station)
        await refreshOperationalOrdersByIds([order.serverId], activeLocation)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error?.message || 'No se pudo actualizar la preparación.' }
      }
    }

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

          if (Number(order.refundDue || 0) > 0.005) {
            return { ...order, status: 'refund_due' }
          }

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
          if (Number(refreshed.refundDue || 0) > 0.005) return { ...table, status: 'refund_due' }
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
  }, [
    updateState, auth.isDesignMode, state.orders, refreshOperationalOrdersByIds, activeLocation,
  ])

  const markRoundDelivered = useCallback(async (orderId, roundId) => {
    if (!auth.isDesignMode) {
      const order = state.orders.find((candidate) => candidate.id === orderId)
      const round = order?.rounds?.find((candidate) => candidate.id === roundId)

      if (!order?.serverId || !round?.serverId) {
        return { ok: false, message: 'No se encontró la comanda sincronizada.' }
      }

      try {
        await markRoundServedRemote(order.serverId, round.serverId)
        await refreshOperationalOrdersByIds([order.serverId], activeLocation)
        await refreshOperationalSummary(activeLocation)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error?.message || 'No se pudo marcar la comanda como entregada.' }
      }
    }

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
  }, [
    updateState, auth.isDesignMode, state.orders, refreshOperationalOrdersByIds,
    refreshOperationalSummary, activeLocation,
  ])

  const transferCurrentTable = useCallback(async (destinationId) => {
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

    if (!auth.isDesignMode) {
      const order = state.orders.find((item) => item.id === currentOrderId)
      if (!order?.serverId) return { ok: false, message: 'No hay una cuenta sincronizada para mover.' }

      try {
        await transferOrderTableRemote(order.serverId, currentTableId, destination)
        setCurrentTableId(destination)
        await refreshOperationalOrdersByIds([order.serverId], activeLocation)
        return { ok: true, reserved: destinationStatus === 'reserved' }
      } catch (error) {
        return { ok: false, message: error?.message || 'No se pudo mover la cuenta en Supabase.' }
      }
    }

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
  }, [
    currentTableId, currentOrderId, state.tables, state.orders, getTableTransferStatus,
    tableLabel, updateState, auth.isDesignMode, refreshOperationalOrdersByIds, activeLocation,
  ])

  const joinTable = useCallback(async (destinationId) => {
    const destination = String(destinationId || '')
    const order = state.orders.find((item) => item.id === currentOrderId)
    if (!order || !destination) return { ok: false, message: 'Abre primero una cuenta de mesa.' }
    if (order.tableIds.includes(destination)) return { ok: false, message: 'Esa mesa ya forma parte de la cuenta.' }

    const status = getTableTransferStatus(destination)
    if (status === 'occupied') {
      return { ok: false, message: 'La mesa destino ya tiene otra cuenta abierta.' }
    }
    if (status === 'unavailable') return { ok: false, message: 'La mesa destino no está disponible.' }

    if (!auth.isDesignMode) {
      if (!order.serverId) return { ok: false, message: 'La cuenta todavía no está sincronizada.' }

      try {
        await joinOrderTableRemote(order.serverId, destination)
        await refreshOperationalOrdersByIds([order.serverId], activeLocation)
        return { ok: true, reserved: status === 'reserved' }
      } catch (error) {
        return { ok: false, message: error?.message || 'No se pudo unir la mesa en Supabase.' }
      }
    }

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
  }, [
    state.orders, currentOrderId, getTableTransferStatus, tableLabel, updateState,
    auth.isDesignMode, refreshOperationalOrdersByIds, activeLocation,
  ])

  const recordPayments = useCallback(async (allocations, method = 'card', invoiceCustomer = undefined) => {
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

    if (!auth.isDesignMode) {
      try {
        const remoteAllocations = normalized.map((allocation) => {
          const order = state.orders.find((candidate) => candidate.id === allocation.orderId)
          if (!order?.serverId) {
            throw new Error(`La orden #${allocation.orderId} no está sincronizada.`)
          }

          return {
            orderId: order.serverId,
            amount: allocation.amount,
            itemAllocations: allocation.itemAllocations,
          }
        })

        const result = await recordOrderPaymentsRemote(
          remoteAllocations,
          method,
          invoiceCustomer === undefined ? null : invoiceCustomer,
        )
        await refreshOperationalOrdersByIds(
          remoteAllocations.map((allocation) => allocation.orderId),
          activeLocation,
        )
        await refreshOperationalSummary(activeLocation)
        return { ok: true, applied: Number(result?.applied || 0) }
      } catch (error) {
        return { ok: false, message: paymentErrorMessage(error) }
      }
    }

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
          customerId: invoiceCustomer?.requested
            ? (invoiceCustomer.id || order.customerId || null)
            : (invoiceCustomer === undefined || order.mode === 'delivery' ? order.customerId : null),
          customerName: invoiceCustomer?.requested
            ? invoiceCustomer.fullName
            : (invoiceCustomer === undefined || order.mode === 'delivery' ? order.customerName : ''),
          invoiceCustomer: invoiceCustomer === undefined
            ? order.invoiceCustomer
            : (invoiceCustomer.requested ? {
                id: invoiceCustomer.id || null,
                name: invoiceCustomer.fullName,
                documentType: invoiceCustomer.documentType,
                documentNumber: invoiceCustomer.documentNumber,
                phone: invoiceCustomer.phone || null,
                email: invoiceCustomer.email || null,
                address: invoiceCustomer.address || null,
                neighborhood: invoiceCustomer.neighborhood || null,
                city: invoiceCustomer.city || null,
              } : null),
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
          `Cobro registrado · ${formatMoney(appliedTotal)} · ${normalized.length} cuenta${normalized.length === 1 ? '' : 's'} interna${normalized.length === 1 ? '' : 's'}`,
        ],
      }
    })

    return { ok: true, applied: expectedApplied }
  }, [
    state.orders, updateState, formatMoney, auth.isDesignMode,
    refreshOperationalOrdersByIds, refreshOperationalSummary, activeLocation,
  ])

  const recordPayment = useCallback((orderId, amount, method = 'card') => (
    recordPayments([{ orderId, amount }], method)
  ), [recordPayments])

  const updateSettings = useCallback((patch) => {
    updateState((previous) => ({ ...previous, settings: { ...previous.settings, ...patch } }))
  }, [updateState])

  const setCurrency = useCallback(async (currency) => {
    const code = String(currency || '').trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(code)) {
      return { ok: false, message: 'Código de moneda inválido.' }
    }

    if (auth.isDesignMode) {
      updateSettings({ currency: code })
      return { ok: true, currency: code }
    }

    if (!restaurantId) {
      return { ok: false, message: 'No se encontró el restaurante activo.' }
    }

    if (!auth.can('settings.manage')) {
      return { ok: false, message: 'Tu rol no tiene permiso para cambiar la moneda del restaurante.' }
    }

    try {
      await saveRestaurantCurrency(restaurantId, code)
      updateSettings({ currency: code })
      return { ok: true, currency: code }
    } catch (error) {
      return { ok: false, message: error?.message || 'No se pudo guardar la moneda en Supabase.' }
    }
  }, [auth.isDesignMode, auth.permissions, restaurantId, updateSettings])

  const setInventoryStockControl = useCallback(async (enabled) => {
    const nextEnabled = Boolean(enabled)

    if (auth.isDesignMode) {
      updateSettings({ blockInsufficientInventory: nextEnabled })
      setInventoryAvailability((current) => ({
        ...current,
        enforcementEnabled: nextEnabled,
      }))
      return { ok: true, enabled: nextEnabled }
    }

    if (!restaurantId) {
      return { ok: false, message: 'No se encontró el restaurante activo.' }
    }

    if (!auth.can('settings.manage')) {
      return { ok: false, message: 'Tu rol no puede cambiar el control de inventario.' }
    }

    try {
      await saveInventoryStockControl(restaurantId, nextEnabled)
      updateSettings({ blockInsufficientInventory: nextEnabled })
      setInventoryAvailability((current) => ({
        ...current,
        enforcementEnabled: nextEnabled,
      }))
      return { ok: true, enabled: nextEnabled }
    } catch (error) {
      return {
        ok: false,
        message: error?.message || 'No se pudo guardar el control de disponibilidad.',
      }
    }
  }, [auth.isDesignMode, auth.permissions, restaurantId, updateSettings])

  const setOperationalBehavior = useCallback(async ({ allowPager, splitStations }) => {
    const nextAllowPager = allowPager == null
      ? state.settings.allowPager !== false
      : Boolean(allowPager)
    const nextSplitStations = splitStations == null
      ? state.settings.splitStations !== false
      : Boolean(splitStations)

    if (auth.isDesignMode) {
      updateSettings({
        allowPager: nextAllowPager,
        splitStations: nextSplitStations,
      })
      return {
        ok: true,
        allowPager: nextAllowPager,
        splitStations: nextSplitStations,
      }
    }

    if (!restaurantId) {
      return { ok: false, message: 'No se encontró el restaurante activo.' }
    }

    if (!auth.can('settings.manage')) {
      return { ok: false, message: 'Tu rol no puede cambiar la configuración operativa.' }
    }

    try {
      const saved = await saveOperationalBehaviorSettings(restaurantId, {
        pagerEnabled: nextAllowPager,
        separateKitchenBar: nextSplitStations,
      })

      updateSettings({
        allowPager: saved.pager_enabled !== false,
        splitStations: saved.separate_kitchen_bar !== false,
      })

      return {
        ok: true,
        allowPager: saved.pager_enabled !== false,
        splitStations: saved.separate_kitchen_bar !== false,
      }
    } catch (error) {
      return {
        ok: false,
        message: error?.message || 'No se pudo guardar la configuración operativa.',
      }
    }
  }, [
    auth.isDesignMode,
    auth.permissions,
    restaurantId,
    state.settings.allowPager,
    state.settings.splitStations,
    updateSettings,
  ])


  const resetDemo = useCallback(() => {
    if (!auth.isDesignMode) {
      return {
        ok: false,
        message: 'Restablecer demo está deshabilitado en una sesión real para proteger los datos del restaurante.',
      }
    }

    const fresh = createInitialDemoState()
    OLD_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key))
    if (draftStorageKey) localStorage.removeItem(draftStorageKey)
    persist(fresh)
    setOrderModeState(fresh.settings.defaultOrderMode)
    setCurrentTableId(null)
    setCurrentOrderId(null)
    setDraft([])
    setPager('')
    setQuickCustomerName('')
    setCurrentDelivery(null)
    setTableOrderSessions([])
    setTableDrafts({})
    draftContextTableIdRef.current = null
    draftContextServiceKeyRef.current = null
    setProducts(DEMO_PRODUCTS)
    setMenuCategories([])
    setMenuStations([])
    setInventoryAvailability({
      enforcementEnabled: fresh.settings.blockInsufficientInventory !== false,
      byProduct: {},
      generatedAt: null,
    })
    return { ok: true }
  }, [persist, auth.isDesignMode, draftStorageKey])

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
    locations,
    activeLocation,
    switchLocation,
    remoteLoading,
    remoteError,
    operationalSummary,
    voidRequestsVersion,
    tableOrderSessions,
    tableDrafts,
    inventoryAvailability,
    refreshMenu,
    refreshInventoryAvailability,
    refreshRemoteData,
    refreshOperationalData,
    refreshOperationalOrdersByIds,
    refreshOperationalSummary,
    refreshTableOrderSessions,
    currencyCode,
    formatMoney,
    setCurrency,
    setInventoryStockControl,
    setOperationalBehavior,
    orderMode,
    currentTableId,
    currentOrderId,
    currentOrder,
    currentDelivery,
    draft,
    pager,
    setPager,
    quickCustomerName,
    setQuickCustomerName,
    setOrderMode,
    openTable,
    touchTableDraftSession,
    releaseTableDraftSession,
    canReleaseTableDraftSession,
    abandonTableDraftSession,
    startQuickOrder,
    updateQuickOrderIdentity,
    releaseEmptyQuickOrder,
    startDelivery,
    openQuickOrder,
    openDelivery,
    startNewOrder,
    addProduct,
    changeDraftQuantity,
    removeDraft,
    updateDraftNote,
    sendDraft,
    applyKitchenApprovedVoidRequest,
    voidPaidTableAccount,
    advanceStationRound,
    markRoundDelivered,
    transferCurrentTable,
    joinTable,
    tableLabel,
    getTableTransferStatus,
    getTableVisualStatus,
    tableSessionForTable,
    tableDraftForTable,
    getTableDraftCount,
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
    state, products, menuCategories, menuStations, locations, activeLocation, switchLocation, remoteLoading, remoteError,
    operationalSummary, voidRequestsVersion, tableOrderSessions, tableDrafts, inventoryAvailability,
    refreshMenu, refreshInventoryAvailability, refreshRemoteData, refreshOperationalData, refreshOperationalOrdersByIds,
    refreshOperationalSummary, refreshTableOrderSessions, currencyCode, formatMoney, setCurrency, setInventoryStockControl, setOperationalBehavior, orderMode, currentTableId, currentOrderId, currentOrder, currentDelivery, draft, pager, quickCustomerName,
    setOrderMode, openTable, touchTableDraftSession, releaseTableDraftSession, canReleaseTableDraftSession, abandonTableDraftSession, startQuickOrder, updateQuickOrderIdentity, releaseEmptyQuickOrder, startDelivery, openQuickOrder, openDelivery, startNewOrder, addProduct, changeDraftQuantity, removeDraft,
    updateDraftNote, sendDraft, applyKitchenApprovedVoidRequest, voidPaidTableAccount,
    advanceStationRound, markRoundDelivered,
    transferCurrentTable, joinTable, tableLabel, getTableTransferStatus, getTableVisualStatus,
    tableSessionForTable, tableDraftForTable, getTableDraftCount,
    addZone, updateZone, deleteZone, addTable, updateTable, deleteTable,
    recordPayment, recordPayments, updateSettings, setCurrency, setInventoryStockControl,
    resetDemo, stationJobs, openOrderForTable,
  ])

  return <RestaurantContext.Provider value={value}>{children}</RestaurantContext.Provider>
}

export function useRestaurant() {
  const context = useContext(RestaurantContext)
  if (!context) throw new Error('useRestaurant must be used inside RestaurantProvider')
  return context
}
