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
    { data: productLocations, error: productLocationsError },
    { data: temporaryUnavailable, error: temporaryUnavailableError },
    { data: stations, error: stationsError },
    { data: routes, error: routesError },
    { data: allergenConfig, error: allergenConfigError },
  ] = await Promise.all([
    client
      .from('menu_categories')
      .select('id,restaurant_id,parent_id,name,description,display_order,active')
      .eq('restaurant_id', restaurantId)
      .order('display_order', { ascending: true })
      .order('name', { ascending: true }),
    client
      .from('products')
      .select('id,restaurant_id,category_id,sku,name,description,base_price,tax_rate,track_inventory,inventory_mode,direct_inventory_item_id,preparation_station_type,active,created_at')
      .eq('restaurant_id', restaurantId)
      .order('name', { ascending: true }),
    client
      .from('product_locations')
      .select('product_id,location_id,active,price_override')
      .eq('restaurant_id', restaurantId),
    client
      .from('product_unavailability_requests')
      .select('id,product_id,reason,unavailable_until')
      .eq('restaurant_id', restaurantId)
      .eq('location_id', locationId)
      .eq('status', 'approved')
      .gt('unavailable_until', new Date().toISOString())
      .order('unavailable_until', { ascending: false }),
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
    client.rpc('load_allergen_configuration', {
      p_restaurant_id: restaurantId,
    }),
  ])

  if (categoriesError) throw categoriesError
  if (productsError) throw productsError
  if (productLocationsError) throw productLocationsError
  if (temporaryUnavailableError) throw temporaryUnavailableError
  if (stationsError) throw stationsError
  if (routesError) throw routesError
  if (allergenConfigError) throw allergenConfigError

  const allergenCatalog = Array.isArray(allergenConfig?.catalog)
    ? allergenConfig.catalog
    : []
  const productAllergens = (
    allergenConfig?.productAllergens
    && typeof allergenConfig.productAllergens === 'object'
  ) ? allergenConfig.productAllergens : {}

  const categoryById = new Map((categories || []).map((category) => [category.id, category]))
  const stationById = new Map((stations || []).map((station) => [station.id, station]))
  const routeByProduct = new Map((routes || []).map((route) => [route.product_id, route]))
  const temporaryByProduct = new Map()
  ;(temporaryUnavailable || []).forEach((row) => {
    const key = String(row.product_id)
    if (!temporaryByProduct.has(key)) temporaryByProduct.set(key, row)
  })
  const locationsByProduct = new Map()
  ;(productLocations || []).forEach((row) => {
    const productId = String(row.product_id)
    const current = locationsByProduct.get(productId) || {}
    current[String(row.location_id)] = {
      active: row.active !== false,
      priceOverride: row.price_override == null ? null : Number(row.price_override),
    }
    locationsByProduct.set(productId, current)
  })

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
    allergenCatalog: allergenCatalog.map((allergen) => ({
      id: allergen.id,
      code: allergen.code,
      nameEs: allergen.nameEs,
      nameEn: allergen.nameEn,
      icon: allergen.icon || '⚠',
      displayOrder: Number(allergen.displayOrder || 0),
      subtypes: (allergen.subtypes || []).map((subtype) => ({
        id: subtype.id,
        code: subtype.code,
        nameEs: subtype.nameEs,
        nameEn: subtype.nameEn,
        displayOrder: Number(subtype.displayOrder || 0),
      })),
    })),
    products: (products || []).map((product) => {
      const category = categoryById.get(product.category_id)
      const route = routeByProduct.get(product.id)
      const station = route ? stationById.get(route.station_id) : null
      const temporary = temporaryByProduct.get(String(product.id)) || null
      const locationAvailability = locationsByProduct.get(String(product.id)) || {}
      const currentLocation = locationAvailability[String(locationId)] || null
      const basePrice = Number(product.base_price || 0)
      const effectivePrice = currentLocation?.priceOverride == null
        ? basePrice
        : Number(currentLocation.priceOverride)

      return {
        id: product.id,
        name: product.name,
        description: product.description || '',
        price: effectivePrice,
        basePrice,
        priceOverride: currentLocation?.priceOverride ?? null,
        locationAvailability,
        activeAtLocation: currentLocation?.active === true,
        taxRate: Number(product.tax_rate || 0),
        sku: product.sku || '',
        categoryId: product.category_id || null,
        category: category?.name || 'Sin categoría',
        station: product.preparation_station_type || station?.station_type || 'kitchen',
        stationName: station?.name || (product.preparation_station_type === 'bar' ? 'Bar' : 'Cocina'),
        directInventoryItemId: product.direct_inventory_item_id || null,
        trackInventory: Boolean(product.track_inventory),
        inventoryMode: product.inventory_mode || (product.track_inventory ? 'recipe' : 'none'),
        allergens: (productAllergens[String(product.id)] || []).map((allergen) => ({
          allergenId: allergen.allergenId,
          code: allergen.code,
          nameEs: allergen.nameEs,
          nameEn: allergen.nameEn,
          icon: allergen.icon || '⚠',
          level: allergen.level === 'may_contain' ? 'may_contain' : 'contains',
          subtypeIds: (allergen.subtypes || []).map((subtype) => subtype.id),
          subtypes: (allergen.subtypes || []).map((subtype) => ({
            id: subtype.id,
            code: subtype.code,
            nameEs: subtype.nameEs,
            nameEn: subtype.nameEn,
            level: subtype.level === 'may_contain' ? 'may_contain' : 'contains',
          })),
        })),
        temporarilyUnavailable: Boolean(temporary),
        temporaryUnavailableReason: temporary?.reason || '',
        temporaryUnavailableUntil: temporary?.unavailable_until || null,
        available: product.active !== false && currentLocation?.active === true && !temporary,
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
  locationId = null,
  categoryId = null,
  name,
  description = '',
  price = 0,
  taxRate = 0,
  sku = '',
  station = 'kitchen',
  directInventory = false,
  inventoryUnit = 'unidad',
  inventoryAverageCost = 0,
  inventoryMinStock = 0,
  inventoryMaxStock = null,
  inventoryOpeningStock = 0,
  active = true,
  allergens = [],
  locationSettings = [],
}) {
  const client = requireSupabase()

  const normalizedAllergens = (Array.isArray(allergens) ? allergens : [])
    .filter((allergen) => allergen?.allergenId)
    .map((allergen) => ({
      allergenId: allergen.allergenId,
      level: allergen.level === 'may_contain' ? 'may_contain' : 'contains',
      subtypeIds: Array.from(new Set(
        (Array.isArray(allergen.subtypeIds) ? allergen.subtypeIds : []).filter(Boolean),
      )),
    }))

  const normalizedLocations = (Array.isArray(locationSettings) ? locationSettings : [])
    .filter((location) => location?.locationId)
    .map((location) => ({
      locationId: location.locationId,
      active: Boolean(location.active),
      priceOverride: location.priceOverride === '' || location.priceOverride == null
        ? null
        : Number(location.priceOverride),
    }))

  const { data, error } = await client.rpc('save_company_catalog_product', {
    p_product_id: productId,
    p_restaurant_id: restaurantId,
    p_category_id: categoryId || null,
    p_name: clean(name),
    p_description: clean(description) || null,
    p_base_price: Number(price || 0),
    p_tax_rate: Number(taxRate || 0),
    p_sku: clean(sku) || null,
    p_station_type: station,
    p_direct_inventory: Boolean(directInventory),
    p_inventory_unit: inventoryUnit,
    p_inventory_average_cost: Number(inventoryAverageCost || 0),
    p_inventory_min_stock: Number(inventoryMinStock || 0),
    p_inventory_max_stock: inventoryMaxStock === '' || inventoryMaxStock == null ? null : Number(inventoryMaxStock),
    p_active: Boolean(active),
    p_allergens: normalizedAllergens,
    p_locations: normalizedLocations,
  })

  if (error) throw error
  return data
}


export async function loadDirectProductInventoryConfig(restaurantId, locationId) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_direct_product_inventory_config', {
    p_restaurant_id: restaurantId,
    p_location_id: locationId,
  })
  if (error) throw error

  const byProduct = {}
  ;(Array.isArray(data) ? data : []).forEach((item) => {
    byProduct[String(item.productId)] = {
      inventoryItemId: item.inventoryItemId,
      unit: item.unit || 'unidad',
      averageCost: Number(item.averageCost || 0),
      minStock: Number(item.minStock || 0),
      maxStock: item.maxStock == null ? null : Number(item.maxStock),
      currentStock: Number(item.currentStock || 0),
    }
  })
  return byProduct
}


