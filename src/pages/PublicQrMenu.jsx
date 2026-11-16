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
      {table && <div className="qr-table-info">Estás consultando el menú para <b>{table.tableName}</b>. Los pedidos desde QR todavía no están habilitados.</div>}
      <div className="qr-heading"><div><small>DESCUBRE NUESTROS SABORES</small><h2>Nuestra carta</h2></div><span>RestOS+</span></div>
      <label className="qr-search"><span aria-hidden="true">⌕</span><input placeholder="Buscar platos o bebidas" aria-label="Buscar productos" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className="qr-categories" aria-label="Categorías">
        <button className={category === 'all' ? 'selected' : ''} onClick={() => setCategory('all')}>Todos</button>
        {menu.categories.map(item => <button key={item.id} className={category === item.id ? 'selected' : ''} onClick={() => setCategory(item.id)}>{item.name}</button>)}
      </div>
      <div className="qr-results">{products.length} {products.length === 1 ? 'producto' : 'productos'}</div>
      <div className="qr-products">
        {products.map(product => <article className="qr-product" key={product.id}>
          {product.imageUrl ? <img src={product.imageUrl} alt={product.name} loading="lazy" /> : <div className="qr-no-photo" aria-hidden="true">✦</div>}
          <div className="qr-product-info"><h3>{product.name}</h3>{product.description && <p>{product.description}</p>}<strong>{price(product.price)}</strong></div>
        </article>)}
      </div>
      {!products.length && <div className="qr-empty">No encontramos productos en esta categoría.</div>}
      <footer className="qr-footer">Menú digital de {menu.restaurant.name} · Powered by RestOS+</footer>
    </div>
  </main>
}
