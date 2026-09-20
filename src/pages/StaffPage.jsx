import React, { useEffect, useMemo, useState } from 'react'
import { ROLE_PRESETS } from '../config/roles.js'
import { useAuth } from '../context/AuthContext.jsx'
import {
  approveAccessRequest,
  loadStaffAdminData,
  rejectAccessRequest,
} from '../services/staffService.js'

function formatDateTime(value) {
  if (!value) return 'Sin fecha'
  try {
    return new Intl.DateTimeFormat('es', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value))
  } catch {
    return 'Sin fecha'
  }
}

export default function StaffPage() {
  const auth = useAuth()
  const restaurantId = auth.userContext?.membership?.restaurant_id || null
  const canManage = auth.can('staff.manage')

  const [requests, setRequests] = useState([])
  const [roles, setRoles] = useState([])
  const [locations, setLocations] = useState([])
  const [choices, setChoices] = useState({})
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')

  const pendingCount = requests.length

  async function refresh() {
    if (auth.isDesignMode || !auth.isSupabaseConfigured || !restaurantId) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')
    try {
      const data = await loadStaffAdminData(restaurantId)
      setRequests(data.requests)
      setRoles(data.roles)
      setLocations(data.locations)
      setChoices((previous) => {
        const next = { ...previous }
        data.requests.forEach((request) => {
          if (!next[request.id]) {
            next[request.id] = {
              roleId: '',
              locationId: data.locations.length === 1 ? data.locations[0].id : '',
            }
          }
        })
        return next
      })
    } catch (err) {
      setError(err?.message || 'No se pudieron cargar las solicitudes.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [restaurantId, auth.isDesignMode, auth.isSupabaseConfigured])

  const roleById = useMemo(
    () => new Map(roles.map((role) => [role.id, role])),
    [roles],
  )

  function updateChoice(requestId, patch) {
    setChoices((previous) => ({
      ...previous,
      [requestId]: {
        ...(previous[requestId] || {}),
        ...patch,
      },
    }))
  }

  async function approve(request) {
    if (!canManage) return window.alert('Tu rol no permite aprobar usuarios.')
    const choice = choices[request.id] || {}
    if (!choice.roleId) return window.alert('Selecciona el rol que tendrá este usuario.')
    if (!choice.locationId && locations.length) {
      const allBranches = window.confirm('No seleccionaste una sucursal. ¿Dar acceso a TODAS las sucursales?')
      if (!allBranches) return
    }

    const roleName = roleById.get(choice.roleId)?.name || 'rol seleccionado'
    const branchName = choice.locationId
      ? locations.find((location) => location.id === choice.locationId)?.name
      : 'todas las sucursales'

    const name = request.profile?.full_name || request.profile?.email || 'este usuario'
    if (!window.confirm(`¿Aprobar a ${name} como ${roleName} con acceso a ${branchName}?`)) return

    setBusyId(request.id)
    setError('')
    try {
      const { error: approvalError } = await approveAccessRequest({
        requestId: request.id,
        roleId: choice.roleId,
        locationId: choice.locationId || null,
      })
      if (approvalError) throw approvalError
      await refresh()
      window.alert('Usuario aprobado y habilitado correctamente.')
    } catch (err) {
      setError(err?.message || 'No se pudo aprobar la solicitud.')
    } finally {
      setBusyId(null)
    }
  }

  async function reject(request) {
    if (!canManage) return window.alert('Tu rol no permite rechazar usuarios.')
    const name = request.profile?.full_name || request.profile?.email || 'este usuario'
    if (!window.confirm(`¿Rechazar la solicitud de ${name}? El usuario no podrá ingresar.`)) return

    setBusyId(request.id)
    setError('')
    try {
      const { error: rejectionError } = await rejectAccessRequest(request.id)
      if (rejectionError) throw rejectionError
      await refresh()
    } catch (err) {
      setError(err?.message || 'No se pudo rechazar la solicitud.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="view active">
      <div className="hero">
        <div>
          <h2>Personal y permisos</h2>
          <p>Aprueba solicitudes, asigna rol y limita el acceso por sucursal.</p>
        </div>
        <button className="btn" onClick={refresh} disabled={loading}>↻ Actualizar</button>
      </div>

      <div className="card">
        <div className="section-title">
          <div>
            <h3>Solicitudes pendientes</h3>
            <p className="muted">El registro por sí solo no concede acceso al restaurante.</p>
          </div>
          <span className="badge">{loading ? 'Cargando…' : `${pendingCount} pendiente${pendingCount === 1 ? '' : 's'}`}</span>
        </div>

        {error && <div className="notice warn">{error}</div>}

        {auth.isDesignMode ? (
          <div className="empty-inline">Sal del modo diseño e ingresa con tu cuenta Owner para gestionar solicitudes reales.</div>
        ) : loading ? (
          <div className="empty-inline">Cargando solicitudes…</div>
        ) : requests.length ? (
          <div className="staff-requests">
            {requests.map((request) => {
              const profile = request.profile || {}
              const choice = choices[request.id] || {}
              const busy = busyId === request.id

              return (
                <article className="staff-request-card" key={request.id}>
                  <div className="staff-request-main">
                    <div className="staff-request-avatar">
                      {(profile.full_name || profile.email || '?').slice(0, 1).toUpperCase()}
                    </div>
                    <div>
                      <h4>{profile.full_name || 'Usuario sin nombre'}</h4>
                      <div className="staff-request-email">{profile.email || 'Sin correo'}</div>
                      <small>
                        {profile.username ? `@${profile.username} · ` : ''}
                        {profile.phone ? `${profile.phone} · ` : ''}
                        Solicitud {formatDateTime(request.requested_at)}
                      </small>
                    </div>
                  </div>

                  <div className="staff-request-controls">
                    <label>
                      <span>Rol</span>
                      <select
                        value={choice.roleId || ''}
                        onChange={(event) => updateChoice(request.id, { roleId: event.target.value })}
                        disabled={!canManage || busy}
                      >
                        <option value="">Selecciona un rol</option>
                        {roles.map((role) => (
                          <option key={role.id} value={role.id}>{role.name}</option>
                        ))}
                      </select>
                    </label>

                    <label>
                      <span>Sucursal</span>
                      <select
                        value={choice.locationId || ''}
                        onChange={(event) => updateChoice(request.id, { locationId: event.target.value })}
                        disabled={!canManage || busy}
                      >
                        <option value="">Todas las sucursales</option>
                        {locations.map((location) => (
                          <option key={location.id} value={location.id}>{location.name}</option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="staff-request-actions">
                    <button
                      className="btn danger-outline"
                      disabled={!canManage || busy}
                      onClick={() => reject(request)}
                    >
                      Rechazar
                    </button>
                    <button
                      className="btn primary"
                      disabled={!canManage || busy || !choice.roleId}
                      onClick={() => approve(request)}
                    >
                      {busy ? 'Procesando…' : '✓ Aprobar usuario'}
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="empty-block">No hay solicitudes pendientes.</div>
        )}

        {!canManage && !auth.isDesignMode && (
          <div className="notice warn">Puedes ver el personal, pero tu rol no tiene el permiso <code>staff.manage</code> para aprobar o rechazar solicitudes.</div>
        )}
      </div>

      <div className="grid two section-gap">
        <div className="card">
          <div className="section-title"><h3>Roles base de RestOS+</h3><span className="badge">7 presets</span></div>
          <div className="list">
            {ROLE_PRESETS.map((role) => (
              <div className="row" key={role.code}>
                <div><b>{role.name}</b><small>{role.description}</small></div>
                <span className="role-icon">{role.icon}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="section-title"><h3>Flujo de alta</h3><span className="badge">Seguro</span></div>
          <div className="list">
            <div className="row"><b>1. Registro</b><span>Correo + contraseña / Google</span></div>
            <div className="row"><b>2. Verificación</b><span>Código por correo</span></div>
            <div className="row"><b>3. Estado</b><span className="badge">PENDIENTE</span></div>
            <div className="row"><b>4. Owner / Manager</b><span>Aprueba + asigna sucursal y rol</span></div>
            <div className="row"><b>5. Acceso</b><span className="badge ok-badge">ACTIVO</span></div>
          </div>
        </div>
      </div>
    </section>
  )
}
