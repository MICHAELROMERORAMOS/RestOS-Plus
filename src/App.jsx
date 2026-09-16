import React, { useEffect, useMemo, useState } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { RestaurantProvider, useRestaurant } from './context/RestaurantContext.jsx'
import AuthGateway from './features/auth/AuthGateway.jsx'
import AppShell from './components/layout/AppShell.jsx'
import { NAV_ITEMS } from './config/navigation.js'
import DashboardPage from './pages/DashboardPage.jsx'
import TablesPage from './pages/TablesPage.jsx'
import OrderPage from './pages/OrderPage.jsx'
import StationPage from './pages/StationPage.jsx'
import CashierPage from './pages/CashierPage.jsx'
import OrdersPage from './pages/OrdersPage.jsx'
import InventoryPage from './pages/InventoryPage.jsx'
import ProductsPage from './pages/ProductsPage.jsx'
import CustomersPage from './pages/CustomersPage.jsx'
import ReservationsPage from './pages/ReservationsPage.jsx'
import StaffPage from './pages/StaffPage.jsx'
import ReportsPage from './pages/ReportsPage.jsx'
import TvPage from './pages/TvPage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'

function MainApplication() {
  const auth = useAuth()
  const restaurant = useRestaurant()
  const visibleItems = useMemo(
    () => NAV_ITEMS.filter((item) => auth.can(item.permission)),
    [auth.permissions, auth.isDesignMode],
  )
  const [activeView, setActiveView] = useState(() => visibleItems[0]?.id || 'dashboard')

  useEffect(() => {
    if (!visibleItems.some((item) => item.id === activeView)) {
      setActiveView(visibleItems[0]?.id || 'dashboard')
    }
  }, [visibleItems, activeView])

  function navigate(view) {
    const meta = NAV_ITEMS.find((item) => item.id === view)
    if (!meta) return
    if (!auth.can(meta.permission)) {
      window.alert('Tu rol no tiene permiso para abrir este módulo.')
      return
    }
    setActiveView(view)
  }

  function openTable(tableId) {
    restaurant.openTable(tableId)
    navigate('order')
  }

  function newOrder() {
    restaurant.startNewOrder()
    navigate('order')
  }

  const pages = {
    dashboard: <DashboardPage onNavigate={navigate} onOpenTable={openTable} onNewOrder={newOrder} />,
    tables: <TablesPage onOpenTable={openTable} />,
    order: <OrderPage onNavigate={navigate} />,
    kitchen: <StationPage station="kitchen" />,
    bar: <StationPage station="bar" />,
    cashier: <CashierPage />,
    orders: <OrdersPage />,
    inventory: <InventoryPage />,
    products: <ProductsPage />,
    customers: <CustomersPage />,
    reservations: <ReservationsPage />,
    staff: <StaffPage />,
    reports: <ReportsPage />,
    tv: <TvPage />,
    settings: <SettingsPage />,
  }

  return (
    <AppShell
      navItems={visibleItems}
      activeView={activeView}
      onNavigate={navigate}
      userContext={auth.userContext}
      onLogout={auth.logout}
      canKitchen={auth.can('kitchen.view')}
      canOrder={auth.can('orders.create')}
      onNewOrder={newOrder}
    >
      {pages[activeView] || pages.dashboard}
    </AppShell>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGateway>
        <RestaurantProvider>
          <MainApplication />
        </RestaurantProvider>
      </AuthGateway>
    </AuthProvider>
  )
}
