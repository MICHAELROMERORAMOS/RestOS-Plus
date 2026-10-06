import React from 'react'

export default function Sidebar({
  items,
  activeView,
  onNavigate,
  userContext,
  companyName = '',
  onLogout,
  collapsed = false,
  onToggleCollapsed,
  contextLabel = '',
}) {
  const resolvedCompanyName = companyName || userContext?.restaurant || 'RestOS+'
  const resolvedContextLabel = contextLabel || 'Sucursal'
  const companyInitial = resolvedCompanyName.trim().charAt(0).toUpperCase() || 'R'

  return (
    <aside className={`side ${collapsed ? 'collapsed' : ''}`}>
      <div className="side-head">
        <div className="brand sidebar-company-brand" title={resolvedCompanyName}>
          <span className="brand-full sidebar-company-name">{resolvedCompanyName}</span>
          <span className="brand-short">{companyInitial}</span>
          <small className="sidebar-location-name" title={resolvedContextLabel}>
            {resolvedContextLabel}
          </small>
        </div>

        <button
          className="side-collapse"
          type="button"
          onClick={onToggleCollapsed}
          title={collapsed ? 'Expandir menú' : 'Contraer menú'}
          aria-label={collapsed ? 'Expandir menú lateral' : 'Contraer menú lateral'}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      <nav className="nav side-nav">
        {items.map((item) => (
          <button
            key={item.id}
            className={activeView === item.id ? 'active' : ''}
            onClick={() => onNavigate(item.id)}
            title={collapsed ? item.label : undefined}
          >
            <span className="ico">{item.icon}</span>
            <span className="txt">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="profile">
        <div className="profile-copy">
          <b>{userContext?.name || 'Usuario'}</b>
          <span>{userContext?.role || 'Rol'} · {userContext?.restaurant || 'Restaurante'}</span>
        </div>
        <button className="logout" onClick={onLogout} title={collapsed ? 'Cerrar sesión' : undefined}>
          <span className="logout-icon">↪</span>
          <span className="logout-text">Cerrar sesión</span>
        </button>
      </div>
    </aside>
  )
}
