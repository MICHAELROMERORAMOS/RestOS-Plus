import { supabase } from '../lib/supabase.js'

export async function loadSalesReport(locationId, startDate, endDate) {
  if (!locationId) throw new Error('No hay una sucursal activa.')
  if (!startDate || !endDate) throw new Error('Selecciona un rango de fechas válido.')

  const { data, error } = await supabase.rpc('get_sales_report', {
    p_location_id: locationId,
    p_start_date: startDate,
    p_end_date: endDate,
  })

  if (error) throw error
  return data || {
    startDate,
    endDate,
    sales: 0,
    tickets: 0,
    averageTicket: 0,
    refunds: 0,
    topProducts: [],
    paymentMethods: [],
    daily: [],
    hourly: [],
  }
}
