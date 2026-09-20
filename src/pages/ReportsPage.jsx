import React from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'
export default function ReportsPage() {
  const { state, formatMoney } = useRestaurant()
  const closed = state.orders.filter((order) => order.status === 'closed')
  const ticketAverage = closed.length ? state.sales / closed.length : 0
  return <section className="view active"><div className="hero"><div><h2>Reportes</h2><p>Ventas, ticket promedio, productos, métodos de pago y rendimiento.</p></div></div><div className="grid stats"><div className="card stat"><span className="label">Ticket promedio</span><strong>{formatMoney(ticketAverage)}</strong><small>Según pagos demo</small></div><div className="card stat"><span className="label">Top producto</span><strong>Burger</strong><small>Demo inicial</small></div><div className="card stat"><span className="label">Efectivo</span><strong>38%</strong><small>Ejemplo</small></div><div className="card stat"><span className="label">Tarjeta</span><strong>62%</strong><small>Ejemplo</small></div></div></section>
}
