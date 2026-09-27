import React, { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import {
  loadCompanyBranches,
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

  const activeBranches = useMemo(
    () => branches.filter((branch) => branch.active !== false),
    [branches],
  )

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
    setEditing({ ...emptyBranch })
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
      window.alert(branchError(err))
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
      window.alert(branchError(err))
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
        {canManage && <button className="btn primary" onClick={openNew}>＋ Nueva sucursal</button>}
      </div>

      {error && <div className="notice warn">{error}</div>}

      <div className="grid stats branch-stats">
        <div className="card stat">
          <span className="label">Empresa</span>
          <strong className="branch-company-name">{company?.name || '—'}</strong>
          <small>{company?.legalName || 'Razón social no configurada'}</small>
        </div>
        <div className="card stat">
          <span className="label">Sucursales activas</span>
          <strong>{activeBranches.length}</strong>
          <small>{branches.length} registradas</small>
        </div>
        <div className="card stat">
          <span className="label">Sucursal actual</span>
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
                        {isCurrent && <span className="badge ok-badge">Sucursal actual</span>}
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
                        disabled={saving || (branch.active && isCurrent)}
                        title={branch.active && isCurrent ? 'Cambia primero a otra sucursal antes de desactivarla.' : ''}
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
