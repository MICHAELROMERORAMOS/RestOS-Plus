import React from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'
export default function TvPage() {
  const { state } = useRestaurant()
  return <section className="view active"><div className="tv"><div><div className="tv-icon">🍽️</div><h2>Bienvenidos a {state.settings.restaurantName}</h2><p className="tv-sub">Síguenos y descubre nuestras novedades</p><div className="socials"><div><strong>12.8K</strong><span>Instagram followers</span></div><div><strong>8.4K</strong><span>Facebook followers</span></div><div><strong>4.9★</strong><span>Valoración</span></div></div><p className="tv-qr">▣ Escanea nuestro QR · @restaurante</p></div></div></section>
}
