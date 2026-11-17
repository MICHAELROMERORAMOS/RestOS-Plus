import { createClient } from '@supabase/supabase-js'

// Customer credentials use separate browser storage from employee/admin sessions.
// Never expose privileged keys in the public menu.
const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

export const guestSupabase = url && publishableKey
  ? createClient(url, publishableKey, {
    auth: {
      storageKey: 'restosplus-qr-customer-auth',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
  })
  : null
