import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import {
  loadInventoryWorkspace,
  recordInventoryMovement,
  saveInventoryItem,
  saveProductRecipe,
} from '../services/inventoryService.js'

const UNITS = [
  { value: 'unidad', label: 'Unidad' },
  { value: 'g', label: 'Gramo (g)' },
  { value: 'kg', label: 'Kilogramo (kg)' },
  { value: 'ml', label: 'Mililitro (ml)' },
  { value: 'l', label: 'Litro (l)' },
  { value: 'porcion', label: 'Porción' },
]

const MOVEMENT_LABELS = {
  opening: 'Existencia inicial',
  purchase: 'Entrada / compra',
  sale: 'Consumo por venta',
  waste: 'Desperdicio',
  adjustment: 'Ajuste manual',
  return: 'Devolución',
  count: 'Conteo',
  transfer_in: 'Traslado recibido',
  transfer_out: 'Traslado enviado',
}

const emptyItem = {
  id: null,
  name: '',
  sku: '',
  unit: 'unidad',
  averageCost: '',
  minStock: '',
  maxStock: '',
  openingStock: '',
  active: true,
}

const emptyMovement = {
  inventoryItemId: '',
  movementType: 'purchase',
  quantity: '',
  unitCost: '',
  note: '',
}

function numberValue(value) {
  return Number(String(value ?? '').replace(',', '.'))
}

function quantityText(value, unit) {
  return `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 3 }).format(Number(value || 0))} ${unit || ''}`.trim()
}

function inventoryError(error, fallback) {
  const message = String(error?.message || '')
  if (message.includes('Inventory SKU is already in use')) return 'Ese código o SKU ya está asignado a otro insumo.'
  if (message.includes('Not allowed to manage inventory')) return 'Tu usuario puede consultar el inventario, pero no modificarlo.'
  if (message.includes('Inventory item not found')) return 'El insumo ya no existe o no pertenece a este restaurante.'
  if (message.includes('Waste reason is required')) return 'Escribe el motivo del desperdicio.'
  if (message.includes('Adjustment reason is required')) return 'Escribe el motivo del ajuste.'
  if (message.includes('Recipe contains')) return 'La receta contiene un insumo o una cantidad inválida.'
  return message || fallback
}

