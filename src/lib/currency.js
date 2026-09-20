export const CURRENCY_OPTIONS = [
  { code: 'EUR', name: 'Euro', locale: 'es-ES' },
  { code: 'COP', name: 'Peso colombiano', locale: 'es-CO' },
  { code: 'USD', name: 'Dólar estadounidense', locale: 'en-US' },
  { code: 'GBP', name: 'Libra esterlina', locale: 'en-GB' },
  { code: 'CAD', name: 'Dólar canadiense', locale: 'en-CA' },
  { code: 'MXN', name: 'Peso mexicano', locale: 'es-MX' },
  { code: 'BRL', name: 'Real brasileño', locale: 'pt-BR' },
  { code: 'ARS', name: 'Peso argentino', locale: 'es-AR' },
  { code: 'CLP', name: 'Peso chileno', locale: 'es-CL' },
  { code: 'PEN', name: 'Sol peruano', locale: 'es-PE' },
]

const currencyByCode = new Map(CURRENCY_OPTIONS.map((currency) => [currency.code, currency]))

export function currencyInfo(code = 'EUR') {
  const normalized = String(code || 'EUR').toUpperCase()
  return currencyByCode.get(normalized) || {
    code: normalized,
    name: normalized,
    locale: 'es-ES',
  }
}

export function createMoneyFormatter(code = 'EUR') {
  const currency = currencyInfo(code)

  try {
    return new Intl.NumberFormat(currency.locale, {
      style: 'currency',
      currency: currency.code,
      currencyDisplay: 'symbol',
    })
  } catch {
    return new Intl.NumberFormat('es-ES', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }
}

export function formatMoneyValue(value, code = 'EUR') {
  const amount = Number(value || 0)
  const currency = currencyInfo(code)

  try {
    return createMoneyFormatter(currency.code).format(amount)
  } catch {
    return `${currency.code} ${amount.toFixed(2)}`
  }
}
