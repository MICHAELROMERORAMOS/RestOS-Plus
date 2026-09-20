const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

function namedKey(envName: string, legacyName: string) {
  const raw = Deno.env.get(envName)
  if (raw) {
    try { const parsed = JSON.parse(raw); if (parsed?.default) return parsed.default } catch {}
  }
  return Deno.env.get(legacyName) || ''
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
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
    if (!brevoApiKey || !senderEmail) return json({ error: 'La confirmación por correo todavía no está configurada.', code: 'EMAIL_NOT_CONFIGURED' }, 503)

    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: publishableKey, Authorization: authHeader } })
    if (!userResponse.ok) return json({ error: 'Invalid session' }, 401)
    const user = await userResponse.json()

    const { auditId } = await req.json()
    if (!auditId) return json({ error: 'Missing audit id.' }, 400)
    const rows = await rpc(supabaseUrl, secretKey, 'get_account_void_email_internal', { p_audit_id: auditId })
    const audit = Array.isArray(rows) ? rows[0] : rows
    if (!audit) return json({ error: 'Invoice void audit not found.' }, 404)
    if (audit.actor_user_id !== user.id) return json({ error: 'Not authorized for this audit.' }, 403)

    const approvers = await rpc(supabaseUrl, secretKey, 'list_void_approvers_internal', { p_restaurant_id: audit.restaurant_id })
    if (!Array.isArray(approvers) || !approvers.length) return json({ error: 'No owner email is configured.' }, 409)
    const items = Array.isArray(audit.items) ? audit.items : []
    const itemRows = items.map((item: any) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #ddd">${escapeHtml(item.quantity)} × ${escapeHtml(item.name)}</td><td style="padding:6px 10px;border-bottom:1px solid #ddd;text-align:right">${Number(item.amount || 0).toFixed(2)}</td></tr>`).join('')

    const emailResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { accept: 'application/json', 'api-key': brevoApiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: approvers.map((owner: any) => ({ email: owner.email, name: owner.full_name || 'Owner' })),
        subject: `Factura anulada · ${audit.invoice_number || audit.order_ref}`,
        htmlContent: `<html><body style="font-family:Arial,sans-serif;color:#18211b">
          <h2>Confirmación de factura anulada</h2>
          <p><b>Factura:</b> ${escapeHtml(audit.invoice_number || audit.order_ref)}<br/>
             <b>Mesa:</b> ${escapeHtml(audit.table_label || 'No aplica')}<br/>
             <b>Motivo:</b> ${escapeHtml(audit.reason)}<br/>
             <b>Observación:</b> ${escapeHtml(audit.comment)}<br/>
             <b>Ejecutado por:</b> ${escapeHtml(audit.actor_email || user.email || user.id)}<br/>
             <b>Reembolso pendiente:</b> ${Number(audit.refund_due || 0).toFixed(2)}</p>
          <table style="border-collapse:collapse;width:100%;max-width:650px"><tbody>${itemRows}</tbody></table>
        </body></html>`,
      }),
    })
    if (!emailResponse.ok) return json({ error: 'La factura fue anulada, pero no se pudo enviar el correo de confirmación.' }, 502)
    await rpc(supabaseUrl, secretKey, 'mark_account_void_email_sent_internal', { p_audit_id: auditId })
    return json({ ok: true })
  } catch (error) {
    console.error(error)
    return json({ error: error instanceof Error ? error.message : 'Unexpected error' }, 400)
  }
})
