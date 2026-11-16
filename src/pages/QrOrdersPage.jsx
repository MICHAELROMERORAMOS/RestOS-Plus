import React from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'
import QrGuestOperations from '../components/QrGuestOperations.jsx'

export default function QrOrdersPage() {
  const restaurant = useRestaurant()
  const tables = (restaurant.state?.tables || []).filter(table => table.active !== false)
  return (
    <section className="view active">
      <div className="hero">
        <div>
          <h2>Pedidos QR</h2>
          <p>Entrega un PIN de 4 números, permite que el cliente abra la mesa desde el QR y confirma las solicitudes directamente a preparación.</p>
        </div>
      </div>
      <QrGuestOperations locationId={restaurant.activeLocation?.id} tables={tables} />
    </section>
  )
}
