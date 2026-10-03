import React, { useEffect } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import PlatformCompaniesPage from './PlatformCompaniesPage.jsx'

export default function DeveloperPortal() {
  const auth = useAuth()

  useEffect(() => {
    document.title = 'RestOS+ Admin · Plataforma'
    if (window.location.pathname !== '/') {
      window.history.replaceState({ portal: 'admin' }, '', '/')
    }
  }, [])

  async function logout() {
    await auth.logout()
    window.history.replaceState({ portal: 'admin' }, '', '/')
  }

  if (!auth.userContext?.platformAdmin) {
    return (
      <div className="developer-portal developer-access-denied">
        <section className="developer-access-card">
          <span className="developer-console-kicker">RESTOS+ · ADMIN PORTAL</span>
          <h1>Acceso restringido</h1>
          <p>Esta dirección pertenece exclusivamente a la administración de la plataforma RestOS+.</p>
          <div className="developer-access-actions">
            <button className="btn" onClick={() => window.location.replace('https://restosplus.com/')}>Abrir RestOS+ clientes</button>
            <button className="btn primary" onClick={logout}>Cerrar sesión</button>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="developer-portal">
      <header className="developer-console-header">
        <div className="developer-console-brand">
          <span className="developer-console-kicker">RESTOS+ · PRIVATE PLATFORM</span>
          <strong>Admin Portal</strong>
          <small>Administración global · sin empresa ni sucursal activa</small>
        </div>

        <div className="developer-console-user">
          <div>
            <b>{auth.userContext?.name || 'Desarrollador'}</b>
            <span>{auth.userContext?.email || 'Administrador de plataforma'}</span>
          </div>
          <span className="developer-console-role">PLATFORM ADMIN</span>
          <button className="btn" onClick={logout}>Cerrar sesión</button>
        </div>
      </header>

      <main className="developer-console-main">
        <div className="developer-console-boundary">
          <span>🛡</span>
          <div>
            <b>Contexto aislado de los clientes</b>
            <small>
              Esta consola no carga RestaurantContext, no selecciona empresas como sesión activa
              y no forma parte de la jerarquía Empresa → Sucursal.
            </small>
          </div>
        </div>

        <PlatformCompaniesPage />
      </main>
    </div>
  )
}
