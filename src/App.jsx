import React, { useEffect, useMemo, useState } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { RestaurantProvider, useRestaurant } from './context/RestaurantContext.jsx'
import AuthGateway from './features/auth/AuthGateway.jsx'
import AppShell from './components/layout/AppShell.jsx'
import { NAV_ITEMS } from './config/navigation.js'
import DashboardPage from './pages/DashboardPage.jsx'
import TablesPage from './pages/TablesPage.jsx'
import DeliveriesPage from './pages/DeliveriesPage.jsx'
import OrderPage from './pages/OrderPage.jsx'
import StationPage from './pages/StationPage.jsx'
import CashierPage from './pages/CashierPage.jsx'
import InvoiceVoidPage from './pages/InvoiceVoidPage.jsx'
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
  const accessibleItems = useMemo(
    () => NAV_ITEMS.filter((item) => auth.can(item.permission)),
    [auth.permissions, auth.isDesignMode],
  )
  const visibleItems = useMemo(
    () => accessibleItems.filter((item) => !item.hidden),
    [accessibleItems],
  )
  const [activeView, setActiveView] = useState(() => visibleItems[0]?.id || 'dashboard')

  useEffect(() => {
    if (!accessibleItems.some((item) => item.id === activeView)) {
      setActiveView(visibleItems[0]?.id || 'dashboard')
    }
  }, [accessibleItems, visibleItems, activeView])

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

  function quickService() {
    restaurant.setOrderMode('quick')
    navigate('order')
  }

  function startDelivery(delivery) {
    const result = restaurant.startDelivery(delivery)
    if (result.ok) navigate('order')
    return result
  }

  function openDelivery(orderId) {
    const result = restaurant.openDelivery(orderId)
    if (result.ok) navigate('order')
    return result
  }

  const pages = {
    dashboard: <DashboardPage onNavigate={navigate} onOpenTable={openTable} onNewOrder={() => navigate('tables')} />,
    tables: <TablesPage onOpenTable={openTable} onQuickService={auth.can('orders.create') ? quickService : null} />,
    deliveries: <DeliveriesPage onStartDelivery={startDelivery} onOpenDelivery={openDelivery} />,
    order: <OrderPage onNavigate={navigate} />,
    kitchen: <StationPage station="kitchen" />,
    bar: <StationPage station="bar" />,
    cashier: <CashierPage />,
    'void-invoice': <InvoiceVoidPage />,
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
