import { isSupabaseConfigured, supabase } from '../lib/supabase.js'

function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase no está disponible en este entorno.')
  }
  return supabase
}

function asNumber(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

function asTimestamp(value) {
  if (!value) return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

function mapItemStatus(status) {
  if (status === 'preparing') return 'preparing'
  if (status === 'ready') return 'ready'
  if (status === 'served') return 'delivered'
  return 'new'
}

function deriveFrontendOrderStatus(raw, rounds) {
  if (asNumber(raw.refund_due) > 0.005 && raw.account_void_scope !== 'paid') return 'refund_due'
  if (raw.status === 'cancelled') return 'cancelled'

  const items = rounds.flatMap((round) => round.items || []).filter((item) => !item.voided)
  const pendingPreparation = items.some((item) => ['new', 'preparing'].includes(item.prepStatus))
  const allPrepared = items.length > 0 && items.every((item) => ['ready', 'delivered'].includes(item.prepStatus))
  const allDelivered = items.length > 0 && items.every((item) => item.prepStatus === 'delivered')
  const waitingForHandoff = items.some((item) => item.prepStatus === 'ready')

  if (raw.payment_status === 'paid' && pendingPreparation) return 'waiting_food'
  if (raw.payment_status === 'paid' && waitingForHandoff && !allDelivered) return 'ready'
  if (raw.status === 'closed') return 'closed'
  if (allPrepared && raw.payment_status !== 'paid') return 'pay'
  if (raw.status === 'awaiting_payment') return 'pay'
  if (raw.status === 'draft') return 'draft'
  return 'open'
}

export function isOperationalOrder(order) {
  if (!order) return false
  if (asNumber(order.refundDue) > 0.005) return true
  return !['closed', 'cancelled', 'merged'].includes(order.status)
}

function mapOperationalSummary(payload) {
  return {
    salesToday: asNumber(payload?.sales_today),
    completedOrdersToday: asNumber(payload?.completed_orders_today),
    tableReleases: Array.isArray(payload?.table_releases)
      ? payload.table_releases.map((release) => ({
          tableId: release.table_id,
          releasedAt: asTimestamp(release.released_at),
        }))
      : [],
  }
}

function mapOperationalOrders(payload) {
  const rawOrders = Array.isArray(payload?.orders) ? payload.orders : []
  const numberByServerId = new Map(
    rawOrders.map((order) => [String(order.id), Number(order.order_number)]),
  )

  return rawOrders.map((raw) => {
    const rounds = (raw.rounds || []).map((round) => ({
      id: Number(round.round_number),
      serverId: round.id,
      created: asTimestamp(round.sent_at || round.created_at) || Date.now(),
      status: round.status,
      items: (round.items || []).map((item) => ({
        lineId: item.id,
        productId: item.product_id,
        stationId: item.station_id,
        name: item.product_name,
        price: asNumber(item.unit_price),
        taxRate: asNumber(item.tax_rate),
        station: item.station_type === 'bar' ? 'bar' : 'kitchen',
        quantity: asNumber(item.quantity),
        note: item.note || '',
        prepStatus: mapItemStatus(item.status),
        voided: item.status === 'cancelled',
        voidReason: item.cancel_reason || '',
        voidedAt: asTimestamp(item.cancelled_at),
      })),
    }))

    const payments = (raw.payments || [])
      .filter((payment) => payment.status !== 'voided')
      .map((payment) => ({
        id: payment.id,
        paymentNumber: payment.payment_number,
        amount: asNumber(payment.amount),
        method: payment.method,
        created: asTimestamp(payment.paid_at) || Date.now(),
        type: payment.status === 'refunded' ? 'refund' : 'payment',
        itemAllocations: (payment.item_allocations || []).map((allocation) => ({
          lineId: allocation.line_id,
          sourceOrderId: Number(allocation.source_order_number)
            || numberByServerId.get(String(allocation.source_order_id))
            || allocation.source_order_id,
          quantity: asNumber(allocation.quantity),
          unitPrice: asNumber(allocation.unit_price),
          name: allocation.name,
          amount: asNumber(allocation.amount),
        })),
      }))

    const deliveryDetails = raw.delivery_details || null
    const delivery = deliveryDetails
      ? {
          customerId: raw.customer_id || null,
          customerName: deliveryDetails.customerName || raw.customer_name || '',
          address: deliveryDetails.address || '',
          phone: deliveryDetails.phone || '',
          email: deliveryDetails.email || null,
          neighborhood: deliveryDetails.neighborhood || '',
          city: deliveryDetails.city || '',
        }
      : null

    return {
      id: Number(raw.order_number),
      serverId: raw.id,
      mode: raw.service_mode === 'counter' ? 'quick' : raw.service_mode,
      customerId: raw.customer_id || null,
      customerName: raw.customer_name || '',
      invoiceCustomer: raw.invoice_customer || null,
      tableIds: raw.table_ids || [],
      pager: raw.pager_number || null,
      delivery,
      deliveryStatus: raw.delivery_status || null,
      rounds,
      payments,
      paidTotal: asNumber(raw.paid_total),
      serverTotal: asNumber(raw.total),
      refundDue: asNumber(raw.refund_due),
      status: deriveFrontendOrderStatus(raw, rounds),
      paymentStatus: raw.payment_status,
      paymentTiming: raw.payment_timing,
      created: asTimestamp(raw.opened_at) || Date.now(),
      closedAt: asTimestamp(raw.closed_at),
      invoiceIssuedAt: asTimestamp(raw.invoice_issued_at),
      invoiceNumber: raw.invoice_number || null,
      invoiceVoidedAt: asTimestamp(raw.invoice_voided_at),
      fiscalCorrectionRequired: Boolean(raw.fiscal_correction_required),
      accountVoidReason: raw.account_void_reason || null,
      accountVoidedAt: asTimestamp(raw.account_voided_at),
      accountVoidAuditId: raw.account_void_audit_id || null,
      accountVoidScope: raw.account_void_scope || null,
    }
  })
}

export async function loadOperationalState(restaurantId, locationId) {
  const client = requireSupabase()

  const [operationalResult, summaryResult] = await Promise.all([
    client.rpc('load_operational_state', {
      p_restaurant_id: restaurantId,
      p_location_id: locationId,
    }),
    client.rpc('load_operational_summary', {
      p_restaurant_id: restaurantId,
      p_location_id: locationId,
    }),
  ])

  if (operationalResult.error) throw operationalResult.error
  if (summaryResult.error) throw summaryResult.error
  return {
    orders: mapOperationalOrders(operationalResult.data || {}),
    summary: mapOperationalSummary(summaryResult.data || {}),
  }
}

export async function loadOperationalSummary(restaurantId, locationId) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('load_operational_summary', {
    p_restaurant_id: restaurantId,
    p_location_id: locationId,
  })

  if (error) throw error
  return mapOperationalSummary(data || {})
}

export async function loadOperationalHistory(
  restaurantId,
  locationId,
  { mode = null, before = null, limit = 50 } = {},
) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('load_operational_history', {
    p_restaurant_id: restaurantId,
    p_location_id: locationId,
    p_service_mode: mode,
    p_before: before || null,
    p_limit: limit,
  })

  if (error) throw error
  return {
    orders: mapOperationalOrders(data || {})
      .filter((order) => !isOperationalOrder(order))
      .sort((left, right) => (right.closedAt || right.created || 0) - (left.closedAt || left.created || 0)),
    hasMore: Boolean(data?.has_more),
    nextBefore: data?.next_before || null,
  }
}

