import React from 'react'

export default function Sidebar({ items, activeView, onNavigate, userContext, onLogout }) {
  return (
    <aside className="side">
      <div className="brand">RestOS+<small>RESTAURANT SYSTEM</small></div>
      <nav className="nav">
        {items.map((item) => (
          <button
            key={item.id}
            className={activeView === item.id ? 'active' : ''}
            onClick={() => onNavigate(item.id)}
          >
            <span className="ico">{item.icon}</span>
            <span className="txt">{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="profile">
        <b>{userContext?.name || 'Usuario'}</b>
        <span>{userContext?.role || 'Rol'} · {userContext?.restaurant || 'Restaurante'}</span>
        <button className="logout" onClick={onLogout}>Cerrar sesión</button>
      </div>
    </aside>
  )
}
