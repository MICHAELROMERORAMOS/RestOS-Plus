import { isSupabaseConfigured, supabase } from '../lib/supabase.js'

function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase no está disponible en este entorno.')
  }
  return supabase
}

export function normalizePhone(value) {
  return String(value || '').replace(/\D+/g, '')
}

export async function findCustomerByPhone(restaurantId, phone) {
  const client = requireSupabase()
  const normalized = normalizePhone(phone)
  if (!restaurantId || !normalized) return null

  const { data, error } = await client.rpc('find_customer_by_phone', {
    p_restaurant_id: restaurantId,
    p_phone: phone,
  })

  if (error) throw error
  return Array.isArray(data) ? (data[0] || null) : (data || null)
}

export async function upsertCustomerByPhone(restaurantId, customer) {
  const client = requireSupabase()

  const { data, error } = await client.rpc('upsert_customer_by_phone', {
    p_restaurant_id: restaurantId,
    p_full_name: customer.full_name ?? customer.customerName ?? '',
    p_phone: customer.phone ?? '',
    p_email: customer.email || null,
    p_address: customer.address || null,
    p_neighborhood: customer.neighborhood || null,
    p_city: customer.city || null,
  })

  if (error) throw error
  return Array.isArray(data) ? (data[0] || null) : (data || null)
}

export async function listCustomers(restaurantId, phoneFilter = '') {
  const client = requireSupabase()
  if (!restaurantId) return []

  let query = client
    .from('customers')
    .select('id,restaurant_id,full_name,email,phone,phone_normalized,address,neighborhood,city,active,created_at,updated_at')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
    .order('full_name', { ascending: true })
    .limit(200)

  const normalized = normalizePhone(phoneFilter)
  if (normalized) {
    query = query.ilike('phone_normalized', `%${normalized}%`)
  }

  const { data, error } = await query
  if (error) throw error
  return data || []
}
