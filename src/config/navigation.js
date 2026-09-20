export const NAV_ITEMS = [
  { id: 'dashboard', icon: '▦', label: 'Resumen', permission: 'dashboard.view' },
  { id: 'tables', icon: '▣', label: 'Mesas', permission: 'tables.view' },
  { id: 'deliveries', icon: '🚚', label: 'Domicilios', permission: 'orders.create' },
  { id: 'order', icon: '🧾', label: 'Pedido', permission: 'orders.create', hidden: true },
  { id: 'kitchen', icon: '🍳', label: 'Cocina', permission: 'kitchen.view' },
  { id: 'bar', icon: '🍸', label: 'Bar', permission: 'bar.view' },
  { id: 'cashier', icon: '💳', label: 'Cobrar', permission: 'payments.create' },
  { id: 'void-invoice', icon: '⊘', label: 'Anular factura', permission: 'payments.create' },
  { id: 'orders', icon: '☷', label: 'Pedidos', permission: 'orders.view' },
  { id: 'inventory', icon: '📦', label: 'Inventario', permission: 'inventory.view' },
  { id: 'products', icon: '🍔', label: 'Productos', permission: 'products.view' },
  { id: 'customers', icon: '👥', label: 'Clientes', permission: 'customers.view' },
  { id: 'reservations', icon: '📅', label: 'Reservas', permission: 'reservations.view' },
  { id: 'staff', icon: '🔐', label: 'Personal', permission: 'staff.view' },
  { id: 'reports', icon: '📊', label: 'Reportes', permission: 'reports.view' },
  { id: 'tv', icon: '📺', label: 'Pantalla TV', permission: 'display.view' },
  { id: 'settings', icon: '⚙', label: 'Configuración', permission: 'settings.view' },
]

export const ALL_PERMISSIONS = NAV_ITEMS.map((item) => item.permission)
