import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import './PublicQrMenu.css'

export default function PublicQrMenu() {
  useEffect(() => {
    document.documentElement.classList.add('qr-public-scroll')
    return () => document.documentElement.classList.remove('qr-public-scroll')
  }, [])
  const locationId = window.location.pathname.match(/^\/menu\/([0-9a-f-]{36})\/?$/i)?.[1]
  const tableToken = new URLSearchParams(window.location.search).get('t')
  const [table, setTable] = useState(null)
  const [tableError, setTableError] = useState('')
  const [cart, setCart] = useState({})
  const [accessCode, setAccessCode] = useState('')
  const [tableOpened, setTableOpened] = useState(false)
  const [opening, setOpening] = useState(false)
  const [sending, setSending] = useState(false)
  const [orderNotice, setOrderNotice] = useState('')
  const [orderError, setOrderError] = useState('')
  const [menu, setMenu] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  useEffect(() => {
    let mounted = true
    async function load() {
      if (!locationId || !supabase) {
        setError('Este menú no está disponible.')
        setLoading(false)
        return
      }
      const [{ data, error: requestError }, tableResult] = await Promise.all([
        supabase.rpc('get_public_qr_menu', { p_location_id: locationId }),
        tableToken && /^[0-9a-f-]{36}$/i.test(tableToken)
          ? supabase.rpc('resolve_public_qr_table', { p_location_id: locationId, p_token: tableToken })
          : Promise.resolve(null),
      ])
      if (!mounted) return
      setMenu(data || null)
      if (tableToken) {
        setTable(tableResult?.data || null)
        setTableError(!tableResult?.data ? 'El código QR de esta mesa ya no es válido. Solicita al personal el código actualizado.' : '')
      }
      setError(requestError ? 'No se pudo cargar el menú.' : !data ? 'Este menú todavía no está publicado.' : '')
      setLoading(false)
    }
    load()
    return () => { mounted = false }
  }, [locationId, tableToken])
  const products = useMemo(() => (menu?.products || []).filter(product =>
    (category === 'all' || product.categoryId === category) &&
    (product.name + ' ' + (product.description || '')).toLocaleLowerCase().includes(search.toLocaleLowerCase())
  ), [menu, search, category])
  const price = value => {
    try { return new Intl.NumberFormat('es-CO', { style: 'currency', currency: menu?.restaurant?.currency || 'COP', maximumFractionDigits: 2 }).format(Number(value || 0)) }
    catch { return String(value) }
  }
  const cartItems = (menu?.products || []).filter(p=>cart[p.id]>0).map(p=>({...p,quantity:cart[p.id]}))
  const cartTotal = cartItems.reduce((sum,p)=>sum+p.price*p.quantity,0)
  function adjust(productId,step) {
    setCart(previous=>({...previous,[productId]:Math.min(20,Math.max(0,(previous[productId]||0)+step))}))
    setOrderNotice('');setOrderError('')
  }
  async function openMyTable() {
    if (!tableToken || !table || !/^[0-9]{4}$/.test(accessCode)) return
    setOpening(true); setOrderError('')
    const {data,error:err}=await supabase.rpc('claim_qr_guest_table',{
      p_location_id:locationId,p_qr_token:tableToken,p_access_code:accessCode,
    })
    if (err || data?.ok!==true) setOrderError(err?.message || data?.message || 'No se pudo abrir la mesa.')
    else { setTableOpened(true); setOrderNotice('Mesa abierta. Ya puedes solicitar productos.') }
    setOpening(false)
  }
  async function refreshCatalog() {
    const {data,error:err}=await supabase.rpc('get_public_qr_menu',{p_location_id:locationId})
    if (!err && data) { setMenu(data); setCart(old=>Object.fromEntries(Object.entries(old).filter(([id])=>data.products.some(p=>p.id===id)))) }
    else setOrderError('No fue posible actualizar las existencias.')
  }
  async function submitGuestRequest() {
    if (!tableToken || !table || !tableOpened || !cartItems.length || !/^[0-9]{4}$/.test(accessCode)) return
    setSending(true);setOrderError('');setOrderNotice('')
    const {data,error:err}=await supabase.rpc('submit_qr_guest_request',{
      p_location_id:locationId,p_qr_token:tableToken,p_access_code:accessCode.trim(),
      p_items:cartItems.map(item=>({productId:item.id,quantity:item.quantity}))
    })
    if(err||data?.ok===false)setOrderError(err?.message||data?.message||'No se pudo enviar la solicitud.')
    else if(data?.ok){setCart({});setOrderNotice('Solicitud recibida. El personal revisará tu pedido antes de registrarlo en cocina.')}
    setSending(false)
  }
  if (loading) return <main className="qr-menu qr-state">Cargando menú…</main>
  if (error) return <main className="qr-menu qr-state"><div><h1>RestOS+</h1><p>{error}</p></div></main>
  return <main className="qr-menu">
    <header className="qr-hero">
      {menu.restaurant.logoUrl && <img className="qr-logo" src={menu.restaurant.logoUrl} alt="" />}
      <p className="qr-eyebrow">BIENVENIDO A</p>
      <h1>{menu.restaurant.name}</h1>
      <p>{menu.location.name} · Menú digital</p>
      {table && <p style={{fontWeight:800,fontSize:17}}>🍽️ {table.zoneName} · {table.tableName}</p>}
    </header>
    <div className="qr-content">
      {tableError && <div role="alert" className="qr-table-warning">{tableError}</div>}
      {table && <div className="qr-table-info">Mesa: <b>{table.tableName}</b>. {tableOpened ? 'Cuenta abierta. Tus solicitudes llegarán a esta mesa.' : 'Introduce el PIN de 4 dígitos que está sobre la mesa para abrir tu cuenta.'}</div>}
      <div className="qr-heading"><div><small>DESCUBRE NUESTROS SABORES</small><h2>Nuestra carta</h2></div><button type="button" className="qr-refresh" onClick={refreshCatalog}>↻ Actualizar existencias</button></div>
      <label className="qr-search"><span aria-hidden="true">⌕</span><input placeholder="Buscar platos o bebidas" aria-label="Buscar productos" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="qr-categories" aria-label="Categorías">
        <button className={category === 'all' ? 'selected' : ''} onClick={() => setCategory('all')}>Todos</button>
        {menu.categories.map(item => <button key={item.id} className={category === item.id ? 'selected' : ''} onClick={() => setCategory(item.id)}>{item.name}</button>)}
      </div>
      <div className="qr-results">{products.length} {products.length === 1 ? 'producto' : 'productos'}</div>
      <div className="qr-products">
        {products.map(product => <article className="qr-product" key={product.id}>
          {product.imageUrl ? <img src={product.imageUrl} alt={product.name} loading="lazy" /> : <div className="qr-no-photo" aria-hidden="true">✦</div>}
          <div className="qr-product-info"><h3>{product.name}</h3>{product.description && <p>{product.description}</p>}<strong>{price(product.price)}</strong>{table&&<div className="qr-cart-controls"><button type="button" aria-label={"Quitar "+product.name} onClick={()=>adjust(product.id,-1)}>−</button><span>{cart[product.id]||0}</span><button type="button" aria-label={"Agregar "+product.name} onClick={()=>adjust(product.id,1)}>+</button></div>}</div>
        </article>)}
      </div>
      {!products.length && <div className="qr-empty">No encontramos productos en esta categoría.</div>}
      {table&&<section className="qr-guest-checkout">
        <h2>Tu selección</h2>
        {!cartItems.length&&<p>Agrega productos del menú para preparar tu solicitud.</p>}
        {cartItems.map(item=><div key={item.id} className="qr-guest-line"><span>{item.quantity} × {item.name}</span><b>{price(item.price*item.quantity)}</b></div>)}
        <div className="qr-guest-total"><strong>Total estimado</strong><strong>{price(cartTotal)}</strong></div>
        <label className="qr-guest-code">PIN de 4 números de esta mesa
          <input value={accessCode} maxLength={4} inputMode="numeric" pattern="[0-9]{4}" autoComplete="off" onChange={e=>{setAccessCode(e.target.value.replace(/[^0-9]/g,'').slice(0,4));setTableOpened(false);setOrderError('')}} placeholder="0000" />
        </label>
        {!tableOpened ? <button className="qr-submit" type="button" onClick={openMyTable} disabled={accessCode.length!==4||opening}>{opening?'Abriendo…':'Abrir mi mesa'}</button>
        : <button className="qr-submit" type="button" onClick={submitGuestRequest} disabled={!cartItems.length||sending}>{sending?'Enviando…':'Enviar solicitud de pedido'}</button>}
        {orderNotice&&<p role="status" className="qr-guest-success">{orderNotice}</p>}
        {orderError&&<p role="alert" className="qr-table-warning">{orderError}</p>}
        <small>El personal debe confirmar la solicitud antes de que llegue a cocina. La disponibilidad puede cambiar hasta ese momento.</small>
      </section>}
      <footer className="qr-footer">Menú digital de {menu.restaurant.name} · Powered by RestOS+</footer>
    </div>
  </main>
}
