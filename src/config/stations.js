export const PREPARATION_STATIONS = {
  kitchen: { value: 'kitchen', label: 'Cocina', icon: '🍳' },
  bar: { value: 'bar', label: 'Bar', icon: '🍸' },
  dessert: { value: 'dessert', label: 'Postres', icon: '🍰' },
  coffee: { value: 'coffee', label: 'Café', icon: '☕' },
  other: { value: 'other', label: 'Otra estación', icon: '📍' },
}

export const PREPARATION_STATION_OPTIONS = Object.values(PREPARATION_STATIONS)

export function preparationStationMeta(type) {
  return PREPARATION_STATIONS[type] || PREPARATION_STATIONS.kitchen
}

export function preparationStationLabel(type) {
  return preparationStationMeta(type).label
}

export function preparationStationDisplay(type) {
  const station = preparationStationMeta(type)
  return `${station.icon} ${station.label}`
}
