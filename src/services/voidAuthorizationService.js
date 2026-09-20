import { isSupabaseConfigured, supabase } from '../lib/supabase.js'

function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase no está disponible en este entorno.')
  }
  return supabase
}

async function functionErrorMessage(error) {
  if (!error) return 'No se pudo completar la operación.'

  try {
    const response = error.context
    if (response?.clone) {
      const payload = await response.clone().json()
      if (payload?.error) return payload.error
    }
  } catch {
    // Fall through to the generic message.
  }

  return error.message || 'No se pudo completar la operación.'
}

export async function createKitchenVoidRequest({
  restaurantId,
  orderRef,
  tableLabel,
  items,
  reason,
}) {
  const client = requireSupabase()

  const { data, error } = await client.rpc('create_kitchen_void_request', {
    p_restaurant_id: restaurantId,
    p_order_ref: String(orderRef),
    p_table_label: tableLabel || null,
    p_items: items,
    p_reason: reason,
  })

  if (error) throw error
  return data
}

export async function listPendingKitchenVoidRequests(restaurantId) {
  const client = requireSupabase()

  const { data, error } = await client.rpc('list_pending_kitchen_void_requests', {
    p_restaurant_id: restaurantId,
  })

  if (error) throw error
  return data || []
}

export async function reviewKitchenVoidRequest(requestId, decision, note = '') {
  const client = requireSupabase()

  const { data, error } = await client.rpc('review_kitchen_void_request', {
    p_request_id: requestId,
    p_decision: decision,
    p_note: note || null,
  })

  if (error) throw error
  return data
}

export async function listMyKitchenVoidRequests(restaurantId, orderRef) {
  const client = requireSupabase()

  const { data, error } = await client.rpc('list_my_kitchen_void_requests', {
    p_restaurant_id: restaurantId,
    p_order_ref: String(orderRef),
  })

  if (error) throw error
  return data || []
}

export async function markKitchenVoidRequestApplied(requestId) {
  const client = requireSupabase()

  const { error } = await client.rpc('mark_kitchen_void_request_applied', {
    p_request_id: requestId,
  })

  if (error) throw error
  return { ok: true }
}

export async function requestAccountVoidAuthorization({
  restaurantId,
  orderRef,
  tableLabel,
  amountPaid,
  reason,
}) {
  const client = requireSupabase()

  const { data, error } = await client.functions.invoke('request-void-authorization', {
    body: {
      restaurantId,
      orderRef: String(orderRef),
      tableLabel,
      amountPaid: Number(amountPaid || 0),
      reason,
    },
  })

  if (error) throw new Error(await functionErrorMessage(error))
  if (data?.error) throw new Error(data.error)
  return data
}

export async function consumeAccountVoidAuthorization({
  requestId,
  code,
  orderRef,
  tableLabel,
  items,
  reason,
  amountPaid,
}) {
  const client = requireSupabase()

  const { data, error } = await client.rpc('consume_account_void_authorization', {
    p_request_id: requestId,
    p_code: String(code || '').trim(),
    p_order_ref: String(orderRef),
    p_table_label: tableLabel || null,
    p_items: items,
    p_reason: reason,
    p_amount_paid: Number(amountPaid || 0),
  })

  if (error) throw error
  return data
}

export async function sendAccountVoidConfirmation(auditId) {
  const client = requireSupabase()

  const { data, error } = await client.functions.invoke('confirm-account-void', {
    body: { auditId },
  })

  if (error) throw new Error(await functionErrorMessage(error))
  if (data?.error) throw new Error(data.error)
  return data
}
