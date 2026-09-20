import { isSupabaseConfigured, supabase } from '../lib/supabase.js'

function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase no está disponible en este entorno.')
  }
  return supabase
}

async function functionErrorMessage(error) {
  if (!error) return 'No se pudo solicitar la autorización.'

  try {
    const response = error.context
    if (response?.clone) {
      const payload = await response.clone().json()
      if (payload?.error) return payload.error
    }
  } catch {
    // Fall back to the generic function error.
  }

  return error.message || 'No se pudo solicitar la autorización.'
}

export async function requestPaidVoidAuthorization({
  restaurantId,
  orderRef,
  lineRef,
  itemName,
  amount,
  reason,
  invoiceIssued = false,
}) {
  const client = requireSupabase()

  const { data, error } = await client.functions.invoke('request-void-authorization', {
    body: {
      restaurantId,
      orderRef: String(orderRef),
      lineRef: String(lineRef),
      itemName,
      amount: Number(amount || 0),
      reason,
      invoiceIssued,
    },
  })

  if (error) throw new Error(await functionErrorMessage(error))
  if (data?.error) throw new Error(data.error)
  return data
}

export async function consumePaidVoidAuthorization({
  requestId,
  code,
  orderRef,
  lineRef,
  itemName,
  amount,
  reason,
}) {
  const client = requireSupabase()

  const { data, error } = await client.rpc('consume_void_authorization', {
    p_request_id: requestId,
    p_code: String(code || '').trim(),
    p_order_ref: String(orderRef),
    p_line_ref: String(lineRef),
    p_item_name: itemName,
    p_amount: Number(amount || 0),
    p_reason: reason,
  })

  if (error) throw error
  return data
}

export async function logUnpaidKitchenVoid({
  restaurantId,
  orderRef,
  lineRef,
  itemName,
  amount,
  reason,
}) {
  const client = requireSupabase()

  const { data, error } = await client.rpc('log_unpaid_kitchen_void', {
    p_restaurant_id: restaurantId,
    p_order_ref: String(orderRef),
    p_line_ref: String(lineRef),
    p_item_name: itemName,
    p_amount: Number(amount || 0),
    p_reason: reason,
  })

  if (error) throw error
  return data
}