export default function InventoryPage() {
  const auth = useAuth()
  const {
    activeLocation,
    currencyCode,
    formatMoney,
    products,
    refreshMenu,
  } = useRestaurant()

  const restaurantId = auth.userContext?.membership?.restaurant_id || null
  const locationId = activeLocation?.id || null
  const canManage = auth.can('inventory.manage')

  const [workspace, setWorkspace] = useState({ items: [], recipes: [], movements: [] })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('stock')
  const [search, setSearch] = useState('')

  const [showItem, setShowItem] = useState(false)
  const [itemForm, setItemForm] = useState(emptyItem)
  const [showMovement, setShowMovement] = useState(false)
  const [movementForm, setMovementForm] = useState(emptyMovement)
  const [showRecipe, setShowRecipe] = useState(false)
  const [recipeProductId, setRecipeProductId] = useState('')
  const [recipeLines, setRecipeLines] = useState([])

  const load = useCallback(async () => {
    if (!restaurantId || !locationId) return
    setLoading(true)
    setError('')
    try {
      setWorkspace(await loadInventoryWorkspace(restaurantId, locationId))
    } catch (loadError) {
      setError(inventoryError(loadError, 'No se pudo cargar el inventario.'))
    } finally {
      setLoading(false)
    }
  }, [restaurantId, locationId])

  useEffect(() => {
    load()
  }, [load])

  const itemById = useMemo(
    () => new Map(workspace.items.map((item) => [item.id, item])),
    [workspace.items],
  )

  const recipesByProduct = useMemo(() => {
    const map = new Map()
    workspace.recipes.forEach((line) => {
      if (!map.has(line.productId)) map.set(line.productId, [])
      map.get(line.productId).push(line)
    })
    return map
  }, [workspace.recipes])

  const activeItems = useMemo(
    () => workspace.items.filter((item) => item.active !== false),
    [workspace.items],
  )

  const visibleItems = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es')
    if (!term) return workspace.items
    return workspace.items.filter((item) => (
      item.name.toLocaleLowerCase('es').includes(term)
      || String(item.sku || '').toLocaleLowerCase('es').includes(term)
    ))
  }, [workspace.items, search])

  const lowStockCount = activeItems.filter(
    (item) => Number(item.minStock || 0) > 0 && Number(item.stock || 0) <= Number(item.minStock || 0),
  ).length
  const inventoryValue = activeItems.reduce((sum, item) => sum + Number(item.stockValue || 0), 0)
  const recipeProductCount = recipesByProduct.size

  function recipeCost(productId) {
    return (recipesByProduct.get(productId) || []).reduce((sum, line) => {
      const item = itemById.get(line.inventoryItemId)
      return sum + (Number(line.quantityRequired || 0) * Number(item?.averageCost || 0))
    }, 0)
  }

  function openNewItem() {
    setItemForm(emptyItem)
    setShowItem(true)
  }

  function openEditItem(item) {
    setItemForm({
      id: item.id,
      name: item.name || '',
      sku: item.sku || '',
      unit: item.unit || 'unidad',
      averageCost: String(item.averageCost ?? ''),
      minStock: String(item.minStock ?? ''),
      maxStock: item.maxStock == null ? '' : String(item.maxStock),
      openingStock: '',
      active: item.active !== false,
    })
    setShowItem(true)
  }

  function openMovement(item = null, movementType = 'purchase') {
    setMovementForm({
      ...emptyMovement,
      inventoryItemId: item?.id || activeItems[0]?.id || '',
      movementType,
      unitCost: movementType === 'purchase' && item ? String(item.averageCost ?? '') : '',
    })
    setShowMovement(true)
  }

  function openRecipe(product) {
    const currentLines = recipesByProduct.get(product.id) || []
    setRecipeProductId(product.id)
    setRecipeLines(currentLines.length ? currentLines.map((line) => ({
      inventoryItemId: line.inventoryItemId,
      quantityRequired: String(line.quantityRequired),
    })) : [{ inventoryItemId: activeItems[0]?.id || '', quantityRequired: '' }])
    setShowRecipe(true)
  }

  async function submitItem(event) {
    event.preventDefault()
    const averageCost = numberValue(itemForm.averageCost || 0)
    const minStock = numberValue(itemForm.minStock || 0)
    const maxStock = itemForm.maxStock === '' ? null : numberValue(itemForm.maxStock)
    const openingStock = numberValue(itemForm.openingStock || 0)

    if (!itemForm.name.trim()) return window.alert('Escribe el nombre del insumo.')
    if (![averageCost, minStock, openingStock].every((value) => Number.isFinite(value) && value >= 0)) {
      return window.alert('Revisa el costo, el stock mínimo y la existencia inicial.')
    }
    if (maxStock != null && (!Number.isFinite(maxStock) || maxStock < minStock)) {
      return window.alert('El stock máximo no puede ser menor que el stock mínimo.')
    }

    setSaving(true)
    try {
      await saveInventoryItem({
        itemId: itemForm.id,
        restaurantId,
        locationId,
        name: itemForm.name,
        sku: itemForm.sku,
        unit: itemForm.unit,
        averageCost,
        minStock,
        maxStock,
        active: itemForm.active,
        openingStock,
      })
      setShowItem(false)
      await load()
    } catch (saveError) {
      window.alert(inventoryError(saveError, 'No se pudo guardar el insumo.'))
    } finally {
      setSaving(false)
    }
  }

  async function submitMovement(event) {
    event.preventDefault()
    const quantity = numberValue(movementForm.quantity)
    const unitCost = movementForm.unitCost === '' ? null : numberValue(movementForm.unitCost)

    if (!movementForm.inventoryItemId) return window.alert('Selecciona un insumo.')
    if (!Number.isFinite(quantity) || quantity === 0) return window.alert('Escribe una cantidad diferente de cero.')
    if (movementForm.movementType !== 'adjustment' && quantity < 0) {
      return window.alert('Para entradas o desperdicios escribe una cantidad positiva; el sistema aplicará el signo correcto.')
    }
    if (unitCost != null && (!Number.isFinite(unitCost) || unitCost < 0)) return window.alert('Escribe un costo válido.')
    if (['waste', 'adjustment'].includes(movementForm.movementType) && !movementForm.note.trim()) {
      return window.alert('Escribe el motivo del movimiento.')
    }

    setSaving(true)
    try {
      await recordInventoryMovement({
        restaurantId,
        locationId,
        inventoryItemId: movementForm.inventoryItemId,
        movementType: movementForm.movementType,
        quantity,
        unitCost,
        note: movementForm.note,
      })
      setShowMovement(false)
      await load()
    } catch (saveError) {
      window.alert(inventoryError(saveError, 'No se pudo registrar el movimiento.'))
    } finally {
      setSaving(false)
    }
  }

  function updateRecipeLine(index, patch) {
    setRecipeLines((current) => current.map((line, lineIndex) => (
      lineIndex === index ? { ...line, ...patch } : line
    )))
  }

  async function submitRecipe(event) {
    event.preventDefault()
    const lines = recipeLines
      .filter((line) => line.inventoryItemId || String(line.quantityRequired || '').trim())
      .map((line) => ({
        inventoryItemId: line.inventoryItemId,
        quantityRequired: numberValue(line.quantityRequired),
      }))

    if (!recipeProductId) return window.alert('Selecciona un producto.')
    if (lines.some((line) => !line.inventoryItemId || !Number.isFinite(line.quantityRequired) || line.quantityRequired <= 0)) {
      return window.alert('Cada línea debe tener un insumo y una cantidad mayor que cero.')
    }
    if (!lines.length && !window.confirm('La receta quedará vacía y este producto no descontará inventario. ¿Continuar?')) return

    setSaving(true)
    try {
      await saveProductRecipe({ restaurantId, locationId, productId: recipeProductId, lines })
      setShowRecipe(false)
      await Promise.all([load(), refreshMenu()])
    } catch (saveError) {
      window.alert(inventoryError(saveError, 'No se pudo guardar la receta.'))
    } finally {
      setSaving(false)
    }
  }

  const selectedMovementItem = itemById.get(movementForm.inventoryItemId)
  const selectedRecipeProduct = products.find((product) => product.id === recipeProductId)
  const draftRecipeCost = recipeLines.reduce((sum, line) => {
    const item = itemById.get(line.inventoryItemId)
    const quantity = numberValue(line.quantityRequired)
    return sum + (Number.isFinite(quantity) ? quantity * Number(item?.averageCost || 0) : 0)
  }, 0)

  return (
    <section className="view active inventory-view">
      <div className="hero inventory-hero">
        <div>
          <h2>Inventario y recetas</h2>
          <p>Controla insumos, costos, entradas, desperdicios y consumo automático por ventas.</p>
        </div>
        {canManage && (
          <div className="inventory-hero-actions">
            <button className="btn" onClick={() => openMovement()} disabled={!activeItems.length}>＋ Movimiento</button>
            <button className="btn primary" onClick={openNewItem}>＋ Nuevo insumo</button>
          </div>
        )}
      </div>

      {!activeLocation && <div className="notice warn">Selecciona una sucursal activa para administrar el inventario.</div>}
      {error && <div className="notice warn">{error}</div>}

      <div className="grid stats inventory-stats">
        <div className="card stat"><span className="label">Insumos activos</span><strong>{activeItems.length}</strong><small>{workspace.items.length} registrados</small></div>
        <div className="card stat"><span className="label">Stock bajo</span><strong>{lowStockCount}</strong><small>En mínimo o por debajo</small></div>
        <div className="card stat"><span className="label">Productos con receta</span><strong>{recipeProductCount}</strong><small>De {products.filter((product) => product.active).length} activos</small></div>
        <div className="card stat"><span className="label">Valor estimado</span><strong>{formatMoney(inventoryValue)}</strong><small>Existencias de {activeLocation?.name || 'la sucursal'}</small></div>
      </div>

      <div className="inventory-tabs" role="tablist" aria-label="Secciones de inventario">
        <button className={tab === 'stock' ? 'active' : ''} onClick={() => setTab('stock')}>Insumos y existencias</button>
        <button className={tab === 'recipes' ? 'active' : ''} onClick={() => setTab('recipes')}>Recetas y costos</button>
        <button className={tab === 'movements' ? 'active' : ''} onClick={() => setTab('movements')}>Movimientos</button>
      </div>

      {tab === 'stock' && (
        <div className="card inventory-section-card">
          <div className="section-title inventory-section-title">
            <div><h3>Insumos y existencias</h3><p className="muted">Las existencias son la suma de todos los movimientos de la sucursal.</p></div>
            <div className="inventory-toolbar">
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar nombre o SKU" />
              <button className="btn" onClick={load} disabled={loading}>{loading ? 'Cargando…' : '↻ Actualizar'}</button>
            </div>
          </div>

          {loading ? <div className="empty-inline">Cargando inventario…</div> : visibleItems.length ? (
            <div className="table-wrap inventory-table-wrap">
              <table className="inventory-table">
                <thead><tr><th>Insumo</th><th>Existencia</th><th>Mínimo</th><th>Costo promedio</th><th>Valor</th><th>Estado</th><th /></tr></thead>
                <tbody>
                  {visibleItems.map((item) => {
                    const stock = Number(item.stock || 0)
                    const isLow = Number(item.minStock || 0) > 0 && stock <= Number(item.minStock || 0)
                    return (
                      <tr key={item.id} className={item.active === false ? 'inactive' : ''}>
                        <td><b>{item.name}</b><small>{item.sku ? `SKU ${item.sku} · ` : ''}{UNITS.find((unit) => unit.value === item.unit)?.label || item.unit}</small></td>
                        <td><strong className={stock < 0 ? 'stock-negative' : ''}>{quantityText(stock, item.unit)}</strong></td>
                        <td>{quantityText(item.minStock, item.unit)}</td>
                        <td>{formatMoney(item.averageCost)} <small>por {item.unit}</small></td>
                        <td><b>{formatMoney(item.stockValue)}</b></td>
                        <td><span className={`inventory-stock-badge ${item.active === false ? 'inactive' : isLow ? 'low' : 'ok'}`}>{item.active === false ? 'Inactivo' : isLow ? 'Stock bajo' : 'Disponible'}</span></td>
                        <td>
                          {canManage && <div className="inventory-row-actions"><button className="mini" onClick={() => openMovement(item)}>Movimiento</button><button className="mini" onClick={() => openEditItem(item)}>Editar</button></div>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : <div className="empty-block">Todavía no hay insumos. Registra el primero para comenzar a controlar existencias.</div>}
        </div>
      )}

      {tab === 'recipes' && (
        <div className="card inventory-section-card">
          <div className="section-title">
            <div><h3>Recetas y costo aproximado</h3><p className="muted">Define cuánto consume una venta de cada producto usando la unidad base de cada insumo.</p></div>
          </div>

          {!activeItems.length ? <div className="notice warn">Primero registra al menos un insumo para crear recetas.</div> : null}
          <div className="recipe-product-grid">
            {products.filter((product) => product.active).map((product) => {
              const lines = recipesByProduct.get(product.id) || []
              const cost = recipeCost(product.id)
              const margin = Number(product.price || 0) - cost
              const costPct = Number(product.price || 0) > 0 ? (cost / Number(product.price)) * 100 : 0
              return (
                <article className={`recipe-product-card ${lines.length ? 'configured' : ''}`} key={product.id}>
                  <div className="recipe-product-heading">
                    <div><h4>{product.name}</h4><small>{product.category} · Venta {formatMoney(product.price)}</small></div>
                    <span className={`badge ${lines.length ? 'ok-badge' : ''}`}>{lines.length ? `${lines.length} insumo${lines.length === 1 ? '' : 's'}` : 'Sin receta'}</span>
                  </div>
                  <div className="recipe-cost-summary">
                    <div><span>Costo estimado</span><b>{formatMoney(cost)}</b></div>
                    <div><span>Costo / venta</span><b>{costPct.toFixed(1)}%</b></div>
                    <div><span>Margen bruto aprox.</span><b>{formatMoney(margin)}</b></div>
                  </div>
                  {lines.length > 0 && (
                    <div className="recipe-mini-lines">
                      {lines.slice(0, 3).map((line) => <span key={line.inventoryItemId}>{itemById.get(line.inventoryItemId)?.name || 'Insumo'} · {quantityText(line.quantityRequired, itemById.get(line.inventoryItemId)?.unit)}</span>)}
                      {lines.length > 3 && <span>＋ {lines.length - 3} más</span>}
                    </div>
                  )}
                  {canManage && <button className="btn full" disabled={!activeItems.length} onClick={() => openRecipe(product)}>{lines.length ? 'Editar receta' : 'Crear receta'}</button>}
                </article>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'movements' && (
        <div className="card inventory-section-card">
          <div className="section-title">
            <div><h3>Últimos movimientos</h3><p className="muted">Entradas positivas y salidas negativas. Se muestran los 150 más recientes.</p></div>
            <button className="btn" onClick={load} disabled={loading}>{loading ? 'Cargando…' : '↻ Actualizar'}</button>
          </div>

          {workspace.movements.length ? (
            <div className="table-wrap inventory-table-wrap">
              <table className="inventory-table movement-table">
                <thead><tr><th>Fecha</th><th>Tipo</th><th>Insumo</th><th>Cantidad</th><th>Costo</th><th>Detalle</th></tr></thead>
                <tbody>
                  {workspace.movements.map((movement) => (
                    <tr key={movement.id}>
                      <td>{new Date(movement.createdAt).toLocaleString('es-CO')}</td>
                      <td><span className={`movement-badge ${Number(movement.quantityDelta) < 0 ? 'out' : 'in'}`}>{MOVEMENT_LABELS[movement.movementType] || movement.movementType}</span></td>
                      <td><b>{movement.itemName}</b></td>
                      <td><strong className={Number(movement.quantityDelta) < 0 ? 'movement-out' : 'movement-in'}>{Number(movement.quantityDelta) > 0 ? '+' : ''}{quantityText(movement.quantityDelta, movement.unit)}</strong></td>
                      <td>{formatMoney(movement.unitCost || 0)}</td>
                      <td><span>{movement.note || 'Sin observación'}</span>{movement.createdByName && <small>Por {movement.createdByName}</small>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="empty-block">Todavía no existen movimientos de inventario.</div>}
        </div>
      )}

      {showItem && (
        <div className="modal open inventory-modal" onClick={() => !saving && setShowItem(false)}>
          <form className="modal-card inventory-form-card" onSubmit={submitItem} onClick={(event) => event.stopPropagation()}>
            <div className="section-title"><div><h3>{itemForm.id ? 'Editar insumo' : 'Nuevo insumo'}</h3><p className="muted">La unidad base se usará también en las recetas.</p></div><button type="button" className="btn" disabled={saving} onClick={() => setShowItem(false)}>×</button></div>
            <div className="inventory-form-grid">
              <label className="wide"><span>Nombre del insumo *</span><input autoFocus value={itemForm.name} onChange={(event) => setItemForm({ ...itemForm, name: event.target.value })} placeholder="Ej. Pechuga de pollo" /></label>
              <label><span>SKU / código</span><input value={itemForm.sku} onChange={(event) => setItemForm({ ...itemForm, sku: event.target.value })} placeholder="Opcional" /></label>
              <label><span>Unidad base *</span><select value={itemForm.unit} onChange={(event) => setItemForm({ ...itemForm, unit: event.target.value })}>{UNITS.map((unit) => <option value={unit.value} key={unit.value}>{unit.label}</option>)}</select></label>
              <label><span>Costo por unidad ({currencyCode}) *</span><input inputMode="decimal" value={itemForm.averageCost} onChange={(event) => setItemForm({ ...itemForm, averageCost: event.target.value })} placeholder="0" /></label>
              <label><span>Stock mínimo</span><input inputMode="decimal" value={itemForm.minStock} onChange={(event) => setItemForm({ ...itemForm, minStock: event.target.value })} placeholder="0" /></label>
              <label><span>Stock máximo</span><input inputMode="decimal" value={itemForm.maxStock} onChange={(event) => setItemForm({ ...itemForm, maxStock: event.target.value })} placeholder="Opcional" /></label>
              {!itemForm.id && <label><span>Existencia inicial</span><input inputMode="decimal" value={itemForm.openingStock} onChange={(event) => setItemForm({ ...itemForm, openingStock: event.target.value })} placeholder="0" /></label>}
              <label className="inventory-toggle wide"><span><b>Insumo activo</b><small>Los inactivos conservan su historial, pero no aparecen al crear recetas nuevas.</small></span><input type="checkbox" checked={itemForm.active} onChange={(event) => setItemForm({ ...itemForm, active: event.target.checked })} /></label>
            </div>
            <button className="btn primary full" disabled={saving}>{saving ? 'Guardando…' : 'Guardar insumo'}</button>
          </form>
        </div>
      )}

      {showMovement && (
        <div className="modal open inventory-modal" onClick={() => !saving && setShowMovement(false)}>
          <form className="modal-card inventory-form-card" onSubmit={submitMovement} onClick={(event) => event.stopPropagation()}>
            <div className="section-title"><div><h3>Registrar movimiento</h3><p className="muted">Entradas, desperdicios y correcciones de inventario.</p></div><button type="button" className="btn" disabled={saving} onClick={() => setShowMovement(false)}>×</button></div>
            <div className="inventory-form-grid">
              <label className="wide"><span>Insumo *</span><select value={movementForm.inventoryItemId} onChange={(event) => setMovementForm({ ...movementForm, inventoryItemId: event.target.value, unitCost: '' })}>{activeItems.map((item) => <option value={item.id} key={item.id}>{item.name} · {quantityText(item.stock, item.unit)}</option>)}</select></label>
              <label><span>Tipo de movimiento *</span><select value={movementForm.movementType} onChange={(event) => setMovementForm({ ...movementForm, movementType: event.target.value, unitCost: '' })}><option value="purchase">Entrada / compra</option><option value="waste">Desperdicio</option><option value="adjustment">Ajuste manual (+ o −)</option></select></label>
              <label><span>Cantidad ({selectedMovementItem?.unit || 'unidad'}) *</span><input autoFocus inputMode="decimal" value={movementForm.quantity} onChange={(event) => setMovementForm({ ...movementForm, quantity: event.target.value })} placeholder={movementForm.movementType === 'adjustment' ? 'Ej. -2 o 5' : 'Ej. 10'} /></label>
              {movementForm.movementType === 'purchase' && <label><span>Costo por {selectedMovementItem?.unit || 'unidad'} ({currencyCode})</span><input inputMode="decimal" value={movementForm.unitCost} onChange={(event) => setMovementForm({ ...movementForm, unitCost: event.target.value })} placeholder={String(selectedMovementItem?.averageCost ?? 0)} /></label>}
              <label className={movementForm.movementType === 'purchase' ? '' : 'wide'}><span>{movementForm.movementType === 'purchase' ? 'Nota / proveedor' : 'Motivo *'}</span><input value={movementForm.note} onChange={(event) => setMovementForm({ ...movementForm, note: event.target.value })} placeholder={movementForm.movementType === 'waste' ? 'Ej. Producto vencido' : 'Observación'} /></label>
            </div>
            {selectedMovementItem && <div className="inventory-current-stock"><span>Existencia actual</span><b>{quantityText(selectedMovementItem.stock, selectedMovementItem.unit)}</b></div>}
            <button className="btn primary full" disabled={saving}>{saving ? 'Registrando…' : 'Registrar movimiento'}</button>
          </form>
        </div>
      )}

      {showRecipe && selectedRecipeProduct && (
        <div className="modal open inventory-modal" onClick={() => !saving && setShowRecipe(false)}>
          <form className="modal-card recipe-form-card" onSubmit={submitRecipe} onClick={(event) => event.stopPropagation()}>
            <div className="section-title"><div><h3>Receta · {selectedRecipeProduct.name}</h3><p className="muted">Cantidad consumida al vender una unidad de este producto.</p></div><button type="button" className="btn" disabled={saving} onClick={() => setShowRecipe(false)}>×</button></div>
            <div className="recipe-form-summary"><div><span>Precio de venta</span><b>{formatMoney(selectedRecipeProduct.price)}</b></div><div><span>Costo estimado</span><b>{formatMoney(draftRecipeCost)}</b></div><div><span>Margen aproximado</span><b>{formatMoney(Number(selectedRecipeProduct.price || 0) - draftRecipeCost)}</b></div></div>
            <div className="recipe-form-scroll">
              <div className="recipe-line-list">
                {recipeLines.map((line, index) => {
                  const item = itemById.get(line.inventoryItemId)
                  return (
                    <div className="recipe-line" key={`${index}-${line.inventoryItemId}`}>
                      <label><span>Insumo</span><select value={line.inventoryItemId} onChange={(event) => updateRecipeLine(index, { inventoryItemId: event.target.value })}><option value="">Selecciona</option>{activeItems.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name} · {candidate.unit}</option>)}</select></label>
                      <label><span>Cantidad por venta {item ? `(${item.unit})` : ''}</span><input inputMode="decimal" value={line.quantityRequired} onChange={(event) => updateRecipeLine(index, { quantityRequired: event.target.value })} placeholder="0" /></label>
                      <button type="button" className="mini danger" onClick={() => setRecipeLines((current) => current.filter((_, lineIndex) => lineIndex !== index))}>Quitar</button>
                    </div>
                  )
                })}
              </div>
              <button type="button" className="btn recipe-add-line" onClick={() => setRecipeLines((current) => [...current, { inventoryItemId: activeItems[0]?.id || '', quantityRequired: '' }])}>＋ Agregar insumo</button>
            </div>
            <button className="btn primary full" disabled={saving}>{saving ? 'Guardando receta…' : 'Guardar receta'}</button>
          </form>
        </div>
      )}
    </section>
  )
}
