import { isSupabaseConfigured, supabase } from '../lib/supabase.js'

function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase no está disponible en este entorno.')
  }
  return supabase
}

export const PREPARATION_STATION_TYPES = [
  { type: 'kitchen', name: 'Cocina', icon: '🍳' },
  { type: 'bar', name: 'Bar', icon: '🍸' },
  { type: 'dessert', name: 'Postres', icon: '🍰' },
  { type: 'coffee', name: 'Café', icon: '☕' },
  { type: 'other', name: 'Otra estación', icon: '📍' },
]

export async function loadBranchStationSettings(locationId) {
  const client = requireSupabase()
  const { data, error } = await client
    .from('kitchen_stations')
    .select('id,location_id,name,station_type,display_order,active,output_mode,is_default,updated_at')
    .eq('location_id', locationId)
    .order('display_order', { ascending: true })

  if (error) throw error

  const byType = new Map((data || []).map((station) => [station.station_type, station]))
  return PREPARATION_STATION_TYPES.map((definition) => {
    const station = byType.get(definition.type)
    return {
      id: station?.id || null,
      locationId,
      stationType: definition.type,
      name: station?.name || definition.name,
      icon: definition.icon,
      displayOrder: station?.display_order ?? 0,
      active: station?.active === true,
      outputMode: station?.output_mode || 'screen',
      isDefault: station?.is_default === true,
      updatedAt: station?.updated_at || null,
    }
  })
}

export async function saveBranchStationSetting({
  locationId,
  stationType,
  active,
  outputMode,
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('save_branch_station_setting', {
    p_location_id: locationId,
    p_station_type: stationType,
    p_active: Boolean(active),
    p_output_mode: outputMode === 'printer' ? 'printer' : 'screen',
  })

  if (error) throw error
  return data
}


export async function setDefaultBranchStation({
  locationId,
  stationType,
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('set_default_branch_station', {
    p_location_id: locationId,
    p_station_type: stationType,
  })

  if (error) throw error
  return data
}