export async function loadDirectProductMasterConfig(restaurantId, productIds = []) {
  const client = requireSupabase()
  const ids = Array.from(new Set((productIds || []).filter(Boolean)))
  if (!ids.length) return {}

  const { data: products, error: productsError } = await client
    .from('products')
    .select('id,direct_inventory_item_id')
    .eq('restaurant_id', restaurantId)
    .in('id', ids)

  if (productsError) throw productsError

  const itemIds = Array.from(new Set(
    (products || []).map((product) => product.direct_inventory_item_id).filter(Boolean),
  ))
  if (!itemIds.length) return {}

  const { data: items, error: itemsError } = await client
    .from('inventory_items')
    .select('id,unit,average_cost,min_stock,max_stock')
    .eq('restaurant_id', restaurantId)
    .in('id', itemIds)

  if (itemsError) throw itemsError

  const itemById = new Map((items || []).map((item) => [String(item.id), item]))
  const byProduct = {}
  ;(products || []).forEach((product) => {
    const item = itemById.get(String(product.direct_inventory_item_id || ''))
    if (!item) return
    byProduct[String(product.id)] = {
      inventoryItemId: item.id,
      unit: item.unit || 'unidad',
      averageCost: Number(item.average_cost || 0),
      minStock: Number(item.min_stock || 0),
      maxStock: item.max_stock == null ? null : Number(item.max_stock),
    }
  })
  return byProduct
}
