export const PLATFORM_ADMIN_HOST = 'admin.restosplus.com'
export const CLIENT_HOST = 'restosplus.com'

export function isPlatformAdminSurface(hostname = window.location.hostname) {
  const host = String(hostname || '').toLowerCase()
  if (host === PLATFORM_ADMIN_HOST) return true

  // Development-only fallback. Production client URLs never expose the platform portal by path.
  const local = host === 'localhost' || host === '127.0.0.1'
  if (!local) return false

  const pathname = window.location.pathname.replace(/\/+$/, '') || '/'
  return pathname === '/developer' || pathname.startsWith('/developer/')
}

export function isLegacyPlatformPath(pathname = window.location.pathname) {
  const normalized = String(pathname || '/').replace(/\/+$/, '') || '/'
  return normalized === '/developer'
    || normalized.startsWith('/developer/')
    || normalized === '/empresas-restos'
}

export function clientAppUrl(path = '/') {
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `https://${CLIENT_HOST}${normalized}`
}

export function platformAdminUrl(path = '/') {
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `https://${PLATFORM_ADMIN_HOST}${normalized}`
}
