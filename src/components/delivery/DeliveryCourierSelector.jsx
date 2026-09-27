import React from 'react'

export const EMPTY_DELIVERY_COURIER = {
  name: '',
  phone: '',
  address: '',
  company: '',
}

export function validateDeliveryCourierForm(value) {
  const courier = {
    name: String(value?.name || '').trim(),
    phone: String(value?.phone || '').trim(),
    address: String(value?.address || '').trim(),
    company: String(value?.company || '').trim(),
  }

  if (!courier.name) return { ok: false, message: 'Escribe el nombre del domiciliario.' }
  if (courier.phone.replace(/\D/g, '').length < 5) {
    return { ok: false, message: 'Escribe un número de teléfono válido para el domiciliario.' }
  }
  if (!courier.address) return { ok: false, message: 'Escribe la dirección del domiciliario.' }
  if (!courier.company) return { ok: false, message: 'Escribe la empresa del domiciliario. Si trabaja por cuenta propia puedes usar “Independiente”.' }

  return { ok: true, courier }
}

export default function DeliveryCourierSelector({
  couriers,
  selectedId,
  onSelect,
  mode,
  onModeChange,
  newCourier,
  onNewCourierChange,
  loading = false,
  error = '',
  disabled = false,
  compact = false,
}) {
  const update = (field, value) => {
    onNewCourierChange?.({ ...newCourier, [field]: value })
  }

  return (
    <div className={`delivery-courier-selector ${compact ? 'compact' : ''}`}>
      <div className="delivery-courier-mode">
        <button
          type="button"
          className={mode === 'existing' ? 'active' : ''}
          disabled={disabled || loading}
          onClick={() => onModeChange?.('existing')}
        >
          Domiciliario registrado
        </button>
        <button
          type="button"
          className={mode === 'new' ? 'active' : ''}
          disabled={disabled || loading}
          onClick={() => onModeChange?.('new')}
        >
          ＋ Registrar nuevo
        </button>
      </div>

      {loading ? (
        <div className="delivery-courier-loading">Cargando domiciliarios…</div>
      ) : mode === 'existing' ? (
        <label className="delivery-courier-select-field">
          <span>Selecciona quién recogió el domicilio *</span>
          <select
            value={selectedId}
            disabled={disabled}
            onChange={(event) => onSelect?.(event.target.value)}
          >
            <option value="">Selecciona un domiciliario</option>
            {(couriers || []).map((courier) => (
              <option value={courier.id} key={courier.id}>
                {courier.name} · {courier.company} · {courier.phone}
              </option>
            ))}
          </select>
          {!couriers?.length && (
            <small>No hay domiciliarios registrados. Usa “Registrar nuevo”.</small>
          )}
        </label>
      ) : (
        <div className="delivery-courier-new-grid">
          <label>
            <span>Nombre *</span>
            <input
              value={newCourier?.name || ''}
              disabled={disabled}
              onChange={(event) => update('name', event.target.value)}
              placeholder="Nombre completo"
            />
          </label>
          <label>
            <span>Teléfono *</span>
            <input
              type="tel"
              value={newCourier?.phone || ''}
              disabled={disabled}
              onChange={(event) => update('phone', event.target.value)}
              placeholder="Número de contacto"
            />
          </label>
          <label>
            <span>Dirección *</span>
            <input
              value={newCourier?.address || ''}
              disabled={disabled}
              onChange={(event) => update('address', event.target.value)}
              placeholder="Dirección / zona"
            />
          </label>
          <label>
            <span>Empresa *</span>
            <input
              value={newCourier?.company || ''}
              disabled={disabled}
              onChange={(event) => update('company', event.target.value)}
              placeholder="Ej. Rappi, Mensajeros Urbanos, Independiente"
            />
          </label>
        </div>
      )}

      {error && <div className="auth-error delivery-courier-error">{error}</div>}
    </div>
  )
}
