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
    .select('id,full_name,email,username,access_status')
    .eq('id', user.id)
    .single()

  if (profileError) throw profileError

  if ((profile.access_status || 'pending') !== 'active') {
    return { profile, status: profile.access_status || 'pending', active: false }
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
  if (!membership) return { profile, status: 'missing_membership', active: false }

  const [roleResult, restaurantResult, permissionResult] = await Promise.all([
    client.from('roles').select('id,name').eq('id', membership.role_id).single(),
    client.from('restaurants').select('id,name').eq('id', membership.restaurant_id).single(),
    client.from('role_permissions').select('permission_code').eq('role_id', membership.role_id),
  ])

  if (roleResult.error) throw roleResult.error
  if (restaurantResult.error) throw restaurantResult.error
  if (permissionResult.error) throw permissionResult.error

  return {
    active: true,
    status: 'active',
    profile,
    membership,
    role: roleResult.data,
    restaurant: restaurantResult.data,
    permissions: permissionResult.data?.map((row) => row.permission_code) || [],
  }
}

export function subscribeToAuth(callback) {
  if (!supabase) return () => {}
  const { data } = supabase.auth.onAuthStateChange(callback)
  return () => data.subscription.unsubscribe()
}
