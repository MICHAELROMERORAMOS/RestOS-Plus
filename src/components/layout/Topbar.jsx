import React from 'react'

export default function Topbar({ title, canKitchen, canOrder, onKitchen, onNewOrder }) {
  return (
    <header className="top">
      <h1>{title}</h1>
      <div className="actions">
        {canKitchen && <button className="btn" onClick={onKitchen}>🍳 Cocina</button>}
        {canOrder && <button className="btn primary" onClick={onNewOrder}>＋ Nuevo pedido</button>}
      </div>
    </header>
  )
}
