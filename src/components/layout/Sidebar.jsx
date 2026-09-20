import React from 'react'

export default function Sidebar({
  items,
  activeView,
  onNavigate,
  userContext,
  onLogout,
  collapsed = false,
  onToggleCollapsed,
}) {
  return (
    <aside className={`side ${collapsed ? 'collapsed' : ''}`}>
      <div className="side-head">
        <div className="brand" title="RestOS+">
          <span className="brand-full">RestOS+</span>
          <span className="brand-short">R</span>
          <small>RESTAURANT SYSTEM</small>
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
