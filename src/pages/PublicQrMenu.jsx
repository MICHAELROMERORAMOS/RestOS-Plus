import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { guestSupabase as supabase, getGuestOAuthProviders } from '../lib/guestSupabase.js'
import './PublicQrMenu.css'
import QrAttentionClient from '../components/QrAttentionClient.jsx'

const safeMoney = (value, currency) => {
  try {
    return new Intl.NumberFormat('es-CO', { style: 'currency', currency: currency || 'COP', maximumFractionDigits: 2 })
      .format(Number(value || 0))
  } catch { return String(value ?? '') }
}

const requestStatusLabel = (status) => ({
  pending: 'Pendiente de confirmación',
  reviewed: 'Confirmado · enviado a preparación',
  rejected: 'Solicitud rechazada',
  sent: 'Enviado a preparación',
  new: 'Recibido en cocina',
  preparing: 'En preparación',
  ready: 'Listo para entregar',
  served: 'Entregado',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
})[status] || 'Actualizando estado'

export default function PublicQrMenu() {
  const locationId = window.location.pathname.match(/^\/menu\/([0-9a-f-]{36})\/?$/i)?.[1]
  const tableToken = new URLSearchParams(window.location.search).get('t')
  const visitKey = locationId && tableToken ? `restosplus:qr-visit:${locationId}:${tableToken}` : null

  const [showMenuAfterAttention, setShowMenuAfterAttention] = useState(false)
  const [attentionEnabled, setAttentionEnabled] = useState(false)
  const [tableQrOrdersAllowed, setTableQrOrdersAllowed] = useState(true)
  const [customerUser, setCustomerUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [providerAvailability, setProviderAvailability] = useState(null)
  const [menu, setMenu] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [table, setTable] = useState(null)
  const [tableError, setTableError] = useState('')
  const [category, setCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [allergySelection, setAllergySelection] = useState([])
  const [allergyExpanded, setAllergyExpanded] = useState(false)
  const [cart, setCart] = useState({})
  const [attentionToken, setAttentionToken] = useState('')
  const [tableOpened, setTableOpened] = useState(false)
  const [opening, setOpening] = useState(false)
  const [sending, setSending] = useState(false)
  const [viewToken, setViewToken] = useState('')
  const [orderSnapshot, setOrderSnapshot] = useState(null)
  const [orderNotice, setOrderNotice] = useState('')
  const [orderError, setOrderError] = useState('')

  useEffect(() => {
    document.documentElement.classList.add('qr-public-scroll')
    return () => document.documentElement.classList.remove('qr-public-scroll')
  }, [])

  useEffect(() => {
    let active = true
    if (!supabase) { setAuthLoading(false); return undefined }
    supabase.auth.getSession().then(({ data }) => {
      if (active) { setCustomerUser(data?.session?.user || null); setAuthLoading(false) }
    }).catch(() => { if (active) setAuthLoading(false) })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) { setCustomerUser(session?.user || null); setAuthLoading(false) }
    })
    return () => { active = false; listener?.subscription?.unsubscribe() }
  }, [])

  useEffect(() => {
    let active = true
    getGuestOAuthProviders().then(p => { if (active) setProviderAvailability(p) })
      .catch(() => { if (active) setProviderAvailability(null) })
    return () => { active = false }
  }, [])

  const authMode = menu?.authMode || 'required'
  const mustSignIn = authMode === 'required'
  const canOpenTable = !authLoading && (!mustSignIn || Boolean(customerUser))
  async function signInCustomer(provider) {
    if (authBusy || !supabase) return
    setAuthBusy(true)
    setAuthError('')
    try {
      const providers = await getGuestOAuthProviders()
      setProviderAvailability(providers)
      if (!providers[provider]) {
        setAuthError('El acceso con ' + (provider === 'google' ? 'Google' : 'Apple') + ' aún no está configurado. Solicita ayuda al personal.')
        return
      }
      const redirectTo = window.location.origin + window.location.pathname + window.location.search
      const { error: signInError } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo } })
      if (signInError) setAuthError(signInError.message)
    } catch {
      setAuthError('No fue posible comprobar el inicio de sesión. Inténtalo nuevamente.')
    } finally { setAuthBusy(false) }
  }

  const loadCatalog = useCallback(async () => {
    if (!locationId || !supabase) return
    const { data, error: fetchError } = await supabase.rpc('get_public_qr_menu', { p_location_id: locationId })
    if (fetchError || !data) return
    setMenu(data)
    setCart(previous => Object.fromEntries(Object.entries(previous).filter(([id]) =>
      (data.products || []).some(product => product.id === id)
    )))
  }, [locationId])

  useEffect(() => {
    let mounted = true
    async function initialize() {
      if (!locationId || !supabase) {
        setError('Este menú no está disponible.')
        setLoading(false)
        return
      }
      const [catalog, tableResult, attentionResult, permissionResult] = await Promise.all([
        supabase.rpc('get_public_qr_menu', { p_location_id: locationId }),
        tableToken && /^[0-9a-f-]{36}$/i.test(tableToken)
          ? supabase.rpc('resolve_public_qr_table', { p_location_id: locationId, p_token: tableToken })
          : Promise.resolve(null),
        tableToken && /^[0-9a-f-]{36}$/i.test(tableToken)
          ? supabase.rpc('get_qr_attention_public_settings', { p_location_id: locationId, p_qr_token: tableToken })
          : Promise.resolve(null),
        tableToken && /^[0-9a-f-]{36}$/i.test(tableToken)
          ? supabase.rpc('get_public_qr_table_order_permission', { p_location_id: locationId, p_qr_token: tableToken })
          : Promise.resolve(null),
      ])
      if (!mounted) return
      setMenu(catalog.data || null)
      setTable(tableResult?.data || null)
      setAttentionEnabled(attentionResult?.data?.enabled === true)
      setTableQrOrdersAllowed(permissionResult?.data?.enabled !== false)
      setTableError(tableToken && !tableResult?.data
        ? 'El QR de esta mesa no es válido. Pide al personal el código actualizado.' : '')
      setError(attentionResult?.data?.enabled === true ? '' : catalog.error ? 'No se pudo cargar el menú.' : !catalog.data ? 'Menú no publicado.' : '')
      setLoading(false)
    }
    initialize()
    return () => { mounted = false }
  }, [locationId, tableToken])

  useEffect(() => {
    if (!visitKey) return
    try {
      const saved = JSON.parse(window.localStorage.getItem(visitKey) || 'null')
      if (saved?.token && saved.expiresAt > Date.now() && /^[0-9a-f-]{36}$/i.test(saved.token)) {
        setViewToken(saved.token)
      } else {
        window.localStorage.removeItem(visitKey)
      }
    } catch { /* The menu remains usable when storage is restricted. */ }
  }, [visitKey])

  const refreshOrderStatus = useCallback(async (token) => {
    if (!token || !locationId || !tableToken) return
    const { data, error: requestError } = await supabase.rpc('get_qr_guest_order_status', {
      p_location_id: locationId, p_qr_token: tableToken, p_view_token: token,
    })
    if (requestError) {
      setOrderError('No se pudo actualizar el estado de tu pedido. Intenta nuevamente.')
      return
    }
    if (!data?.authorized) {
      setViewToken('')
      setOrderSnapshot(null)
      setTableOpened(false)
      try { if (visitKey) window.localStorage.removeItem(visitKey) } catch {}
      return
    }
    setOrderSnapshot(data)
    setTableOpened(Boolean(data.canOrder))
  }, [locationId, tableToken, visitKey])

  useEffect(() => {
    if (!viewToken) return undefined
    void refreshOrderStatus(viewToken)
    const poll = () => {
      if (document.visibilityState === 'visible') void refreshOrderStatus(viewToken)
    }
    const timer = window.setInterval(poll, 8000)
    const onFocus = () => { poll(); void loadCatalog() }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [viewToken, refreshOrderStatus, loadCatalog])

  useEffect(() => {
    if (!menu) return undefined
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadCatalog()
    }, 30000)
    return () => window.clearInterval(timer)
  }, [menu?.location?.name, loadCatalog])

  const selectedIds = useMemo(() => new Set(allergySelection.map(a => a.allergenId)), [allergySelection])
  const allergyConflict = useCallback(product => (product.allergens || []).some(a => selectedIds.has(a.allergenId)), [selectedIds])
  const products = useMemo(() => (menu?.products || []).filter(product => (
    (category === 'all' || product.categoryId === category) &&
    (product.name + ' ' + (product.description || '')).toLocaleLowerCase().includes(search.toLocaleLowerCase()) &&
    !allergyConflict(product)
  )), [menu, category, search, allergyConflict])
  const cartItems = (menu?.products || []).filter(p => cart[p.id] > 0 && !allergyConflict(p))
    .map(p => ({ ...p, quantity: cart[p.id] }))
  const cartTotal = cartItems.reduce((sum, p) => sum + p.price * p.quantity, 0)
  const price = value => safeMoney(value, menu?.restaurant?.currency)

  function setDeclaredAllergies(value) {
    setAllergySelection(value)
    const ids = new Set(value.map(a => a.allergenId))
    setCart(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => {
      const product = (menu?.products || []).find(p => p.id === id)
      return product && !(product.allergens || []).some(a => ids.has(a.allergenId))
    })))
    setOrderNotice('')
    setOrderError('')
  }

  function toggleAllergen(allergenId) {
    setDeclaredAllergies(selectedIds.has(allergenId)
      ? allergySelection.filter(a => a.allergenId !== allergenId)
      : [...allergySelection, { allergenId, subtypeIds: [] }])
  }

  function toggleSubtype(allergenId, subtypeId) {
    setDeclaredAllergies(allergySelection.map(a => {
      if (a.allergenId !== allergenId) return a
      const subtypes = a.subtypeIds || []
      return {
        ...a,
        subtypeIds: subtypes.includes(subtypeId)
          ? subtypes.filter(id => id !== subtypeId)
          : [...subtypes, subtypeId],
      }
    }))
  }

  function adjust(productId, step) {
    setCart(previous => ({ ...previous, [productId]: Math.min(20, Math.max(0, (previous[productId] || 0) + step)) }))
    setOrderNotice('')
    setOrderError('')
  }

  const onAttentionAuthorized = useCallback(token => {
    setAttentionToken(current => current === token ? current : token)
  }, [])

  async function openMyTable(selectedToken = attentionToken) {
    if (!tableQrOrdersAllowed || !menu || menu.customerOrderingEnabled === false) {
      setOrderError('Los pedidos desde el celular no están habilitados para esta mesa.')
      return
    }
    if (!attentionEnabled || !selectedToken) {
      setOrderError('Introduce primero el código general de 6 dígitos del restaurante.')
      return
    }
    setShowMenuAfterAttention(true)
    if (!canOpenTable) {
      setOrderError('Para realizar pedidos, inicia sesión con Google o Apple según la configuración de esta sucursal.')
      return
    }
    if (!table || !tableToken || opening) return
    setOpening(true)
    setOrderError('')
    try {
      const { data, error: openError } = await supabase.rpc('open_qr_guest_order_with_attention', {
        p_location_id: locationId, p_qr_token: tableToken, p_attention_token: selectedToken,
      })
      if (openError || !data?.ok || !data.viewToken) {
        throw new Error(openError?.message || data?.message || 'No fue posible abrir la mesa.')
      }
      setViewToken(data.viewToken)
      setTableOpened(true)
      setOrderNotice('Mesa habilitada para realizar solicitudes de productos. El personal confirmará cada pedido.')
      try {
        if (visitKey) window.localStorage.setItem(visitKey, JSON.stringify({
          token: data.viewToken, expiresAt: Date.now() + 48 * 60 * 60 * 1000,
        }))
      } catch { /* The active page can still track this order. */ }
      void refreshOrderStatus(data.viewToken)
    } catch (exception) {
      setOrderError(exception.message || 'No se pudo abrir la mesa.')
    } finally {
      setOpening(false)
    }
  }

  async function submitGuestRequest() {
    if (!tableQrOrdersAllowed || menu?.customerOrderingEnabled === false) { setOrderError('Los pedidos QR están desactivados para esta sucursal o mesa.');return }
    if (!canOpenTable) { setOrderError('Debes iniciar sesión para realizar pedidos.');return }
    if (!table || !tableToken || !tableOpened || !cartItems.length || !viewToken || sending) return
    if (!attentionToken) { setOrderError('Tu autorización QR expiró. Vuelve a introducir el código general de 6 dígitos.');return }
    setSending(true)
    setOrderNotice('')
    setOrderError('')
    const { data, error: submitError } = await supabase.rpc('submit_qr_guest_order_with_attention', {
      p_location_id: locationId, p_qr_token: tableToken, p_attention_token: attentionToken,
      p_view_token: viewToken,
      p_items: cartItems.map(item => ({
        productId: item.id,
        quantity: item.quantity,
        declaredAllergies: allergySelection,
      })),
    })
    if (submitError || !data?.ok) {
      setOrderError(submitError?.message || data?.message || 'No fue posible enviar la solicitud.')
      if (/cerrada|no admite|sesión/i.test(submitError?.message || '')) {
        setTableOpened(false)
        void refreshOrderStatus(viewToken)
      }
    } else {
      setCart({})
      setOrderNotice('Solicitud enviada. Puedes revisar su progreso en «Estado de tu pedido».')
      void refreshOrderStatus(viewToken)
    }
    setSending(false)
  }

  if (loading) return <main className="qr-menu qr-state">Cargando menú…</main>
  if (error && !orderSnapshot) return <main className="qr-menu qr-state"><div><h1>RestOS+</h1><p>{error}</p></div></main>

  return <main className="qr-menu">
    <header className="qr-hero">
      {(menu?.restaurant?.logoUrl || table?.restaurantLogoUrl) && <img className="qr-logo" src={menu?.restaurant?.logoUrl || table?.restaurantLogoUrl} alt="" />}
      <p className="qr-eyebrow">BIENVENIDO A</p>
      <h1>{menu?.restaurant?.name || table?.restaurantName || 'RestOS+'}</h1>
      <p>{menu?.location?.name || table?.locationName || ''} · {attentionEnabled && !showMenuAfterAttention ? 'Atención al cliente' : 'Menú digital'}</p>
      {table && <p className="qr-table-title">🍽️ {table.zoneName} · {table.tableName}</p>}
    </header>
    <div className="qr-content">
      {tableError && <div role="alert" className="qr-table-warning">{tableError}</div>}
      {table && tableToken && attentionEnabled && (
        <QrAttentionClient locationId={locationId} qrToken={tableToken} table={table}
          orderSnapshot={orderSnapshot}
          canOrderProducts={Boolean(menu) && menu.customerOrderingEnabled !== false && tableQrOrdersAllowed}
          onAuthorized={onAttentionAuthorized}
          onRequestOrder={token => { setAttentionToken(token); void openMyTable(token) }}
          onShowMenu={() => setShowMenuAfterAttention(true)} />
      )}
      {(!attentionEnabled || showMenuAfterAttention) && <>
      {table && <div className="qr-table-info">Mesa: <b>{table.tableName}</b>. {tableOpened ? 'Tu cuenta está abierta.' : orderSnapshot?.orderClosed ? 'La cuenta de esta visita está cerrada.' : 'Introduce el PIN de la mesa para abrir tu cuenta.'}</div>}
      {viewToken && orderSnapshot?.authorized && (
        <section className="qr-order-tracking" id="estado-pedido" aria-live="polite">
          <div className="qr-order-tracking-head">
            <div><span className="qr-section-eyebrow">SEGUIMIENTO</span><h2>Estado de tu pedido</h2></div>
            <button type="button" className="qr-refresh" onClick={() => refreshOrderStatus(viewToken)}>↻ Actualizar</button>
          </div>
          {orderSnapshot.orderClosed && <div className="qr-tracking-closed">Esta visita finalizó. Puedes consultar lo que pediste durante un máximo de 48 horas, pero ya no enviar nuevos pedidos.</div>}
          {orderSnapshot.orderClosed && <button type="button" className="qr-new-visit" onClick={() => {
            try { if (visitKey) window.localStorage.removeItem(visitKey) } catch {}
            setOrderSnapshot(null)
            setViewToken('')
            setTableOpened(false)
            setOrderError('')
          }}>Iniciar una nueva visita en esta mesa</button>}
          {!orderSnapshot.requests?.length && <p className="qr-tracking-empty">Todavía no has enviado solicitudes.</p>}
          {(orderSnapshot.requests || []).map(request => (
            <article className="qr-tracking-request" key={request.id}>
              <div className="qr-tracking-request-head">
                <b>{requestStatusLabel(request.status)}</b>
                <small>{new Date(request.createdAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</small>
              </div>
              {(request.items || []).map((item, index) => (
                <div className="qr-tracking-item" key={`${request.id}-${index}`}>
                  <span>{item.quantity} × {item.name}</span>
                  <small className={item.status === 'served' ? 'is-served' : ''}>{requestStatusLabel(item.status)}</small>
                </div>
              ))}
              <div className="qr-tracking-total"><span>Total de esta solicitud</span><b>{price(request.total)}</b></div>
            </article>
          ))}
          <small className="qr-tracking-privacy">Solo muestra las solicitudes asociadas a esta visita. No incluye pedidos de otros clientes de la mesa.</small>
        </section>
      )}
      {menu && <div id="qr-digital-menu">
        <div className="qr-heading"><div><small>DESCUBRE NUESTROS SABORES</small><h2>Nuestra carta</h2></div><button type="button" className="qr-refresh" onClick={loadCatalog}>↻ Actualizar existencias</button></div>
        <label className="qr-search"><span aria-hidden="true">⌕</span><input placeholder="Buscar platos o bebidas" aria-label="Buscar productos" value={search} onChange={e => setSearch(e.target.value)} /></label>
        <section className="qr-allergy-filter">
          <button type="button" className="qr-allergy-toggle" aria-expanded={allergyExpanded} onClick={() => setAllergyExpanded(v => !v)}>
            <span>⚠ Alérgenos {allergySelection.length ? `· ${allergySelection.length} seleccionados` : '· Filtrar menú'}</span>
            <span aria-hidden="true">{allergyExpanded ? '▴' : '▾'}</span>
          </button>
          {allergyExpanded && <div className="qr-allergy-options">
            <p>Selecciona los alérgenos que debes evitar. Se ocultarán los productos que los tengan registrados como «contiene» o «puede contener».</p>
            <div className="qr-allergy-grid">
              {(menu.allergenCatalog || []).map(allergen => {
                const selected = allergySelection.find(a => a.allergenId === allergen.id)
                return <div className={`qr-allergy-choice ${selected ? 'selected' : ''}`} key={allergen.id}>
                  <label>
                    <input type="checkbox" checked={Boolean(selected)} onChange={() => toggleAllergen(allergen.id)} />
                    <span>{allergen.icon || '⚠'}</span><b>{allergen.nameEs}</b>
                  </label>
                  {selected && Boolean(allergen.subtypes?.length) && <div className="qr-allergy-subtypes">
                    <small>Especifica el subtipo (opcional)</small>
                    {allergen.subtypes.map(subtype => <label key={subtype.id}>
                      <input type="checkbox" checked={(selected.subtypeIds || []).includes(subtype.id)} onChange={() => toggleSubtype(allergen.id, subtype.id)} />
                      {subtype.nameEs}
                    </label>)}
                  </div>}
                </div>
              })}
            </div>
            {allergySelection.length > 0 && <button className="qr-allergy-clear" onClick={() => setDeclaredAllergies([])} type="button">Quitar filtros</button>}
            <p className="qr-allergy-safety"><b>Importante:</b> el filtro depende de los datos registrados por el restaurante. No garantiza la ausencia de contaminación cruzada ni la seguridad para personas alérgicas. Consulta siempre al personal.</p>
          </div>}
        </section>
        <div className="qr-categories" aria-label="Categorías">
          <button className={category === 'all' ? 'selected' : ''} onClick={() => setCategory('all')}>Todos</button>
          {(menu.categories || []).map(item => <button key={item.id} className={category === item.id ? 'selected' : ''} onClick={() => setCategory(item.id)}>{item.name}</button>)}
        </div>
        <div className="qr-results">{products.length} {products.length === 1 ? 'producto disponible' : 'productos disponibles'}</div>
        <div className="qr-products">
          {products.map(product => <article className="qr-product" key={product.id}>
            {product.imageUrl ? <img src={product.imageUrl} alt={product.name} loading="lazy" /> : <div className="qr-no-photo" aria-hidden="true">✦</div>}
            <div className="qr-product-info">
              <h3>{product.name}</h3>
              {product.description && <p>{product.description}</p>}
              <div className="qr-product-allergens">
                {product.allergens?.length
                  ? product.allergens.map(a => <span key={a.allergenId} className={a.level === 'may_contain' ? 'may-contain' : ''} title={a.level === 'may_contain' ? 'Puede contener' : 'Contiene'}>
                    {a.icon || '⚠'} {a.nameEs}{a.level === 'may_contain' ? ' (posible)' : ''}
                  </span>)
                  : <small>Alérgenos no declarados en la ficha</small>}
              </div>
              <strong>{price(product.price)}</strong>
              {table && tableOpened && tableQrOrdersAllowed && <div className="qr-cart-controls">
                <button type="button" aria-label={'Quitar ' + product.name} onClick={() => adjust(product.id, -1)}>−</button>
                <span>{cart[product.id] || 0}</span>
                <button type="button" aria-label={'Agregar ' + product.name} onClick={() => adjust(product.id, 1)}>+</button>
              </div>}
            </div>
          </article>)}
        </div>
        {!products.length && <div className="qr-empty">No encontramos productos disponibles con estos filtros.</div>}
      </div>}
      {table && (!tableQrOrdersAllowed || menu?.customerOrderingEnabled === false) && <p className="qr-table-warning">🔒 Los pedidos de productos por QR están desactivados para esta sucursal o mesa. Puedes consultar la carta y solicitar atención al personal.</p>}
      {table && menu && tableQrOrdersAllowed && menu.customerOrderingEnabled !== false && attentionEnabled && <section className="qr-guest-checkout">
        <h2>{tableOpened ? 'Tu selección' : 'Acceso a tu mesa'}</h2>
        {tableOpened && <>
          {!cartItems.length && <p>Agrega productos del menú para preparar tu solicitud.</p>}
          {cartItems.map(item => <div className="qr-guest-line" key={item.id}><span>{item.quantity} × {item.name}</span><b>{price(item.price * item.quantity)}</b></div>)}
          <div className="qr-guest-total"><strong>Total estimado</strong><strong>{price(cartTotal)}</strong></div>
          {allergySelection.length > 0 && <p className="qr-guest-allergy-notice">⚠ Se comunicarán al personal las alergias seleccionadas. Comprueba los ingredientes antes de consumir.</p>}
        </>}
        {!orderSnapshot?.orderClosed && <>
          {authMode !== 'disabled' && (
            <div className="qr-customer-auth">
              <div className="qr-customer-auth-heading">
                <b>{customerUser ? 'Identidad del cliente verificada' : mustSignIn ? 'Identifícate para hacer pedidos' : 'Identificación opcional'}</b>
                <small>{mustSignIn ? 'Inicia sesión para realizar pedidos. Ya tienes acceso a la mesa con el código general de 6 dígitos.' : 'Puedes identificarte opcionalmente. Para pedir se usa la autorización general de 6 dígitos.'}</small>
              </div>
              {customerUser ? (
                <div className="qr-customer-profile">
                  <span>✓ {customerUser.email || 'Cuenta conectada'}</span>
                  <button type="button" onClick={async () => {
                    await supabase.auth.signOut()
                    setCustomerUser(null);setTableOpened(false);setViewToken('');setOrderSnapshot(null)
                    try {if (visitKey) window.localStorage.removeItem(visitKey)} catch {}
                  }}>Salir</button>
                </div>
              ) : (
                <div className="qr-customer-provider-actions">
                  <button type="button" className="qr-customer-provider" disabled={authBusy || authLoading || providerAvailability?.google === false} onClick={() => signInCustomer('google')}>Continuar con Google</button>
                  <button type="button" className="qr-customer-provider" disabled={authBusy || authLoading || providerAvailability?.apple === false} onClick={() => signInCustomer('apple')}>Continuar con Apple</button>
                </div>
              )}
              {providerAvailability && !providerAvailability.google && !providerAvailability.apple && (
                <p role="status" className="qr-table-warning">Google y Apple todavía no están habilitados. El menú sigue disponible, pero para realizar pedidos con autenticación obligatoria el administrador debe configurar uno de estos accesos.</p>
              )}
              {authError && <p role="alert" className="qr-table-warning">{authError}</p>}
            </div>
          )}
          {!tableOpened
            ? <button className="qr-submit" type="button" onClick={() => openMyTable()} disabled={opening || !canOpenTable || !attentionToken}>
                {opening ? 'Abriendo…' : 'Habilitar pedidos en mi mesa'}
              </button>
            : <button className="qr-submit" type="button" onClick={submitGuestRequest}
                disabled={!cartItems.length || sending || !canOpenTable || !viewToken || !attentionToken}>
                {sending ? 'Enviando…' : 'Solicitar productos'}
              </button>}
        </>}
        {!attentionToken && <p className="qr-tracking-privacy">Para realizar pedidos, introduce el código general de seis dígitos que aparece en la pantalla del restaurante.</p>}
        {orderNotice && <p role="status" className="qr-guest-success">{orderNotice}</p>}
        {orderError && <p role="alert" className="qr-table-warning">{orderError}</p>}
        <small>El personal confirma cada solicitud antes de enviarla a cocina. La disponibilidad puede variar hasta ese momento.</small>
      </section>}
      </>}
      <footer className="qr-footer">Menú digital de {menu?.restaurant?.name || 'RestOS+'} · Powered by RestOS+</footer>
    </div>
  </main>
}
