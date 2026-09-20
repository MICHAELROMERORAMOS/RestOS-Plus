const METHOD_LABELS = { cash: 'Efectivo', card: 'Tarjeta', bank: 'Transferencia', voucher: 'Vale', other: 'Otro' }

function number(value) {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function money(value, currencyCode) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: currencyCode || 'EUR',
  }).format(number(value))
}

function safeDate(value) {
  const date = value ? new Date(value) : new Date()
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function addInvoicePage(doc, invoice, currencyCode, pageIndex) {
  if (pageIndex > 0) doc.addPage()
  const left = 16
  const right = 194
  let y = 18
  const line = (label, value) => {
    doc.setFont('helvetica', 'bold')
    doc.text(label, left, y)
    doc.setFont('helvetica', 'normal')
    doc.text(String(value || '-'), 55, y)
    y += 6
  }

  doc.setTextColor(24, 33, 27)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text(invoice.restaurantName || 'RestOS+', left, y)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  doc.text(invoice.locationName || '', right, y, { align: 'right' })
  y += 9
  doc.setDrawColor(43, 117, 72)
  doc.setLineWidth(0.8)
  doc.line(left, y, right, y)
  y += 9
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text('FACTURA ' + invoice.invoiceNumber, left, y)
  y += 8
  doc.setFontSize(10)
  line('Fecha:', safeDate(invoice.issuedAt).toLocaleString('es-CO'))
  line('Orden:', '#' + invoice.orderNumber)
  line('Mesa / cuenta:', invoice.tableLabel || invoice.customerName || invoice.serviceMode || 'No aplica')

  y += 3
  doc.setFillColor(239, 246, 241)
  doc.rect(left, y, right - left, 8, 'F')
  doc.setFont('helvetica', 'bold')
  doc.text('Cant.', left + 2, y + 5.5)
  doc.text('Producto', left + 22, y + 5.5)
  doc.text('Unitario', 153, y + 5.5, { align: 'right' })
  doc.text('Total', right - 2, y + 5.5, { align: 'right' })
  y += 12

  doc.setFont('helvetica', 'normal')
  for (const item of invoice.items || []) {
    const nameLines = doc.splitTextToSize(String(item.name || 'Producto'), 93)
    const rowHeight = Math.max(7, nameLines.length * 5)
    if (y + rowHeight > 257) {
      doc.addPage()
      y = 18
    }
    doc.text(String(number(item.quantity)), left + 2, y)
    doc.text(nameLines, left + 22, y)
    doc.text(money(item.unitPrice, currencyCode), 153, y, { align: 'right' })
    doc.text(money(item.amount, currencyCode), right - 2, y, { align: 'right' })
    y += rowHeight
    doc.setDrawColor(225, 229, 226)
    doc.line(left, y - 2, right, y - 2)
  }

  y += 4
  const totalLine = (label, value, strong = false) => {
    doc.setFont('helvetica', strong ? 'bold' : 'normal')
    doc.text(label, 142, y, { align: 'right' })
    doc.text(money(value, currencyCode), right - 2, y, { align: 'right' })
    y += 6
  }
  totalLine('Subtotal', invoice.subtotal)
  if (number(invoice.discountTotal) > 0) totalLine('Descuento', -number(invoice.discountTotal))
  if (number(invoice.taxTotal) > 0) totalLine('Impuestos', invoice.taxTotal)
  totalLine('TOTAL PAGADO', invoice.paidTotal, true)

  y += 5
  doc.setFont('helvetica', 'bold')
  doc.text('Pagos', left, y)
  y += 6
  doc.setFont('helvetica', 'normal')
  for (const payment of invoice.payments || []) {
    const label = (METHOD_LABELS[payment.method] || payment.method || 'Pago') + ' - ' + safeDate(payment.paidAt).toLocaleString('es-CO')
    doc.text(label, left, y)
    doc.text(money(payment.amount, currencyCode), right - 2, y, { align: 'right' })
    y += 6
  }

  doc.setFontSize(8)
  doc.setTextColor(90, 99, 93)
  doc.text('Documento generado por RestOS+. Conserve esta factura para sus registros.', 105, 286, { align: 'center' })
}

export async function createInvoicePdf(invoices, currencyCode = 'EUR') {
  if (!Array.isArray(invoices) || !invoices.length) {
    throw new Error('No hay facturas disponibles para generar el PDF.')
  }
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  invoices.forEach((invoice, index) => addInvoicePage(doc, invoice, currencyCode, index))
  const first = invoices[0]?.invoiceNumber || 'factura'
  return {
    blob: doc.output('blob'),
    filename: invoices.length === 1 ? first + '.pdf' : 'facturas-' + first + '.pdf',
  }
}
