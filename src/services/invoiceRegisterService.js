import { isSupabaseConfigured, supabase } from '../lib/supabase.js'

export async function listPaidInvoices(restaurantId, filters = {}) {
  if (!isSupabaseConfigured || !supabase) return []
  const { data, error } = await supabase.rpc('list_paid_invoices', {
    p_restaurant_id: restaurantId,
    p_from: filters.from || null,
    p_to: filters.to || null,
    p_voided: filters.status === 'voided' ? true : filters.status === 'valid' ? false : null,
  })
  if (error) throw error
  return data || []
}

export async function loadCompanyProfile(restaurantId) {
  if (!isSupabaseConfigured || !supabase) return null
  const { data, error } = await supabase.from('company_profiles').select('*').eq('restaurant_id', restaurantId).maybeSingle()
  if (error) throw error
  return data
}

export async function saveCompanyProfile(profile) {
  const { data, error } = await supabase.from('company_profiles').upsert(profile, { onConflict: 'restaurant_id' }).select('*').single()
  if (error) throw error
  return data
}
