import { supabase } from '../lib/supabase.js'

function requireSupabase() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}

export async function loadCompanyBranches(restaurantId) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('load_company_branches', {
    p_restaurant_id: restaurantId,
  })
  if (error) throw error
  return {
    company: data?.company || null,
    branches: Array.isArray(data?.branches) ? data.branches : [],
  }
}

export async function saveCompanyBranch({
  restaurantId,
  branchId = null,
  name,
  code,
  addressLine1 = '',
  addressLine2 = '',
  city = '',
  country = '',
  phone = '',
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('save_company_branch', {
    p_restaurant_id: restaurantId,
    p_branch_id: branchId,
    p_name: name,
    p_code: code,
    p_address_line1: addressLine1 || null,
    p_address_line2: addressLine2 || null,
    p_city: city || null,
    p_country: country || null,
    p_phone: phone || null,
  })
  if (error) throw error
  return data
}

export async function setCompanyBranchActive({ restaurantId, branchId, active }) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('set_company_branch_active', {
    p_restaurant_id: restaurantId,
    p_branch_id: branchId,
    p_active: active,
  })
  if (error) throw error
  return Boolean(data)
}
