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

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

async function rpc(url: string, key: string, name: string, payload: unknown) {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.message || data?.hint || `RPC ${name} failed`)
  return data
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let requestId = ''

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const publishableKey = namedKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY')
    const secretKey = namedKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY')
    const brevoApiKey = Deno.env.get('BREVO_API_KEY') || ''
    const senderEmail = Deno.env.get('BRANCH_CAPACITY_EMAIL_FROM')
      || Deno.env.get('AUTHORIZATION_EMAIL_FROM')
      || Deno.env.get('VOID_EMAIL_FROM')
      || ''
    const senderName = Deno.env.get('BRANCH_CAPACITY_EMAIL_FROM_NAME')
      || Deno.env.get('AUTHORIZATION_EMAIL_FROM_NAME')
      || Deno.env.get('VOID_EMAIL_FROM_NAME')
      || 'RestOS+'

    if (!supabaseUrl || !publishableKey || !secretKey) {
      return json({ error: 'Supabase function environment is incomplete.' }, 500)
    }
    if (!brevoApiKey || !senderEmail) {
      return json({ error: 'El correo de solicitudes comerciales todavía no está configurado.', code: 'EMAIL_NOT_CONFIGURED' }, 503)
    }

    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)

    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: publishableKey, Authorization: authHeader },
    })
    if (!userResponse.ok) return json({ error: 'Invalid session' }, 401)
    const user = await userResponse.json()

    const body = await req.json()
    const restaurantId = String(body.restaurantId || '')
    const additionalBranches = Number(body.additionalBranches || 0)

    if (!restaurantId || !Number.isInteger(additionalBranches) || additionalBranches < 1 || additionalBranches > 100) {
      return json({ error: 'Indica una cantidad válida de sucursales adicionales entre 1 y 100.' }, 400)
    }

    const createdRaw = await rpc(
      supabaseUrl,
      secretKey,
      'create_branch_capacity_request_internal',
      {
        p_restaurant_id: restaurantId,
        p_requested_by: user.id,
        p_additional_count: additionalBranches,
      },
    )
    const created = Array.isArray(createdRaw) ? createdRaw[0] : createdRaw
    requestId = String(created?.requestId || '')
    if (!requestId) throw new Error('No se pudo registrar la solicitud de ampliación.')

    const recipients = await rpc(
      supabaseUrl,
      secretKey,
      'list_platform_admin_recipients_internal',
      {},
    )

    if (!Array.isArray(recipients) || !recipients.length) {
      await rpc(
        supabaseUrl,
        secretKey,
        'cancel_branch_capacity_request_internal',
        { p_request_id: requestId },
      )
      return json({ error: 'No hay un correo del desarrollador configurado para recibir solicitudes.' }, 409)
    }

    const emailResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': brevoApiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: recipients.map((recipient: any) => ({
          email: recipient.email,
          name: recipient.full_name || 'Administrador RestOS+',
        })),
        subject: `Solicitud de ampliación de sucursales · ${created.companyName}`,
        htmlContent: `<html><body style="font-family:Arial,sans-serif;color:#18211b;background:#f5f7f6;padding:24px">
          <div style="max-width:680px;margin:auto;background:#fff;border:1px solid #e2e8e4;border-radius:16px;padding:28px">
            <div style="font-size:12px;font-weight:800;letter-spacing:1.5px;color:#174c36">RESTOS+ · SOLICITUD COMERCIAL</div>
            <h2 style="margin:10px 0 18px">Ampliación de sucursales</h2>
            <p>La empresa <b>${escapeHtml(created.companyName)}</b> solicita ampliar su capacidad contratada.</p>
            <table style="width:100%;border-collapse:collapse;margin:20px 0">
              <tr><td style="padding:9px;border-bottom:1px solid #eee">Sucursales adicionales solicitadas</td><td style="padding:9px;border-bottom:1px solid #eee;text-align:right"><b>+${additionalBranches}</b></td></tr>
              <tr><td style="padding:9px;border-bottom:1px solid #eee">Límite actual</td><td style="padding:9px;border-bottom:1px solid #eee;text-align:right"><b>${escapeHtml(created.allowedBranchCount)}</b></td></tr>
              <tr><td style="padding:9px;border-bottom:1px solid #eee">Sucursales activas</td><td style="padding:9px;border-bottom:1px solid #eee;text-align:right"><b>${escapeHtml(created.activeBranchCount)}</b></td></tr>
            </table>
            <p><b>Solicitado por:</b> ${escapeHtml(user.email || created.requesterEmail || user.id)}</p>
            <p style="color:#5f6d65">El siguiente paso es acordar el costo y confirmar el pago. Después del pago, desde el portal admin se puede emitir el código de activación que se enviará al correo del administrador principal de la empresa.</p>
          </div>
        </body></html>`,
      }),
    })

    if (!emailResponse.ok) {
      await rpc(
        supabaseUrl,
        secretKey,
        'cancel_branch_capacity_request_internal',
        { p_request_id: requestId },
      )
      return json({ error: 'No se pudo enviar la solicitud al desarrollador. Inténtalo nuevamente.' }, 502)
    }

    await rpc(
      supabaseUrl,
      secretKey,
      'mark_branch_capacity_request_email_sent_internal',
      { p_request_id: requestId },
    )

    return json({
      ok: true,
      requestId,
      additionalBranches,
      message: 'Solicitud enviada correctamente.',
    })
  } catch (error) {
    console.error(error)
    return json({ error: error instanceof Error ? error.message : 'Unexpected error' }, 400)
  }
})
