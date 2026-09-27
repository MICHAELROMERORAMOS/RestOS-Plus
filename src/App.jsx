import React, { useEffect, useMemo, useState } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { RestaurantProvider, useRestaurant } from './context/RestaurantContext.jsx'
import AuthGateway from './features/auth/AuthGateway.jsx'
import AppShell from './components/layout/AppShell.jsx'
import { NAV_ITEMS } from './config/navigation.js'
import DashboardPage from './pages/DashboardPage.jsx'
import TablesPage from './pages/TablesPage.jsx'
import QuickServicePage from './pages/QuickServicePage.jsx'
import DeliveriesPage from './pages/DeliveriesPage.jsx'
import OrderPage from './pages/OrderPage.jsx'
import StationPage from './pages/StationPage.jsx'
import CashierPage from './pages/CashierPage.jsx'
import InvoiceVoidPage from './pages/InvoiceVoidPage.jsx'
import InvoiceRegisterPage from './pages/InvoiceRegisterPage.jsx'
import InventoryPage from './pages/InventoryPage.jsx'
import ProductsPage from './pages/ProductsPage.jsx'
import CustomersPage from './pages/CustomersPage.jsx'
import ReservationsPage from './pages/ReservationsPage.jsx'
import StaffPage from './pages/StaffPage.jsx'
import ReportsPage from './pages/ReportsPage.jsx'
import ShiftClosePage from './pages/ShiftClosePage.jsx'
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

  async function openTable(tableId, { confirmed = false } = {}) {
    const status = restaurant.getTableVisualStatus(tableId)

    if (status === 'free' && !confirmed) {
      const accepted = window.confirm(
        `¿Deseas abrir ${restaurant.tableLabel(tableId)} para tomar el pedido?`,
      )
      if (!accepted) return { ok: false, cancelled: true }
    }

    const result = await restaurant.openTable(tableId)
    if (!result?.ok) {
      if (!confirmed && !result?.cancelled) {
        window.alert(result?.message || 'No se pudo abrir la mesa.')
      }
      return result
    }

    navigate('order')
    return result
  }

  async function quickService() {
    const result = await restaurant.startQuickOrder()
    if (result.ok) navigate('order')
    return result
  }

  function openQuickOrder(orderId) {
    const result = restaurant.openQuickOrder(orderId)
    if (result.ok) navigate('order')
    return result
  }

  async function startDelivery(delivery) {
    const result = await restaurant.startDelivery(delivery)
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
    tables: <TablesPage onOpenTable={openTable} />,
    'quick-service': (
      <QuickServicePage
        onStartQuickOrder={quickService}
        onOpenQuickOrder={openQuickOrder}
      />
    ),
    deliveries: <DeliveriesPage onStartDelivery={startDelivery} onOpenDelivery={openDelivery} />,
    order: <OrderPage onNavigate={navigate} />,
    kitchen: <StationPage station="kitchen" />,
    bar: <StationPage station="bar" />,
    cashier: <CashierPage />,
    'void-invoice': <InvoiceVoidPage />,
    'invoice-register': <InvoiceRegisterPage />,
    inventory: <InventoryPage />,
    products: <ProductsPage />,
    customers: <CustomersPage />,
    reservations: <ReservationsPage />,
    staff: <StaffPage />,
    reports: <ReportsPage />,
    'shift-close': <ShiftClosePage />,
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
