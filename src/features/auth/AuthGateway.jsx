import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import { friendlyAuthError } from '../../lib/authErrors.js'
import {
  requestPasswordRecovery,
  resendSignupOtp,
  signInWithGoogle,
  signOut,
  signUpWithPassword,
  submitCompanyAccessRequest,
  submitCompanyRegistration,
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
  const [registrationMode, setRegistrationMode] = useState('company')
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

  if (auth.mode === 'onboarding') {
    const onboardingStatus = auth.userContext?.onboarding?.status || 'onboarding_required'

    return (
      <AuthFrame>
        <div className="auth-view active auth-onboarding-view">
          <h1>Completa tu acceso</h1>
          <p className="sub">
            {onboardingStatus === 'company_rejected'
              ? 'Corrige los datos y vuelve a enviar la solicitud de empresa.'
              : onboardingStatus === 'employee_rejected'
                ? 'Puedes solicitar acceso nuevamente con el código correcto de tu empresa.'
                : 'Elige cómo vas a usar RestOS+.'}
          </p>

          <div className="auth-account-type">
            <button
              type="button"
              className={registrationMode === 'company' ? 'active' : ''}
              onClick={() => setRegistrationMode('company')}
            >
              <b>🏢 Crear una empresa</b>
              <small>Seré el Owner de una empresa nueva.</small>
            </button>
            <button
              type="button"
              className={registrationMode === 'join' ? 'active' : ''}
              onClick={() => setRegistrationMode('join')}
            >
              <b>🔑 Unirme a una empresa</b>
              <small>Ya tengo el código entregado por mi empresa.</small>
            </button>
          </div>

          {registrationMode === 'company' ? (
            <form onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              const companyName = String(form.get('companyName') || '').trim()
              const country = String(form.get('country') || '').trim()
              if (!companyName) return setError('Escribe el nombre comercial de la empresa.')
              if (!country) return setError('Escribe el país de la empresa.')

              perform(async () => {
                const result = await submitCompanyRegistration({
                  companyName,
                  legalName: String(form.get('legalName') || '').trim(),
                  taxId: String(form.get('taxId') || '').trim(),
                  verificationDigit: String(form.get('verificationDigit') || '').trim(),
                  taxRegime: String(form.get('taxRegime') || '').trim(),
                  taxResponsibilities: String(form.get('taxResponsibilities') || '').trim(),
                  address: String(form.get('address') || '').trim(),
                  city: String(form.get('city') || '').trim(),
                  region: String(form.get('region') || '').trim(),
                  country,
                  companyPhone: String(form.get('companyPhone') || '').trim(),
                  companyEmail: String(form.get('companyEmail') || auth.userContext?.email || '').trim().toLowerCase(),
                  currencyCode: String(form.get('currencyCode') || 'COP').trim().toUpperCase(),
                  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                  primaryBranchName: String(form.get('primaryBranchName') || 'Principal').trim(),
                })

                await signOut()
                auth.setPendingState({
                  title: 'Solicitud de empresa enviada',
                  message: `“${result?.company_name || companyName}” quedó pendiente de aprobación por RestOS+. Cuando se apruebe, entrarás como Owner.`,
                  icon: '🏢',
                })
                auth.setMode('pending')
              })
            }}>
              <div className="field"><label>Nombre comercial *</label><input name="companyName" defaultValue={auth.userContext?.onboarding?.company_name || ''} /></div>
              <div className="field"><label>Razón social</label><input name="legalName" /></div>
              <div className="auth-grid-two">
                <div className="field"><label>NIT / Identificación fiscal</label><input name="taxId" /></div>
                <div className="field"><label>Dígito de verificación</label><input name="verificationDigit" /></div>
              </div>
              <div className="auth-grid-two">
                <div className="field"><label>Régimen fiscal</label><input name="taxRegime" /></div>
                <div className="field"><label>Responsabilidades fiscales</label><input name="taxResponsibilities" /></div>
              </div>
              <div className="field"><label>Dirección</label><input name="address" /></div>
              <div className="auth-grid-two">
                <div className="field"><label>Ciudad</label><input name="city" /></div>
                <div className="field"><label>Departamento / Estado</label><input name="region" /></div>
              </div>
              <div className="auth-grid-two">
                <div className="field"><label>País *</label><input name="country" /></div>
                <div className="field">
                  <label>Moneda</label>
                  <select name="currencyCode" defaultValue="COP">
                    <option value="COP">COP — Peso colombiano</option>
                    <option value="EUR">EUR — Euro</option>
                    <option value="USD">USD — Dólar estadounidense</option>
                    <option value="GBP">GBP — Libra esterlina</option>
                  </select>
                </div>
              </div>
              <div className="auth-grid-two">
                <div className="field"><label>Teléfono empresa</label><input name="companyPhone" type="tel" /></div>
                <div className="field"><label>Correo empresa</label><input name="companyEmail" type="email" defaultValue={auth.userContext?.email || ''} /></div>
              </div>
              <div className="field"><label>Nombre de la primera sucursal</label><input name="primaryBranchName" defaultValue="Principal" /></div>
              <div className="auth-error">{error}</div>
              <button className="auth-btn" disabled={busy}>{busy ? 'Enviando solicitud…' : 'Solicitar creación de empresa'}</button>
            </form>
          ) : (
            <form onSubmit={(event) => {
              event.preventDefault()
              const joinCode = String(new FormData(event.currentTarget).get('joinCode') || '').trim().toUpperCase()
              if (!joinCode) return setError('Escribe el código de empresa.')

              perform(async () => {
                const result = await submitCompanyAccessRequest(joinCode)
                await signOut()
                auth.setPendingState({
                  title: 'Solicitud de acceso enviada',
                  message: `La solicitud fue enviada a “${result?.company_name || 'la empresa'}”. Su Owner debe asignarte rol y sucursal.`,
                  icon: '⏳',
                })
                auth.setMode('pending')
              })
            }}>
              <div className="notice">
                Solicita al Owner de tu empresa el <b>código de empresa</b>. El código no concede acceso por sí solo: únicamente envía tu solicitud.
              </div>
              <div className="field">
                <label>Código de empresa *</label>
                <input name="joinCode" autoCapitalize="characters" placeholder="Ej. A1B2C3D4" />
              </div>
              <div className="auth-error">{error}</div>
              <button className="auth-btn" disabled={busy}>{busy ? 'Enviando solicitud…' : 'Solicitar acceso'}</button>
            </form>
          )}

          <button className="auth-btn secondary" disabled={busy} onClick={auth.logout}>Cerrar sesión</button>
        </div>
      </AuthFrame>
    )
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
        <p className="sub">Primero crea tu usuario. Después de verificar el correo, RestOS+ enviará la solicitud a la empresa correspondiente.</p>

        <div className="auth-account-type">
          <button
            type="button"
            className={registrationMode === 'company' ? 'active' : ''}
            onClick={() => setRegistrationMode('company')}
          >
            <b>🏢 Crear una empresa</b>
            <small>Registraré una empresa nueva y seré su Owner.</small>
          </button>
          <button
            type="button"
            className={registrationMode === 'join' ? 'active' : ''}
            onClick={() => setRegistrationMode('join')}
          >
            <b>🔑 Unirme a una empresa</b>
            <small>Ya tengo un código de empresa.</small>
          </button>
        </div>

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
            onboardingMode: registrationMode,
            companyName: String(form.get('companyName') || '').trim(),
            legalName: String(form.get('legalName') || '').trim(),
            taxId: String(form.get('taxId') || '').trim(),
            verificationDigit: String(form.get('verificationDigit') || '').trim(),
            taxRegime: String(form.get('taxRegime') || '').trim(),
            taxResponsibilities: String(form.get('taxResponsibilities') || '').trim(),
            address: String(form.get('address') || '').trim(),
            city: String(form.get('city') || '').trim(),
            region: String(form.get('region') || '').trim(),
            country: String(form.get('country') || '').trim(),
            companyPhone: String(form.get('companyPhone') || '').trim(),
            companyEmail: String(form.get('companyEmail') || '').trim().toLowerCase(),
            currencyCode: String(form.get('currencyCode') || 'COP').trim().toUpperCase(),
            primaryBranchName: String(form.get('primaryBranchName') || 'Principal').trim(),
            joinCode: String(form.get('joinCode') || '').trim().toUpperCase(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          }

          if (!payload.fullName || !payload.email || !payload.phone || !payload.username || !payload.password || !payload.password2) {
            return setError('Completa todos los datos personales.')
          }
          if (!validEmail(payload.email)) return setError('Introduce un correo válido.')
          if (payload.username.length < 3) return setError('El nombre de usuario debe tener al menos 3 caracteres.')
          if (payload.password.length < 8) return setError('La contraseña debe tener al menos 8 caracteres.')
          if (payload.password !== payload.password2) return setError('Las contraseñas no coinciden.')

          if (registrationMode === 'company') {
            if (!payload.companyName) return setError('Escribe el nombre comercial de la empresa.')
            if (!payload.country) return setError('Escribe el país de la empresa.')
            if (!payload.companyEmail) payload.companyEmail = payload.email
            if (!validEmail(payload.companyEmail)) return setError('Introduce un correo válido para la empresa.')
          } else if (!payload.joinCode) {
            return setError('Escribe el código de la empresa a la que quieres ingresar.')
          }

          perform(async () => {
            const { data, error: signupError } = await signUpWithPassword(payload)
            if (signupError) throw signupError
            const { password, password2, ...safeRegistration } = payload
            setRegistration(safeRegistration)
            setSignupCode('')
            if (data.session) await signOut()
            setScreen('verifySignup')
          })
        }}>
          <div className="auth-form-section">
            <h3>1. Tus datos</h3>
            <div className="field"><label>Nombre completo *</label><input name="fullName" autoComplete="name" /></div>
            <div className="field"><label>Correo electrónico *</label><input name="email" type="email" autoComplete="email" /></div>
            <div className="auth-grid-two">
              <div className="field"><label>Celular *</label><input name="phone" type="tel" autoComplete="tel" placeholder="+57 ..." /></div>
              <div className="field"><label>Nombre de usuario *</label><input name="username" autoComplete="username" /></div>
            </div>
            <div className="auth-grid-two">
              <div className="field"><label>Contraseña *</label><input name="password" type="password" autoComplete="new-password" /></div>
              <div className="field"><label>Confirmar *</label><input name="password2" type="password" autoComplete="new-password" /></div>
            </div>
          </div>

          {registrationMode === 'company' ? (
            <div className="auth-form-section">
              <h3>2. Datos de la empresa</h3>
              <div className="field"><label>Nombre comercial *</label><input name="companyName" placeholder="Ej. Restaurante La Esquina" /></div>
              <div className="field"><label>Razón social</label><input name="legalName" /></div>
              <div className="auth-grid-two">
                <div className="field"><label>NIT / Identificación fiscal</label><input name="taxId" /></div>
                <div className="field"><label>Dígito de verificación</label><input name="verificationDigit" /></div>
              </div>
              <div className="auth-grid-two">
                <div className="field"><label>Régimen fiscal</label><input name="taxRegime" /></div>
                <div className="field"><label>Responsabilidades fiscales</label><input name="taxResponsibilities" /></div>
              </div>
              <div className="field"><label>Dirección</label><input name="address" /></div>
              <div className="auth-grid-two">
                <div className="field"><label>Ciudad</label><input name="city" /></div>
                <div className="field"><label>Departamento / Estado</label><input name="region" /></div>
              </div>
              <div className="auth-grid-two">
                <div className="field"><label>País *</label><input name="country" /></div>
                <div className="field">
                  <label>Moneda</label>
                  <select name="currencyCode" defaultValue="COP">
                    <option value="COP">COP — Peso colombiano</option>
                    <option value="EUR">EUR — Euro</option>
                    <option value="USD">USD — Dólar estadounidense</option>
                    <option value="GBP">GBP — Libra esterlina</option>
                  </select>
                </div>
              </div>
              <div className="auth-grid-two">
                <div className="field"><label>Teléfono empresa</label><input name="companyPhone" type="tel" /></div>
                <div className="field"><label>Correo empresa</label><input name="companyEmail" type="email" placeholder="Puede ser el mismo correo personal" /></div>
              </div>
              <div className="field"><label>Primera sucursal</label><input name="primaryBranchName" defaultValue="Principal" /></div>
            </div>
          ) : (
            <div className="auth-form-section">
              <h3>2. Empresa</h3>
              <div className="notice">
                Pide al Owner el código de empresa. Después de verificar tu correo, tu solicitud aparecerá en <b>Personal → Solicitudes pendientes</b>.
              </div>
              <div className="field"><label>Código de empresa *</label><input name="joinCode" autoCapitalize="characters" placeholder="Ej. A1B2C3D4" /></div>
            </div>
          )}

          <div className="auth-error">{error}</div>
          <button className="auth-btn" disabled={busy || !auth.isSupabaseConfigured}>{busy ? 'Creando cuenta…' : 'Crear cuenta y verificar correo'}</button>
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

            if (registration?.onboardingMode === 'company') {
              const result = await submitCompanyRegistration({
                companyName: registration.companyName,
                legalName: registration.legalName,
                taxId: registration.taxId,
                verificationDigit: registration.verificationDigit,
                taxRegime: registration.taxRegime,
                taxResponsibilities: registration.taxResponsibilities,
                address: registration.address,
                city: registration.city,
                region: registration.region,
                country: registration.country,
                companyPhone: registration.companyPhone,
                companyEmail: registration.companyEmail || registration.email,
                currencyCode: registration.currencyCode,
                timezone: registration.timezone,
                primaryBranchName: registration.primaryBranchName,
              })

              await signOut()
              auth.setPendingState({
                title: 'Solicitud de empresa enviada',
                message: `“${result?.company_name || registration.companyName}” quedó pendiente de aprobación por RestOS+. Al aprobarla se crearán automáticamente la empresa, la sucursal principal y tu acceso de Owner.`,
                icon: '🏢',
              })
            } else {
              const result = await submitCompanyAccessRequest(registration.joinCode)
              await signOut()
              auth.setPendingState({
                title: 'Solicitud de acceso enviada',
                message: `Tu solicitud fue enviada a “${result?.company_name || 'la empresa'}”. Su Owner debe asignarte un rol y una sucursal.`,
                icon: '⏳',
              })
            }

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
