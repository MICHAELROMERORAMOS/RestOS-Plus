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

export async function requestDesktopFullscreen() {
  if (!isDesktopDevice() || typeof document === 'undefined') return false
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

export async function exitDesktopFullscreen() {
  if (typeof document === 'undefined' || !document.fullscreenElement) return

  try {
    await document.exitFullscreen()
  } catch {
    // Browser restrictions are intentionally ignored.
  }
}
