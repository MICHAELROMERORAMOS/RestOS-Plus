import React, { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import { preparationStationDisplay } from '../config/stations.js'
import {
  consumeProductUnavailabilityAuthorization,
  listMyPendingProductUnavailabilityRequests,
  requestProductUnavailability,
} from '../services/productAvailabilityService.js'

const DURATION_OPTIONS = [
  { value: 30, label: '30 minutos' },
  { value: 60, label: '1 hora' },
  { value: 120, label: '2 horas' },
  { value: 240, label: '4 horas' },
  { value: 480, label: '8 horas' },
  { value: 720, label: '12 horas' },
  { value: 1440, label: '24 horas' },
]

function formatUntil(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })
}

export default function ProductAvailabilityPage() {
  const auth = useAuth()
  const restaurant = useRestaurant()
  const restaurantId = auth.userContext?.membership?.restaurant_id || null
  const locationId = restaurant.activeLocation?.id || null
  const canRequest = auth.can('products.availability.request')

  const [pending, setPending] = useState([])
  const [loadingPending, setLoadingPending] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState(null)
  const [reason, setReason] = useState('')
  const [durationMinutes, setDurationMinutes] = useState(60)
  const [authorization, setAuthorization] = useState(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')

  async function refreshPending() {
    if (!restaurantId || !locationId || !canRequest || auth.isDesignMode) {
      setPending([])
      return
    }
    setLoadingPending(true)
    try {
      setPending(await listMyPendingProductUnavailabilityRequests({ restaurantId, locationId }))
    } catch (error) {
      window.alert(error?.message || 'No se pudieron cargar las solicitudes pendientes.')
    } finally {
      setLoadingPending(false)
    }
  }

  useEffect(() => {
    refreshPending()
  }, [restaurantId, locationId, canRequest, auth.isDesignMode])

  const pendingByProduct = useMemo(
    () => new Map((pending || []).map((request) => [String(request.product_id), request])),
    [pending],
  )

  const products = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (restaurant.products || [])
      .filter((product) => product.active && product.activeAtLocation)
      .filter((product) => !term || product.name.toLowerCase().includes(term))
      .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }))
  }, [restaurant.products, search])

  function inventoryState(productId) {
    const state = restaurant.inventoryAvailability?.byProduct?.[String(productId)]
    const controlled = Boolean(state?.trackInventory && state?.hasRecipe)
    const maxPreparations = state?.maxPreparations == null ? null : Number(state.maxPreparations)
    const blocked = Boolean(
      restaurant.inventoryAvailability?.enforcementEnabled !== false
      && controlled
      && maxPreparations != null
      && maxPreparations < 1
    )
    return { controlled, maxPreparations, blocked }
  }

  function openRequest(product) {
    if (!canRequest || product.temporarilyUnavailable) return
    setSelectedProduct(product)
    setReason('')
    setDurationMinutes(60)
    setAuthorization(null)
    setCode('')
  }

  function continuePending(product, request) {
    setSelectedProduct(product)
    setReason(request.reason || '')
    setDurationMinutes(Number(request.duration_minutes || 60))
    setAuthorization({
      requestId: request.request_id,
      expiresAt: request.authorization_expires_at,
    })
    setCode('')
  }

  function closeModal() {
    if (busy) return
    setSelectedProduct(null)
    setAuthorization(null)
    setCode('')
  }

  async function sendRequest(event) {
    event.preventDefault()
    if (!selectedProduct || !restaurantId || !locationId) return
    const cleanReason = reason.trim()
    if (cleanReason.length < 5) {
      return window.alert('Explica el motivo con al menos 5 caracteres.')
    }

    setBusy(true)
    try {
      const result = await requestProductUnavailability({
        restaurantId,
        locationId,
        productId: selectedProduct.id,
        reason: cleanReason,
        durationMinutes,
      })
      setAuthorization({
        requestId: result.requestId,
        expiresAt: result.expiresAt,
      })
      setCode('')
      await refreshPending()
    } catch (error) {
      window.alert(error?.message || 'No se pudo enviar la solicitud.')
    } finally {
      setBusy(false)
    }
  }

  async function confirmCode(event) {
    event.preventDefault()
    if (!authorization?.requestId) return
    if (!/^[0-9]{6}$/.test(code.trim())) {
      return window.alert('Ingresa el código de 6 dígitos.')
    }

    setBusy(true)
    try {
      const result = await consumeProductUnavailabilityAuthorization({
        requestId: authorization.requestId,
        code,
      })

      if (!result?.ok) {
        window.alert(result?.message || 'No se pudo autorizar la indisponibilidad.')
        if (['EXPIRED', 'TOO_MANY_ATTEMPTS', 'NOT_PENDING'].includes(result?.code)) {
          await refreshPending()
          setSelectedProduct(null)
          setAuthorization(null)
          setCode('')
        }
        return
      }

      await Promise.all([
        restaurant.refreshMenu(),
        restaurant.refreshInventoryAvailability(),
        refreshPending(),
      ])
      setSelectedProduct(null)
      setAuthorization(null)
      setCode('')
      window.alert('Producto no disponible temporalmente hasta ' + formatUntil(result.unavailableUntil) + '.')
    } catch (error) {
      window.alert(error?.message || 'No se pudo validar el código.')
    } finally {
      setBusy(false)
    }
  }

  if (!restaurant.activeLocation) {
    return (
      <section className="view active">
        <div className="notice warn">Selecciona una sucursal para administrar su disponibilidad operativa.</div>
      </section>
    )
  }

  return (
    <section className="view active product-availability-view">
      <div className="hero">
        <div>
          <h2>Disponibilidad de productos</h2>
          <p>
            Sucursal: <b>{restaurant.activeLocation.name}</b>. Aquí no se modifica el catálogo:
            únicamente se solicita una indisponibilidad temporal autorizada.
          </p>
        </div>
        <button
          className="btn"
          onClick={() => Promise.all([restaurant.refreshMenu(), restaurant.refreshInventoryAvailability(), refreshPending()])}
          disabled={busy || loadingPending}
        >
          ↻ Actualizar
        </button>
      </div>

      {!canRequest && (
        <div className="notice warn">Tu rol puede consultar el menú, pero no solicitar indisponibilidades temporales.</div>
      )}

      <div className="card section-gap">
        <div className="section-title">
          <div>
            <h3>Estado del menú de la sucursal</h3>
            <p className="muted">El inventario bloquea automáticamente; la retirada manual siempre requiere autorización.</p>
          </div>
          <span className="badge">{products.length} productos</span>
        </div>

        <input
          className="product-availability-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Buscar producto…"
        />

        <div className="product-availability-list section-gap">
          {products.length ? products.map((product) => {
            const inventory = inventoryState(product.id)
            const pendingRequest = pendingByProduct.get(String(product.id))
            const temp = product.temporarilyUnavailable

            let status = 'Disponible'
            let detail = 'Puede venderse normalmente.'
            let tone = 'ok'
            if (temp) {
              status = 'Indisponible temporalmente'
              detail = (product.temporaryUnavailableReason || 'Autorizado') + ' · hasta ' + formatUntil(product.temporaryUnavailableUntil)
              tone = 'blocked'
            } else if (inventory.blocked) {
              status = 'Bloqueado por inventario'
              detail = 'No hay insumos suficientes. Se habilitará automáticamente cuando vuelva a existir stock.'
              tone = 'inventory'
            } else if (inventory.controlled && inventory.maxPreparations != null) {
              detail = inventory.maxPreparations + ' unidad(es) producibles según inventario.'
            }

            return (
              <article className={'product-availability-row ' + tone} key={product.id}>
                <div>
                  <div className="product-availability-title">
                    <b>{product.name}</b>
                    <span className={'badge ' + (tone === 'ok' ? 'ok-badge' : '')}>{status}</span>
                  </div>
                  <small>{product.category} · {preparationStationDisplay(product.station)}</small>
                  <p>{detail}</p>
                </div>

                <div className="product-availability-actions">
                  {pendingRequest && !temp ? (
                    <button className="btn" onClick={() => continuePending(product, pendingRequest)}>
                      Ingresar código
                    </button>
                  ) : (
                    <button
                      className="btn"
                      disabled={!canRequest || temp || inventory.blocked}
                      onClick={() => openRequest(product)}
                      title={inventory.blocked ? 'El producto ya está bloqueado automáticamente por inventario.' : ''}
                    >
                      Solicitar indisponibilidad
                    </button>
                  )}
                </div>
              </article>
            )
          }) : (
            <div className="empty-block">No hay productos asignados a esta sucursal que coincidan con la búsqueda.</div>
          )}
        </div>
      </div>

      {selectedProduct && (
        <div className="modal open" onClick={closeModal}>
          <form
            className="modal-card product-availability-modal"
            onSubmit={authorization ? confirmCode : sendRequest}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="section-title">
              <div>
                <h3>{authorization ? 'Autorizar indisponibilidad' : 'Solicitar indisponibilidad'}</h3>
                <p className="muted">{selectedProduct.name} · {restaurant.activeLocation.name}</p>
              </div>
              <button type="button" className="btn" onClick={closeModal} disabled={busy}>×</button>
            </div>

            {!authorization ? (
              <>
                <label>
                  <span>Motivo *</span>
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Ej. equipo de cocción fuera de servicio, problema de calidad, producto retenido…"
                    maxLength={500}
                    autoFocus
                  />
                  <small>El motivo queda registrado en la auditoría.</small>
                </label>

                <label>
                  <span>Duración *</span>
                  <select value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))}>
                    {DURATION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>

                <div className="notice">
                  RestOS+ enviará un código de 6 dígitos a los responsables corporativos autorizados.
                  Sin ese código el producto seguirá disponible.
                </div>

                <button className="btn primary full" disabled={busy || reason.trim().length < 5}>
                  {busy ? 'Enviando autorización…' : 'Enviar solicitud y código'}
                </button>
              </>
            ) : (
              <>
                <div className="notice">
                  El código fue enviado por correo a los responsables corporativos.
                  {' '}Caduca {authorization.expiresAt ? 'a las ' + formatUntil(authorization.expiresAt) : 'en 10 minutos'}.
                </div>

                <label>
                  <span>Código de autorización *</span>
                  <input
                    className="product-authorization-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    autoFocus
                  />
                </label>

                <div className="product-authorization-summary">
                  <div><span>Motivo</span><b>{reason}</b></div>
                  <div><span>Duración</span><b>{DURATION_OPTIONS.find((item) => item.value === durationMinutes)?.label || durationMinutes + ' min'}</b></div>
                </div>

                <button className="btn primary full" disabled={busy || code.length !== 6}>
                  {busy ? 'Validando…' : 'Validar código y retirar temporalmente'}
                </button>
              </>
            )}
          </form>
        </div>
      )}
    </section>
  )
}
