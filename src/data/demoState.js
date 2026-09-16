export const createInitialDemoState = () => ({
  tables: Array.from({ length: 12 }, (_, index) => ({ id: index + 1, status: 'free' })),
  orders: [],
  sales: 0,
  activity: ['Sistema iniciado en modo desarrollo'],
  nextOrder: 1001,
  settings: {
    currency: 'EUR',
    currencySymbol: '€',
    defaultOrderMode: 'table',
    quickIdentifier: 'order',
    allowPager: true,
    splitStations: true,
    automaticOrderNumbering: true,
    restaurantName: 'Nuestro Restaurante',
  },
})
