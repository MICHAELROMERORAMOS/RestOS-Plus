export const NAV_ITEMS = [
  { id: 'dashboard', path: '/', icon: '▦', label: 'Resumen', permission: 'dashboard.view' },
  { id: 'tables', path: '/mesas', icon: '▣', label: 'Mesas', permission: 'tables.view' },
  { id: 'quick-service', path: '/servicio-rapido', icon: '⚡', label: 'Servicio rápido', permission: 'orders.create' },
  { id: 'deliveries', path: '/domicilios', icon: '🚚', label: 'Domicilios', permission: 'orders.create' },
  { id: 'order', path: '/pedido', icon: '🧾', label: 'Pedido', permission: 'orders.create', hidden: true },
  { id: 'kitchen', path: '/cocina', icon: '🍳', label: 'Cocina', permission: 'kitchen.view' },
  { id: 'bar', path: '/bar', icon: '🍸', label: 'Bar', permission: 'bar.view' },
  { id: 'cashier', path: '/cobrar', icon: '💳', label: 'Cobrar', permission: 'payments.create' },
  { id: 'void-invoice', path: '/anular-factura', icon: '⊘', label: 'Anular factura', permission: 'payments.create' },
  { id: 'invoice-register', path: '/facturas', icon: '🧾', label: 'Facturas cobradas', permission: 'reports.view' },
  { id: 'shift-close', path: '/cierre-turno', icon: '🔒', label: 'Cierre de turno', permission: 'shifts.view' },
  { id: 'inventory', path: '/inventario', icon: '📦', label: 'Inventario', permission: 'inventory.view' },
  { id: 'products', path: '/productos', icon: '🍔', label: 'Productos', permission: 'products.view' },
  { id: 'customers', path: '/clientes', icon: '👥', label: 'Clientes', permission: 'customers.view' },
  { id: 'reservations', path: '/reservas', icon: '📅', label: 'Reservas', permission: 'reservations.view' },
  { id: 'staff', path: '/usuarios', icon: '🔐', label: 'Personal', permission: 'staff.view' },
  { id: 'branches', path: '/empresa-sucursales', icon: '🏢', label: 'Empresa y sucursales', permission: 'branches.view' },
  { id: 'platform-companies', path: '/empresas-restos', icon: '🌐', label: 'Empresas RestOS+', platformAdmin: true },
  { id: 'reports', path: '/reportes', icon: '📊', label: 'Reportes', permission: 'reports.view' },
  { id: 'tv', path: '/pantalla-tv', icon: '📺', label: 'Pantalla TV', permission: 'display.view' },
  { id: 'settings', path: '/configuracion', icon: '⚙', label: 'Configuración', permission: 'settings.view' },
]

function normalizePath(pathname = '/') {
  if (!pathname || pathname === '/') return '/'
  return pathname.replace(/\/+$/, '') || '/'
}

export function pathForView(view) {
  return NAV_ITEMS.find((item) => item.id === view)?.path || '/'
}

export function viewFromPath(pathname) {
  const normalized = normalizePath(pathname)
  return NAV_ITEMS.find((item) => item.path === normalized)?.id || null
}

export const ALL_PERMISSIONS = NAV_ITEMS.map((item) => item.permission).filter(Boolean)
