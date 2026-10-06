export function preparationOrderNumber(order) {
  const value = Number(order?.displayOrderNumber)
  return Number.isFinite(value) && value > 0 ? value : null
}

export function orderNumberLabel(order, {
  pending = 'SIN ENVIAR',
  prefix = 'Orden #',
} = {}) {
  const value = preparationOrderNumber(order)
  return value == null ? pending : `${prefix}${value}`
}
