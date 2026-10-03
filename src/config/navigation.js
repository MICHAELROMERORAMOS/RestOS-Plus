export const NAV_ITEMS = [
  { id: 'central', path: '/central', icon: '🏢', label: 'Control central', permission: 'company.control.view', scope: 'central' },

  { id: 'dashboard', path: '/', icon: '▦', label: 'Resumen', permission: 'dashboard.view', scope: 'branch' },
  { id: 'tables', path: '/mesas', icon: '▣', label: 'Mesas', permission: 'tables.view', scope: 'branch' },
  { id: 'quick-service', path: '/servicio-rapido', icon: '⚡', label: 'Servicio rápido', permission: 'orders.create', scope: 'branch' },
  { id: 'deliveries', path: '/domicilios', icon: '🚚', label: 'Domicilios', permission: 'orders.create', scope: 'branch' },
  { id: 'order', path: '/pedido', icon: '🧾', label: 'Pedido', permission: 'orders.create', hidden: true, scope: 'branch' },
  { id: 'kitchen', path: '/cocina', icon: '🍳', label: 'Cocina', permission: 'kitchen.view', scope: 'branch' },
  { id: 'bar', path: '/bar', icon: '🍸', label: 'Bar', permission: 'bar.view', scope: 'branch' },
  { id: 'cashier', path: '/cobrar', icon: '💳', label: 'Cobrar', permission: 'payments.create', scope: 'branch' },
  { id: 'void-invoice', path: '/anular-factura', icon: '⊘', label: 'Anular factura', permission: 'payments.create', scope: 'branch' },
  { id: 'invoice-register', path: '/facturas', icon: '🧾', label: 'Facturas cobradas', permission: 'reports.view', scope: 'branch' },
  { id: 'shift-close', path: '/cierre-turno', icon: '🔒', label: 'Cierre de turno', permission: 'shifts.view', scope: 'branch' },
  { id: 'inventory', path: '/inventario', icon: '📦', label: 'Inventario', permission: 'inventory.view', scope: 'branch' },
  { id: 'availability', path: '/disponibilidad-productos', icon: '⏱', label: 'Disponibilidad', permission: 'products.availability.request', scope: 'branch' },
  { id: 'customers', path: '/clientes', icon: '👥', label: 'Clientes', permission: 'customers.view', scope: 'branch' },
  { id: 'reservations', path: '/reservas', icon: '📅', label: 'Reservas', permission: 'reservations.view', scope: 'branch' },
  { id: 'reports', path: '/reportes', icon: '📊', label: 'Reportes', permission: 'reports.view', scope: 'branch' },
  { id: 'tv', path: '/pantalla-tv', icon: '📺', label: 'Pantalla TV', permission: 'display.view', scope: 'branch' },
  { id: 'settings', path: '/configuracion', icon: '⚙', label: 'Configuración sucursal', permission: 'settings.view', scope: 'branch' },

  {
    id: 'products',
    path: '/central/catalogo',
    aliases: ['/productos'],
    icon: '🍔',
    label: 'Catálogo maestro',
    permission: 'products.catalog.manage',
    contextPermission: 'company.control.view',
    scope: 'central',
  },
  {
    id: 'branches',
    path: '/central/sucursales',
    aliases: ['/empresa-sucursales'],
    icon: '📍',
    label: 'Sucursales',
    permission: 'branches.view',
    contextPermission: 'company.control.view',
    scope: 'central',
  },
  {
    id: 'staff',
    path: '/central/personal',
    aliases: ['/usuarios'],
    icon: '🔐',
    label: 'Personal y permisos',
    permission: 'staff.view',
    contextPermission: 'company.control.view',
    scope: 'central',
  },

]

const EXTRA_PERMISSIONS = [
  'company.control.view',
  'products.catalog.manage',
  'products.branch.assign',
  'products.availability.request',
  'products.availability.approve',
  'inventory.central.manage',
  'inventory.transfer.request',
  'inventory.transfer.approve',
  'inventory.transfer.dispatch',
  'inventory.transfer.receive',
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
  return NAV_ITEMS.find((item) => (
    item.path === normalized
    || (item.aliases || []).includes(normalized)
  ))?.id || null
}

export function scopeForView(view) {
  return NAV_ITEMS.find((item) => item.id === view)?.scope || 'branch'
}

export const ALL_PERMISSIONS = Array.from(new Set([
  ...NAV_ITEMS.map((item) => item.permission).filter(Boolean),
  ...NAV_ITEMS.map((item) => item.contextPermission).filter(Boolean),
  ...EXTRA_PERMISSIONS,
]))
