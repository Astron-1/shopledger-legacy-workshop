const assert = require('node:assert/strict');
const test = require('node:test');

const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

function billedOrder(items, coupon) {
  const totals = pricing.computeTotals(items, coupon);
  return orders.add({ nextOrderId: 1001, orders: [] }, {
    date: '2021-11-15',
    items,
    coupon,
    subtotal: totals.subtotal,
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total
  });
}

test('invoice matches the billed total and GST breakdown for a mixed-rate order with SAVE10', () => {
  const order = billedOrder([
    { name: 'Rice', hsn: '1006', price: 500, qty: 1 },
    { name: 'Ghee', hsn: '0405', price: 500, qty: 1 }
  ], 'SAVE10');
  assert.deepEqual([order.discount, order.tax, order.total], [100, 76.5, 976.5]);

  const { discount, tax, cgst, sgst, total, rows } = invoice.computeInvoiceFigures(order);
  assert.deepEqual({ discount, tax, cgst, sgst, total }, {
    discount: 100, tax: 76.5, cgst: 38.25, sgst: 38.25, total: 976.5
  });
  assert.deepEqual(rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [[5, 22.5], [12, 54]]);

  const html = invoice.render(order);
  assert.match(html, /<td class="r">5%<\/td><td class="r">₹22\.50<\/td>/);
  assert.match(html, /<td class="r">12%<\/td><td class="r">₹54\.00<\/td>/);
  assert.match(html, /<td>CGST<\/td><td class="r">₹38\.25<\/td>/);
  assert.match(html, /<td>SGST<\/td><td class="r">₹38\.25<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹976\.50<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice matches the billed total for an undiscounted default-rate order', () => {
  const order = billedOrder([{ name: 'Tea', price: 100, qty: 2 }]);
  assert.equal(order.total, 236);
  assert.deepEqual(invoice.computeInvoiceFigures(order), {
    subtotal: 200,
    discount: 0,
    tax: 36,
    cgst: 18,
    sgst: 18,
    total: 236,
    rows: [{
      name: 'Tea',
      sku: '-',
      hsn: '-',
      qty: 2,
      price: 100,
      gstPercent: 18,
      line: 200,
      lineTax: 36
    }]
  });

  const html = invoice.render(order);
  assert.match(html, /Invoice Total<\/td><td class="r">₹236\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice uses checkout HSN rates for saved items without explicit rates', () => {
  const order = billedOrder([
    { id: 1, name: 'Rice', hsn: '1006', price: 100, qty: 2 },
    { id: 2, name: 'Ghee', hsn: '0405', price: 100, qty: 1 },
    { id: 3, name: 'Tea', hsn: '0902', price: 100, qty: 1 }
  ]);
  assert.equal(order.tax, 40);
  assert.equal(order.total, 440);

  const { rows, tax, cgst, sgst, total } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(rows.map(({ hsn, gstPercent, lineTax }) => [hsn, gstPercent, lineTax]), [
    ['1006', 5, 10],
    ['0405', 12, 12],
    ['0902', 18, 18]
  ]);
  assert.deepEqual({ tax, cgst, sgst, total }, { tax: 40, cgst: 20, sgst: 20, total: 440 });

  const html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹40\.00/);
  assert.match(html, /<td class="r">5%<\/td><td class="r">₹10\.00<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹440\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);

  assert.deepEqual(reports.getGstReconciliation({ orders: [order] }), {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: 1001,
      date: '2021-11-15',
      customer: 'Walk-in',
      coupon: '',
      ledgerSubtotal: 400,
      ledgerDiscount: 0,
      ledgerTax: 40,
      ledgerTotal: 440,
      invoiceDiscount: 0,
      invoiceTax: 40,
      invoiceTotal: 440,
      delta: 0,
      matched: true
    }]
  });
});

