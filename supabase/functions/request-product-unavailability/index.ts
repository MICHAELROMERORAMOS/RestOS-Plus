const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function namedKey(envName: string, legacyName: string) {
  const raw = Deno.env.get(envName)
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed?.default) return parsed.default
    } catch {}
  }
  return Deno.env.get(legacyName) || ''
}

function generateCode() {
  const bytes = new Uint32Array(1)
  crypto.getRandomValues(bytes)
  return String(bytes[0] % 1_000_000).padStart(6, '0')
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

async function rpc(url: string, key: string, name: string, payload: unknown) {
  const response = await fetch(url + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.message || data?.hint || ('RPC ' + name + ' failed'))
  return data
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const publishableKey = namedKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY')
    const secretKey = namedKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')
    const brevoApiKey = Deno.env.get('BREVO_API_KEY') || ''
    const senderEmail = Deno.env.get('AUTHORIZATION_EMAIL_FROM')
      || Deno.env.get('VOID_EMAIL_FROM')
      || ''
    const senderName = Deno.env.get('AUTHORIZATION_EMAIL_FROM_NAME')
      || Deno.env.get('VOID_EMAIL_FROM_NAME')
      || 'RestOS+'

    if (!supabaseUrl || !publishableKey || !secretKey) {
      return json({ error: 'Supabase function environment is incomplete.' }, 500)
    }
    if (!brevoApiKey || !senderEmail) {
      return json({
        error: 'El correo de autorizaciones todavía no está configurado.',
        code: 'EMAIL_NOT_CONFIGURED',
      }, 503)
    }

    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)

    const userResponse = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { apikey: publishableKey, Authorization: authHeader },
    })
    if (!userResponse.ok) return json({ error: 'Invalid session' }, 401)
    const user = await userResponse.json()

    const body = await req.json()
    const restaurantId = String(body.restaurantId || '')
    const locationId = String(body.locationId || '')
    const productId = String(body.productId || '')
    const reason = String(body.reason || '').trim()
    const durationMinutes = Number(body.durationMinutes || 0)

    if (!restaurantId || !locationId || !productId || reason.length < 5) {
      return json({ error: 'Faltan datos para solicitar la indisponibilidad.' }, 400)
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 1440) {
      return json({ error: 'La duración debe estar entre 15 minutos y 24 horas.' }, 400)
    }

    const code = generateCode()
    const created = await rpc(
      supabaseUrl,
      secretKey,
      'create_product_unavailability_authorization_internal',
      {
        p_restaurant_id: restaurantId,
        p_location_id: locationId,
        p_product_id: productId,
        p_requested_by: user.id,
        p_reason: reason,
        p_duration_minutes: durationMinutes,
        p_code: code,
      },
    )
    const request = Array.isArray(created) ? created[0] : created
    if (!request?.request_id) throw new Error('No se pudo crear la solicitud de autorización.')

    const approvers = await rpc(
      supabaseUrl,
      secretKey,
      'list_product_availability_approvers_internal',
      { p_restaurant_id: restaurantId },
    )

    if (!Array.isArray(approvers) || !approvers.length) {
      await rpc(
        supabaseUrl,
        secretKey,
        'cancel_product_unavailability_authorization_internal',
        { p_request_id: request.request_id },
      )
      return json({ error: 'No hay un responsable corporativo activo con correo configurado.' }, 409)
    }

    const durationLabel = durationMinutes < 60
      ? durationMinutes + ' minutos'
      : durationMinutes % 60 === 0
        ? (durationMinutes / 60) + ' hora(s)'
        : durationMinutes + ' minutos'

    const emailResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': brevoApiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: approvers.map((approver: any) => ({
          email: approver.email,
          name: approver.full_name || 'Responsable corporativo',
        })),
        subject: 'Código para retirar temporalmente ' + request.product_name,
        htmlContent: '<html><body style="font-family:Arial,sans-serif;color:#18211b">'
          + '<h2>Solicitud de indisponibilidad temporal</h2>'
          + '<p><b>Producto:</b> ' + escapeHtml(request.product_name) + '<br/>'
          + '<b>Sucursal:</b> ' + escapeHtml(request.location_name) + '<br/>'
          + '<b>Duración:</b> ' + escapeHtml(durationLabel) + '<br/>'
          + '<b>Motivo:</b> ' + escapeHtml(reason) + '<br/>'
          + '<b>Solicitado por:</b> ' + escapeHtml(user.email || user.id) + '</p>'
          + '<div style="font-size:34px;font-weight:800;letter-spacing:8px;margin:24px 0">' + code + '</div>'
          + '<p>Entrega este código únicamente si autorizas retirar temporalmente el producto. '
          + 'Es de un solo uso y caduca en 10 minutos.</p>'
          + '</body></html>',
      }),
    })

    if (!emailResponse.ok) {
      await rpc(
        supabaseUrl,
        secretKey,
        'cancel_product_unavailability_authorization_internal',
        { p_request_id: request.request_id },
      )
      return json({ error: 'No se pudo enviar el código de autorización.' }, 502)
    }

    await rpc(
      supabaseUrl,
      secretKey,
      'mark_product_unavailability_email_sent_internal',
      { p_request_id: request.request_id },
    )

    return json({
      ok: true,
      requestId: request.request_id,
      expiresAt: request.authorization_expires_at,
      productName: request.product_name,
      locationName: request.location_name,
      durationMinutes,
    })
  } catch (error) {
    console.error(error)
    return json({ error: error instanceof Error ? error.message : 'Unexpected error' }, 400)
  }
})