export async function loadOperationalOrdersByIds(restaurantId, locationId, orderIds) {
  const client = requireSupabase()
  const ids = Array.from(new Set((orderIds || []).filter(Boolean)))
  if (!ids.length) return { orders: [] }

  const { data, error } = await client.rpc('load_operational_orders_by_ids', {
    p_restaurant_id: restaurantId,
    p_location_id: locationId,
    p_order_ids: ids,
  })

  if (error) throw error
  return {
    orders: mapOperationalOrders(data || {}),
  }
}

export async function createDeliveryOrderRemote({
  restaurantId,
  locationId,
  customerId,
  customerName,
  delivery,
}) {
  const client = requireSupabase()

  const { data, error } = await client.rpc('create_delivery_order', {
    p_restaurant_id: restaurantId,
    p_location_id: locationId,
    p_customer_id: customerId || null,
    p_customer_name: customerName,
    p_delivery_details: delivery,
  })

  if (error) throw error
  return data
}

export async function sendOrderRoundRemote({
  orderServerId,
  restaurantId,
  locationId,
  mode,
  tableIds,
  customerId,
  customerName,
  delivery,
  pager,
  items,
  prepaid = false,
  paymentMethod = 'card',
}) {
  const client = requireSupabase()

  const { data, error } = await client.rpc('send_order_round', {
    p_order_id: orderServerId || null,
    p_restaurant_id: restaurantId,
    p_location_id: locationId,
    p_service_mode: mode === 'quick' ? 'counter' : mode,
    p_payment_timing: prepaid ? 'prepaid' : 'postpaid',
    p_table_ids: tableIds || [],
    p_customer_id: customerId || null,
    p_customer_name: customerName || null,
    p_delivery_details: delivery || null,
    p_pager_number: pager || null,
    p_items: (items || []).map((item) => ({
      productId: item.productId,
      quantity: Number(item.quantity || 0),
      note: item.note || '',
    })),
    p_prepaid: Boolean(prepaid),
    p_payment_method: paymentMethod === 'cash/card' ? 'card' : paymentMethod,
  })

  if (error) throw error
  return data
}

