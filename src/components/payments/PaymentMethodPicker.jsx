import React from 'react'

export const PAYMENT_METHODS = [
  { value: 'cash', icon: '💵', label: 'Efectivo', description: 'Pago en caja' },
  { value: 'card', icon: '💳', label: 'Tarjeta', description: 'Débito o crédito' },
  { value: 'transfer', icon: '🏦', label: 'Transferencia', description: 'Transferencia bancaria' },
  { value: 'nequi', icon: '📱', label: 'Nequi', description: 'Pago por Nequi' },
  { value: 'other', icon: '＋', label: 'Otro', description: 'Otro medio de pago' },
]

export function paymentMethodLabel(value) {
  return PAYMENT_METHODS.find((method) => method.value === value)?.label || value || 'Pago'
}

export default function PaymentMethodPicker({ value, onChange, disabled = false }) {
  return (
    <div className="payment-method-picker" role="radiogroup" aria-label="Método de pago">
      {PAYMENT_METHODS.map((method) => (
        <button
          key={method.value}
          type="button"
          className={`payment-method-option ${value === method.value ? 'active' : ''}`}
          role="radio"
          aria-checked={value === method.value}
          disabled={disabled}
          onClick={() => onChange(method.value)}
        >
          <span className="payment-method-icon" aria-hidden="true">{method.icon}</span>
          <span>
            <b>{method.label}</b>
            <small>{method.description}</small>
          </span>
          <span className="payment-method-check" aria-hidden="true">{value === method.value ? '✓' : ''}</span>
        </button>
      ))}
    </div>
  )
}
