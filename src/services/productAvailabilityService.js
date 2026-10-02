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
    // Use generic error below.
  }
  return error.message || 'No se pudo completar la operación.'
}

export async function requestProductUnavailability({
  restaurantId,
  locationId,
  productId,
  reason,
  durationMinutes,
}) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke('request-product-unavailability', {
    body: {
      restaurantId,
      locationId,
      productId,
      reason: String(reason || '').trim(),
      durationMinutes: Number(durationMinutes || 0),
    },
  })

  if (error) throw new Error(await functionErrorMessage(error))
  if (data?.error) throw new Error(data.error)
  return data
}

export async function consumeProductUnavailabilityAuthorization({ requestId, code }) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('consume_product_unavailability_authorization', {
    p_request_id: requestId,
    p_code: String(code || '').trim(),
  })

  if (error) throw error
  return data
}

export async function listMyPendingProductUnavailabilityRequests({
  restaurantId,
  locationId,
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('list_my_pending_product_unavailability', {
    p_restaurant_id: restaurantId,
    p_location_id: locationId,
  })

  if (error) throw error
  return data || []
}
