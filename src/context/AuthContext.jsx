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
    title: 'Falta asignar restaurante y rol',
    message: 'Tu cuenta está aprobada, pero todavía no tiene una membresía activa con restaurante y rol.',
    icon: '⏳',
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
    })
    setPendingState(null)
    setMode('design')
  }, [])

  const handleUser = useCallback(async (user) => {
    if (!user) {
      setMode('signedOut')
      return
    }
    try {
      const access = await loadUserAccess(user)
      if (!access.active) {
        await remoteSignOut()
        const copy = statusCopy[access.status] || {
          title: 'Acceso no disponible',
          message: 'Tu cuenta no está habilitada para entrar en RestOS+.',
          icon: '!',
        }
        setPendingState(copy)
        setUserContext(null)
        setPermissions(new Set())
        setMode('pending')
        return
      }
      setPermissions(new Set(access.permissions))
      setUserContext({
        id: user.id,
        name: access.profile.full_name || access.profile.username || user.email,
        role: access.role?.name || 'Rol',
        restaurant: access.restaurant?.name || 'Restaurante',
        membership: access.membership,
      })
      sessionStorage.removeItem(DESIGN_SESSION_KEY)
      setPendingState(null)
      setMode('authenticated')
    } catch (error) {
      await remoteSignOut()
      setPendingState({
        title: 'No pudimos cargar tu perfil',
        message: friendlyAuthError(error),
        icon: '!',
      })
      setMode('pending')
    }
  }, [])

  const login = useCallback(async (email, password) => {
    const { data, error } = await signInWithPassword(email, password)
    if (error) throw error
    await handleUser(data.user)
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

  const value = useMemo(() => ({
    mode,
    isDesignMode: mode === 'design',
    isAuthenticated: mode === 'authenticated' || mode === 'design',
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
