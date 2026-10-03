import React, { useEffect, useMemo, useState } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext.jsx'
import { RestaurantProvider, useRestaurant } from './context/RestaurantContext.jsx'
import AuthGateway from './features/auth/AuthGateway.jsx'
import AppShell from './components/layout/AppShell.jsx'
import { NAV_ITEMS, pathForView, scopeForView, viewFromPath } from './config/navigation.js'
import CompanyControlPage from './pages/CompanyControlPage.jsx'
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
import ProductAvailabilityPage from './pages/ProductAvailabilityPage.jsx'
import CustomersPage from './pages/CustomersPage.jsx'
import ReservationsPage from './pages/ReservationsPage.jsx'
import StaffPage from './pages/StaffPage.jsx'
import BranchesPage from './pages/BranchesPage.jsx'
import DeveloperPortal from './pages/DeveloperPortal.jsx'
import ReportsPage from './pages/ReportsPage.jsx'
import ShiftClosePage from './pages/ShiftClosePage.jsx'
import TvPage from './pages/TvPage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'

function MainApplication() {
  const auth = useAuth()
  const restaurant = useRestaurant()

  const accessibleItems = useMemo(
    () => NAV_ITEMS.filter((item) => {
      if (item.stationType) {
        const station = restaurant.menuStations.find((candidate) => (
          candidate.stationType === item.stationType && candidate.active !== false
        ))
        if (!station) return false
      }
      if (item.permission && !auth.can(item.permission)) return false
      if (item.contextPermission && !auth.can(item.contextPermission)) return false
      return true
    }),
    [
      auth.permissions,
      auth.isDesignMode,
      restaurant.menuStations,
    ],
  )

  const [activeView, setActiveView] = useState(
    () => viewFromPath(window.location.pathname) || 'dashboard',
  )

  const activeScope = scopeForView(activeView)

  const visibleItems = useMemo(
    () => accessibleItems.filter((item) => !item.hidden && item.scope === activeScope),
    [accessibleItems, activeScope],
  )

  useEffect(() => {
    function syncViewFromUrl() {
      const requestedView = viewFromPath(window.location.pathname)

      if (requestedView) {
        setActiveView(requestedView)
        const canonicalPath = pathForView(requestedView)
        if (window.location.pathname !== canonicalPath) {
          window.history.replaceState({ view: requestedView }, '', canonicalPath)
        }
        return
      }

      setActiveView('dashboard')
      window.history.replaceState({ view: 'dashboard' }, '', pathForView('dashboard'))
    }

    syncViewFromUrl()
    window.addEventListener('popstate', syncViewFromUrl)
    return () => window.removeEventListener('popstate', syncViewFromUrl)
  }, [])

  function navigate(view) {
    const item = accessibleItems.find((candidate) => candidate.id === view)

    if (!item) {
      window.alert('Tu usuario no tiene permiso para abrir este módulo.')
      return false
    }

    setActiveView(view)
    const nextPath = pathForView(view)
    if (window.location.pathname !== nextPath) {
      window.history.pushState({ view }, '', nextPath)
    }
    return true
  }

  async function enterBranch(locationId = null) {
    if (locationId && String(locationId) !== String(restaurant.activeLocation?.id || '')) {
      const result = await restaurant.switchLocation(locationId)
      if (!result?.ok) return result
    }
    navigate('dashboard')
    return { ok: true }
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
    central: <CompanyControlPage onNavigate={navigate} onEnterBranch={enterBranch} />,
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
    dessert: <StationPage station="dessert" />,
    coffee: <StationPage station="coffee" />,
    'other-station': <StationPage station="other" />,
    cashier: <CashierPage />,
    'void-invoice': <InvoiceVoidPage />,
    'invoice-register': <InvoiceRegisterPage />,
    inventory: <InventoryPage />,
    products: <ProductsPage />,
    availability: <ProductAvailabilityPage />,
    customers: <CustomersPage />,
    reservations: <ReservationsPage />,
    staff: <StaffPage />,
    branches: <BranchesPage />,
    reports: <ReportsPage />,
    'shift-close': <ShiftClosePage />,
    tv: <TvPage />,
    settings: <SettingsPage />,
  }

  const activeViewAllowed = accessibleItems.some((item) => item.id === activeView)
  const activePage = activeViewAllowed
    ? (pages[activeView] || pages.dashboard)
    : (
      <div className="panel">
        <h2>Acceso restringido</h2>
        <p>Tu usuario no tiene permiso para abrir esta sección.</p>
        <button type="button" className="btn" onClick={() => navigate('dashboard')}>
          Ir al resumen
        </button>
      </div>
    )

  return (
    <AppShell
      navItems={visibleItems}
      activeView={activeView}
      onNavigate={navigate}
      userContext={auth.userContext}
      onLogout={async () => {
        await auth.logout()
        window.history.replaceState({ view: 'dashboard' }, '', '/')
      }}
      canKitchen={activeScope === 'branch' && auth.can('kitchen.view') && restaurant.menuStations.some((station) => station.stationType === 'kitchen' && station.active !== false)}
      canOrder={activeScope === 'branch' && auth.can('orders.create')}
      onNewOrder={() => navigate('tables')}
      companyName={auth.userContext?.restaurant || 'Empresa'}
      locations={restaurant.locations}
      activeLocation={restaurant.activeLocation}
      onLocationChange={restaurant.switchLocation}
      workspaceMode={activeScope}
      canCompanyControl={auth.can('company.control.view')}
      onEnterCentral={() => navigate('central')}
      onEnterBranch={enterBranch}
    >
      {activePage}
    </AppShell>
  )
}

function isDeveloperPortalPath(pathname = window.location.pathname) {
  const normalized = pathname.replace(/\/+$/, '') || '/'
  return normalized === '/developer'
    || normalized.startsWith('/developer/')
    || normalized === '/empresas-restos'
}

function AuthenticatedApplication() {
  const auth = useAuth()
  const developerPortal = isDeveloperPortalPath()

  useEffect(() => {
    if (auth.userContext?.platformOnly && !developerPortal) {
      window.location.replace('/developer')
    }
  }, [auth.userContext?.platformOnly, developerPortal])

  if (developerPortal) return <DeveloperPortal />

  if (auth.userContext?.platformOnly) {
    return (
      <div className="app-loader">
        <div><strong>RestOS+</strong><span>Abriendo Developer Console…</span></div>
      </div>
    )
  }

  return (
    <RestaurantProvider>
      <MainApplication />
    </RestaurantProvider>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGateway>
        <AuthenticatedApplication />
      </AuthGateway>
    </AuthProvider>
  )
}
