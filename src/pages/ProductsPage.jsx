import React, { useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import { createMenuCategory, saveMenuProduct } from '../services/menuService.js'

const emptyProduct = {
  id: null,
  name: '',
  description: '',
  price: '',
  taxRate: '0',
  sku: '',
  categoryId: '',
  station: 'kitchen',
  trackInventory: false,
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
      trackInventory: Boolean(product.trackInventory),
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

    if (!form.name.trim()) return window.alert('Escribe el nombre del producto.')
    if (!Number.isFinite(price) || price < 0) return window.alert('Escribe un precio válido.')
    if (!Number.isFinite(taxRate) || taxRate < 0) return window.alert('La tasa de impuesto no es válida.')

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
        trackInventory: form.trackInventory,
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
        <div className="modal open" onClick={() => !saving && setShowProduct(false)}>
          <form className="modal-card product-form-card" onSubmit={saveProduct} onClick={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div>
                <h3>{form.id ? 'Editar producto' : 'Nuevo producto'}</h3>
                <p className="muted">Datos que aparecerán en el menú y en las comandas.</p>
              </div>
              <button type="button" className="btn" disabled={saving} onClick={() => setShowProduct(false)}>×</button>
            </div>

            <div className="product-form-grid">
              <label className="wide">
                <span>Nombre *</span>
                <input value={form.name} onChange={(event) => updateField('name', event.target.value)} autoFocus />
              </label>

              <label>
                <span>Categoría</span>
                <select value={form.categoryId} onChange={(event) => updateField('categoryId', event.target.value)}>
                  <option value="">Sin categoría</option>
                  {activeCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                </select>
              </label>

              <label>
                <span>Preparación *</span>
                <select value={form.station} onChange={(event) => updateField('station', event.target.value)}>
                  {stationTypes.map((station) => <option key={station.value} value={station.value}>{station.label}</option>)}
                </select>
              </label>

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

              <label className="toggle-row">
                <span>Controlar inventario</span>
                <input type="checkbox" checked={form.trackInventory} onChange={(event) => updateField('trackInventory', event.target.checked)} />
              </label>

              <label className="toggle-row wide">
                <span>Producto activo / disponible</span>
                <input type="checkbox" checked={form.active} onChange={(event) => updateField('active', event.target.checked)} />
              </label>
            </div>

            <button className="btn primary full" type="submit" disabled={saving}>
              {saving ? 'Guardando en Supabase…' : 'Guardar producto'}
            </button>
          </form>
        </div>
      )}
    </section>
  )
}
