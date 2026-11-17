import React from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import QrGuestOperations from '../components/QrGuestOperations.jsx'

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
      <QrGuestOperations locationId={activeLocation?.id} formatMoney={formatMoney} />
    </section>
  )
}
