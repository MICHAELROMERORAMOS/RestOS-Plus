import React from 'react'
import Sidebar from './Sidebar.jsx'
import Topbar from './Topbar.jsx'

export default function AppShell({ children, navItems, activeView, onNavigate, userContext, onLogout, canKitchen, canOrder, onNewOrder }) {
  const current = navItems.find((item) => item.id === activeView)
  return (
    <div className="app">
      <Sidebar
        items={navItems}
        activeView={activeView}
        onNavigate={onNavigate}
        userContext={userContext}
        onLogout={onLogout}
      />
      <main className="main">
        <Topbar
          title={current?.label || 'RestOS+'}
          canKitchen={canKitchen}
          canOrder={canOrder}
          onKitchen={() => onNavigate('kitchen')}
          onNewOrder={onNewOrder}
        />
        <div className="content">{children}</div>
      </main>
    </div>
  )
}
