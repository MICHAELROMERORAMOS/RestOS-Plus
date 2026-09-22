import { isSupabaseConfigured, supabase } from '../lib/supabase.js'

function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase no está disponible en este entorno.')
  }
  return supabase
}

export async function loadInventoryWorkspace(restaurantId, locationId) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_inventory_workspace', {
    p_restaurant_id: restaurantId,
    p_location_id: locationId,
  })

  if (error) throw error
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    recipes: Array.isArray(data?.recipes) ? data.recipes : [],
    movements: Array.isArray(data?.movements) ? data.movements : [],
    generatedAt: data?.generatedAt || null,
  }
}

export async function saveInventoryItem({
  itemId = null,
  restaurantId,
  locationId,
  name,
  sku = '',
  unit,
  averageCost = 0,
  minStock = 0,
  maxStock = null,
  active = true,
  openingStock = 0,
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('save_inventory_item', {
    p_item_id: itemId,
    p_restaurant_id: restaurantId,
    p_location_id: locationId,
    p_name: name,
    p_sku: sku || null,
    p_unit: unit,
    p_average_cost: Number(averageCost || 0),
    p_min_stock: Number(minStock || 0),
    p_max_stock: maxStock === '' || maxStock == null ? null : Number(maxStock),
    p_active: Boolean(active),
    p_opening_stock: Number(openingStock || 0),
  })

  if (error) throw error
  return data
}

export async function recordInventoryMovement({
  restaurantId,
  locationId,
  inventoryItemId,
  movementType,
  quantity,
  unitCost = null,
  note = '',
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('record_inventory_movement', {
    p_restaurant_id: restaurantId,
    p_location_id: locationId,
    p_inventory_item_id: inventoryItemId,
    p_movement_type: movementType,
    p_quantity: Number(quantity),
    p_unit_cost: unitCost === '' || unitCost == null ? null : Number(unitCost),
    p_note: note || null,
  })

  if (error) throw error
  return data
}

export async function saveProductRecipe({ restaurantId, locationId, productId, lines }) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('save_product_recipe', {
    p_restaurant_id: restaurantId,
    p_location_id: locationId,
    p_product_id: productId,
    p_lines: lines,
  })

  if (error) throw error
  return data
}
