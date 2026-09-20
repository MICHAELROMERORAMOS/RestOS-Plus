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
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
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
    const senderEmail = Deno.env.get('VOID_EMAIL_FROM') || ''
    const senderName = Deno.env.get('VOID_EMAIL_FROM_NAME') || 'RestOS+'

    if (!supabaseUrl || !publishableKey || !secretKey) return json({ error: 'Supabase function environment is incomplete.' }, 500)
    if (!brevoApiKey || !senderEmail) return json({ error: 'El correo de autorizaciones todavía no está configurado.', code: 'EMAIL_NOT_CONFIGURED' }, 503)

    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: publishableKey, Authorization: authHeader },
    })
    if (!userResponse.ok) return json({ error: 'Invalid session' }, 401)
    const user = await userResponse.json()

    const body = await req.json()
    const restaurantId = String(body.restaurantId || '')
    const invoiceNumber = String(body.invoiceNumber || '').trim().toUpperCase()
    const reason = String(body.reason || '').trim()
    const comment = String(body.comment || '').trim()
    if (!restaurantId || !invoiceNumber || !reason || comment.length < 5) {
      return json({ error: 'Faltan datos para solicitar la anulación de la factura.' }, 400)
    }

    const code = generateCode()
    const created = await rpc(supabaseUrl, secretKey, 'create_invoice_void_authorization_internal', {
      p_restaurant_id: restaurantId,
      p_requested_by: user.id,
      p_invoice_number: invoiceNumber,
      p_reason: reason,
      p_comment: comment,
      p_code: code,
    })
    const request = Array.isArray(created) ? created[0] : created
    if (!request?.request_id) throw new Error('No se pudo crear la solicitud de autorización.')

    const approvers = await rpc(supabaseUrl, secretKey, 'list_void_approvers_internal', {
      p_restaurant_id: restaurantId,
    })
    if (!Array.isArray(approvers) || !approvers.length) {
      await rpc(supabaseUrl, secretKey, 'cancel_void_authorization_internal', { p_request_id: request.request_id })
      return json({ error: 'No hay un owner activo con correo configurado.' }, 409)
    }

    const items = Array.isArray(request.items) ? request.items : []
    const itemRows = items.map((item: any) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #ddd">${escapeHtml(item.quantity)} × ${escapeHtml(item.name)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right">${Number(item.amount || 0).toFixed(2)}</td>
      </tr>`).join('')

    const emailResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { accept: 'application/json', 'api-key': brevoApiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: approvers.map((owner: any) => ({ email: owner.email, name: owner.full_name || 'Owner' })),
        subject: `Código para anular factura ${request.invoice_number}`,
        htmlContent: `<html><body style="font-family:Arial,sans-serif;color:#18211b">
          <h2>Solicitud para anular una factura pagada</h2>
          <p><b>Factura:</b> ${escapeHtml(request.invoice_number)}<br/>
             <b>Orden:</b> #${escapeHtml(request.order_number)}<br/>
             <b>Mesa:</b> ${escapeHtml(request.table_label || 'No aplica')}<br/>
             <b>Total pagado:</b> ${Number(request.amount_paid || 0).toFixed(2)}<br/>
             <b>Motivo:</b> ${escapeHtml(reason)}<br/>
             <b>Observación:</b> ${escapeHtml(comment)}<br/>
             <b>Solicitado por:</b> ${escapeHtml(user.email || user.id)}</p>
          <table style="border-collapse:collapse;width:100%;max-width:650px"><tbody>${itemRows}</tbody></table>
          <div style="font-size:34px;font-weight:800;letter-spacing:8px;margin:24px 0">${code}</div>
          <p>Este código es de un solo uso y caduca en 10 minutos.</p>
        </body></html>`,
      }),
    })

    if (!emailResponse.ok) {
      await rpc(supabaseUrl, secretKey, 'cancel_void_authorization_internal', { p_request_id: request.request_id })
      return json({ error: 'No se pudo enviar el código al owner.' }, 502)
    }

    await rpc(supabaseUrl, secretKey, 'mark_void_email_sent_internal', { p_request_id: request.request_id })
    return json({ ok: true, requestId: request.request_id, expiresAt: request.expires_at })
  } catch (error) {
    console.error(error)
    return json({ error: error instanceof Error ? error.message : 'Unexpected error' }, 400)
  }
})
