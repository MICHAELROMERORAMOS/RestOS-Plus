import React, { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import {
  listCustomers,
  normalizePhone,
  upsertCustomerByPhone,
} from '../services/customerService.js'

const emptyCustomer = {
  id: null,
  full_name: '',
  phone: '',
  email: '',
  address: '',
  neighborhood: '',
  city: '',
}

export default function CustomersPage() {
  const auth = useAuth()
  const restaurantId = auth.userContext?.membership?.restaurant_id || null
  const canManage = auth.can('customers.manage')

  const [phoneFilter, setPhoneFilter] = useState('')
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyCustomer)
  const [saving, setSaving] = useState(false)

  async function load(filter = phoneFilter) {
    if (!restaurantId) {
      setCustomers([])
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')

    try {
      const data = await listCustomers(restaurantId, filter)
      setCustomers(data)
    } catch (err) {
      setError(err?.message || 'No se pudo cargar la base de clientes.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!restaurantId) {
      setLoading(false)
      return undefined
    }

    const timer = window.setTimeout(() => {
      load(phoneFilter)
    }, 250)

    return () => window.clearTimeout(timer)
  }, [restaurantId, phoneFilter])

  function openNew() {
    if (!canManage) return window.alert('Tu rol no tiene permiso para registrar clientes.')
    setForm(emptyCustomer)
    setShowForm(true)
  }

  function openEdit(customer) {
    if (!canManage) return
    setForm({
      id: customer.id,
      full_name: customer.full_name || '',
      phone: customer.phone || '',
      email: customer.email || '',
      address: customer.address || '',
      neighborhood: customer.neighborhood || '',
      city: customer.city || '',
    })
    setShowForm(true)
  }

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function save(event) {
    event.preventDefault()

    if (!restaurantId) return window.alert('No se encontró el restaurante activo.')
    if (!form.full_name.trim()) return window.alert('Escribe el nombre del cliente.')
    if (!normalizePhone(form.phone)) return window.alert('Escribe el celular del cliente.')

    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email.trim())) {
      return window.alert('El correo electrónico no parece válido.')
    }

    setSaving(true)
    setError('')

    try {
      await upsertCustomerByPhone(restaurantId, form)
      setShowForm(false)
      setForm(emptyCustomer)
      await load(phoneFilter)
    } catch (err) {
      setError(err?.message || 'No se pudo guardar el cliente.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="view active customers-view">
      <div className="hero customers-hero">
        <div>
          <h2>Clientes</h2>
          <p>Base única de clientes del restaurante. El celular es el identificador de búsqueda.</p>
        </div>

        {canManage && (
          <button className="btn primary" onClick={openNew}>＋ Registrar cliente</button>
        )}
      </div>

      <div className="card">
        <div className="customers-toolbar">
          <label className="customer-phone-filter">
            <span>Buscar por celular</span>
            <input
              type="tel"
              value={phoneFilter}
              onChange={(event) => setPhoneFilter(event.target.value)}
              placeholder="Ej. 99991234 o +356 9999 1234"
            />
          </label>

          <button className="btn" onClick={() => load(phoneFilter)} disabled={loading}>↻ Actualizar</button>
        </div>

        {error && <div className="notice warn">{error}</div>}

        {loading ? (
          <div className="empty-inline">Cargando clientes…</div>
        ) : customers.length ? (
          <div className="customer-list">
            {customers.map((customer) => (
              <article className="customer-card" key={customer.id}>
                <div className="customer-avatar">
                  {(customer.full_name || '?').slice(0, 1).toUpperCase()}
                </div>

                <div className="customer-main">
                  <div className="customer-title">
                    <h4>{customer.full_name}</h4>
                    <b>📱 {customer.phone}</b>
                  </div>

                  <small>
                    {customer.address
                      ? `${customer.address}${customer.neighborhood ? ` · ${customer.neighborhood}` : ''}${customer.city ? ` · ${customer.city}` : ''}`
                      : 'Sin dirección registrada'}
                  </small>

                  {customer.email && <small>✉ {customer.email}</small>}
                </div>

                {canManage && (
                  <button className="btn" onClick={() => openEdit(customer)}>Editar</button>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-block">
            {phoneFilter
              ? 'No hay clientes que coincidan con ese celular.'
              : 'Todavía no hay clientes registrados.'}
          </div>
        )}
      </div>

      {showForm && (
        <div className="modal open" onClick={() => !saving && setShowForm(false)}>
          <form className="modal-card customer-form-card" onSubmit={save} onClick={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div>
                <h3>{form.id ? 'Editar cliente' : 'Registrar cliente'}</h3>
                <p className="muted">El celular evita crear fichas duplicadas del mismo cliente.</p>
              </div>
              <button type="button" className="btn" disabled={saving} onClick={() => setShowForm(false)}>×</button>
            </div>

            <div className="delivery-form-grid">
              <label className="wide">
                <span>Nombre del cliente *</span>
                <input
                  value={form.full_name}
                  onChange={(event) => updateField('full_name', event.target.value)}
                  placeholder="Nombre completo"
                  autoFocus
                />
              </label>

              <label>
                <span>Celular *</span>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(event) => updateField('phone', event.target.value)}
                  placeholder="Número de contacto"
                />
              </label>

              <label>
                <span>Correo electrónico</span>
                <input
                  type="email"
                  value={form.email}
                  onChange={(event) => updateField('email', event.target.value)}
                  placeholder="Opcional"
                />
              </label>

              <label className="wide">
                <span>Dirección</span>
                <input
                  value={form.address}
                  onChange={(event) => updateField('address', event.target.value)}
                  placeholder="Calle, número, apartamento..."
                />
              </label>

              <label>
                <span>Barrio</span>
                <input
                  value={form.neighborhood}
                  onChange={(event) => updateField('neighborhood', event.target.value)}
                  placeholder="Barrio / zona"
                />
              </label>

              <label>
                <span>Ciudad</span>
                <input
                  value={form.city}
                  onChange={(event) => updateField('city', event.target.value)}
                  placeholder="Ciudad"
                />
              </label>
            </div>

            <div className="notice">
              Si ya existe un cliente con el mismo celular, RestOS+ actualizará su ficha en lugar de crear un duplicado.
            </div>

            <button className="btn primary full" type="submit" disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar cliente'}
            </button>
          </form>
        </div>
      )}
    </section>
  )
}
