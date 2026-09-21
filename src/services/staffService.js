import { isSupabaseConfigured, supabase } from '../lib/supabase.js'

function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase no está disponible en este entorno.')
  }
  return supabase
}

export async function loadStaffAdminData(restaurantId) {
  const client = requireSupabase()
  if (!restaurantId) throw new Error('No se encontró el restaurante activo.')

  const [requestsResult, rolesResult, locationsResult, membersResult] = await Promise.all([
    client
      .from('access_requests')
      .select('id,user_id,restaurant_id,status,requested_at')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'pending')
      .order('requested_at', { ascending: true }),
    client
      .from('roles')
      .select('id,name,description,active')
      .eq('restaurant_id', restaurantId)
      .eq('active', true)
      .order('name'),
    client
      .from('locations')
      .select('id,name,code,active')
      .eq('restaurant_id', restaurantId)
      .eq('active', true)
      .order('name'),
    client.rpc('list_staff_members', {
      p_restaurant_id: restaurantId,
    }),
  ])

  if (requestsResult.error) throw requestsResult.error
  if (rolesResult.error) throw rolesResult.error
  if (locationsResult.error) throw locationsResult.error
  if (membersResult.error) throw membersResult.error

  const requests = requestsResult.data || []
  let profiles = []

  if (requests.length) {
    const profileResult = await client
      .from('profiles')
      .select('id,full_name,email,phone,username,access_status')
      .in('id', requests.map((request) => request.user_id))

    if (profileResult.error) throw profileResult.error
    profiles = profileResult.data || []
  }

  const profileById = new Map(profiles.map((profile) => [profile.id, profile]))

  return {
    requests: requests.map((request) => ({
      ...request,
      profile: profileById.get(request.user_id) || null,
    })),
    roles: rolesResult.data || [],
    locations: locationsResult.data || [],
    members: Array.isArray(membersResult.data) ? membersResult.data : [],
  }
}

export async function approveAccessRequest({ requestId, roleId, locationId = null }) {
  const client = requireSupabase()
  return client.rpc('approve_access_request', {
    p_request_id: requestId,
    p_role_id: roleId,
    p_location_id: locationId || null,
  })
}

export async function rejectAccessRequest(requestId) {
  const client = requireSupabase()
  return client.rpc('reject_access_request', {
    p_request_id: requestId,
  })
}

export async function updateStaffMember({
  restaurantId,
  membershipId,
  fullName,
  username,
  phone,
  roleId,
  status,
  allLocations,
  locationIds,
}) {
  const client = requireSupabase()
  return client.rpc('update_staff_member', {
    p_restaurant_id: restaurantId,
    p_membership_id: membershipId,
    p_full_name: fullName,
    p_username: username,
    p_phone: phone || null,
    p_role_id: roleId,
    p_status: status,
    p_all_locations: Boolean(allLocations),
    p_location_ids: allLocations ? [] : locationIds,
  })
}
