import { isSupabaseConfigured, supabase } from '../lib/supabase.js'

function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase no está disponible en este entorno.')
  }
  return supabase
}

export async function listDeliveryCouriers(restaurantId) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('list_delivery_couriers', {
    p_restaurant_id: restaurantId,
  })

  if (error) throw error
  return Array.isArray(data) ? data : []
}

export async function saveDeliveryCourier(restaurantId, courier) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('save_delivery_courier', {
    p_restaurant_id: restaurantId,
    p_name: String(courier?.name || '').trim(),
    p_phone: String(courier?.phone || '').trim(),
    p_address: String(courier?.address || '').trim(),
    p_company: String(courier?.company || '').trim(),
  })

  if (error) throw error
  return data
}

export async function assignDeliveryCourier(orderServerId, courierId) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('assign_delivery_courier', {
    p_order_id: orderServerId,
    p_courier_id: courierId,
  })

  if (error) throw error
  return data
}
