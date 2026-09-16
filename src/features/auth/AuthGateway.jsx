import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import { friendlyAuthError } from '../../lib/authErrors.js'
import {
  requestPasswordRecovery,
  resendSignupOtp,
  signInWithGoogle,
  signOut,
  signUpWithPassword,
  updatePassword,
  verifyRecoveryOtp,
  verifySignupOtp,
} from '../../services/authService.js'

const OTP_SECONDS = 180
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

function useCountdown(activeKey) {
  const [seconds, setSeconds] = useState(OTP_SECONDS)
  useEffect(() => {
    if (!activeKey) return undefined
    setSeconds(OTP_SECONDS)
    const interval = window.setInterval(() => setSeconds((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(interval)
  }, [activeKey])
  const display = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  return { seconds, display, restart: () => setSeconds(OTP_SECONDS) }
}

function OtpBoxes({ value, onChange }) {
  const refs = useRef([])
  const digits = useMemo(() => Array.from({ length: 6 }, (_, index) => value[index] || ''), [value])
  function update(index, raw) {
    const digit = raw.replace(/\D/g, '').slice(-1)
    const next = [...digits]
    next[index] = digit
    onChange(next.join(''))
    if (digit && index < 5) refs.current[index + 1]?.focus()
  }
  return (
    <div className="code-boxes">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(node) => { refs.current[index] = node }}
          value={digit}
          maxLength={1}
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          onChange={(event) => update(index, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Backspace' && !digit && index > 0) refs.current[index - 1]?.focus()
          }}
        />
      ))}
    </div>
  )
}

function AuthFrame({ children }) {
  return (
    <div className="auth-shell">
      <div className="auth-wrap">
        <div className="auth-brand">
          <div className="mark">RestOS+</div>
          <div>
            <h2>Todo el restaurante, en un solo sistema.</h2>
            <p>Mesas, pedidos, cocina, bar, caja, inventario, reservas, clientes y equipo conectados en una sola operación.</p>
          </div>
          <div className="auth-points">
            <span>✓ Cuenta abierta por mesa y comandas por rondas</span>
            <span>✓ Servicio rápido / prepago con turno o pager</span>
            <span>✓ Roles, permisos y aprobación de acceso</span>
            <span>✓ Preparado para Supabase y operación multi-sucursal</span>
          </div>
        </div>
        <div className="auth-panel">{children}</div>
      </div>
    </div>
  )
}

