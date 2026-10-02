import { isSupabaseConfigured, supabase } from '../lib/supabase.js'

function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase todavía no está configurado en este entorno. Usa el modo diseño o crea tu archivo .env.')
  }
  return supabase
}

export async function signInWithPassword(email, password) {
  return requireSupabase().auth.signInWithPassword({ email, password })
}

export async function signUpWithPassword({ fullName, email, phone, username, password }) {
  return requireSupabase().auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName, phone, username } },
  })
}

export async function submitCompanyRegistration({
  companyName,
  legalName = '',
  taxId = '',
  verificationDigit = '',
  taxRegime = '',
  taxResponsibilities = '',
  address = '',
  city = '',
  region = '',
  country = '',
  companyPhone = '',
  companyEmail = '',
  currencyCode = 'COP',
  timezone = 'America/Bogota',
  primaryBranchName = 'Principal',
}) {
  const { data, error } = await requireSupabase().rpc('submit_company_registration', {
    p_company_name: companyName,
    p_legal_name: legalName,
    p_tax_id: taxId,
    p_verification_digit: verificationDigit,
    p_tax_regime: taxRegime,
    p_tax_responsibilities: taxResponsibilities,
    p_address: address,
    p_city: city,
    p_region: region,
    p_country: country,
    p_company_phone: companyPhone,
    p_company_email: companyEmail,
    p_currency_code: currencyCode,
    p_timezone: timezone,
    p_primary_branch_name: primaryBranchName,
  })
  if (error) throw error
  return data
}

export async function submitCompanyAccessRequest(joinCode) {
  const { data, error } = await requireSupabase().rpc('submit_company_access_request', {
    p_join_code: joinCode,
  })
  if (error) throw error
  return data
}

export async function loadMyOnboardingStatus() {
  const { data, error } = await requireSupabase().rpc('get_my_onboarding_status')
  if (error) throw error
  return data || { status: 'onboarding_required' }
}

export async function verifySignupOtp(email, token) {
  return requireSupabase().auth.verifyOtp({ email, token, type: 'email' })
}

export async function resendSignupOtp(email) {
  return requireSupabase().auth.resend({ type: 'signup', email })
}

export async function requestPasswordRecovery(email) {
  return requireSupabase().auth.resetPasswordForEmail(email)
}

export async function verifyRecoveryOtp(email, token) {
  return requireSupabase().auth.verifyOtp({ email, token, type: 'recovery' })
}

export async function updatePassword(password) {
  return requireSupabase().auth.updateUser({ password })
}

export async function signInWithGoogle() {
  const client = requireSupabase()
  const redirectTo = `${window.location.origin}${window.location.pathname}`
  return client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } })
}

export async function signOut() {
  if (!supabase) return { error: null }
  return supabase.auth.signOut()
}

export async function getAuthenticatedUser() {
  if (!supabase) return { data: { user: null }, error: null }
  return supabase.auth.getUser()
}

export async function loadUserAccess(user) {
  const client = requireSupabase()
  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('id,full_name,email,username,phone,access_status')
    .eq('id', user.id)
    .single()

  if (profileError) throw profileError

  if ((profile.access_status || 'pending') !== 'active') {
    if (profile.access_status === 'suspended') {
      return { profile, status: 'suspended', active: false }
    }

    const onboarding = await loadMyOnboardingStatus()
    return {
      profile,
      status: onboarding?.status || profile.access_status || 'pending',
      onboarding,
      active: false,
    }
  }

  const { data: membership, error: membershipError } = await client
    .from('memberships')
    .select('id,restaurant_id,role_id,status,all_locations')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (membershipError) throw membershipError
  if (!membership) {
    const onboarding = await loadMyOnboardingStatus()
    return {
      profile,
      status: onboarding?.status || 'missing_membership',
      onboarding,
      active: false,
    }
  }

  const [roleResult, restaurantResult, permissionResult, platformAdminResult] = await Promise.all([
    client.from('roles').select('id,name,company_scope').eq('id', membership.role_id).single(),
    client.from('restaurants').select('id,name').eq('id', membership.restaurant_id).single(),
    client.from('role_permissions').select('permission_code').eq('role_id', membership.role_id),
    client.rpc('is_platform_admin'),
  ])

  if (roleResult.error) throw roleResult.error
  if (restaurantResult.error) throw restaurantResult.error
  if (permissionResult.error) throw permissionResult.error
  if (platformAdminResult.error) throw platformAdminResult.error

  return {
    active: true,
    status: 'active',
    profile,
    membership,
    role: roleResult.data,
    restaurant: restaurantResult.data,
    platformAdmin: Boolean(platformAdminResult.data),
    permissions: permissionResult.data?.map((row) => row.permission_code) || [],
  }
}

export function subscribeToAuth(callback) {
  if (!supabase) return () => {}
  const { data } = supabase.auth.onAuthStateChange(callback)
  return () => data.subscription.unsubscribe()
}

export function subscribeToUserAccess(userId, callback) {
  if (!supabase || !userId) return () => {}

  const channel = supabase
    .channel(`restos-user-access:${userId}`)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'memberships',
      filter: `user_id=eq.${userId}`,
    }, callback)
    .subscribe()

  return () => {
    supabase.removeChannel(channel)
  }
}
