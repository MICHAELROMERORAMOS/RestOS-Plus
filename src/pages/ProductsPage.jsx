import React, { useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import { createMenuCategory, saveMenuProduct } from '../services/menuService.js'

const INVENTORY_UNITS = [
  { value: 'unidad', label: 'Unidad' },
  { value: 'g', label: 'Gramo (g)' },
  { value: 'kg', label: 'Kilogramo (kg)' },
  { value: 'ml', label: 'Mililitro (ml)' },
  { value: 'l', label: 'Litro (l)' },
  { value: 'porcion', label: 'Porción' },
]

const emptyProduct = {
  id: null,
  name: '',
  description: '',
  price: '',
  taxRate: '0',
  sku: '',
  categoryId: '',
  station: 'kitchen',
  inventoryMode: 'none',
  directInventory: false,
  inventoryUnit: 'unidad',
  inventoryAverageCost: '',
  inventoryMinStock: '',
  inventoryMaxStock: '',
  inventoryOpeningStock: '',
  currentStock: null,
  active: true,
}

export default function ProductsPage() {
  const auth = useAuth()
  const {
    products,
    menuCategories,
    menuStations,
    activeLocation,
    currencyCode,
    formatMoney,
    remoteLoading,
    remoteError,
    refreshMenu,
  } = useRestaurant()

  const restaurantId = auth.userContext?.membership?.restaurant_id || null
  const canManage = auth.can('products.manage')
  const canManageInventory = auth.can('inventory.manage')

  const [showProduct, setShowProduct] = useState(false)
  const [form, setForm] = useState(emptyProduct)
  const [categoryName, setCategoryName] = useState('')
  const [saving, setSaving] = useState(false)

  const activeCategories = useMemo(
    () => menuCategories
      .filter((category) => category.active !== false)
      .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.name.localeCompare(b.name)),
    [menuCategories],
  )

  const stationTypes = useMemo(() => {
    const map = new Map()
    ;(menuStations || []).forEach((station) => {
      if (!map.has(station.stationType)) map.set(station.stationType, station.name)
    })
    if (!map.has('kitchen')) map.set('kitchen', 'Cocina')
    if (!map.has('bar')) map.set('bar', 'Bar')
    return Array.from(map.entries()).map(([value, label]) => ({ value, label }))
  }, [menuStations])

  function openNewProduct() {
    if (!canManage) return
    setForm({
      ...emptyProduct,
      categoryId: activeCategories[0]?.id || '',
    })
    setShowProduct(true)
  }

  function openEditProduct(product) {
    if (!canManage) return
    setForm({
      id: product.id,
      name: product.name || '',
      description: product.description || '',
      price: String(product.price ?? ''),
      taxRate: String(product.taxRate ?? 0),
      sku: product.sku || '',
      categoryId: product.categoryId || '',
      station: product.station || 'kitchen',
      inventoryMode: product.inventoryMode || (product.trackInventory ? 'recipe' : 'none'),
      directInventory: product.inventoryMode === 'direct',
      inventoryUnit: product.directInventory?.unit || 'unidad',
      inventoryAverageCost: String(product.directInventory?.averageCost ?? ''),
      inventoryMinStock: String(product.directInventory?.minStock ?? ''),
      inventoryMaxStock: product.directInventory?.maxStock == null ? '' : String(product.directInventory.maxStock),
      inventoryOpeningStock: '',
      currentStock: product.directInventory?.currentStock ?? null,
      active: product.active !== false,
    })
    setShowProduct(true)
  }

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function addCategory(event) {
    event.preventDefault()
    const name = categoryName.trim()
    if (!name) return
    if (!restaurantId) return window.alert('No se encontró el restaurante activo.')

    setSaving(true)
    try {
      const category = await createMenuCategory(restaurantId, name, activeCategories.length)
      setCategoryName('')
      await refreshMenu()
      setForm((current) => ({ ...current, categoryId: current.categoryId || category.id }))
    } catch (error) {
      window.alert(
        error?.code === '23505'
          ? 'Ya existe una categoría con ese nombre.'
          : (error?.message || 'No se pudo crear la categoría.'),
      )
    } finally {
      setSaving(false)
    }
  }

  async function saveProduct(event) {
    event.preventDefault()

    if (!restaurantId || !activeLocation?.id) {
      return window.alert('No se encontró el restaurante o la sucursal activa.')
    }

    const price = Number(String(form.price).replace(',', '.'))
    const taxRate = Number(String(form.taxRate).replace(',', '.'))
    const inventoryAverageCost = Number(String(form.inventoryAverageCost || 0).replace(',', '.'))
    const inventoryMinStock = Number(String(form.inventoryMinStock || 0).replace(',', '.'))
    const inventoryMaxStock = form.inventoryMaxStock === ''
      ? null
      : Number(String(form.inventoryMaxStock).replace(',', '.'))
    const inventoryOpeningStock = Number(String(form.inventoryOpeningStock || 0).replace(',', '.'))

    if (!form.name.trim()) return window.alert('Escribe el nombre del producto.')
    if (!Number.isFinite(price) || price < 0) return window.alert('Escribe un precio válido.')
    if (!Number.isFinite(taxRate) || taxRate < 0) return window.alert('La tasa de impuesto no es válida.')

    if (form.directInventory) {
      if (!canManageInventory) {
        return window.alert('Tu rol necesita permiso de inventario para vincular un producto directamente al stock.')
      }
      if (![inventoryAverageCost, inventoryMinStock, inventoryOpeningStock].every((value) => Number.isFinite(value) && value >= 0)) {
        return window.alert('Revisa costo unitario, stock mínimo y stock inicial.')
      }
      if (inventoryMaxStock != null && (!Number.isFinite(inventoryMaxStock) || inventoryMaxStock < inventoryMinStock)) {
        return window.alert('El stock máximo no puede ser menor que el stock mínimo.')
      }
    }

    if (form.id && form.inventoryMode === 'recipe' && form.directInventory) {
      const replaceRecipe = window.confirm(
        'Este producto actualmente descuenta inventario mediante una receta.\n\nSi continúas, la receta será reemplazada por descuento directo de 1 unidad del producto. ¿Continuar?',
      )
      if (!replaceRecipe) return
    }

    if (form.id && form.inventoryMode === 'direct' && !form.directInventory) {
      const disableDirect = window.confirm(
        '¿Desactivar el descuento directo de inventario para este producto?\n\nLos movimientos históricos se conservarán, pero las próximas ventas dejarán de descontar este artículo hasta que configures otro método.',
      )
      if (!disableDirect) return
    }

    setSaving(true)
    try {
      await saveMenuProduct({
        productId: form.id,
        restaurantId,
        locationId: activeLocation.id,
        categoryId: form.categoryId || null,
        name: form.name,
        description: form.description,
        price,
        taxRate,
        sku: form.sku,
        station: form.station,
        directInventory: form.directInventory,
        inventoryUnit: form.inventoryUnit,
        inventoryAverageCost,
        inventoryMinStock,
        inventoryMaxStock,
        inventoryOpeningStock: form.id ? 0 : inventoryOpeningStock,
        active: form.active,
      })

      await refreshMenu()
      setShowProduct(false)
      setForm(emptyProduct)
    } catch (error) {
      window.alert(
        error?.code === '23505'
          ? 'El SKU ya está siendo utilizado por otro producto.'
          : (error?.message || 'No se pudo guardar el producto.'),
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="view active products-admin-view">
      <div className="hero products-admin-hero">
        <div>
          <h2>Productos y menú</h2>
          <p>El menú ya se guarda en Supabase y define qué productos van a Cocina o Bar.</p>
        </div>
        {canManage && (
          <button className="btn primary" onClick={openNewProduct} disabled={!activeLocation || remoteLoading}>
            ＋ Producto
          </button>
        )}
      </div>

      {remoteError && <div className="notice warn">{remoteError}</div>}
      {!activeLocation && !remoteLoading && (
        <div className="notice warn">Necesitas una sucursal activa antes de crear el menú.</div>
      )}

      <div className="grid two">
        <div className="card">
          <div className="section-title">
            <div>
              <h3>Categorías</h3>
              <p className="muted">Agrupa el menú: comidas, bebidas, postres, etc.</p>
            </div>
            <span className="badge">{activeCategories.length}</span>
          </div>

          {canManage && (
            <form className="inline-create-form" onSubmit={addCategory}>
              <input
                value={categoryName}
                onChange={(event) => setCategoryName(event.target.value)}
                placeholder="Nueva categoría"
                disabled={saving}
              />
              <button className="btn" type="submit" disabled={saving || !categoryName.trim()}>
                ＋ Agregar
              </button>
            </form>
          )}

          <div className="list section-gap">
            {activeCategories.length ? activeCategories.map((category) => (
              <div className="row" key={category.id}>
                <b>{category.name}</b>
                <small>{products.filter((product) => product.categoryId === category.id).length} productos</small>
              </div>
            )) : <div className="empty-inline">Todavía no hay categorías.</div>}
          </div>
        </div>

        <div className="card">
          <div className="section-title">
            <div>
              <h3>Resumen del menú</h3>
              <p className="muted">Productos activos e inactivos registrados en Supabase.</p>
            </div>
          </div>
          <div className="list">
            <div className="row"><b>Productos registrados</b><strong>{products.length}</strong></div>
            <div className="row"><b>Activos</b><strong>{products.filter((product) => product.active).length}</strong></div>
            <div className="row"><b>Cocina</b><strong>{products.filter((product) => product.active && product.station === 'kitchen').length}</strong></div>
            <div className="row"><b>Bar</b><strong>{products.filter((product) => product.active && product.station === 'bar').length}</strong></div>
          </div>
        </div>
      </div>

      <div className="card section-gap">
        <div className="section-title">
          <div>
            <h3>Lista de productos</h3>
            <p className="muted">{activeLocation ? `Sucursal: ${activeLocation.name}` : 'Sin sucursal activa'}</p>
          </div>
          <button className="btn" onClick={() => refreshMenu()} disabled={remoteLoading}>↻ Actualizar</button>
        </div>

        {remoteLoading ? (
          <div className="empty-inline">Cargando menú desde Supabase…</div>
        ) : products.length ? (
          <div className="menu-product-list">
            {products.map((product) => (
              <article className={`menu-product-card ${product.active ? '' : 'inactive'}`} key={product.id}>
                <div className="menu-product-main">
                  <div className="menu-product-title">
                    <h4>{product.name}</h4>
                    {!product.active && <span className="badge">INACTIVO</span>}
                  </div>
                  <small>{product.category} · {product.station === 'bar' ? '🍸 Bar' : '🍳 Cocina'}</small>
                  {product.description && <p>{product.description}</p>}
                  {product.sku && <small>SKU: {product.sku}</small>}
                  {product.inventoryMode === 'direct' && <span className="badge ok-badge">Inventario directo</span>}
                  {product.inventoryMode === 'recipe' && <span className="badge">Por receta</span>}
                </div>

                <strong className="menu-product-price">{formatMoney(product.price)}</strong>

                {canManage && (
                  <button className="btn" onClick={() => openEditProduct(product)}>Editar</button>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-block">Todavía no hay productos. Crea una categoría y registra el primer producto.</div>
        )}
      </div>

      {showProduct && (
        <div className="modal open product-form-modal" onClick={() => !saving && setShowProduct(false)}>
          <form className="modal-card product-form-card" onSubmit={saveProduct} onClick={(event) => event.stopPropagation()}>
            <div className="section-title product-form-head">
              <div>
                <h3>{form.id ? 'Editar producto' : 'Nuevo producto'}</h3>
                <p className="muted">Datos que aparecerán en el menú y en las comandas.</p>
              </div>
              <button type="button" className="btn" disabled={saving} onClick={() => setShowProduct(false)}>×</button>
            </div>

            <div className="product-form-scroll">
              <div className="product-form-grid">
              <label className="wide">
                <span>Nombre *</span>
                <input value={form.name} onChange={(event) => updateField('name', event.target.value)} autoFocus />
              </label>

              <div className="product-choice-field wide">
                <span className="product-choice-label">Categoría</span>
                <div className="product-choice-buttons" role="group" aria-label="Categoría del producto">
                  <button
                    type="button"
                    className={`product-choice-btn ${form.categoryId === '' ? 'active' : ''}`}
                    aria-pressed={form.categoryId === ''}
                    onClick={() => updateField('categoryId', '')}
                  >
                    Sin categoría
                  </button>
                  {activeCategories.map((category) => (
                    <button
                      type="button"
                      key={category.id}
                      className={`product-choice-btn ${form.categoryId === category.id ? 'active' : ''}`}
                      aria-pressed={form.categoryId === category.id}
                      onClick={() => updateField('categoryId', category.id)}
                    >
                      {category.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="product-choice-field wide">
                <span className="product-choice-label">Preparación *</span>
                <div className="product-choice-buttons product-station-buttons" role="group" aria-label="Zona de preparación">
                  {stationTypes.map((station) => (
                    <button
                      type="button"
                      key={station.value}
                      className={`product-choice-btn station-choice-btn ${form.station === station.value ? 'active' : ''}`}
                      aria-pressed={form.station === station.value}
                      onClick={() => updateField('station', station.value)}
                    >
                      <span className="product-choice-icon">
                        {station.value === 'kitchen'
                          ? '🍳'
                          : station.value === 'bar'
                            ? '🍸'
                            : station.value === 'dessert'
                              ? '🍰'
                              : station.value === 'coffee'
                                ? '☕'
                                : '📍'}
                      </span>
                      {station.label}
                    </button>
                  ))}
                </div>
              </div>

              <label>
                <span>Precio ({currencyCode}) *</span>
                <input inputMode="decimal" value={form.price} onChange={(event) => updateField('price', event.target.value)} placeholder="0.00" />
              </label>

              <label>
                <span>Impuesto %</span>
                <input inputMode="decimal" value={form.taxRate} onChange={(event) => updateField('taxRate', event.target.value)} />
              </label>

              <label className="wide">
                <span>Descripción</span>
                <textarea value={form.description} onChange={(event) => updateField('description', event.target.value)} />
              </label>

              <label>
                <span>SKU / Código</span>
                <input value={form.sku} onChange={(event) => updateField('sku', event.target.value)} placeholder="Opcional" />
              </label>

              <div className="product-direct-inventory wide">
                <label className="toggle-row product-direct-inventory-toggle">
                  <span>
                    <b>Descontar directamente del inventario</b>
                    <small>
                      Actívalo para productos que se venden tal como se compran: bebidas, botellas, paquetes, postres empacados, etc.
                      Cada unidad vendida descontará 1 unidad de este artículo.
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    checked={form.directInventory}
                    disabled={!canManageInventory}
                    onChange={(event) => updateField('directInventory', event.target.checked)}
                  />
                </label>

                {!canManageInventory && (
                  <div className="notice warn">Tu rol puede administrar productos, pero necesita <b>inventory.manage</b> para crear stock directo.</div>
                )}

                {form.inventoryMode === 'recipe' && !form.directInventory && (
                  <div className="notice">Este producto actualmente descuenta inventario mediante <b>receta</b>. La receta se administra desde Inventario.</div>
                )}

                {form.directInventory && (
                  <div className="product-direct-inventory-fields">
                    <div className="product-direct-inventory-head">
                      <div>
                        <b>Artículo de inventario vinculado</b>
                        <small>Se creará automáticamente con el mismo nombre y SKU del producto.</small>
                      </div>
                      {form.id && form.currentStock != null && (
                        <span className="badge">Stock actual: {Number(form.currentStock || 0).toLocaleString('es-CO', { maximumFractionDigits: 3 })}</span>
                      )}
                    </div>

                    <label>
                      <span>Unidad base *</span>
                      <select value={form.inventoryUnit} onChange={(event) => updateField('inventoryUnit', event.target.value)}>
                        {INVENTORY_UNITS.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
                      </select>
                    </label>

                    <label>
                      <span>Costo unitario / compra ({currencyCode})</span>
                      <input
                        inputMode="decimal"
                        value={form.inventoryAverageCost}
                        onChange={(event) => updateField('inventoryAverageCost', event.target.value)}
                        placeholder="0.00"
                      />
                    </label>

                    <label>
                      <span>Stock mínimo</span>
                      <input
                        inputMode="decimal"
                        value={form.inventoryMinStock}
                        onChange={(event) => updateField('inventoryMinStock', event.target.value)}
                        placeholder="0"
                      />
                    </label>

                    <label>
                      <span>Stock máximo</span>
                      <input
                        inputMode="decimal"
                        value={form.inventoryMaxStock}
                        onChange={(event) => updateField('inventoryMaxStock', event.target.value)}
                        placeholder="Opcional"
                      />
                    </label>

                    {!form.id && (
                      <label>
                        <span>Stock inicial</span>
                        <input
                          inputMode="decimal"
                          value={form.inventoryOpeningStock}
                          onChange={(event) => updateField('inventoryOpeningStock', event.target.value)}
                          placeholder="0"
                        />
                      </label>
                    )}

                    <div className="notice">
                      <b>Precio de venta:</b> se toma del campo Precio del producto. <b>Costo unitario:</b> se usa para valorar inventario, FIFO y margen.
                    </div>
                  </div>
                )}
              </div>

              <label className="toggle-row wide">
                <span>Producto activo / disponible</span>
                <input type="checkbox" checked={form.active} onChange={(event) => updateField('active', event.target.checked)} />
              </label>
              </div>
            </div>

            <div className="product-form-footer">
              <button className="btn primary full" type="submit" disabled={saving}>
                {saving ? 'Guardando en Supabase…' : 'Guardar producto'}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}
