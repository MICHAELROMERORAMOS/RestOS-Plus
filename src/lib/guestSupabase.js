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


/**
 * Checks the public GoTrue runtime configuration before starting browser OAuth.
 * Prevents sending guests to the unbranded "provider is not enabled" error page.
 * This endpoint exposes only provider enablement flags, never credentials.
 */
export async function getGuestOAuthProviders() {
  if (!url || !publishableKey) throw new Error('Autenticación no configurada.')
  const response = await fetch(`${url.replace(/\/$/, '')}/auth/v1/settings`, {
    headers: { apikey: publishableKey },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('No fue posible verificar los proveedores de acceso.')
  const settings = await response.json()
  return {
    google: settings?.external?.google === true,
    apple: settings?.external?.apple === true,
  }
}
