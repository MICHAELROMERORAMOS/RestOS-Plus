import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import {
  listPendingKitchenVoidRequests,
  reviewKitchenVoidRequest,
} from '../services/voidAuthorizationService.js'

export default function StationPage({ station }) {
  const auth = useAuth()
  const { stationJobs, advanceStationRound, tableLabel, formatMoney } = useRestaurant()
  const audioContextRef = useRef(null)
  const knownJobKeysRef = useRef(new Set())
  const knownStationRef = useRef(station)
  const jobsInitializedRef = useRef(false)
  const [showSummary, setShowSummary] = useState(false)
  const [showVoidRequests, setShowVoidRequests] = useState(false)
  const [voidRequests, setVoidRequests] = useState([])
  const [requestsLoading, setRequestsLoading] = useState(false)
  const [reviewingId, setReviewingId] = useState(null)
  const soundStorageKey = `restos-kds-sound-${station}`
  const [soundEnabled, setSoundEnabled] = useState(() => (
    localStorage.getItem(`restos-kds-sound-${station}`) === 'on'
  ))
  const [soundReady, setSoundReady] = useState(false)

  const jobs = stationJobs(station)
  const jobSignature = jobs
    .map(({ order, round }) => `${order.serverId || order.id}:${round.serverId || round.id}`)
    .sort()
    .join('|')
  const isBar = station === 'bar'
  const label = isBar ? 'Bar Display' : 'Kitchen Display'
  const stationName = isBar ? 'Bar' : 'Cocina'
  const icon = isBar ? '🍸' : '🍳'
  const canReviewVoids = station === 'kitchen' && auth.can('orders.void.review_unpaid')
  const restaurantId = auth.userContext?.membership?.restaurant_id || null

  const preparationSummary = useMemo(() => {
    const totals = new Map()

    jobs.forEach(({ items }) => {
      items.forEach((item) => {
        const key = item.productId || item.name
        const current = totals.get(key) || {
          key,
          name: item.name,
          total: 0,
          newQty: 0,
          preparingQty: 0,
        }

        const quantity = Number(item.quantity || 0)
        current.total += quantity

        if (item.prepStatus === 'preparing') current.preparingQty += quantity
        else current.newQty += quantity

        totals.set(key, current)
      })
    })

    return Array.from(totals.values()).sort((a, b) => (
      a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
    ))
  }, [jobs])

  const totalPendingUnits = preparationSummary.reduce((sum, item) => sum + item.total, 0)

  const ensureAudioReady = useCallback(async () => {
    if (typeof window === 'undefined') return false

    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (!AudioContextClass) return false

    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContextClass()
      }

      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume()
      }

      const ready = audioContextRef.current.state === 'running'
      setSoundReady(ready)
      return ready
    } catch {
      setSoundReady(false)
      return false
    }
  }, [])

  const playNewOrderSound = useCallback(async ({ test = false } = {}) => {
    if (!test && !soundEnabled) return false

    const ready = await ensureAudioReady()
    if (!ready || !audioContextRef.current) return false

    const context = audioContextRef.current
    const start = context.currentTime + 0.02
    const notes = [
      { frequency: 880, delay: 0, duration: 0.14 },
      { frequency: 1046, delay: 0.2, duration: 0.14 },
      { frequency: 880, delay: 0.4, duration: 0.22 },
    ]

    notes.forEach(({ frequency, delay, duration }) => {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const noteStart = start + delay
      const noteEnd = noteStart + duration

      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequency, noteStart)
      gain.gain.setValueAtTime(0.0001, noteStart)
      gain.gain.exponentialRampToValueAtTime(0.22, noteStart + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd)

      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(noteStart)
      oscillator.stop(noteEnd + 0.03)
    })

    return true
  }, [ensureAudioReady, soundEnabled])

  const toggleSound = useCallback(async () => {
    if (soundEnabled) {
      localStorage.setItem(soundStorageKey, 'off')
      setSoundEnabled(false)
      setSoundReady(false)
      return
    }

    const ready = await ensureAudioReady()
    if (!ready) {
      window.alert('El navegador bloqueó el audio. Haz clic de nuevo en “Activar sonido” después de interactuar con la página.')
      return
    }

    localStorage.setItem(soundStorageKey, 'on')
    setSoundEnabled(true)
    await playNewOrderSound({ test: true })
  }, [soundEnabled, soundStorageKey, ensureAudioReady, playNewOrderSound])

  useEffect(() => {
    setSoundEnabled(localStorage.getItem(soundStorageKey) === 'on')
    setSoundReady(false)
    knownStationRef.current = station
    knownJobKeysRef.current = new Set()
    jobsInitializedRef.current = false
  }, [station, soundStorageKey])

  useEffect(() => {
    if (!soundEnabled) return undefined

    const unlock = () => {
      ensureAudioReady().catch(() => {})
    }

    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })

    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [soundEnabled, ensureAudioReady])

  useEffect(() => {
    if (knownStationRef.current !== station) {
      knownStationRef.current = station
      knownJobKeysRef.current = new Set()
      jobsInitializedRef.current = false
    }

    const currentKeys = new Set(
      jobs.map(({ order, round }) => `${order.serverId || order.id}:${round.serverId || round.id}`),
    )

    if (!jobsInitializedRef.current) {
      knownJobKeysRef.current = currentKeys
      jobsInitializedRef.current = true
      return
    }

    const hasNewJob = Array.from(currentKeys).some((key) => !knownJobKeysRef.current.has(key))
    knownJobKeysRef.current = currentKeys

    if (hasNewJob && soundEnabled) {
      playNewOrderSound().then((played) => {
        if (!played) setSoundReady(false)
      }).catch(() => setSoundReady(false))
    }
  }, [jobSignature, jobs, station, soundEnabled, playNewOrderSound])

  useEffect(() => () => {
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
  }, [])

  async function refreshVoidRequests({ silent = false } = {}) {
    if (!canReviewVoids || !restaurantId) {
      setVoidRequests([])
      return
    }

    if (!silent) setRequestsLoading(true)

    try {
      const data = await listPendingKitchenVoidRequests(restaurantId)
      setVoidRequests(data)
    } catch (error) {
      if (!silent) window.alert(error?.message || 'No se pudieron cargar las solicitudes de anulación.')
    } finally {
      if (!silent) setRequestsLoading(false)
    }
  }

  useEffect(() => {
    if (!canReviewVoids || !restaurantId) return undefined

    refreshVoidRequests()
    const timer = window.setInterval(() => {
      refreshVoidRequests({ silent: true })
    }, 5000)

    return () => window.clearInterval(timer)
  }, [canReviewVoids, restaurantId])

  async function reviewRequest(request, decision) {
    if (reviewingId) return

    let note = ''
    if (decision === 'rejected') {
      const input = window.prompt('Motivo del rechazo (opcional):', '')
      if (input === null) return
      note = input.trim()
    } else {
      const confirmed = window.confirm(
        `¿Aprobar la anulación solicitada para ${request.table_label || `Orden #${request.order_ref}`}?`,
      )
      if (!confirmed) return
    }

    setReviewingId(request.id)

    try {
      await reviewKitchenVoidRequest(request.id, decision, note)
      setVoidRequests((current) => current.filter((item) => item.id !== request.id))
    } catch (error) {
      window.alert(error?.message || 'No se pudo registrar la decisión de Cocina.')
    } finally {
      setReviewingId(null)
    }
  }

  return (
    <section className={`view active station-view ${isBar ? 'bar-station' : 'kitchen-station'}`}>
      <div className="hero station-hero">
        <div>
          <h2>{label}</h2>
          <p>Solo aparecen productos asignados a {stationName}.</p>
        </div>

        <div className="station-hero-actions">
          <button
            type="button"
            className={`btn station-sound-button ${soundEnabled ? 'enabled' : 'disabled'}`}
            onClick={toggleSound}
            title={soundEnabled
              ? 'Desactivar alerta sonora en este dispositivo'
              : 'Activar alerta sonora para nuevas comandas'}
          >
            <span className="station-sound-icon">{soundEnabled ? '🔔' : '🔕'}</span>
            <span className="station-sound-copy">
              <b>{soundEnabled ? 'Sonido activado' : 'Activar sonido'}</b>
              <small>
                {soundEnabled
                  ? (soundReady ? 'Listo para nuevas comandas' : 'Haz clic o toca la pantalla una vez')
                  : 'Solo en este dispositivo'}
              </small>
            </span>
          </button>

          {canReviewVoids && (
            <button
              className={`btn station-void-alert-button ${voidRequests.length ? 'has-pending' : ''}`}
              onClick={() => {
                setShowVoidRequests(true)
                refreshVoidRequests({ silent: true })
              }}
            >
              <span className="station-void-alert-icon">⚠</span>
              <span className="station-void-alert-copy">
                <b>Anulaciones</b>
                <small>{voidRequests.length ? 'Solicitudes pendientes' : 'Sin solicitudes'}</small>
              </span>
              <span className="station-void-count">{voidRequests.length}</span>
            </button>
          )}

          <button
            className="btn primary station-summary-button"
            onClick={() => setShowSummary(true)}
          >
            ∑ Resumen de preparación
            <span>{totalPendingUnits} unidad{totalPendingUnits === 1 ? '' : 'es'}</span>
          </button>
        </div>
      </div>

      <div className="kds kds-large">
        {jobs.length ? jobs.map(({ order, round, items, status }) => (
          <article className="card ticket kds-ticket" key={`${order.id}-${round.id}`}>
            <div className="section-title kds-ticket-head">
              <div>
                <h3>{
                  order.tableIds?.length
                    ? order.tableIds.map((id) => tableLabel(id)).join(' + ')
                    : order.mode === 'delivery'
                      ? `🚚 Domicilio · ${order.delivery?.customerName || `Orden #${order.id}`}`
                      : `Orden #${order.id}`
                }</h3>
                <small>
                  Orden #{order.id} · Comanda {round.id} · {items.length} producto{items.length === 1 ? '' : 's'}
                  {order.mode === 'delivery' && order.delivery?.address ? ` · ${order.delivery.address}` : ''}
                </small>
              </div>
              <span className="badge">#{order.id} · C{round.id}</span>
            </div>

            <div className={`time kds-state ${status === 'preparing' ? 'preparing' : 'new'}`}>
              {status === 'new' ? 'NUEVO' : 'PREPARANDO'}
            </div>

            {order.pager && <div className="badge">Pager / turno {order.pager}</div>}

            <div className="station-job-items kds-item-list">
              {items.map((item) => (
                <div className="kds-line kds-product-row" key={item.lineId}>
                  <span className="kds-qty">{item.quantity}×</span>
                  <div className="kds-product-copy">
                    <b>{item.name}</b>
                    {item.note && <small>↳ {item.note}</small>}
                  </div>
                </div>
              ))}
            </div>

            <button
              className={`btn kds-action ${status === 'preparing' ? 'primary' : ''}`}
              onClick={async () => {
                const result = await advanceStationRound(order.id, round.id, station)
                if (result?.ok === false) window.alert(result.message)
              }}
            >
              {status === 'new' ? `${icon} Empezar preparación` : '✓ Marcar productos listos'}
            </button>
          </article>
        )) : (
          <div className="card placeholder kds-empty">
            <div>
              <div className="icon">✓</div>
              <h3>Sin comandas pendientes</h3>
              <p>Los nuevos envíos para {isBar ? 'bar' : 'cocina'} aparecerán aquí automáticamente.</p>
            </div>
          </div>
        )}
      </div>

      {showVoidRequests && canReviewVoids && (
        <div className="modal open kitchen-void-modal" onClick={() => setShowVoidRequests(false)}>
          <div className="modal-card kitchen-void-modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-title kitchen-void-modal-head">
              <div>
                <h3>⚠ Solicitudes de anulación</h3>
                <p>
                  {voidRequests.length} pendiente{voidRequests.length === 1 ? '' : 's'} · actualización automática cada 5 segundos
                </p>
              </div>

              <div className="kitchen-void-modal-head-actions">
                <button className="btn" disabled={requestsLoading} onClick={() => refreshVoidRequests()}>
                  ↻
                </button>
                <button className="btn" onClick={() => setShowVoidRequests(false)}>×</button>
              </div>
            </div>

            {requestsLoading && !voidRequests.length ? (
              <div className="empty-inline">Cargando solicitudes…</div>
            ) : voidRequests.length ? (
              <div className="kitchen-void-request-list kitchen-void-request-list-modal">
                {voidRequests.map((request) => (
                  <article className="kitchen-void-request" key={request.id}>
                    <div className="kitchen-void-request-copy">
                      <div className="kitchen-void-request-title">
                        <b>{request.table_label || `Orden #${request.order_ref}`}</b>
                        <span>Solicita: {request.requester_name || 'Usuario'}</span>
                      </div>

                      <div className="kitchen-void-request-items">
                        {(request.items || []).map((item) => (
                          <div key={item.lineId}>
                            <b>{Number(item.quantity || 0)} × {item.name}</b>
                            <span>{formatMoney(item.amount || 0)}</span>
                          </div>
                        ))}
                      </div>

                      <p><b>Motivo:</b> {request.reason}</p>
                    </div>

                    <div className="kitchen-void-review-buttons">
                      <button
                        className="btn"
                        disabled={reviewingId === request.id}
                        onClick={() => reviewRequest(request, 'rejected')}
                      >
                        Rechazar
                      </button>
                      <button
                        className="btn primary"
                        disabled={reviewingId === request.id}
                        onClick={() => reviewRequest(request, 'approved')}
                      >
                        {reviewingId === request.id ? 'Procesando…' : '✓ Aprobar'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-block kitchen-void-empty">
                <div className="icon">✓</div>
                <h3>Sin solicitudes pendientes</h3>
                <p>Cuando Mesero, Caja o Admin soliciten una anulación, aparecerá aquí automáticamente.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {showSummary && (
        <div className="modal open station-summary-modal" onClick={() => setShowSummary(false)}>
          <div className="modal-card station-summary-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-title station-summary-head">
              <div>
                <h3>{icon} Resumen de {stationName}</h3>
                <p>
                  {totalPendingUnits} unidad{totalPendingUnits === 1 ? '' : 'es'} pendiente{totalPendingUnits === 1 ? '' : 's'}
                  {' · '}{jobs.length} comanda{jobs.length === 1 ? '' : 's'}
                </p>
              </div>
              <button className="btn" onClick={() => setShowSummary(false)}>×</button>
            </div>

            {preparationSummary.length ? (
              <div className="station-summary-list">
                {preparationSummary.map((item) => (
                  <div className="station-summary-row" key={item.key}>
                    <div className="station-summary-quantity">{item.total}×</div>
                    <div className="station-summary-copy">
                      <b>{item.name}</b>
                      <small>
                        {item.newQty > 0 && `${item.newQty} nueva${item.newQty === 1 ? '' : 's'}`}
                        {item.newQty > 0 && item.preparingQty > 0 ? ' · ' : ''}
                        {item.preparingQty > 0 && `${item.preparingQty} preparando`}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-block">No hay productos pendientes de preparación.</div>
            )}

            <button className="btn primary full station-summary-close" onClick={() => setShowSummary(false)}>
              Cerrar resumen
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
