import { supabase } from '../lib/supabase.js'

function requireSupabase() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}

function toTimestamp(value) {
  if (!value) return null
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

function mapBlockers(raw) {
  return {
    canClose: Boolean(raw?.can_close),
    pendingKitchenBarItems: Number(raw?.pending_kitchen_bar_items || 0),
    unpaidOrders: Number(raw?.unpaid_orders || 0),
    activeOrders: Number(raw?.active_orders || 0),
    occupiedTables: Number(raw?.occupied_tables || 0),
    tableOrderSessions: Number(raw?.table_order_sessions || 0),
    quickOrders: Number(raw?.quick_orders || 0),
    deliveryOrders: Number(raw?.delivery_orders || 0),
    refundDueOrders: Number(raw?.refund_due_orders || 0),
  }
}

function mapShift(raw) {
  if (!raw) return null
  return {
    id: raw.id,
    shiftNumber: Number(raw.shift_number || 0),
    status: raw.status,
    openedAt: toTimestamp(raw.opened_at),
    openedByName: raw.opened_by_name || 'Inicio automático',
    closedAt: toTimestamp(raw.closed_at),
    closedByName: raw.closed_by_name || null,
    closeNote: raw.close_note || '',
    salesTotal: Number(raw.sales_total || 0),
    paymentCount: Number(raw.payment_count || 0),
    cashTotal: Number(raw.cash_total || 0),
    cardTotal: Number(raw.card_total || 0),
    transferTotal: Number(raw.transfer_total || 0),
    otherTotal: Number(raw.other_total || 0),
    invoiceCount: Number(raw.invoice_count || 0),
    completedOrderCount: Number(raw.completed_order_count || 0),
    blockers: mapBlockers(raw.blockers),
  }
}

export async function loadCurrentShift(restaurantId, locationId) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_current_shift', {
    p_restaurant_id: restaurantId,
    p_location_id: locationId,
  })
  if (error) throw error
  return mapShift(data)
}

export async function closeCurrentShift(restaurantId, locationId, note = '') {
  const client = requireSupabase()
  const { data, error } = await client.rpc('close_current_shift', {
    p_restaurant_id: restaurantId,
    p_location_id: locationId,
    p_note: note || null,
  })
  if (error) throw error
  return {
    closedShift: mapShift(data?.closed_shift),
    currentShift: mapShift(data?.current_shift),
  }
}

export async function loadShiftHistory(restaurantId, locationId, limit = 20) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('load_shift_history', {
    p_restaurant_id: restaurantId,
    p_location_id: locationId,
    p_limit: limit,
  })
  if (error) throw error
  return Array.isArray(data) ? data.map(mapShift) : []
}
