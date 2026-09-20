import React, { useEffect, useState } from 'react'
import Sidebar from './Sidebar.jsx'
import Topbar from './Topbar.jsx'

const SIDEBAR_STORAGE_KEY = 'restos-plus-sidebar-collapsed'

function loadSidebarPreference() {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export default function AppShell({ children, navItems, activeView, onNavigate, userContext, onLogout, canKitchen, canOrder, onNewOrder }) {
  const current = navItems.find((item) => item.id === activeView)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarPreference)

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed))
    } catch {
      // Sidebar preference is non-critical.
    }
  }, [sidebarCollapsed])

  return (
    <div className={`app ${sidebarCollapsed ? 'sidebar-collapsed' : 'sidebar-expanded'}`}>
      <Sidebar
        items={navItems}
        activeView={activeView}
        onNavigate={onNavigate}
        userContext={userContext}
        onLogout={onLogout}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((currentValue) => !currentValue)}
      />

      <main className="main">
        <Topbar
          title={current?.label || 'RestOS+'}
          canKitchen={canKitchen}
          canOrder={canOrder}
          onKitchen={() => onNavigate('kitchen')}
          onNewOrder={onNewOrder}
        />
        <div className="content-scroll">
          <div className="content">{children}</div>
        </div>
      </main>
    </div>
  )
}
