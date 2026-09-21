import React, { useState } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import { findCustomerByPhone, normalizePhone } from '../../services/customerService.js'

const DOCUMENT_TYPES = [
  { value: 'CC', label: 'Cédula de ciudadanía' },
  { value: 'NIT', label: 'NIT' },
  { value: 'CE', label: 'Cédula de extranjería' },
  { value: 'TI', label: 'Tarjeta de identidad' },
  { value: 'PA', label: 'Pasaporte' },
  { value: 'PPT', label: 'Permiso por protección temporal' },
  { value: 'OTHER', label: 'Otro documento' },
]

export function invoiceCustomerFromOrders(orders = []) {
  const orderWithSnapshot = orders.find((order) => order?.invoiceCustomer)
  const snapshot = orderWithSnapshot?.invoiceCustomer || null
  const delivery = orders.find((order) => order?.delivery)?.delivery || null
  const linkedOrder = orders.find((order) => order?.customerId || order?.customerName) || null

  return {
    requested: Boolean(snapshot),
    id: snapshot?.id || delivery?.customerId || linkedOrder?.customerId || null,
    fullName: snapshot?.name || delivery?.customerName || linkedOrder?.customerName || '',
    documentType: snapshot?.documentType || 'CC',
    documentNumber: snapshot?.documentNumber || '',
    phone: snapshot?.phone || delivery?.phone || '',
    email: snapshot?.email || delivery?.email || '',
    address: snapshot?.address || delivery?.address || '',
    neighborhood: snapshot?.neighborhood || delivery?.neighborhood || '',
    city: snapshot?.city || delivery?.city || '',
  }
}

export function validateInvoiceCustomer(value) {
  if (!value?.requested) {
    return { ok: true, customer: { requested: false } }
  }

  const customer = {
    requested: true,
    id: value.id || null,
    fullName: String(value.fullName || '').trim(),
    documentType: String(value.documentType || '').trim().toUpperCase(),
    documentNumber: String(value.documentNumber || '').trim(),
    phone: String(value.phone || '').trim(),
    email: String(value.email || '').trim().toLowerCase(),
    address: String(value.address || '').trim(),
    neighborhood: String(value.neighborhood || '').trim(),
    city: String(value.city || '').trim(),
  }

  if (customer.fullName.length < 2) {
    return { ok: false, message: 'Escribe el nombre completo o la razón social del cliente.' }
  }

  if (!DOCUMENT_TYPES.some((type) => type.value === customer.documentType)) {
    return { ok: false, message: 'Selecciona un tipo de documento válido.' }
  }

  const normalizedDocument = customer.documentNumber.replace(/[^a-z0-9]/gi, '')
  if (normalizedDocument.length < 3 || normalizedDocument.length > 30) {
    return { ok: false, message: 'Escribe un número de documento válido.' }
  }

  if (customer.phone && normalizePhone(customer.phone).length < 7) {
    return { ok: false, message: 'El celular del cliente es demasiado corto.' }
  }

  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    return { ok: false, message: 'Escribe un correo electrónico válido.' }
  }

  return { ok: true, customer }
}

export default function InvoiceCustomerFields({ value, onChange, disabled = false }) {
  const auth = useAuth()
  const restaurantId = auth.userContext?.membership?.restaurant_id || null
  const [lookupState, setLookupState] = useState('idle')

  function update(field, nextValue) {
    const nextCustomer = { ...value, [field]: nextValue }

    // A customer id is only valid for the phone that was used to find it.
    // If the phone changes, force a fresh lookup/upsert at checkout instead of
    // accidentally overwriting the previously selected customer.
    if (field === 'phone' && nextValue !== value.phone) nextCustomer.id = null

    onChange(nextCustomer)
    if (field === 'phone') setLookupState('idle')
  }

  async function searchCustomer() {
    const phone = normalizePhone(value.phone)
    if (phone.length < 7) {
      return window.alert('Escribe primero un celular de al menos 7 dígitos.')
    }

    if (!restaurantId || auth.isDesignMode) {
      setLookupState('new')
      return
    }

    setLookupState('searching')
    try {
      const customer = await findCustomerByPhone(restaurantId, value.phone)
      if (!customer) {
        setLookupState('new')
        return
      }

      onChange({
        ...value,
        requested: true,
        id: customer.id,
        fullName: customer.full_name || '',
        documentType: customer.document_type || value.documentType || 'CC',
        documentNumber: customer.document_number || '',
        phone: customer.phone || value.phone,
        email: customer.email || '',
        address: customer.address || '',
        neighborhood: customer.neighborhood || '',
        city: customer.city || '',
      })
      setLookupState('found')
    } catch {
      setLookupState('error')
    }
  }

  return (
    <section className={`invoice-customer-panel ${value.requested ? 'enabled' : ''}`}>
      <label className="invoice-customer-toggle">
        <input
          type="checkbox"
          checked={Boolean(value.requested)}
          disabled={disabled}
          onChange={(event) => update('requested', event.target.checked)}
        />
        <span>
          <b>Factura a nombre del cliente</b>
          <small>Opcional. Si no se activa, la factura queda como consumidor final.</small>
        </span>
      </label>

      {value.requested && (
        <div className="invoice-customer-fields">
          <div className="invoice-customer-phone-row">
            <label>
              <span>Celular</span>
              <input
                type="tel"
                value={value.phone}
                disabled={disabled}
                onChange={(event) => update('phone', event.target.value)}
                placeholder="300 000 0000"
              />
            </label>
            <button type="button" className="btn" disabled={disabled || lookupState === 'searching'} onClick={searchCustomer}>
              {lookupState === 'searching' ? 'Buscando…' : 'Buscar cliente'}
            </button>
          </div>

          {lookupState === 'found' && <div className="customer-lookup-state found">Cliente encontrado; puedes verificar o corregir sus datos.</div>}
          {lookupState === 'new' && <div className="customer-lookup-state new">No existe con ese celular; se registrará al confirmar el cobro.</div>}
          {lookupState === 'error' && <div className="customer-lookup-state error">No se pudo consultar la base de clientes.</div>}

          <div className="invoice-customer-grid">
            <label className="wide">
              <span>Nombre completo o razón social *</span>
              <input
                value={value.fullName}
                disabled={disabled}
                onChange={(event) => update('fullName', event.target.value)}
                placeholder="Nombre del cliente o empresa"
              />
            </label>

            <label>
              <span>Tipo de documento *</span>
              <select value={value.documentType} disabled={disabled} onChange={(event) => update('documentType', event.target.value)}>
                {DOCUMENT_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
              </select>
            </label>

            <label>
              <span>Número de documento *</span>
              <input
                value={value.documentNumber}
                disabled={disabled}
                onChange={(event) => update('documentNumber', event.target.value)}
                placeholder={value.documentType === 'NIT' ? '900123456-7' : 'Número de identificación'}
              />
            </label>

            <label>
              <span>Correo</span>
              <input
                type="email"
                value={value.email}
                disabled={disabled}
                onChange={(event) => update('email', event.target.value)}
                placeholder="cliente@correo.com"
              />
            </label>

            <label>
              <span>Ciudad</span>
              <input value={value.city} disabled={disabled} onChange={(event) => update('city', event.target.value)} />
            </label>

            <label className="wide">
              <span>Dirección</span>
              <input value={value.address} disabled={disabled} onChange={(event) => update('address', event.target.value)} />
            </label>
          </div>
        </div>
      )}
    </section>
  )
}