export async function advanceStationRoundRemote(orderServerId, roundServerId, station) {
  const client = requireSupabase()

  const { data, error } = await client.rpc('advance_station_round', {
    p_order_id: orderServerId,
    p_round_id: roundServerId,
    p_station_type: station,
  })

  if (error) throw error
  return data
}

export async function markRoundServedRemote(orderServerId, roundServerId) {
  const client = requireSupabase()

  const { error } = await client.rpc('mark_round_served', {
    p_order_id: orderServerId,
    p_round_id: roundServerId,
  })

  if (error) throw error
  return { ok: true }
}

export async function transferOrderTableRemote(orderServerId, fromTableId, toTableId) {
  const client = requireSupabase()

  const { error } = await client.rpc('transfer_order_table', {
    p_order_id: orderServerId,
    p_from_table_id: fromTableId,
    p_to_table_id: toTableId,
  })

  if (error) throw error
  return { ok: true }
}

export async function joinOrderTableRemote(orderServerId, tableId) {
  const client = requireSupabase()

  const { error } = await client.rpc('join_order_table', {
    p_order_id: orderServerId,
    p_table_id: tableId,
  })

  if (error) throw error
  return { ok: true }
}

export async function recordOrderPaymentsRemote(allocations, method, invoiceCustomer = null) {
  const client = requireSupabase()

  const { data, error } = await client.rpc('record_order_payments', {
    p_allocations: allocations,
    p_method: method,
    p_invoice_customer: invoiceCustomer,
  })

  if (error) throw error
  return data || { applied: 0 }
}

export function subscribeOperationalChanges(restaurantId, locationId, onChange) {
  const client = requireSupabase()
  const channel = client.channel(`restos-operational:${locationId}`)
  const emit = (table) => (payload) => onChange?.({ ...payload, table: payload.table || table })

  channel
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'orders',
      filter: `location_id=eq.${locationId}`,
    }, emit('orders'))
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'payments',
      filter: `location_id=eq.${locationId}`,
    }, emit('payments'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_table_links' }, emit('order_table_links'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_rounds' }, emit('order_rounds'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, emit('order_items'))
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'kitchen_void_requests',
      filter: `restaurant_id=eq.${restaurantId}`,
    }, emit('kitchen_void_requests'))
    .subscribe()

  return channel
}

export async function unsubscribeOperationalChanges(channel) {
  if (!channel || !supabase) return
  await supabase.removeChannel(channel)
}
