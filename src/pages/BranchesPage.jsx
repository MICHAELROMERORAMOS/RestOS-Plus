import React, { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import {
  activateBranchCapacity,
  loadCompanyBranches,
  requestBranchCapacity,
  rotateCompanyJoinCode,
  saveCompanyBranch,
  setBranchInvoicePrefix,
  setCompanyBranchActive,
} from '../services/branchService.js'

const emptyBranch = {
  id: null,
  name: '',
  code: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  country: '',
  phone: '',
  invoicePrefix: '',
  invoicePrefixLocked: false,
}

function branchError(error) {
  const message = String(error?.message || '')
  if (message.includes('Branch name or code is already in use')) return 'El nombre o código de la sucursal ya está en uso.'
  if (message.includes('Cannot deactivate the last active branch')) return 'No puedes desactivar la última sucursal activa de la empresa.'
  if (message.includes('Branch has active orders')) return 'No puedes desactivar esta sucursal mientras tenga pedidos activos.'
  if (message.includes('Branch has active table sessions')) return 'No puedes desactivar esta sucursal mientras haya una mesa en toma de pedido.'
  if (message.includes('Active branch limit reached')) return 'La empresa alcanzó el número máximo de sucursales activas permitido por su suscripción.'
  if (message.includes('Not allowed to manage branches')) return 'Tu usuario no tiene permiso para administrar sucursales.'
  if (message.includes('Invoice prefix is already in use')) return 'Ese prefijo de facturación ya está usado por otra sucursal de la empresa.'
  if (message.includes('Invoice prefix is locked after the first invoice')) return 'El prefijo de facturación queda bloqueado después de emitir la primera factura.'
  if (message.includes('Invoice prefix is required')) return 'Escribe un prefijo de facturación válido.'
  return message || 'No se pudo completar la operación.'
}

export default function BranchesPage() {
  const auth = useAuth()
  const restaurant = useRestaurant()
  const restaurantId = auth.userContext?.membership?.restaurant_id || null
  const canManage = auth.can('branches.manage')

  const [company, setCompany] = useState(null)
  const [branches, setBranches] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)
  const [capacityDialog, setCapacityDialog] = useState(null)
  const [capacityBusy, setCapacityBusy] = useState(false)
  const [additionalBranches, setAdditionalBranches] = useState('1')
  const [activationCode, setActivationCode] = useState('')
  const [capacityMessage, setCapacityMessage] = useState('')

  const activeBranches = useMemo(
    () => branches.filter((branch) => branch.active !== false),
    [branches],
  )
  const allowedBranchCount = Math.max(1, Number(company?.allowedBranchCount || 1))
  const branchLimitReached = activeBranches.length >= allowedBranchCount

  async function refresh() {
    if (auth.isDesignMode || !restaurantId) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')
    try {
      const data = await loadCompanyBranches(restaurantId)
      setCompany(data.company)
      setBranches(data.branches)
    } catch (err) {
      setError(branchError(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [restaurantId, auth.isDesignMode])

  function openNew() {
    if (branchLimitReached) {
      setCapacityMessage('')
      setCapacityDialog('limit')
      return
    }
    setEditing({ ...emptyBranch })
  }

  function openCapacityRequest() {
    setCapacityMessage('')
    setAdditionalBranches('1')
    setCapacityDialog('request')
  }

  function openCapacityActivation() {
    setCapacityMessage('')
    setActivationCode('')
    setCapacityDialog('activate')
  }

  async function submitCapacityRequest(event) {
    event.preventDefault()
    if (capacityBusy || !restaurantId) return
    const quantity = Number(additionalBranches)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      setCapacityMessage('Indica una cantidad válida entre 1 y 100 sucursales adicionales.')
      return
    }

    setCapacityBusy(true)
    setCapacityMessage('')
    try {
      await requestBranchCapacity({ restaurantId, additionalBranches: quantity })
      await refresh()
      setCapacityDialog('success')
      setCapacityMessage(
        `Solicitud enviada correctamente por ${quantity} sucursal${quantity === 1 ? '' : 'es'} adicional${quantity === 1 ? '' : 'es'}. El desarrollador recibirá la solicitud por correo. Cuando se confirme el pago, el administrador principal recibirá el código de activación.`,
      )
    } catch (err) {
      const message = String(err?.message || '')
      setCapacityMessage(
        message.includes('Open branch capacity request already exists')
          ? 'Ya existe una solicitud de ampliación pendiente para esta empresa.'
          : (message || 'No se pudo enviar la solicitud.'),
      )
    } finally {
      setCapacityBusy(false)
    }
  }

  async function submitCapacityActivation(event) {
    event.preventDefault()
    if (capacityBusy || !restaurantId) return
    const code = activationCode.trim().toUpperCase()
    if (!/^[A-Z0-9]{8}$/.test(code)) {
      setCapacityMessage('Ingresa el código de activación de 8 caracteres recibido por correo.')
      return
    }

    setCapacityBusy(true)
    setCapacityMessage('')
    try {
      const result = await activateBranchCapacity({ restaurantId, code })
      await Promise.all([refresh(), restaurant.refreshRemoteData()])
      setCapacityDialog('success')
      setCapacityMessage(
        `Activación completada. La empresa ahora puede tener hasta ${result?.newAllowedBranchCount || 'más'} sucursales activas.`,
      )
    } catch (err) {
      const message = String(err?.message || '')
      setCapacityMessage(
        message.includes('Invalid or unavailable activation code')
          ? 'El código no es válido, ya fue utilizado o no corresponde a esta empresa.'
          : (message || 'No se pudo activar la ampliación.'),
      )
    } finally {
      setCapacityBusy(false)
    }
  }

  function openEdit(branch) {
    setEditing({
      id: branch.id,
      name: branch.name || '',
      code: branch.code || '',
      addressLine1: branch.addressLine1 || '',
      addressLine2: branch.addressLine2 || '',
      city: branch.city || '',
      country: branch.country || '',
      phone: branch.phone || '',
      invoicePrefix: branch.invoicePrefix || '',
      invoicePrefixLocked: Boolean(branch.invoicePrefixLocked),
    })
  }

  async function save(event) {
    event.preventDefault()
    if (!editing || saving) return
    if (!editing.name.trim()) return window.alert('Escribe el nombre de la sucursal.')

    setSaving(true)
    try {
      const savedBranch = await saveCompanyBranch({
        restaurantId,
        branchId: editing.id,
        name: editing.name.trim(),
        code: editing.code.trim(),
        addressLine1: editing.addressLine1.trim(),
        addressLine2: editing.addressLine2.trim(),
        city: editing.city.trim(),
        country: editing.country.trim(),
        phone: editing.phone.trim(),
      })

      const requestedPrefix = String(editing.invoicePrefix || '').trim()
      if (requestedPrefix && !editing.invoicePrefixLocked) {
        await setBranchInvoicePrefix({
          restaurantId,
          locationId: savedBranch.id,
          prefix: requestedPrefix,
        })
      }

      setEditing(null)
      await Promise.all([refresh(), restaurant.refreshRemoteData()])
    } catch (err) {
      const message = branchError(err)
      if (message.includes('máximo de sucursales activas')) {
        setCapacityMessage('')
        setCapacityDialog('limit')
      } else {
        window.alert(message)
      }
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(branch) {
    if (!canManage) return

    const nextActive = !branch.active
    const confirmed = window.confirm(
      nextActive
        ? `¿Activar nuevamente la sucursal “${branch.name}”?`
        : `¿Desactivar la sucursal “${branch.name}”?\n\nNo se eliminarán ventas, inventario, facturas ni historial. La sucursal dejará de estar disponible para nuevas operaciones.`,
    )
    if (!confirmed) return

    setSaving(true)
    try {
      await setCompanyBranchActive({
        restaurantId,
        branchId: branch.id,
        active: nextActive,
      })
      await Promise.all([refresh(), restaurant.refreshRemoteData()])
    } catch (err) {
      const message = branchError(err)
      if (message.includes('máximo de sucursales activas')) {
        setCapacityMessage('')
        setCapacityDialog('limit')
      } else {
        window.alert(message)
      }
    } finally {
      setSaving(false)
    }
  }

  async function rotateJoinCode() {
    if (!canManage || saving || !restaurantId) return

    const confirmed = window.confirm(
      '¿Generar un nuevo código de empresa?\n\nEl código anterior dejará de servir para nuevas solicitudes de empleados.',
    )
    if (!confirmed) return

    setSaving(true)
    try {
      const joinCode = await rotateCompanyJoinCode(restaurantId)
      setCompany((previous) => previous ? { ...previous, joinCode } : previous)
      window.alert(`Nuevo código de empresa: ${joinCode}`)
    } catch (err) {
      window.alert(branchError(err))
    } finally {
      setSaving(false)
    }
  }

  if (auth.isDesignMode) {
    return (
      <section className="view active">
        <div className="hero"><div><h2>Empresa y sucursales</h2><p>Disponible al ingresar con Supabase.</p></div></div>
      </section>
    )
  }

  return (
    <section className="view active branches-view">
      <div className="hero">
        <div>
          <h2>Empresa y sucursales</h2>
          <p>Administra las sedes operativas de {company?.name || auth.userContext?.restaurant || 'la empresa'}.</p>
        </div>
        {canManage && (
          <button
            className="btn primary"
            onClick={openNew}
            disabled={saving}
            title={branchLimitReached ? 'Límite alcanzado · solicitar ampliación' : ''}
          >
            ＋ Nueva sucursal
          </button>
        )}
      </div>

      {error && <div className="notice warn">{error}</div>}
      {(branchLimitReached || company?.branchCapacityRequest) && (
        <div className="branch-capacity-banner">
          <div className="branch-capacity-icon">🏢</div>
          <div className="branch-capacity-copy">
            <strong>{branchLimitReached ? 'Límite de sucursales alcanzado' : 'Ampliación de sucursales en proceso'}</strong>
            <p>
              {branchLimitReached
                ? <>Esta empresa tiene <b>{activeBranches.length} de {allowedBranchCount}</b> sucursales activas permitidas. </>
                : <>La empresa tiene actualmente <b>{activeBranches.length} de {allowedBranchCount}</b> sucursales activas. </>}
              Si necesitas ampliar la capacidad, puedes solicitar aquí el número de sucursales adicionales.
              Después de confirmar el pago, el administrador principal recibirá por correo un código de activación.
            </p>
            {company?.branchCapacityRequest && (
              <div className="branch-capacity-status">
                {company.branchCapacityRequest.status === 'pending' && 'Solicitud enviada · pendiente de confirmación de pago'}
                {company.branchCapacityRequest.status === 'paid' && 'Pago confirmado · código pendiente de envío o reenvío'}
                {company.branchCapacityRequest.status === 'code_sent' && 'Código de activación enviado al correo del administrador principal'}
                {' · +'}{company.branchCapacityRequest.additionalBranches} sucursal(es)
              </div>
            )}
          </div>
          {canManage && (
            <div className="branch-capacity-actions">
              {!company?.branchCapacityRequest && (
                <button className="btn primary" onClick={openCapacityRequest}>Solicitar ampliación</button>
              )}
              <button className="btn" onClick={openCapacityActivation}>Activar código</button>
            </div>
          )}
        </div>
      )}

      <div className="grid stats branch-stats">
        <div className="card stat">
          <span className="label">Empresa</span>
          <strong className="branch-company-name">{company?.name || '—'}</strong>
          <small>{company?.legalName || 'Razón social no configurada'}</small>
        </div>
        <div className="card stat">
          <span className="label">Sucursales activas</span>
          <strong>{activeBranches.length} / {allowedBranchCount}</strong>
          <small>{branches.length} registradas · límite administrado por RestOS+</small>
        </div>
        <div className="card stat">
          <span className="label">Última sucursal operativa</span>
          <strong className="branch-company-name">{restaurant.activeLocation?.name || '—'}</strong>
          <small>{restaurant.activeLocation?.code || 'Sin código'}</small>
        </div>
        <div className="card stat">
          <span className="label">Moneda empresa</span>
          <strong>{company?.currencyCode || restaurant.currencyCode || '—'}</strong>
          <small>{company?.timezone || 'Zona horaria no configurada'}</small>
        </div>
      </div>

      {canManage && company?.joinCode && (
        <div className="card section-gap company-access-code-card">
          <div className="section-title">
            <div>
              <h3>Código de empresa para empleados</h3>
              <p className="muted">Compártelo únicamente con personas que deban solicitar acceso a esta empresa.</p>
            </div>
            <button className="btn" onClick={rotateJoinCode} disabled={saving}>↻ Cambiar código</button>
          </div>
          <div className="company-access-code">
            <strong>{company.joinCode}</strong>
            <button
              className="btn"
              onClick={() => navigator.clipboard?.writeText(company.joinCode)}
            >
              Copiar
            </button>
          </div>
          <div className="notice">
            Este código <b>no da acceso automáticamente</b>. Solo identifica la empresa durante el registro.
            La solicitud seguirá apareciendo en <b>Personal</b> para que el Owner asigne rol y sucursal.
          </div>
        </div>
      )}

      <div className="card section-gap">
        <div className="section-title">
          <div>
            <h3>Sucursales</h3>
            <p className="muted">Cada sucursal mantiene separadas sus mesas, pedidos, caja, turnos e inventario.</p>
          </div>
          <button className="btn" onClick={refresh} disabled={loading}>{loading ? 'Cargando…' : '↻ Actualizar'}</button>
        </div>

        {loading ? (
          <div className="empty-inline">Cargando sucursales…</div>
        ) : branches.length ? (
          <div className="branch-grid">
            {branches.map((branch) => {
              const isCurrent = String(branch.id) === String(restaurant.activeLocation?.id)
              return (
                <article className={`branch-card ${branch.active ? '' : 'inactive'} ${isCurrent ? 'current' : ''}`} key={branch.id}>
                  <div className="branch-card-head">
                    <div>
                      <div className="branch-name-line">
                        <h3>{branch.name}</h3>
                        {isCurrent && <span className="badge ok-badge">Última operativa</span>}
                        {!branch.active && <span className="badge">Inactiva</span>}
                      </div>
                      <small>{branch.code || 'Sin código'}</small>
                    </div>
                  </div>

                  <div className="branch-meta">
                    <div><span>Dirección</span><b>{[branch.addressLine1, branch.city, branch.country].filter(Boolean).join(' · ') || 'Sin configurar'}</b></div>
                    <div><span>Teléfono</span><b>{branch.phone || '—'}</b></div>
                    <div><span>Usuarios con acceso</span><b>{Number(branch.assignedUsers || 0)}</b></div>
                    <div><span>Pedidos activos</span><b>{Number(branch.openOrders || 0)}</b></div>
                    <div>
                      <span>Prefijo facturas</span>
                      <b>{branch.invoicePrefix || '—'}</b>
                    </div>
                    <div>
                      <span>Próxima factura</span>
                      <b>{branch.nextInvoice || '—'}</b>
                    </div>
                  </div>

                  <div className="branch-actions">
                    {branch.active && !isCurrent && (
                      <button className="btn" onClick={() => restaurant.switchLocation(branch.id)}>
                        Trabajar aquí
                      </button>
                    )}
                    {canManage && <button className="btn" onClick={() => openEdit(branch)}>Editar</button>}
                    {canManage && (
                      <button
                        className={`btn ${branch.active ? 'danger-outline' : ''}`}
                        onClick={() => toggleActive(branch)}
                        disabled={
                          saving
                          || (branch.active && isCurrent)
                          || (!branch.active && branchLimitReached)
                        }
                        title={
                          branch.active && isCurrent
                            ? 'Cambia primero a otra sucursal antes de desactivarla.'
                            : (!branch.active && branchLimitReached
                              ? 'No se puede reactivar: la empresa alcanzó el límite de sucursales activas.'
                              : '')
                        }
                      >
                        {branch.active ? 'Desactivar' : 'Activar'}
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="empty-block">No hay sucursales registradas.</div>
        )}
      </div>

      <div className="notice section-gap">
        Los usuarios con acceso a <b>Todas las sucursales</b> reciben automáticamente acceso a nuevas sedes.
        Los usuarios limitados a sucursales específicas deben asignarse desde <b>Personal</b>.
      </div>

      {capacityDialog && (
        <div className="modal open branch-capacity-modal-backdrop" onClick={() => !capacityBusy && setCapacityDialog(null)}>
          <div className="modal-card branch-capacity-modal" onClick={(event) => event.stopPropagation()}>
            {capacityDialog === 'limit' && (
              <>
                <div className="branch-capacity-modal-icon">🏢</div>
                <h3>Límite de sucursales alcanzado</h3>
                <p>
                  La empresa ya utiliza <b>{activeBranches.length} de {allowedBranchCount}</b> sucursales activas.
                  Puedes solicitar una ampliación. La solicitud se enviará al desarrollador de RestOS+ y,
                  después de confirmar el pago, el código de activación llegará al correo del administrador principal.
                </p>
                <div className="branch-capacity-modal-actions">
                  <button className="btn" onClick={() => setCapacityDialog(null)}>Cerrar</button>
                  <button className="btn" onClick={openCapacityActivation}>Tengo un código</button>
                  {!company?.branchCapacityRequest && (
                    <button className="btn primary" onClick={openCapacityRequest}>Solicitar ampliación</button>
                  )}
                </div>
              </>
            )}

            {capacityDialog === 'request' && (
              <form onSubmit={submitCapacityRequest}>
                <div className="section-title">
                  <div>
                    <span className="branch-capacity-kicker">AMPLIACIÓN DE CAPACIDAD</span>
                    <h3>Solicitar más sucursales</h3>
                    <p className="muted">La solicitud llegará directamente al desarrollador de RestOS+.</p>
                  </div>
                  <button type="button" className="btn" disabled={capacityBusy} onClick={() => setCapacityDialog(null)}>×</button>
                </div>
                <label className="field">
                  <span>Sucursales adicionales solicitadas</span>
                  <input type="number" min="1" max="100" step="1" value={additionalBranches}
                    onChange={(event) => setAdditionalBranches(event.target.value)} required />
                </label>
                <div className="branch-capacity-process">
                  <div><b>1</b><span>Envías la solicitud</span></div>
                  <div><b>2</b><span>Se acuerda y confirma el pago</span></div>
                  <div><b>3</b><span>Recibes el código por correo</span></div>
                  <div><b>4</b><span>Activas la nueva capacidad</span></div>
                </div>
                {capacityMessage && <div className="notice warn">{capacityMessage}</div>}
                <div className="branch-capacity-modal-actions">
                  <button type="button" className="btn" disabled={capacityBusy} onClick={() => setCapacityDialog(null)}>Cancelar</button>
                  <button type="submit" className="btn primary" disabled={capacityBusy}>
                    {capacityBusy ? 'Enviando…' : 'Enviar solicitud'}
                  </button>
                </div>
              </form>
            )}

            {capacityDialog === 'activate' && (
              <form onSubmit={submitCapacityActivation}>
                <div className="section-title">
                  <div>
                    <span className="branch-capacity-kicker">CÓDIGO DE ACTIVACIÓN</span>
                    <h3>Activar sucursales adicionales</h3>
                    <p className="muted">Introduce el código enviado al correo del administrador principal después de confirmar el pago.</p>
                  </div>
                  <button type="button" className="btn" disabled={capacityBusy} onClick={() => setCapacityDialog(null)}>×</button>
                </div>
                <label className="field">
                  <span>Código</span>
                  <input className="branch-capacity-code-input" value={activationCode} maxLength={8}
                    onChange={(event) => setActivationCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
                    placeholder="ABCD1234" autoComplete="one-time-code" required />
                </label>
                {capacityMessage && <div className="notice warn">{capacityMessage}</div>}
                <div className="branch-capacity-modal-actions">
                  <button type="button" className="btn" disabled={capacityBusy} onClick={() => setCapacityDialog(null)}>Cancelar</button>
                  <button type="submit" className="btn primary" disabled={capacityBusy}>
                    {capacityBusy ? 'Activando…' : 'Activar ampliación'}
                  </button>
                </div>
              </form>
            )}

            {capacityDialog === 'success' && (
              <>
                <div className="branch-capacity-modal-icon success">✓</div>
                <h3>Proceso actualizado</h3>
                <p>{capacityMessage}</p>
                <div className="branch-capacity-modal-actions single">
                  <button className="btn primary" onClick={() => setCapacityDialog(null)}>Entendido</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {editing && (
        <div className="modal open" onClick={() => !saving && setEditing(null)}>
          <form className="modal-card branch-form-card" onSubmit={save} onClick={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div>
                <h3>{editing.id ? 'Editar sucursal' : 'Nueva sucursal'}</h3>
                <p className="muted">La sucursal pertenecerá a {company?.name || 'esta empresa'}.</p>
              </div>
              <button type="button" className="btn" disabled={saving} onClick={() => setEditing(null)}>×</button>
            </div>

            <div className="grid two settings-form branch-form-grid">
              <label><span>Nombre *</span><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Ej. Sucursal Centro" /></label>
              <label><span>Código</span><input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })} placeholder="Ej. CENTRO" /></label>
              <label><span>Dirección</span><input value={editing.addressLine1} onChange={(e) => setEditing({ ...editing, addressLine1: e.target.value })} /></label>
              <label><span>Dirección adicional</span><input value={editing.addressLine2} onChange={(e) => setEditing({ ...editing, addressLine2: e.target.value })} /></label>
              <label><span>Ciudad</span><input value={editing.city} onChange={(e) => setEditing({ ...editing, city: e.target.value })} /></label>
              <label><span>País</span><input value={editing.country} onChange={(e) => setEditing({ ...editing, country: e.target.value })} /></label>
              <label><span>Teléfono</span><input value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} /></label>
              <label>
                <span>Prefijo de facturación</span>
                <input
                  value={editing.invoicePrefix}
                  disabled={editing.invoicePrefixLocked}
                  onChange={(e) => setEditing({
                    ...editing,
                    invoicePrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12),
                  })}
                  placeholder={editing.code ? editing.code.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 12) : 'Ej. CENTRO'}
                />
                <small>
                  {editing.invoicePrefixLocked
                    ? 'Bloqueado porque esta sucursal ya emitió facturas.'
                    : 'Solo letras y números. El consecutivo es independiente para esta sucursal.'}
                </small>
              </label>
            </div>

            <button className="btn primary full" disabled={saving}>
              {saving ? 'Guardando…' : editing.id ? 'Guardar cambios' : 'Crear sucursal'}
            </button>
          </form>
        </div>
      )}
    </section>
  )
}
