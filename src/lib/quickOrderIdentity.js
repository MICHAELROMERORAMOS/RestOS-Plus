export function formatQuickCounterValue(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  if (/^\d+$/.test(raw)) return raw.padStart(2, '0')
  return raw.toUpperCase()
}

export function quickServiceIdentity(order, {
  manual = true,
  fallback = 'NUEVO PEDIDO',
} = {}) {
  const customerName = String(order?.customerName || '').trim()
  const pager = formatQuickCounterValue(order?.pager)
  const orderId = order?.id

  if (manual) {
    if (customerName) return customerName
    if (pager) return `PAGER ${pager}`
    return orderId != null && String(orderId).trim()
      ? `ORDEN #${orderId}`
      : fallback
  }

  const turn = pager || formatQuickCounterValue(orderId)
  return turn ? `TURNO ${turn}` : fallback
}
