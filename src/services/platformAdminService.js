import { supabase } from '../lib/supabase.js'

function requireSupabase() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}

export async function loadPlatformCompanies() {
  const client = requireSupabase()
  const [requestsResult, companiesResult] = await Promise.all([
    client.rpc('list_platform_company_requests'),
    client.rpc('list_platform_companies'),
  ])

  if (requestsResult.error) throw requestsResult.error
  if (companiesResult.error) throw companiesResult.error

  return {
    requests: Array.isArray(requestsResult.data) ? requestsResult.data : [],
    companies: Array.isArray(companiesResult.data) ? companiesResult.data : [],
  }
}

export async function approveCompanyRegistration(requestId) {
  const { data, error } = await requireSupabase().rpc('approve_company_registration_request', {
    p_request_id: requestId,
  })
  if (error) throw error
  return data
}

export async function rejectCompanyRegistration(requestId, reason = '') {
  const { data, error } = await requireSupabase().rpc('reject_company_registration_request', {
    p_request_id: requestId,
    p_reason: reason || null,
  })
  if (error) throw error
  return data
}


export async function updatePlatformCompanySubscription({
  restaurantId,
  subscriptionStartedAt,
  allowedBranchCount,
}) {
  const { data, error } = await requireSupabase().rpc('update_platform_company_subscription', {
    p_restaurant_id: restaurantId,
    p_subscription_started_at: subscriptionStartedAt,
    p_allowed_branch_count: Number(allowedBranchCount),
  })
  if (error) throw error
  return data
}
