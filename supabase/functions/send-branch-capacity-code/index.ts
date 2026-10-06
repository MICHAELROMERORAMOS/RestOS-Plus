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

function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('')
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
      return json({ error: 'El correo de activaciones todavía no está configurado.', code: 'EMAIL_NOT_CONFIGURED' }, 503)
    }

    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)

    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: publishableKey, Authorization: authHeader },
    })
    if (!userResponse.ok) return json({ error: 'Invalid session' }, 401)
    const user = await userResponse.json()

    const { requestId } = await req.json()
    if (!requestId) return json({ error: 'Falta la solicitud de ampliación.' }, 400)

    const code = generateCode()
    const preparedRaw = await rpc(
      supabaseUrl,
      secretKey,
      'prepare_branch_capacity_activation_internal',
      {
        p_request_id: requestId,
        p_admin_user_id: user.id,
        p_code: code,
      },
    )
    const prepared = Array.isArray(preparedRaw) ? preparedRaw[0] : preparedRaw

    if (!prepared?.ownerEmail) {
      return json({ error: 'La empresa no tiene un correo de administrador principal configurado.' }, 409)
    }

    const nextLimit = Number(prepared.currentAllowedBranchCount || 0) + Number(prepared.additionalBranches || 0)

    const emailResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': brevoApiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{
          email: prepared.ownerEmail,
          name: prepared.ownerName || 'Administrador principal',
        }],
        subject: `Código de activación de sucursales · ${prepared.companyName}`,
        htmlContent: `<html><body style="font-family:Arial,sans-serif;color:#18211b;background:#f5f7f6;padding:24px">
          <div style="max-width:680px;margin:auto;background:#fff;border:1px solid #e2e8e4;border-radius:16px;padding:28px">
            <div style="font-size:12px;font-weight:800;letter-spacing:1.5px;color:#174c36">RESTOS+ · ACTIVACIÓN</div>
            <h2 style="margin:10px 0 18px">Pago confirmado</h2>
            <p>Se confirmó el pago de la ampliación de capacidad para <b>${escapeHtml(prepared.companyName)}</b>.</p>
            <p>Este código habilita <b>${escapeHtml(prepared.additionalBranches)} sucursal(es) adicional(es)</b>. Al activarlo, el límite pasará de <b>${escapeHtml(prepared.currentAllowedBranchCount)}</b> a <b>${nextLimit}</b>.</p>
            <div style="margin:26px 0;padding:18px;border-radius:12px;background:#eef6f1;text-align:center">
              <div style="font-size:11px;font-weight:800;color:#5d6d64;letter-spacing:1px">CÓDIGO DE ACTIVACIÓN</div>
              <div style="font-size:34px;font-weight:900;letter-spacing:7px;color:#174c36;margin-top:8px">${code}</div>
            </div>
            <p>Ingresa este código en <b>Empresa y sucursales → Activar código</b>. El código es de un solo uso y solo puede aplicarse a esta empresa.</p>
          </div>
        </body></html>`,
      }),
    })

    if (!emailResponse.ok) {
      return json({
        error: 'El pago quedó confirmado, pero no se pudo enviar el correo. Puedes reenviar un código nuevo desde el portal admin.',
        code: 'EMAIL_SEND_FAILED',
      }, 502)
    }

    await rpc(
      supabaseUrl,
      secretKey,
      'mark_branch_capacity_activation_email_sent_internal',
      { p_request_id: requestId },
    )

    return json({
      ok: true,
      requestId,
      ownerEmail: prepared.ownerEmail,
      additionalBranches: prepared.additionalBranches,
      nextAllowedBranchCount: nextLimit,
    })
  } catch (error) {
    console.error(error)
    return json({ error: error instanceof Error ? error.message : 'Unexpected error' }, 400)
  }
})
