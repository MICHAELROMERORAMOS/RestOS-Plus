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
          <p>Revisa y confirma las solicitudes de los clientes. La generación de PIN se realiza directamente desde Mesas.</p>
        </div>
      </div>
      <QrAttentionStaff locationId={activeLocation?.id} />
      <QrGuestOperations locationId={activeLocation?.id} formatMoney={formatMoney} />
    </section>
  )
}