test('invoice reflects checkout’s percentage coupon cap and GST after discount', () => {
  const order = billedOrder([{ name: 'Tea', price: 2000, qty: 1 }], 'SAVE10');
  assert.deepEqual([order.discount, order.tax, order.total], [150, 333, 2183]);

  const { discount, tax, cgst, sgst, total } = invoice.computeInvoiceFigures(order);
  assert.deepEqual({ discount, tax, cgst, sgst, total }, {
    discount: 150,
    tax: 333,
    cgst: 166.5,
    sgst: 166.5,
    total: 2183
  });

  const html = invoice.render(order);
  assert.match(html, /Coupon Discount \(SAVE10\)<\/td><td[^>]*>-₹150\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice reflects checkout’s GST after a flat coupon', () => {
  const order = billedOrder([{ name: 'Tea', price: 500, qty: 1 }], 'FLAT50');
  assert.deepEqual([order.discount, order.tax, order.total], [50, 81, 531]);

  const { discount, tax, total } = invoice.computeInvoiceFigures(order);
  assert.deepEqual({ discount, tax, total }, { discount: 50, tax: 81, total: 531 });
});

test('invoice resolves explicit percentage, decimal, and zero GST rates like checkout', () => {
  const order = billedOrder([
    { name: 'Percentage rate', price: 100, qty: 1, gstRate: 5 },
    { name: 'Decimal rate', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Zero rate', price: 100, qty: 1, gstRate: 0 }
  ]);
  assert.equal(order.tax, 10);
  assert.equal(order.total, 310);

  const { rows, tax, total } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [
    [5, 5],
    [5, 5],
    [0, 0]
  ]);
  assert.equal(tax, 10);
  assert.equal(total, 310);
});

test('invoice GST equals the sum of the rounded line amounts', () => {
  const order = billedOrder([
    { name: 'First item', price: 0.1, qty: 1, gstRate: 5 },
    { name: 'Second item', price: 0.1, qty: 1, gstRate: 5 }
  ]);
  assert.equal(order.tax, 0.02);
  assert.equal(order.total, 0.22);

  const { rows, tax, cgst, sgst, total } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(rows.map(({ lineTax }) => lineTax), [0.01, 0.01]);
  assert.deepEqual({ tax, cgst, sgst, total }, { tax: 0.02, cgst: 0.01, sgst: 0.01, total: 0.22 });
});

test('invoice splits rounded GST into the same amounts as checkout', () => {
  const items = [{ name: 'Tea', price: 0.15, qty: 1 }];
  const order = billedOrder(items);
  const checkout = pricing.computeTotals(items);
  assert.deepEqual([order.tax, checkout.cgst, checkout.sgst, order.total], [0.03, 0.02, 0.01, 0.18]);

  const { tax, cgst, sgst, total } = invoice.computeInvoiceFigures(order);
  assert.deepEqual({ tax, cgst, sgst, total }, { tax: 0.03, cgst: 0.02, sgst: 0.01, total: 0.18 });

  const html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹0\.03<\/td>/);
  assert.match(html, /<td>CGST<\/td><td class="r">₹0\.02<\/td>/);
  assert.match(html, /<td>SGST<\/td><td class="r">₹0\.01<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('reconciliation matches GST as well as the total on an invoice with a capped coupon', () => {
  const order = billedOrder([{ name: 'Ghee', hsn: '0405', price: 2896.55, qty: 1 }], 'SAVE10');
  assert.deepEqual([order.discount, order.tax, order.total], [150, 329.59, 3076.14]);

  const { discount, tax, total } = invoice.computeInvoiceFigures(order);
  assert.deepEqual({ discount, tax, total }, { discount: 150, tax: 329.59, total: 3076.14 });
  const html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹329\.59<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);

  const { mismatchCount, totalDelta, rows: [row] } = reports.getGstReconciliation({ orders: [order] });
  assert.equal(mismatchCount, 0);
  assert.equal(totalDelta, 0);
  assert.deepEqual([row.ledgerTax, row.invoiceTax, row.delta, row.matched], [329.59, 329.59, 0, true]);
});

test('printed invoice preserves saved amounts while reconciliation still flags historical differences', () => {
  const order = {
    items: [{ name: 'Rice', hsn: '1006', price: 100, qty: 1 }],
    subtotal: 100,
    discount: 0,
    tax: 18,
    total: 118
  };

  const html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹18\.00<\/td>/);
  assert.match(html, /<td>CGST<\/td><td class="r">₹9\.00<\/td>/);
  assert.match(html, /<td>SGST<\/td><td class="r">₹9\.00<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹118\.00<\/td>/);
  assert.match(html, /<td class="r">&mdash;<\/td><td class="r">&mdash;<\/td>/);
  assert.match(html, /Item GST details are unavailable for this saved order/);
  assert.match(html, /Accountant Reconciliation Notice:<\/strong> The report uses current pricing rules, which calculate ₹5\.00 GST and ₹105\.00 total/);

  const { mismatchCount, totalDelta, rows: [row] } = reports.getGstReconciliation({ orders: [order] });
  assert.equal(mismatchCount, 1);
  assert.equal(totalDelta, 13);
  assert.deepEqual([row.ledgerTax, row.invoiceTax, row.delta, row.matched], [18, 5, -13, false]);
});

test('printed invoice shows the adjustment needed to reach a historical billed total', () => {
  const html = invoice.render({
    items: [{ name: 'Tea', price: 10.10, qty: 1 }],
    coupon: 'WELCOME',
    subtotal: 10.10,
    discount: 0.51,
    tax: 1.73,
    total: 11.33
  });
  assert.match(html, /Billed Total Adjustment<\/td><td class="r">\+₹0\.01<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹11\.33<\/td>/);
});

test('printed invoice uses checkout figures when a legacy order has no saved amounts', () => {
  const html = invoice.render({
    items: [{ name: 'Rice', hsn: '1006', price: 100, qty: 1 }]
  });
  assert.match(html, /<td class="r">5%<\/td><td class="r">₹5\.00<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹105\.00<\/td>/);
  assert.match(html, /Current pricing rules were used to calculate missing billing amounts \(subtotal, discount, GST\)/);
  assert.match(html, /The invoice total was calculated from the amounts shown above/);
});

test('printed invoice derives a missing total from the available saved components', () => {
  const html = invoice.render({
    items: [{ name: 'Rice', hsn: '1006', price: 100, qty: 1 }],
    subtotal: 100,
    discount: 0,
    tax: 18
  });
  assert.match(html, /Invoice Total<\/td><td class="r">₹118\.00<\/td>/);
  assert.match(html, /The invoice total was calculated from the amounts shown above/);
  assert.doesNotMatch(html, /Current pricing rules were used to calculate missing billing amounts/);
});
