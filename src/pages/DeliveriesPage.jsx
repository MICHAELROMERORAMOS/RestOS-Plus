import React, { useMemo, useState } from 'react'
import { useRestaurant, orderBalance, orderTotal } from '../context/RestaurantContext.jsx'

const emptyForm = {
  customerName: '',
  address: '',
  phone: '',
  email: '',
  neighborhood: '',
  city: '',
}

function prepStatus(order) {
  const items = (order.rounds || []).flatMap((round) => round.items || []).filter((item) => !item.voided)
  if (!items.length) return 'SIN ENVIAR'
  if (items.every((item) => ['ready', 'delivered'].includes(item.prepStatus))) return 'LISTO PARA DESPACHAR'
  if (items.some((item) => item.prepStatus === 'preparing')) return 'EN PREPARACIÓN'
  return 'RECIBIDO'
}

export default function DeliveriesPage({ onStartDelivery, onOpenDelivery }) {
  const { state } = useRestaurant()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyForm)

  const deliveries = useMemo(
    () => state.orders
      .filter((order) => order.mode === 'delivery')
      .slice()
      .sort((a, b) => (b.created || 0) - (a.created || 0)),
    [state.orders],
  )

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  function submit(event) {
    event.preventDefault()

    const required = ['customerName', 'address', 'phone', 'neighborhood', 'city']
    if (required.some((field) => !String(form[field] || '').trim())) {
      return window.alert('Completa nombre, dirección, celular, barrio y ciudad.')
    }

    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email.trim())) {
      return window.alert('El correo electrónico no parece válido.')
    }

    const result = onStartDelivery(form)
    if (!result?.ok) return window.alert(result?.message || 'No se pudo crear el domicilio.')

    setForm(emptyForm)
    setShowForm(false)
  }

  return (
    <section className="view active deliveries-view">
      <div className="hero deliveries-hero">
        <div>
          <h2>Domicilios</h2>
          <p>Registra los datos del cliente, arma el pedido y envíalo a Cocina/Bar.</p>
        </div>
        <button className="btn primary" onClick={() => setShowForm(true)}>＋ Nuevo domicilio</button>
      </div>

      <div className="card">
        <div className="section-title">
          <div>
            <h3>Pedidos a domicilio</h3>
            <p className="muted">{deliveries.length} domicilio{deliveries.length === 1 ? '' : 's'} registrado{deliveries.length === 1 ? '' : 's'}</p>
          </div>
        </div>

        {deliveries.length ? (
          <div className="delivery-list">
            {deliveries.map((order) => {
              const customer = order.delivery || {}
              const balance = orderBalance(order)
              return (
                <article className="delivery-card" key={order.id}>
                  <div className="delivery-card-main">
                    <div className="delivery-card-icon">🚚</div>
                    <div>
                      <div className="delivery-card-title">
                        <h4>{customer.customerName || 'Cliente sin nombre'}</h4>
                        <span className="badge">{prepStatus(order)}</span>
                      </div>
                      <b className="delivery-address">{customer.address || 'Sin dirección'}</b>
                      <small>{customer.neighborhood || 'Sin barrio'} · {customer.city || 'Sin ciudad'}</small>
                      <small>📱 {customer.phone || 'Sin celular'}{customer.email ? ` · ✉ ${customer.email}` : ''}</small>
                    </div>
                  </div>

                  <div className="delivery-card-meta">
                    <span>Orden #{order.id}</span>
                    <strong>€{orderTotal(order).toFixed(2)}</strong>
                    {balance > 0.005 && <small>Saldo €{balance.toFixed(2)}</small>}
                  </div>

                  <button className="btn" onClick={() => onOpenDelivery(order.id)}>Abrir pedido</button>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="empty-block">Todavía no hay domicilios. Crea el primero con “Nuevo domicilio”.</div>
        )}
      </div>

      {showForm && (
        <div className="modal open" onClick={() => setShowForm(false)}>
          <form className="modal-card delivery-form-card" onSubmit={submit} onClick={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div>
                <h3>🚚 Nuevo domicilio</h3>
                <p className="muted">Datos de entrega y contacto del cliente.</p>
              </div>
              <button type="button" className="btn" onClick={() => setShowForm(false)}>×</button>
            </div>

            <div className="delivery-form-grid">
              <label className="wide">
                <span>Nombre del cliente *</span>
                <input value={form.customerName} onChange={(event) => updateField('customerName', event.target.value)} placeholder="Nombre completo" autoFocus />
              </label>

              <label className="wide">
                <span>Dirección *</span>
                <input value={form.address} onChange={(event) => updateField('address', event.target.value)} placeholder="Calle, carrera, número, apartamento..." />
              </label>

              <label>
                <span>Celular *</span>
                <input type="tel" value={form.phone} onChange={(event) => updateField('phone', event.target.value)} placeholder="Número de contacto" />
              </label>

              <label>
                <span>Correo electrónico</span>
                <input type="email" value={form.email} onChange={(event) => updateField('email', event.target.value)} placeholder="Opcional" />
              </label>

              <label>
                <span>Barrio *</span>
                <input value={form.neighborhood} onChange={(event) => updateField('neighborhood', event.target.value)} placeholder="Barrio / zona" />
              </label>

              <label>
                <span>Ciudad *</span>
                <input value={form.city} onChange={(event) => updateField('city', event.target.value)} placeholder="Ciudad" />
              </label>
            </div>

            <div className="notice">* Nombre, dirección, celular, barrio y ciudad son obligatorios. El correo es opcional.</div>
            <button className="btn primary full" type="submit">Continuar y agregar productos</button>
          </form>
        </div>
      )}
    </section>
  )
}