export default function AuthGateway({ children }) {
  const auth = useAuth()
  const [screen, setScreen] = useState('login')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [registration, setRegistration] = useState(null)
  const [recoveryEmail, setRecoveryEmail] = useState('')
  const [signupCode, setSignupCode] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const signupTimer = useCountdown(screen === 'verifySignup' ? registration?.email : null)
  const recoveryTimer = useCountdown(screen === 'verifyRecovery' ? recoveryEmail : null)

  useEffect(() => setError(''), [screen])

  if (auth.isAuthenticated) return children

  if (auth.mode === 'loading') {
    return <div className="app-loader"><div><strong>RestOS+</strong><span>Cargando sesión…</span></div></div>
  }

  if (auth.mode === 'pending') {
    const pending = auth.pendingState || { title: 'Acceso pendiente', message: 'Tu cuenta todavía no está habilitada.', icon: '⏳' }
    return (
      <AuthFrame>
        <div className="auth-view active pending-card">
          <div className="pending-icon">{pending.icon}</div>
          <h1>{pending.title}</h1>
          <p>{pending.message}</p>
          <button className="auth-btn" onClick={() => { auth.setPendingState(null); auth.setMode('signedOut'); setScreen('login') }}>Volver al ingreso</button>
        </div>
      </AuthFrame>
    )
  }

  async function perform(action) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(friendlyAuthError(err))
    } finally {
      setBusy(false)
    }
  }

  const screens = {
    login: (
      <div className="auth-view active">
        <h1>Bienvenido</h1>
        <p className="sub">Ingresa a RestOS+ con tu correo y contraseña.</p>
        {!auth.isSupabaseConfigured && (
          <div className="notice warn"><b>Supabase aún no está configurado en este entorno.</b> La aplicación completa puede probarse con Modo diseño. Cuando se cree el archivo <code>.env</code>, el login real quedará activo.</div>
        )}
        <form onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          const email = String(form.get('email') || '').trim().toLowerCase()
          const password = String(form.get('password') || '')
          if (!validEmail(email)) return setError('Introduce un correo válido.')
          if (!password) return setError('Escribe tu contraseña.')
          perform(() => auth.login(email, password))
        }}>
          <div className="field"><label>Correo electrónico</label><input name="email" type="email" autoComplete="email" placeholder="nombre@correo.com" /></div>
          <div className="field"><label>Contraseña</label><input name="password" type="password" autoComplete="current-password" placeholder="••••••••" /></div>
          <div className="auth-error">{error}</div>
          <button className="auth-btn" disabled={busy}>{busy ? 'Ingresando…' : 'Ingresar'}</button>
        </form>
        <div className="auth-links">
          <button className="linkbtn" onClick={() => setScreen('forgot')}>¿Olvidaste tu contraseña?</button>
          <button className="linkbtn" onClick={() => setScreen('register')}>Crear cuenta</button>
        </div>
        <div className="divider">o</div>
        <button className="google-btn" disabled={busy || !auth.isSupabaseConfigured} onClick={() => perform(async () => {
          const { error: googleError } = await signInWithGoogle()
          if (googleError) throw googleError
        })}><span className="google-g">G</span> Continuar con Google</button>
        <div className="devbox"><b>Desarrollo:</b> mientras Supabase Auth no esté configurado, entra con acceso total para seguir construyendo y probando todas las ventanas.</div>
        <button className="auth-btn secondary" onClick={auth.enterDesignMode}>Entrar en modo diseño</button>
      </div>
    ),
    register: (
      <div className="auth-view active">
        <h1>Crear cuenta</h1>
        <p className="sub">El registro identifica a la persona, pero no concede acceso hasta que un administrador la apruebe y asigne un rol.</p>
        <form onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          const payload = {
            fullName: String(form.get('fullName') || '').trim(),
            email: String(form.get('email') || '').trim().toLowerCase(),
            phone: String(form.get('phone') || '').trim(),
            username: String(form.get('username') || '').trim(),
            password: String(form.get('password') || ''),
            password2: String(form.get('password2') || ''),
          }
          if (Object.values(payload).some((value) => !value)) return setError('Completa todos los campos.')
          if (!validEmail(payload.email)) return setError('Introduce un correo válido.')
          if (payload.username.length < 3) return setError('El nombre de usuario debe tener al menos 3 caracteres.')
          if (payload.password.length < 8) return setError('La contraseña debe tener al menos 8 caracteres.')
          if (payload.password !== payload.password2) return setError('Las contraseñas no coinciden.')
          perform(async () => {
            const { data, error: signupError } = await signUpWithPassword(payload)
            if (signupError) throw signupError
            setRegistration({ email: payload.email })
            setSignupCode('')
            if (data.session) await signOut()
            setScreen('verifySignup')
          })
        }}>
          <div className="field"><label>Nombre completo</label><input name="fullName" autoComplete="name" /></div>
          <div className="field"><label>Correo electrónico</label><input name="email" type="email" autoComplete="email" /></div>
          <div className="field"><label>Celular</label><input name="phone" type="tel" autoComplete="tel" placeholder="+356 ..." /></div>
          <div className="field"><label>Nombre de usuario</label><input name="username" autoComplete="username" /></div>
          <div className="auth-grid-two">
            <div className="field"><label>Contraseña</label><input name="password" type="password" autoComplete="new-password" /></div>
            <div className="field"><label>Confirmar</label><input name="password2" type="password" autoComplete="new-password" /></div>
          </div>
          <div className="auth-error">{error}</div>
          <button className="auth-btn" disabled={busy || !auth.isSupabaseConfigured}>{busy ? 'Creando cuenta…' : 'Crear cuenta y enviar código'}</button>
        </form>
        <button className="auth-btn secondary" onClick={() => setScreen('login')}>Volver al ingreso</button>
      </div>
    ),
    verifySignup: (
      <div className="auth-view active">
        <h1>Verifica tu correo</h1>
        <p className="sub">Enviamos un código de 6 dígitos a <b>{registration?.email}</b>.</p>
        <OtpBoxes value={signupCode} onChange={setSignupCode} />
        <div className="timer">{signupTimer.display}</div>
        <div className="auth-error">{error}</div>
        <button className="auth-btn" disabled={busy} onClick={() => {
          if (signupTimer.seconds <= 0) return setError('El código venció. Solicita uno nuevo.')
          if (signupCode.length !== 6) return setError('Escribe los 6 dígitos.')
          perform(async () => {
            const { error: verifyError } = await verifySignupOtp(registration.email, signupCode)
            if (verifyError) throw verifyError
            await signOut()
            auth.setPendingState({
              title: 'Correo verificado',
              message: 'Tu identidad por correo quedó verificada. La cuenta permanece pendiente hasta que un administrador la apruebe y asigne un rol.',
              icon: '✓',
            })
            auth.setMode('pending')
          })
        }}>{busy ? 'Verificando…' : 'Verificar correo'}</button>
        <button className="auth-btn secondary" onClick={() => perform(async () => {
          const { error: resendError } = await resendSignupOtp(registration.email)
          if (resendError) throw resendError
          setSignupCode('')
          signupTimer.restart()
        })}>Reenviar código</button>
        <div className="devbox">La plantilla <b>Confirm signup</b> de Supabase debe incluir <code>{'{{ .Token }}'}</code> para mostrar el PIN.</div>
      </div>
    ),
    forgot: (
      <div className="auth-view active">
        <h1>Recuperar contraseña</h1>
        <p className="sub">Introduce el correo asociado a tu cuenta. Enviaremos un código de recuperación.</p>
        <form onSubmit={(event) => {
          event.preventDefault()
          const email = String(new FormData(event.currentTarget).get('email') || '').trim().toLowerCase()
          if (!validEmail(email)) return setError('Introduce un correo válido.')
          perform(async () => {
            const { error: recoveryError } = await requestPasswordRecovery(email)
            if (recoveryError) throw recoveryError
            setRecoveryEmail(email)
            setRecoveryCode('')
            setScreen('verifyRecovery')
          })
        }}>
          <div className="field"><label>Correo electrónico</label><input name="email" type="email" autoComplete="email" /></div>
          <div className="auth-error">{error}</div>
          <button className="auth-btn" disabled={busy || !auth.isSupabaseConfigured}>{busy ? 'Enviando…' : 'Enviar código'}</button>
        </form>
        <button className="auth-btn secondary" onClick={() => setScreen('login')}>Volver</button>
      </div>
    ),
    verifyRecovery: (
      <div className="auth-view active">
        <h1>Comprueba tu correo</h1>
        <p className="sub">Escribe el código de 6 dígitos enviado a <b>{recoveryEmail}</b>.</p>
        <OtpBoxes value={recoveryCode} onChange={setRecoveryCode} />
        <div className="timer">{recoveryTimer.display}</div>
        <div className="auth-error">{error}</div>
        <button className="auth-btn" disabled={busy} onClick={() => {
          if (recoveryTimer.seconds <= 0) return setError('El código venció. Solicita uno nuevo.')
          if (recoveryCode.length !== 6) return setError('Escribe los 6 dígitos.')
          perform(async () => {
            const { error: verifyError } = await verifyRecoveryOtp(recoveryEmail, recoveryCode)
            if (verifyError) throw verifyError
            setScreen('newPassword')
          })
        }}>{busy ? 'Verificando…' : 'Continuar'}</button>
        <button className="auth-btn secondary" onClick={() => perform(async () => {
          const { error: resendError } = await requestPasswordRecovery(recoveryEmail)
          if (resendError) throw resendError
          setRecoveryCode('')
          recoveryTimer.restart()
        })}>Reenviar código</button>
      </div>
    ),
    newPassword: (
      <div className="auth-view active">
        <h1>Nueva contraseña</h1>
        <p className="sub">Crea una nueva contraseña para tu cuenta.</p>
        <form onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          const password = String(form.get('password') || '')
          const confirmation = String(form.get('confirmation') || '')
          if (password.length < 8) return setError('La contraseña debe tener al menos 8 caracteres.')
          if (password !== confirmation) return setError('Las contraseñas no coinciden.')
          perform(async () => {
            const { error: passwordError } = await updatePassword(password)
            if (passwordError) throw passwordError
            await signOut()
            auth.setPendingState({ title: 'Contraseña actualizada', message: 'Tu contraseña se actualizó correctamente. Ya puedes volver al ingreso.', icon: '✓' })
            auth.setMode('pending')
          })
        }}>
          <div className="field"><label>Nueva contraseña</label><input name="password" type="password" autoComplete="new-password" /></div>
          <div className="field"><label>Confirmar contraseña</label><input name="confirmation" type="password" autoComplete="new-password" /></div>
          <div className="auth-error">{error}</div>
          <button className="auth-btn" disabled={busy}>{busy ? 'Actualizando…' : 'Actualizar contraseña'}</button>
        </form>
      </div>
    ),
  }

  return <AuthFrame>{screens[screen]}</AuthFrame>
}
