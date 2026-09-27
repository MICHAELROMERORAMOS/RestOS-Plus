import { supabase } from '../lib/supabase.js'

function requireSupabase() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}

export async function processOrderRefund({
  orderServerId,
  amount,
  method,
  reference = '',
  note = '',
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('process_order_refund', {
    p_order_id: orderServerId,
    p_amount: amount,
    p_method: method,
    p_reference: reference || null,
    p_note: note || null,
  })

  if (error) throw error
  return {
    ok: Boolean(data?.ok),
    refundId: data?.refund_id || null,
    orderId: data?.order_id || orderServerId,
    orderNumber: Number(data?.order_number || 0),
    invoiceNumber: data?.invoice_number || null,
    amount: Number(data?.amount || 0),
    remainingRefund: Number(data?.remaining_refund || 0),
  }
}
