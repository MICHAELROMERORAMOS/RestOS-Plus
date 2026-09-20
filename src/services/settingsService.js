import { isSupabaseConfigured, supabase } from '../lib/supabase.js'

function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase no está disponible en este entorno.')
  }
  return supabase
}

export async function loadRestaurantSettings(restaurantId) {
  const client = requireSupabase()

  const { data, error } = await client
    .from('restaurant_settings')
    .select('restaurant_id,currency_code,default_service_mode,default_payment_timing,pager_enabled,tax_inclusive,service_charge_pct,allow_split_bill,allow_merge_tables,allow_table_transfer,extra,updated_at')
    .eq('restaurant_id', restaurantId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

export async function saveRestaurantCurrency(restaurantId, currencyCode) {
  const client = requireSupabase()
  const code = String(currencyCode || '').trim().toUpperCase()

  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error('Código de moneda inválido.')
  }

  const { data, error } = await client
    .from('restaurant_settings')
    .upsert({
      restaurant_id: restaurantId,
      currency_code: code,
    }, {
      onConflict: 'restaurant_id',
    })
    .select('restaurant_id,currency_code,updated_at')
    .single()

  if (error) throw error
  return data
}
