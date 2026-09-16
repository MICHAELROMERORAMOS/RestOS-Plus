import React from 'react'
import { useRestaurant } from '../context/RestaurantContext.jsx'
export default function ProductsPage() {
  const { products } = useRestaurant()
  return <section className="view active"><div className="hero"><div><h2>Productos y menú</h2><p>Precios, categorías, disponibilidad, preparación, variantes y recetas.</p></div><button className="btn primary">＋ Producto</button></div><div className="card"><div className="products">{products.map((product) => <div className="product" key={product.id}><strong>{product.name}</strong><small>{product.category} · {product.station === 'bar' ? 'Bar' : 'Cocina'}</small><em>€{product.price.toFixed(2)}</em></div>)}</div></div></section>
}
