import React, { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import {
  approveCompanyRegistration,
  loadPlatformCompanies,
  rejectCompanyRegistration,
  updatePlatformCompanySubscription,
} from '../services/platformAdminService.js'

function formatDateTime(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('es', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function formatDate(value) {
  if (!value) return '—'
  const normalized = String(value).slice(0, 10)
  const [year, month, day] = normalized.split('-').map(Number)
  if (!year || !month || !day) return normalized
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium' })
    .format(new Date(year, month - 1, day))
}

function adminError(error) {
  const message = String(error?.message || '')
  if (message.includes('Platform administrator access required')) return 'Solo el administrador de la plataforma puede gestionar empresas.'
  if (message.includes('Applicant already belongs')) return 'El solicitante ya pertenece a una empresa activa.'
  if (message.includes('no longer pending')) return 'La solicitud ya fue procesada.'
  if (message.includes('Allowed branch count cannot be lower than active branch count')) {
    return 'El número de sucursales permitidas no puede ser menor que las sucursales que están activas.'
  }
  if (message.includes('Allowed branch count must be between')) {
    return 'El número de sucursales permitidas debe estar entre 1 y 1000.'
  }
  if (message.includes('Subscription date is required')) return 'Selecciona la fecha de suscripción.'
  return message || 'No se pudo completar la operación.'
}

export default function PlatformCompaniesPage() {
  const auth = useAuth()
  const [requests, setRequests] = useState([])
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('requests')
  const [editingCompany, setEditingCompany] = useState(null)
  const [subscriptionSaving, setSubscriptionSaving] = useState(false)

  const pending = useMemo(
    () => requests.filter((request) => request.status === 'pending'),
    [requests],
  )

  async function refresh() {
    if (!auth.userContext?.platformAdmin) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')
    try {
      const data = await loadPlatformCompanies()
      setRequests(data.requests)
      setCompanies(data.companies)
    } catch (err) {
      setError(adminError(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [auth.userContext?.platformAdmin])

  async function approve(request) {
    const confirmed = window.confirm(
      `¿Aprobar la creación de “${request.companyName}”?\n\nSe creará automáticamente la empresa, su sucursal “${request.primaryBranchName || 'Principal'}”, los roles base y ${request.ownerName} quedará como Owner. La suscripción comenzará hoy y tendrá 1 sucursal permitida inicialmente.`,
    )
    if (!confirmed) return

    setBusyId(request.id)
    setError('')
    try {
      const result = await approveCompanyRegistration(request.id)
      await refresh()
      window.alert(
        `Empresa creada correctamente.\n\nEmpresa: ${result?.company_name || request.companyName}\nCódigo de empresa: ${result?.join_code || 'generado'}\nSucursales permitidas: ${result?.allowed_branch_count || 1}`,
      )
    } catch (err) {
      setError(adminError(err))
    } finally {
      setBusyId(null)
    }
  }

  async function reject(request) {
    const reason = window.prompt(
      `Motivo para rechazar la solicitud de “${request.companyName}” (opcional):`,
      '',
    )
    if (reason === null) return

    setBusyId(request.id)
    setError('')
    try {
      await rejectCompanyRegistration(request.id, reason.trim())
      await refresh()
    } catch (err) {
      setError(adminError(err))
    } finally {
      setBusyId(null)
    }
  }

  function openSubscriptionEditor(company) {
    setEditingCompany({
      id: company.id,
      name: company.name,
      subscriptionStartedAt: String(company.subscriptionStartedAt || '').slice(0, 10),
      allowedBranchCount: Number(company.allowedBranchCount || 1),
      activeBranchCount: Number(company.activeBranchCount || 0),
    })
  }

  async function saveSubscription(event) {
    event.preventDefault()
    if (!editingCompany || subscriptionSaving) return

    const allowed = Number(editingCompany.allowedBranchCount)
    if (!editingCompany.subscriptionStartedAt) {
      window.alert('Selecciona la fecha de suscripción.')
      return
    }
    if (!Number.isInteger(allowed) || allowed < 1 || allowed > 1000) {
      window.alert('El número de sucursales permitidas debe ser un entero entre 1 y 1000.')
      return
    }
    if (allowed < Number(editingCompany.activeBranchCount || 0)) {
      window.alert(
        `Esta empresa tiene ${editingCompany.activeBranchCount} sucursales activas. Primero debes desactivar las excedentes o asignar un límite igual o mayor.`,
      )
      return
    }

    setSubscriptionSaving(true)
    setError('')
    try {
      await updatePlatformCompanySubscription({
        restaurantId: editingCompany.id,
        subscriptionStartedAt: editingCompany.subscriptionStartedAt,
        allowedBranchCount: allowed,
      })
      setEditingCompany(null)
      await refresh()
    } catch (err) {
      setError(adminError(err))
    } finally {
      setSubscriptionSaving(false)
    }
  }

  if (!auth.userContext?.platformAdmin) {
    return (
      <section className="view active">
        <div className="notice warn">Esta sección es exclusiva de la administración de RestOS+.</div>
      </section>
    )
  }

  return (
    <section className="view active platform-companies-view">
      <div className="hero">
        <div>
          <h2>Administración de empresas</h2>
          <p>Alta de clientes, suscripciones y capacidad de sucursales de cada tenant de RestOS+.</p>
        </div>
        <button className="btn" onClick={refresh} disabled={loading}>↻ Actualizar</button>
      </div>

      {error && <div className="notice warn">{error}</div>}

      <div className="grid stats">
        <div className="card stat">
          <span className="label">Empresas</span>
          <strong>{companies.length}</strong>
          <small>registradas en RestOS+</small>
        </div>
        <div className="card stat">
          <span className="label">Solicitudes pendientes</span>
          <strong>{pending.length}</strong>
          <small>requieren revisión</small>
        </div>
        <div className="card stat">
          <span className="label">Sucursales activas</span>
          <strong>{companies.reduce((sum, company) => sum + Number(company.activeBranchCount || 0), 0)}</strong>
          <small>entre todas las empresas</small>
        </div>
        <div className="card stat">
          <span className="label">Capacidad contratada</span>
          <strong>{companies.reduce((sum, company) => sum + Number(company.allowedBranchCount || 0), 0)}</strong>
          <small>sucursales permitidas en total</small>
        </div>
      </div>

      <div className="tabs section-gap">
        <button className={tab === 'requests' ? 'active' : ''} onClick={() => setTab('requests')}>
          Solicitudes {pending.length ? `(${pending.length})` : ''}
        </button>
        <button className={tab === 'companies' ? 'active' : ''} onClick={() => setTab('companies')}>
          Empresas ({companies.length})
        </button>
      </div>

      {tab === 'requests' && (
        <div className="card">
          <div className="section-title">
            <div>
              <h3>Solicitudes de nuevas empresas</h3>
              <p className="muted">Solo una aprobación crea realmente el tenant, la sucursal principal y el Owner.</p>
            </div>
          </div>

          {loading ? (
            <div className="empty-inline">Cargando solicitudes…</div>
          ) : pending.length ? (
            <div className="platform-request-list">
              {pending.map((request) => {
                const busy = busyId === request.id
                return (
                  <article className="platform-request-card" key={request.id}>
                    <div className="platform-request-head">
                      <div>
                        <h3>{request.companyName}</h3>
                        <span>{request.legalName || 'Sin razón social registrada'}</span>
                      </div>
                      <span className="badge warn-badge">PENDIENTE</span>
                    </div>

                    <div className="platform-request-grid">
                      <div><small>SOLICITANTE</small><b>{request.ownerName}</b><span>{request.ownerEmail}</span></div>
                      <div><small>NIT / ID FISCAL</small><b>{request.taxId || '—'}{request.verificationDigit ? `-${request.verificationDigit}` : ''}</b></div>
                      <div><small>UBICACIÓN</small><b>{[request.city, request.region, request.country].filter(Boolean).join(' · ') || '—'}</b></div>
                      <div><small>CONTACTO EMPRESA</small><b>{request.companyEmail || '—'}</b><span>{request.companyPhone || '—'}</span></div>
                      <div><small>MONEDA</small><b>{request.currencyCode || '—'}</b></div>
                      <div><small>PRIMERA SUCURSAL</small><b>{request.primaryBranchName || 'Principal'}</b></div>
                      <div><small>SOLICITUD</small><b>{formatDateTime(request.requestedAt)}</b></div>
                    </div>

                    {(request.address || request.taxRegime || request.taxResponsibilities) && (
                      <div className="platform-request-extra">
                        {request.address && <span><b>Dirección:</b> {request.address}</span>}
                        {request.taxRegime && <span><b>Régimen:</b> {request.taxRegime}</span>}
                        {request.taxResponsibilities && <span><b>Responsabilidades:</b> {request.taxResponsibilities}</span>}
                      </div>
                    )}

                    <div className="platform-request-actions">
                      <button className="btn danger-outline" disabled={busy} onClick={() => reject(request)}>
                        Rechazar
                      </button>
                      <button className="btn primary" disabled={busy} onClick={() => approve(request)}>
                        {busy ? 'Procesando…' : '✓ Aprobar y crear empresa'}
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          ) : (
            <div className="empty-block">No hay solicitudes de empresas pendientes.</div>
          )}
        </div>
      )}

      {tab === 'companies' && (
        <div className="card">
          <div className="section-title">
            <div>
              <h3>Empresas registradas</h3>
              <p className="muted">La plataforma controla la fecha de suscripción y el máximo de sucursales activas de cada empresa.</p>
            </div>
          </div>

          {loading ? (
            <div className="empty-inline">Cargando empresas…</div>
          ) : companies.length ? (
            <div className="platform-company-list">
              {companies.map((company) => {
                const activeBranches = Number(company.activeBranchCount || 0)
                const allowedBranches = Number(company.allowedBranchCount || 1)
                const atLimit = activeBranches >= allowedBranches

                return (
                  <article className="platform-company-card" key={company.id}>
                    <div className="platform-company-head">
                      <div>
                        <h3>{company.name}</h3>
                        <span>{company.legalName || 'Sin razón social'}</span>
                      </div>
                      <span className={`badge ${company.status === 'active' ? 'ok-badge' : ''}`}>
                        {String(company.status || '').toUpperCase()}
                      </span>
                    </div>

                    <div className="platform-company-grid">
                      <div><small>OWNER</small><b>{company.ownerName || '—'}</b><span>{company.ownerEmail || '—'}</span></div>
                      <div><small>FECHA DE SUSCRIPCIÓN</small><b>{formatDate(company.subscriptionStartedAt)}</b><span>inicio del servicio</span></div>
                      <div className={atLimit ? 'platform-limit-cell limit' : 'platform-limit-cell'}>
                        <small>SUCURSALES ACTIVAS</small>
                        <b>{activeBranches}</b>
                        <span>{company.branchCount || 0} registradas</span>
                      </div>
                      <div className={atLimit ? 'platform-limit-cell limit' : 'platform-limit-cell'}>
                        <small>SUCURSALES PERMITIDAS</small>
                        <b>{allowedBranches}</b>
                        <span>{atLimit ? 'límite alcanzado' : `${allowedBranches - activeBranches} disponibles`}</span>
                      </div>
                      <div><small>USUARIOS</small><b>{company.activeUserCount || 0} activos</b></div>
                      <div><small>CÓDIGO EMPRESA</small><b className="company-code">{company.joinCode || '—'}</b></div>
                      <div><small>MONEDA</small><b>{company.currencyCode || '—'}</b></div>
                      <div><small>CREADA</small><b>{formatDateTime(company.createdAt)}</b></div>
                    </div>

                    <div className="platform-company-actions">
                      <button className="btn primary" onClick={() => openSubscriptionEditor(company)}>
                        ⚙ Configurar suscripción
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          ) : (
            <div className="empty-block">Todavía no hay empresas registradas.</div>
          )}
        </div>
      )}

      {editingCompany && (
        <div className="modal open" onClick={() => !subscriptionSaving && setEditingCompany(null)}>
          <form
            className="modal-card platform-subscription-modal"
            onSubmit={saveSubscription}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="section-title">
              <div>
                <span className="developer-console-kicker">CONTROL DE PLATAFORMA</span>
                <h3>Suscripción · {editingCompany.name}</h3>
                <p className="muted">Estos valores solo pueden modificarse desde el portal admin.</p>
              </div>
              <button type="button" className="btn" disabled={subscriptionSaving} onClick={() => setEditingCompany(null)}>×</button>
            </div>

            <div className="platform-subscription-current">
              <div>
                <span>Sucursales activas</span>
                <strong>{editingCompany.activeBranchCount}</strong>
              </div>
              <div>
                <span>Límite actual</span>
                <strong>{editingCompany.allowedBranchCount}</strong>
              </div>
            </div>

            <label className="field">
              <span>Fecha de suscripción</span>
              <input
                type="date"
                value={editingCompany.subscriptionStartedAt}
                onChange={(event) => setEditingCompany((current) => ({
                  ...current,
                  subscriptionStartedAt: event.target.value,
                }))}
                required
              />
            </label>

            <label className="field">
              <span>Número de sucursales permitidas</span>
              <input
                type="number"
                min={Math.max(1, editingCompany.activeBranchCount)}
                max="1000"
                step="1"
                value={editingCompany.allowedBranchCount}
                onChange={(event) => setEditingCompany((current) => ({
                  ...current,
                  allowedBranchCount: event.target.value,
                }))}
                required
              />
              <small className="platform-subscription-help">
                No puede ser menor que las {editingCompany.activeBranchCount} sucursales que están activas.
              </small>
            </label>

            <div className="notice">
              Al alcanzar este límite, la empresa no podrá crear ni reactivar más sucursales.
              El bloqueo se valida directamente en Supabase, no solamente en la interfaz.
            </div>

            <div className="platform-subscription-actions">
              <button type="button" className="btn" disabled={subscriptionSaving} onClick={() => setEditingCompany(null)}>
                Cancelar
              </button>
              <button type="submit" className="btn primary" disabled={subscriptionSaving}>
                {subscriptionSaving ? 'Guardando…' : 'Guardar configuración'}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  )
}
