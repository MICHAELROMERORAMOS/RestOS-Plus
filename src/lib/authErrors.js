export function friendlyAuthError(error) {
  const message = (error?.message || '').toLowerCase()
  if (message.includes('invalid login credentials')) return 'Correo o contraseña incorrectos.'
  if (message.includes('email not confirmed')) return 'Primero debes verificar tu correo electrónico.'
  if (message.includes('user already registered')) return 'Ya existe una cuenta con ese correo.'
  if (message.includes('password should be')) return 'La contraseña no cumple los requisitos de seguridad.'
  if (message.includes('rate limit')) return 'Demasiados intentos. Espera un momento y vuelve a intentarlo.'
  if (message.includes('database error')) return 'No fue posible crear el perfil. Revisa si el nombre de usuario ya está en uso.'
  return error?.message || 'Ocurrió un error. Inténtalo nuevamente.'
}
