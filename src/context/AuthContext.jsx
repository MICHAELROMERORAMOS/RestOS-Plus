import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { ALL_PERMISSIONS } from '../config/navigation.js'
import { friendlyAuthError } from '../lib/authErrors.js'
import { isSupabaseConfigured } from '../lib/supabase.js'
import {
  getAuthenticatedUser,
  loadUserAccess,
  signInWithPassword,
  signOut as remoteSignOut,
  subscribeToAuth,
  subscribeToUserAccess,
} from '../services/authService.js'

const AuthContext = createContext(null)
const DESIGN_SESSION_KEY = 'restos-design-session'

const statusCopy = {
  pending: {
    title: 'Cuenta pendiente de aprobación',
    message: 'Tu correo está verificado, pero todavía no tienes acceso. Un administrador debe aprobar tu cuenta y asignarte un rol.',
    icon: '⏳',
  },
  suspended: {
    title: 'Cuenta suspendida',
    message: 'Tu cuenta está suspendida. Contacta al administrador del restaurante.',
    icon: '⛔',
  },
  rejected: {
    title: 'Solicitud no aprobada',
    message: 'La solicitud de acceso no fue aprobada. Contacta al administrador si necesitas revisión.',
    icon: '×',
  },
  missing_membership: {
    title: 'Falta asignar empresa y rol',
    message: 'Tu cuenta está aprobada, pero todavía no tiene una membresía activa con una empresa y un rol.',
    icon: '⏳',
  },
  company_pending: {
    title: 'Empresa pendiente de aprobación',
    message: 'Tu solicitud para crear la empresa fue enviada a RestOS+. Podrás ingresar cuando sea aprobada.',
    icon: '🏢',
  },
  employee_pending: {
    title: 'Acceso solicitado',
    message: 'Tu solicitud fue enviada al Owner de la empresa. Podrás ingresar cuando te asigne un rol y una sucursal.',
    icon: '⏳',
  },
  company_approved: {
    title: 'Empresa aprobada',
    message: 'La empresa fue aprobada. Vuelve a ingresar para cargar tu acceso de Owner.',
    icon: '✓',
  },
  employee_approved: {
    title: 'Acceso aprobado',
    message: 'Tu acceso fue aprobado. Vuelve a ingresar para cargar tu empresa y rol.',
    icon: '✓',
  },
}

