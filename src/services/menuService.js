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

export async function loadMenuCatalog(restaurantId, locationId) {
  const client = requireSupabase()

  const [
    { data: categories, error: categoriesError },
    { data: products, error: productsError },
    { data: stations, error: stationsError },
    { data: routes, error: routesError },
  ] = await Promise.all([
    client
      .from('menu_categories')
      .select('id,restaurant_id,parent_id,name,description,display_order,active')
      .eq('restaurant_id', restaurantId)
      .order('display_order', { ascending: true })
      .order('name', { ascending: true }),
    client
      .from('products')
      .select('id,restaurant_id,category_id,sku,name,description,base_price,tax_rate,track_inventory,active,created_at')
      .eq('restaurant_id', restaurantId)
      .order('name', { ascending: true }),
    client
      .from('kitchen_stations')
      .select('id,location_id,name,station_type,display_order,active')
      .eq('location_id', locationId)
      .eq('active', true)
      .order('display_order', { ascending: true }),
    client
      .from('product_station_routes')
      .select('product_id,location_id,station_id')
      .eq('location_id', locationId),
  ])

  if (categoriesError) throw categoriesError
  if (productsError) throw productsError
  if (stationsError) throw stationsError
  if (routesError) throw routesError

  const categoryById = new Map((categories || []).map((category) => [category.id, category]))
  const stationById = new Map((stations || []).map((station) => [station.id, station]))
  const routeByProduct = new Map((routes || []).map((route) => [route.product_id, route]))

  return {
    categories: (categories || []).map((category) => ({
      id: category.id,
      name: category.name,
      description: category.description || '',
      displayOrder: category.display_order,
      active: category.active,
    })),
    stations: (stations || []).map((station) => ({
      id: station.id,
      name: station.name,
      stationType: station.station_type,
      active: station.active,
    })),
    products: (products || []).map((product) => {
      const category = categoryById.get(product.category_id)
      const route = routeByProduct.get(product.id)
      const station = route ? stationById.get(route.station_id) : null

      return {
        id: product.id,
        name: product.name,
        description: product.description || '',
        price: Number(product.base_price || 0),
        taxRate: Number(product.tax_rate || 0),
        sku: product.sku || '',
        categoryId: product.category_id || null,
        category: category?.name || 'Sin categoría',
        station: station?.station_type || 'kitchen',
        stationName: station?.name || 'Cocina',
        trackInventory: Boolean(product.track_inventory),
        available: product.active !== false,
        active: product.active !== false,
      }
    }),
  }
}

export async function createMenuCategory(restaurantId, name, displayOrder = 0) {
  const client = requireSupabase()

  const { data, error } = await client
    .from('menu_categories')
    .insert({
      restaurant_id: restaurantId,
      name: clean(name),
      display_order: Number(displayOrder || 0),
      active: true,
    })
    .select('id,name,description,display_order,active')
    .single()

  if (error) throw error

  return {
    id: data.id,
    name: data.name,
    description: data.description || '',
    displayOrder: data.display_order,
    active: data.active,
  }
}

export async function saveMenuProduct({
  productId = null,
  restaurantId,
  locationId,
  categoryId = null,
  name,
  description = '',
  price = 0,
  taxRate = 0,
  sku = '',
  station = 'kitchen',
  trackInventory = false,
  active = true,
}) {
  const client = requireSupabase()

  const { data, error } = await client.rpc('save_menu_product', {
    p_product_id: productId,
    p_restaurant_id: restaurantId,
    p_location_id: locationId,
    p_category_id: categoryId || null,
    p_name: clean(name),
    p_description: clean(description) || null,
    p_base_price: Number(price || 0),
    p_tax_rate: Number(taxRate || 0),
    p_sku: clean(sku) || null,
    p_station_type: station,
    p_track_inventory: Boolean(trackInventory),
    p_active: Boolean(active),
  })

  if (error) throw error
  return data
}
