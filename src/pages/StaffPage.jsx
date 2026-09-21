import React, { useEffect, useMemo, useState } from 'react'
import { ROLE_PRESETS } from '../config/roles.js'
import { useAuth } from '../context/AuthContext.jsx'
import {
  approveAccessRequest,
  loadStaffAdminData,
  rejectAccessRequest,
  updateStaffMember,
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

function friendlyStaffError(error, fallback = 'No se pudo completar la operación.') {
  const message = String(error?.message || '')

  if (message.includes('That username is already in use')) return 'Ese nombre de usuario ya está siendo utilizado.'
  if (message.includes('primary Owner')) return 'El Owner principal no puede desactivarse ni cambiarse a otro rol.'
  if (message.includes('deactivate your own user')) return 'No puedes desactivar tu propio usuario.'
  if (message.includes('Not authorized')) return 'Tu rol no tiene permiso para administrar este personal.'
  if (message.includes('Select at least one location')) return 'Selecciona al menos una sucursal.'
  if (message.includes('Username must contain')) return 'El usuario debe tener entre 3 y 40 caracteres y usar solo letras, números, puntos, guiones o guion bajo.'
  if (message.includes('Full name must contain')) return 'El nombre debe tener entre 2 y 120 caracteres.'

  return message || fallback
}

function roleIcon(roleName) {
  return ROLE_PRESETS.find((role) => role.name === roleName)?.icon || '👤'
}

export default function StaffPage() {
  const auth = useAuth()
  const restaurantId = auth.userContext?.membership?.restaurant_id || null
  const canManage = auth.can('staff.manage')

  const [members, setMembers] = useState([])
  const [requests, setRequests] = useState([])
  const [roles, setRoles] = useState([])
  const [locations, setLocations] = useState([])
  const [choices, setChoices] = useState({})
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [editingMember, setEditingMember] = useState(null)
  const [memberForm, setMemberForm] = useState(null)

  const pendingCount = requests.length
  const activeCount = members.filter((member) => member.membership_status === 'active').length
  const inactiveCount = members.length - activeCount

  async function refresh() {
    if (auth.isDesignMode || !auth.isSupabaseConfigured || !restaurantId) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')
    try {
      const data = await loadStaffAdminData(restaurantId)
      setMembers(data.members)
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
      setError(friendlyStaffError(err, 'No se pudo cargar el personal.'))
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

  const locationById = useMemo(
    () => new Map(locations.map((location) => [location.id, location])),
    [locations],
  )

  const filteredMembers = useMemo(() => {
    const term = search.trim().toLowerCase()
    return members.filter((member) => {
      const matchesStatus = statusFilter === 'all' || member.membership_status === statusFilter
      const searchable = [member.full_name, member.username, member.email, member.phone, member.role_name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return matchesStatus && (!term || searchable.includes(term))
    })
  }, [members, search, statusFilter])

  function updateChoice(requestId, patch) {
    setChoices((previous) => ({
      ...previous,
      [requestId]: {
        ...(previous[requestId] || {}),
        ...patch,
      },
    }))
  }

  function memberLocationText(member) {
    if (member.all_locations) return 'Todas las sucursales'
    const names = (member.location_ids || [])
      .map((locationId) => locationById.get(locationId)?.name)
      .filter(Boolean)
    return names.length ? names.join(', ') : 'Sin sucursal asignada'
  }

  function openMemberEditor(member) {
    if (!canManage) return window.alert('Tu rol permite consultar el personal, pero no modificarlo.')
    setError('')
    setEditingMember(member)
    setMemberForm({
      fullName: member.full_name || '',
      username: member.username || '',
      phone: member.phone || '',
      roleId: member.role_id || '',
      status: member.membership_status === 'suspended' ? 'suspended' : 'active',
      allLocations: Boolean(member.all_locations),
      locationIds: Array.isArray(member.location_ids) ? member.location_ids : [],
    })
  }

  function closeMemberEditor() {
    if (busyId) return
    setEditingMember(null)
    setMemberForm(null)
  }

  function updateMemberField(field, value) {
    setMemberForm((previous) => ({ ...previous, [field]: value }))
  }

  function toggleMemberLocation(locationId) {
    setMemberForm((previous) => {
      const selected = new Set(previous.locationIds || [])
      if (selected.has(locationId)) selected.delete(locationId)
      else selected.add(locationId)
      return { ...previous, locationIds: Array.from(selected) }
    })
  }

  async function saveMember() {
    if (!editingMember || !memberForm || !canManage) return

    const fullName = memberForm.fullName.trim()
    const username = memberForm.username.trim().toLowerCase()
    if (fullName.length < 2) return window.alert('Escribe el nombre completo del usuario.')
    if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) {
      return window.alert('El usuario debe tener entre 3 y 40 caracteres y usar solo letras, números, puntos, guiones o guion bajo.')
    }
    if (!memberForm.roleId) return window.alert('Selecciona un rol.')
    if (!memberForm.allLocations && !memberForm.locationIds.length) {
      return window.alert('Selecciona al menos una sucursal.')
    }

    if (memberForm.status === 'suspended' && editingMember.membership_status !== 'suspended') {
      const confirmed = window.confirm(
        `¿Desactivar a ${editingMember.full_name || editingMember.email}? No podrá volver a ingresar hasta que lo actives nuevamente.`,
      )
      if (!confirmed) return
    }

    setBusyId(editingMember.membership_id)
    setError('')
    try {
      const { error: updateError } = await updateStaffMember({
        restaurantId,
        membershipId: editingMember.membership_id,
        fullName,
        username,
        phone: memberForm.phone.trim(),
        roleId: memberForm.roleId,
        status: memberForm.status,
        allLocations: memberForm.allLocations,
        locationIds: memberForm.locationIds,
      })
      if (updateError) throw updateError

      await refresh()
      setEditingMember(null)
      setMemberForm(null)
      window.alert('Datos del usuario actualizados correctamente.')
    } catch (err) {
      setError(friendlyStaffError(err, 'No se pudo actualizar el usuario.'))
    } finally {
      setBusyId(null)
    }
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
      setError(friendlyStaffError(err, 'No se pudo aprobar la solicitud.'))
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
      setError(friendlyStaffError(err, 'No se pudo rechazar la solicitud.'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="view active staff-admin-view">
      <div className="hero staff-admin-hero">
        <div>
          <h2>Personal y permisos</h2>
          <p>Administra datos, roles, sucursales y acceso de cada usuario.</p>
        </div>
        <button className="btn" onClick={refresh} disabled={loading}>↻ Actualizar</button>
      </div>

      {error && <div className="notice warn staff-global-error">{error}</div>}

      <div className="card staff-members-card">
        <div className="section-title staff-members-title">
          <div>
            <h3>Personal registrado</h3>
            <p className="muted">El correo se muestra como referencia; aquí puedes cambiar los datos operativos y el acceso.</p>
          </div>
          <div className="staff-count-badges">
            <span className="badge ok-badge">{activeCount} activos</span>
            <span className="badge">{inactiveCount} inactivos</span>
          </div>
        </div>

        <div className="staff-toolbar">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por nombre, usuario, correo o rol…"
          />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">Todos los estados</option>
            <option value="active">Solo activos</option>
            <option value="suspended">Solo inactivos</option>
          </select>
        </div>

        {auth.isDesignMode ? (
          <div className="empty-inline">Sal del modo diseño e ingresa con tu cuenta Owner para gestionar el personal real.</div>
        ) : loading ? (
          <div className="empty-inline">Cargando personal…</div>
        ) : filteredMembers.length ? (
          <div className="staff-member-list">
            {filteredMembers.map((member) => (
              <article
                className={`staff-member-card ${member.membership_status === 'active' ? '' : 'inactive'}`}
                key={member.membership_id}
              >
                <div className="staff-member-heading">
                  <div className="staff-request-avatar">{roleIcon(member.role_name)}</div>
                  <div className="staff-member-identity">
                    <div className="staff-member-name-line">
                      <h4>{member.full_name || 'Usuario sin nombre'}</h4>
                      {member.is_restaurant_owner && <span className="badge owner-badge">OWNER PRINCIPAL</span>}
                      {member.is_current_user && <span className="badge">TÚ</span>}
                    </div>
                    <span>{member.username ? `@${member.username}` : 'Sin usuario'}</span>
                  </div>
                  <span className={`staff-status-badge ${member.membership_status === 'active' ? 'active' : 'inactive'}`}>
                    {member.membership_status === 'active' ? 'ACTIVO' : 'INACTIVO'}
                  </span>
                </div>

                <div className="staff-member-details">
                  <div><small>ROL</small><b>{member.role_name || 'Sin rol'}</b></div>
                  <div><small>CORREO DE ACCESO</small><b>{member.email || 'Sin correo'}</b></div>
                  <div><small>CELULAR</small><b>{member.phone || 'Sin celular'}</b></div>
                  <div><small>SUCURSALES</small><b>{memberLocationText(member)}</b></div>
                </div>

                {canManage && (
                  <button className="btn staff-edit-button" onClick={() => openMemberEditor(member)}>
                    ✎ Editar usuario
                  </button>
                )}
              </article>
            ))}
          </div>
        ) : members.length ? (
          <div className="empty-inline">No hay usuarios que coincidan con la búsqueda.</div>
        ) : (
          <div className="empty-block">Todavía no hay personal aprobado.</div>
        )}

        {!canManage && !auth.isDesignMode && (
          <div className="notice warn">Puedes consultar el personal, pero tu rol no tiene permiso para modificar usuarios.</div>
        )}
      </div>

      <div className="card section-gap">
        <div className="section-title">
          <div>
            <h3>Solicitudes pendientes</h3>
            <p className="muted">El registro por sí solo no concede acceso al restaurante.</p>
          </div>
          <span className="badge">{loading ? 'Cargando…' : `${pendingCount} pendiente${pendingCount === 1 ? '' : 's'}`}</span>
        </div>

        {auth.isDesignMode ? (
          <div className="empty-inline">Las solicitudes reales aparecen al ingresar con Supabase.</div>
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
      </div>

      <div className="grid two section-gap">
        <div className="card">
          <div className="section-title"><h3>Roles base de RestOS+</h3><span className="badge">7 perfiles</span></div>
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
            <div className="row"><b>4. Owner / Admin</b><span>Aprueba + asigna sucursal y rol</span></div>
            <div className="row"><b>5. Acceso</b><span className="badge ok-badge">ACTIVO</span></div>
          </div>
        </div>
      </div>

      {editingMember && memberForm && (
        <div className="modal open" onClick={closeMemberEditor}>
          <div className="modal-card staff-edit-modal" onClick={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div>
                <h3>Editar usuario</h3>
                <p className="muted">{editingMember.email || 'Usuario del restaurante'}</p>
              </div>
              <button className="btn" disabled={Boolean(busyId)} onClick={closeMemberEditor}>×</button>
            </div>

            {error && <div className="notice warn">{error}</div>}

            <div className="staff-edit-grid">
              <label>
                <span>Nombre completo *</span>
                <input value={memberForm.fullName} onChange={(event) => updateMemberField('fullName', event.target.value)} />
              </label>
              <label>
                <span>Nombre de usuario *</span>
                <input value={memberForm.username} onChange={(event) => updateMemberField('username', event.target.value)} placeholder="usuario" />
              </label>
              <label>
                <span>Celular</span>
                <input type="tel" value={memberForm.phone} onChange={(event) => updateMemberField('phone', event.target.value)} />
              </label>
              <label>
                <span>Correo de acceso</span>
                <input value={editingMember.email || ''} readOnly />
                <small>El correo de inicio de sesión no se modifica desde esta ventana.</small>
              </label>
              <label className="staff-role-field">
                <span>Rol *</span>
                <select
                  value={memberForm.roleId}
                  onChange={(event) => updateMemberField('roleId', event.target.value)}
                  disabled={editingMember.is_restaurant_owner}
                >
                  {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                </select>
              </label>
            </div>

            <div className="staff-edit-section">
              <b>Estado de acceso</b>
              <div className="staff-status-options">
                <button
                  type="button"
                  className={memberForm.status === 'active' ? 'active' : ''}
                  onClick={() => updateMemberField('status', 'active')}
                  disabled={editingMember.is_restaurant_owner}
                >
                  ✓ Activo
                </button>
                <button
                  type="button"
                  className={memberForm.status === 'suspended' ? 'inactive' : ''}
                  onClick={() => updateMemberField('status', 'suspended')}
                  disabled={editingMember.is_restaurant_owner || editingMember.is_current_user}
                >
                  ⏸ Inactivo
                </button>
              </div>
            </div>

            <div className="staff-edit-section">
              <label className="staff-all-locations">
                <input
                  type="checkbox"
                  checked={memberForm.allLocations}
                  onChange={(event) => updateMemberField('allLocations', event.target.checked)}
                />
                <span><b>Acceso a todas las sucursales</b><small>Incluye automáticamente las sucursales que se creen después.</small></span>
              </label>

              {!memberForm.allLocations && (
                <div className="staff-location-options">
                  {locations.map((location) => (
                    <label key={location.id}>
                      <input
                        type="checkbox"
                        checked={memberForm.locationIds.includes(location.id)}
                        onChange={() => toggleMemberLocation(location.id)}
                      />
                      <span>{location.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {editingMember.is_restaurant_owner && (
              <div className="notice">Por seguridad, el Owner principal siempre debe permanecer activo y conservar su rol. Sus datos personales y sucursales sí se pueden actualizar.</div>
            )}

            <button className="btn primary full" disabled={Boolean(busyId)} onClick={saveMember}>
              {busyId ? 'Guardando cambios…' : 'Guardar cambios'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