export function AuthProvider({ children }) {
  const [mode, setMode] = useState('loading')
  const [userContext, setUserContext] = useState(null)
  const [permissions, setPermissions] = useState(new Set())
  const [pendingState, setPendingState] = useState(null)

  const enterDesignMode = useCallback(() => {
    sessionStorage.setItem(DESIGN_SESSION_KEY, '1')
    setPermissions(new Set(ALL_PERMISSIONS))
    setUserContext({
      name: 'Usuario de desarrollo',
      role: 'Owner / Super Admin',
      restaurant: 'Modo diseño',
      companyScope: true,
      isPrimaryOwner: true,
    })
    setPendingState(null)
    setMode('design')
  }, [])

  const handleUser = useCallback(async (user) => {
    if (!user) {
      setMode('signedOut')
      return { mode: 'signedOut' }
    }
    try {
      const access = await loadUserAccess(user)
      if (!access.active) {
        const onboarding = access.onboarding || {}
        const actionable = ['onboarding_required', 'company_rejected', 'employee_rejected'].includes(access.status)

        if (actionable) {
          setPendingState({
            title: access.status === 'company_rejected'
              ? 'Solicitud de empresa no aprobada'
              : access.status === 'employee_rejected'
                ? 'Solicitud de acceso no aprobada'
                : 'Completa tu registro',
            message: access.status === 'company_rejected'
              ? (onboarding.review_note || 'Puedes corregir los datos y enviar una nueva solicitud de empresa.')
              : access.status === 'employee_rejected'
                ? 'Puedes solicitar acceso nuevamente usando el código de empresa correcto.'
                : 'Indica si vas a crear una empresa nueva o si quieres unirte a una empresa existente.',
            icon: access.status === 'onboarding_required' ? '🏢' : '×',
          })
          setUserContext({
            id: user.id,
            name: access.profile?.full_name || access.profile?.username || user.email,
            email: access.profile?.email || user.email,
            phone: access.profile?.phone || '',
            onboarding,
          })
          setPermissions(new Set())
          setMode('onboarding')
          return { mode: 'onboarding' }
        }

        await remoteSignOut()
        const baseCopy = statusCopy[access.status] || {
          title: 'Acceso no disponible',
          message: 'Tu cuenta no está habilitada para entrar en RestOS+.',
          icon: '!',
        }
        const companyName = onboarding.company_name
        const copy = {
          ...baseCopy,
          message: access.status === 'company_pending' && companyName
            ? `La solicitud para crear “${companyName}” está pendiente de aprobación por RestOS+.`
            : access.status === 'employee_pending' && companyName
              ? `Tu solicitud de acceso a “${companyName}” está pendiente de aprobación por el Owner de esa empresa.`
              : baseCopy.message,
        }
        setPendingState(copy)
        setUserContext(null)
        setPermissions(new Set())
        setMode('pending')
        return { mode: 'pending' }
      }
      setPermissions(new Set(access.permissions))
      setUserContext({
        id: user.id,
        name: access.profile.full_name || access.profile.username || user.email,
        email: access.profile.email || user.email,
        role: access.platformOnly ? 'Desarrollador RestOS+' : (access.role?.name || 'Rol'),
        restaurant: access.platformOnly ? null : (access.restaurant?.name || 'Restaurante'),
        companyScope: access.platformOnly ? false : Boolean(access.role?.company_scope),
        isPrimaryOwner: access.platformOnly ? false : access.restaurant?.owner_user_id === user.id,
        membership: access.membership || null,
        platformAdmin: Boolean(access.platformAdmin),
        platformOnly: Boolean(access.platformOnly),
      })
      sessionStorage.removeItem(DESIGN_SESSION_KEY)
      setPendingState(null)
      setMode('authenticated')
      return { mode: 'authenticated' }
    } catch (error) {
      await remoteSignOut()
      setPendingState({
        title: 'No pudimos cargar tu perfil',
        message: friendlyAuthError(error),
        icon: '!',
      })
      setMode('pending')
      return { mode: 'pending' }
    }
  }, [])

  const login = useCallback(async (email, password) => {
    const { data, error } = await signInWithPassword(email, password)
    if (error) throw error
    return handleUser(data.user)
  }, [handleUser])

  const logout = useCallback(async () => {
    sessionStorage.removeItem(DESIGN_SESSION_KEY)
    setUserContext(null)
    setPermissions(new Set())
    setPendingState(null)
    await remoteSignOut()
    setMode('signedOut')
  }, [])

  useEffect(() => {
    let alive = true
    async function initialize() {
      if (sessionStorage.getItem(DESIGN_SESSION_KEY)) {
        enterDesignMode()
        return
      }
      if (!isSupabaseConfigured) {
        if (alive) setMode('signedOut')
        return
      }
      try {
        const { data, error } = await getAuthenticatedUser()
        if (!alive) return
        if (!error && data?.user) await handleUser(data.user)
        else setMode('signedOut')
      } catch {
        if (alive) setMode('signedOut')
      }
    }
    initialize()
    const unsubscribe = subscribeToAuth((event, session) => {
      if (!alive || sessionStorage.getItem(DESIGN_SESSION_KEY)) return
      if (event === 'SIGNED_OUT') setMode('signedOut')
      if (event === 'SIGNED_IN' && session?.user) handleUser(session.user)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [enterDesignMode, handleUser])

  useEffect(() => {
    if (mode !== 'authenticated' || !userContext?.id) return undefined

    let refreshing = false
    const unsubscribe = subscribeToUserAccess(userContext.id, async () => {
      if (refreshing) return
      refreshing = true
      try {
        const { data, error } = await getAuthenticatedUser()
        if (!error && data?.user) await handleUser(data.user)
      } finally {
        refreshing = false
      }
    })

    return unsubscribe
  }, [mode, userContext?.id, handleUser])

  const value = useMemo(() => ({
    mode,
    isDesignMode: mode === 'design',
    isAuthenticated: mode === 'authenticated' || mode === 'design',
    isOnboarding: mode === 'onboarding',
    userContext,
    permissions,
    pendingState,
    isSupabaseConfigured,
    login,
    logout,
    enterDesignMode,
    setPendingState,
    setMode,
    handleUser,
    can: (permission) => mode === 'design' || permissions.has(permission),
  }), [mode, userContext, permissions, pendingState, login, logout, enterDesignMode, handleUser])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider')
  return context
}
