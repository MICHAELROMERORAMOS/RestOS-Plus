const DESKTOP_QUERY = 'restosDesktop'

export function isDesktopDevice() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false

  const uaMobile = navigator.userAgentData?.mobile
  if (typeof uaMobile === 'boolean') return !uaMobile

  const mobileAgent = /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(navigator.userAgent || '')
  if (mobileAgent) return false

  const finePointer = window.matchMedia?.('(pointer:fine)')?.matches
  const wideScreen = Math.max(window.screen?.width || 0, window.innerWidth || 0) >= 900
  return Boolean(finePointer || wideScreen)
}

export function isDesktopAppWindow() {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get(DESKTOP_QUERY) === '1'
}

export function buildDesktopAppUrl() {
  const url = new URL(window.location.href)
  url.searchParams.set(DESKTOP_QUERY, '1')
  return url.toString()
}

export function openDesktopAppWindow() {
  if (!isDesktopDevice() || isDesktopAppWindow()) return null

  const width = Math.max(900, window.screen?.availWidth || window.screen?.width || window.innerWidth || 1200)
  const height = Math.max(650, window.screen?.availHeight || window.screen?.height || window.innerHeight || 800)
  const features = [
    'popup=yes',
    'toolbar=no',
    'location=no',
    'menubar=no',
    'status=no',
    'scrollbars=yes',
    'resizable=yes',
    'left=0',
    'top=0',
    `width=${width}`,
    `height=${height}`,
    'fullscreen=yes',
  ].join(',')

  const popup = window.open('', 'RestOSPlusDesktop', features)
  if (!popup) return null

  try {
    popup.document.open()
    popup.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>RestOS+</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html,body{margin:0;width:100%;height:100%;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;background:#102f24;color:#fff}
    body{display:grid;place-items:center}
    .box{text-align:center;padding:28px}
    .brand{font-size:34px;font-weight:950;margin-bottom:8px}
    .sub{color:#bdd0c8;font-size:14px}
  </style>
</head>
<body>
  <div class="box">
    <div class="brand">RestOS+</div>
    <div class="sub">Abriendo ventana de operación…</div>
  </div>
</body>
</html>`)
    popup.document.close()
  } catch {
    // The popup can still be used even if the browser blocks document injection.
  }

  try {
    popup.moveTo(0, 0)
    popup.resizeTo(width, height)
    popup.focus()
  } catch {
    // Some browsers intentionally restrict programmatic resizing.
  }

  try {
    const root = popup.document?.documentElement
    if (root?.requestFullscreen) {
      const result = root.requestFullscreen({ navigationUI: 'hide' })
      result?.catch?.(() => {})
    }
  } catch {
    // Fullscreen is best-effort; browsers may require interaction inside the new window.
  }

  return popup
}

export function navigateDesktopAppWindow(popup) {
  if (!popup || popup.closed) return false

  try {
    popup.location.replace(buildDesktopAppUrl())
    popup.focus()
    return true
  } catch {
    return false
  }
}

export function maximizeDesktopWindow() {
  if (!isDesktopDevice()) return

  const width = Math.max(900, window.screen?.availWidth || window.screen?.width || window.innerWidth || 1200)
  const height = Math.max(650, window.screen?.availHeight || window.screen?.height || window.innerHeight || 800)

  try {
    window.moveTo(0, 0)
    window.resizeTo(width, height)
  } catch {
    // Browser restrictions are expected in some environments.
  }
}

export async function requestDesktopFullscreen() {
  if (typeof document === 'undefined') return false
  if (document.fullscreenElement) return true

  const root = document.documentElement
  if (!root?.requestFullscreen) return false

  try {
    await root.requestFullscreen({ navigationUI: 'hide' })
    return true
  } catch {
    return false
  }
}
