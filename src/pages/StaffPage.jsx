import React from 'react'
import { ROLE_PRESETS } from '../config/roles.js'
import { useAuth } from '../context/AuthContext.jsx'

export default function StaffPage() {
  const auth = useAuth()
  return (
    <section className="view active">
      <div className="hero"><div><h2>Personal y permisos</h2><p>Registro, aprobación, roles y permisos por usuario.</p></div><button className="btn primary" onClick={() => window.alert('La invitación y aprobación real se activará cuando Supabase Auth quede configurado.')}>＋ Usuario</button></div>
      <div className="grid two">
        <div className="card">
          <div className="section-title"><h3>Roles base de RestOS+</h3><span className="badge">7 presets</span></div>
          <div className="list">
            {ROLE_PRESETS.map((role) => <div className="row" key={role.code}><div><b>{role.name}</b><small>{role.description}</small></div><span className="role-icon">{role.icon}</span></div>)}
          </div>
        </div>
        <div className="card">
          <div className="section-title"><h3>Flujo de alta</h3><span className="badge">Seguro</span></div>
          <div className="list">
            <div className="row"><b>1. Registro</b><span>Correo + contraseña / Google</span></div>
            <div className="row"><b>2. Verificación</b><span>Código por correo</span></div>
            <div className="row"><b>3. Estado</b><span className="badge">PENDIENTE</span></div>
            <div className="row"><b>4. Administrador</b><span>Aprueba + asigna restaurante, sucursal y rol</span></div>
            <div className="row"><b>5. Acceso</b><span className="badge">ACTIVO</span></div>
          </div>
          <div className="notice warn">Verificar el correo o entrar con Google identifica a la persona, pero <b>no concede permisos</b>. El acceso depende de una membresía activa y de su rol.</div>
          {!auth.isSupabaseConfigured && <div className="notice">Supabase todavía no está configurado en este entorno. Por eso no se consultan aún las solicitudes pendientes reales.</div>}
        </div>
      </div>
      <div className="card section-gap placeholder compact-placeholder">
        <div><div className="icon">🔐</div><h3>Solicitudes pendientes</h3><p>Cuando Auth quede habilitado, aquí aparecerán usuarios con <code>access_status = pending</code> para aprobarlos y asignarles restaurante, sucursal y rol.</p></div>
      </div>
    </section>
  )
}
