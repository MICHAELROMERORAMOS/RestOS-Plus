import React from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import QrGuestOperations from '../components/QrGuestOperations.jsx'
import QrAttentionStaff from '../components/QrAttentionStaff.jsx'

export default function QrOrdersPage() {
  const restaurant = useRestaurant()
  const { activeLocation, formatMoney } = restaurant
  return (
    <section className="view active">
      <div className="hero">
        <div>
          <h2>Pedidos QR</h2>
          <p>Revisa pedidos y solicitudes de atención. El código único de seis dígitos de la sucursal se muestra desde «Código QR» en la barra superior.</p>
        </div>
      </div>
      <QrAttentionStaff locationId={activeLocation?.id} />
      <QrGuestOperations locationId={activeLocation?.id} formatMoney={formatMoney} />
    </section>
  )
}
