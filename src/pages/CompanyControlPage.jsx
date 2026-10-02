import React from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useRestaurant } from '../context/RestaurantContext.jsx'

export default function CompanyControlPage({ onNavigate, onEnterBranch }) {
  const auth = useAuth()
  const restaurant = useRestaurant()
  const canBranches = auth.can('branches.view')
  const canStaff = auth.can('staff.view')

  return (
    <section className="view active company-control-view">
      <div className="hero company-control-hero">
        <div>
          <span className="company-control-kicker">ADMINISTRACIÓN GENERAL</span>
          <h2>Control central</h2>
          <p>
            Administra la empresa sin trabajar dentro de una sucursal. La operación diaria se abre únicamente
            cuando eliges una sucursal.
          </p>
        </div>
        <span className="company-control-badge">🏢 {auth.userContext?.restaurant || 'Empresa'}</span>
      </div>

      <div className="grid stats company-control-stats">
        <div className="card stat">
          <span className="label">Nivel actual</span>
          <strong>Empresa</strong>
          <small>Control Central</small>
        </div>
        <div className="card stat">
          <span className="label">Sucursales disponibles</span>
          <strong>{restaurant.locations.length}</strong>
          <small>Según tu alcance de acceso</small>
        </div>
        <div className="card stat">
          <span className="label">Tu rol</span>
          <strong className="company-control-role">{auth.userContext?.role || 'Rol corporativo'}</strong>
          <small>Permisos aplicados desde Supabase</small>
        </div>
      </div>

      <div className="company-control-grid section-gap">
        {canBranches && (
          <button className="company-control-card" onClick={() => onNavigate('branches')}>
            <span className="company-control-icon">📍</span>
            <div>
              <h3>Sucursales</h3>
              <p>Crear, editar, activar y administrar la estructura de establecimientos de la empresa.</p>
            </div>
            <span className="company-control-arrow">›</span>
          </button>
        )}

        {canStaff && (
          <button className="company-control-card" onClick={() => onNavigate('staff')}>
            <span className="company-control-icon">🔐</span>
            <div>
              <h3>Personal y permisos</h3>
              <p>Asigna roles corporativos o locales y controla a qué sucursales puede entrar cada usuario.</p>
            </div>
            <span className="company-control-arrow">›</span>
          </button>
        )}
      </div>

      <div className="card section-gap">
        <div className="section-title">
          <div>
            <h3>Entrar a una sucursal</h3>
            <p className="muted">Al entrar cambias del nivel Empresa al nivel Sucursal y se habilita el menú operativo.</p>
          </div>
          <span className="badge">{restaurant.locations.length} disponibles</span>
        </div>

        {restaurant.locations.length ? (
          <div className="company-branch-entry-grid">
            {restaurant.locations.map((location) => (
              <button
                className="company-branch-entry"
                key={location.id}
                onClick={() => onEnterBranch(location.id)}
              >
                <span>📍</span>
                <div>
                  <b>{location.name}</b>
                  <small>{location.code || 'Sin código'}{location.city ? ` · ${location.city}` : ''}</small>
                </div>
                <strong>Entrar ›</strong>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-block">No hay sucursales disponibles para este usuario.</div>
        )}
      </div>

      <div className="card section-gap company-level-map">
        <div>
          <span>🌐</span>
          <b>Plataforma RestOS+</b>
          <small>Administración SaaS</small>
        </div>
        <span className="company-level-arrow">→</span>
        <div className="active">
          <span>🏢</span>
          <b>Empresa</b>
          <small>Control Central</small>
        </div>
        <span className="company-level-arrow">→</span>
        <div>
          <span>📍</span>
          <b>Sucursal</b>
          <small>Operación diaria</small>
        </div>
      </div>
    </section>
  )
}
