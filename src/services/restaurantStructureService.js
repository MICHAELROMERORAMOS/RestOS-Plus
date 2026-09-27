import { isSupabaseConfigured, supabase } from '../lib/supabase.js'

function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase no está disponible en este entorno.')
  }
  return supabase
}

function clean(value) {
  return String(value || '').trim()
}

export async function loadRestaurantStructure(restaurantId, preferredLocationId = null) {
  const client = requireSupabase()

  const { data: locations, error: locationsError } = await client
    .from('locations')
    .select('id,restaurant_id,name,code,address_line1,address_line2,city,country,phone,active,created_at,updated_at')
    .eq('restaurant_id', restaurantId)
    .eq('active', true)
    .order('created_at', { ascending: true })

  if (locationsError) throw locationsError

  const availableLocations = (locations || []).map((location) => ({
    id: location.id,
    restaurantId: location.restaurant_id,
    name: location.name,
    code: location.code || '',
    addressLine1: location.address_line1 || '',
    addressLine2: location.address_line2 || '',
    city: location.city || '',
    country: location.country || '',
    phone: location.phone || '',
    active: location.active,
  }))

  const location = availableLocations.find(
    (candidate) => String(candidate.id) === String(preferredLocationId || ''),
  ) || availableLocations[0] || null

  if (!location) {
    return { location: null, locations: [], zones: [], tables: [] }
  }

  const [{ data: zones, error: zonesError }, { data: tables, error: tablesError }] = await Promise.all([
    client
      .from('dining_zones')
      .select('id,location_id,name,display_order,active,created_at,updated_at')
      .eq('location_id', location.id)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true }),
    client
      .from('dining_tables')
      .select('id,location_id,zone_id,code,name,capacity,shape,active,created_at,updated_at')
      .eq('location_id', location.id)
      .order('created_at', { ascending: true }),
  ])

  if (zonesError) throw zonesError
  if (tablesError) throw tablesError

  return {
    location,
    locations: availableLocations,
    zones: (zones || []).map((zone) => ({
      id: zone.id,
      locationId: zone.location_id,
      name: zone.name,
      displayOrder: zone.display_order,
      active: zone.active,
    })),
    tables: (tables || []).map((table) => ({
      id: table.id,
      locationId: table.location_id,
      zoneId: table.zone_id,
      code: table.code,
      name: table.name || table.code,
      capacity: Number(table.capacity || 2),
      shape: table.shape || 'square',
      active: table.active,
    })),
  }
}

export async function importLocalStructure(locationId, zones, tables) {
  const client = requireSupabase()
  const activeZones = (zones || []).filter((zone) => zone.active !== false)

  if (activeZones.length) {
    const { error } = await client.from('dining_zones').upsert(
      activeZones.map((zone, index) => ({
        id: zone.id,
        location_id: locationId,
        name: clean(zone.name),
        display_order: zone.displayOrder ?? index,
        active: true,
      })),
      { onConflict: 'id' },
    )
    if (error) throw error
  }

  const activeTables = (tables || []).filter((table) => table.active !== false)
  if (activeTables.length) {
    const { error } = await client.from('dining_tables').upsert(
      activeTables.map((table) => ({
        id: table.id,
        location_id: locationId,
        zone_id: table.zoneId,
        code: clean(table.code || table.name),
        name: clean(table.name || table.code),
        capacity: Math.max(1, Number(table.capacity || 2)),
        shape: table.shape || 'square',
        active: true,
      })),
      { onConflict: 'id' },
    )
    if (error) throw error
  }
}

export async function createZone(locationId, name, displayOrder = 0) {
  const client = requireSupabase()
  const { data, error } = await client
    .from('dining_zones')
    .insert({
      location_id: locationId,
      name: clean(name),
      display_order: Number(displayOrder || 0),
      active: true,
    })
    .select('id,location_id,name,display_order,active')
    .single()

  if (error) throw error

  return {
    id: data.id,
    locationId: data.location_id,
    name: data.name,
    displayOrder: data.display_order,
    active: data.active,
  }
}

export async function updateZone(zoneId, patch) {
  const client = requireSupabase()
  const payload = {}
  if (patch.name !== undefined) payload.name = clean(patch.name)
  if (patch.displayOrder !== undefined) payload.display_order = Number(patch.displayOrder || 0)
  if (patch.active !== undefined) payload.active = Boolean(patch.active)

  const { data, error } = await client
    .from('dining_zones')
    .update(payload)
    .eq('id', zoneId)
    .select('id,location_id,name,display_order,active')
    .single()

  if (error) throw error

  return {
    id: data.id,
    locationId: data.location_id,
    name: data.name,
    displayOrder: data.display_order,
    active: data.active,
  }
}

export async function createTable({ locationId, zoneId, name, capacity = 2 }) {
  const client = requireSupabase()
  const cleaned = clean(name)

  const { data, error } = await client
    .from('dining_tables')
    .insert({
      location_id: locationId,
      zone_id: zoneId,
      code: cleaned,
      name: cleaned,
      capacity: Math.max(1, Number(capacity || 2)),
      shape: 'square',
      active: true,
    })
    .select('id,location_id,zone_id,code,name,capacity,shape,active')
    .single()

  if (error) throw error

  return {
    id: data.id,
    locationId: data.location_id,
    zoneId: data.zone_id,
    code: data.code,
    name: data.name || data.code,
    capacity: Number(data.capacity || 2),
    shape: data.shape,
    active: data.active,
  }
}

export async function updateTable(tableId, patch) {
  const client = requireSupabase()
  const payload = {}

  if (patch.name !== undefined) {
    const cleaned = clean(patch.name)
    payload.name = cleaned
    payload.code = cleaned
  }
  if (patch.zoneId !== undefined) payload.zone_id = patch.zoneId
  if (patch.capacity !== undefined) payload.capacity = Math.max(1, Number(patch.capacity || 2))
  if (patch.active !== undefined) payload.active = Boolean(patch.active)

  const { data, error } = await client
    .from('dining_tables')
    .update(payload)
    .eq('id', tableId)
    .select('id,location_id,zone_id,code,name,capacity,shape,active')
    .single()

  if (error) throw error

  return {
    id: data.id,
    locationId: data.location_id,
    zoneId: data.zone_id,
    code: data.code,
    name: data.name || data.code,
    capacity: Number(data.capacity || 2),
    shape: data.shape,
    active: data.active,
  }
}
