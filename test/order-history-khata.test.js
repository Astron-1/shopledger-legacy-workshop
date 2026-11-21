const assert = require('node:assert/strict');
const test = require('node:test');

const dates = require('../lib/dates');
const ledger = require('../lib/ledger');
const orders = require('../lib/orders');

function orderIds(db, filters) {
  return orders.list(db, filters).map(order => order.id);
}

function customerFixture() {
  return {
    nextSettlementId: 504,
    settlements: [{ id: 503, customerId: 1, amount: 500 }],
    customers: [{
      id: 1, name: 'Meera Joshi', openingBalance: 450,
      totalBilled: 1982.01, totalSettled: 1200, balance: 1232.01
    }]
  };
}

test('order history combines status, search, and inclusive date filters', () => {
  const db = { orders: [
    { id: 1, date: '01/03/2022', customer: 'Meera Joshi' },
    { id: 2, date: '10/03/2022', coupon: 'MEERA' },
    { id: 3, date: '11/03/2022', customer: 'Meera Joshi', status: 'pending' },
    { id: 4, date: '12/03/2022', customer: 'Walk-in' }
  ] };

  assert.deepEqual(orderIds(db, {
    from: '2022-03-01', to: '2022-03-10', status: 'completed', search: ' meera '
  }), [2, 1]);
  assert.deepEqual(orderIds(db, { status: 'all', search: '3' }), [3]);
  assert.deepEqual(db.orders.map(order => order.id), [1, 2, 3, 4]);
});

test('fiscal year rolls over in April for stored dates and date-picker values', () => {
  assert.equal(dates.getFiscalYear('31/03/2022'), 'FY21-22');
  assert.equal(dates.getFiscalYear('2022-04-01'), 'FY22-23');
});

test('a numeric settlement updates the customer and records a receipt', () => {
  const db = customerFixture();
  assert.equal(ledger.listCustomers(db)[0].balance, 1232.01);

  const result = ledger.recordSettlement(db, '1', 500);

  assert.equal(result.ok, true);
  assert.equal(result.customer.totalSettled, 1700);
  assert.equal(result.customer.balance, 732.01);
  assert.equal(ledger.listCustomers(db)[0].balance, 732.01);
  assert.deepEqual(result.settlement, {
    id: 504, customerId: 1, customerName: 'Meera Joshi', date: dates.today(),
    amount: 500, mode: 'upi', note: 'Khata settlement'
  });
  assert.deepEqual(db.settlements.map(entry => entry.id), [504, 503]);
  assert.equal(db.nextSettlementId, 505);
});

test('a nonpositive settlement or unknown customer leaves the ledger intact', () => {
  const db = customerFixture();
  assert.deepEqual(ledger.recordSettlement(db, 1, 0), {
    ok: false, error: 'Settlement amount must be greater than zero'
  });
  assert.deepEqual(ledger.recordSettlement(db, 99, 500), {
    ok: false, error: 'Customer not found'
  });
  assert.deepEqual(db, customerFixture());
});

test('order history sorts dates chronologically and filters across months and years', () => {
  const db = { orders: [
    { id: 1001, date: '28/12/2021' },
    { id: 1004, date: '30/01/2022' },
    { id: 1007, date: '04/03/2022' },
    { id: 1008, date: '15/03/2022' },
    { id: 1009, date: '2022-03-15' }
  ] };

  assert.deepEqual(orderIds(db), [1009, 1008, 1007, 1004, 1001]);
  assert.deepEqual(orderIds(db, { from: '2021-12-28', to: '30/01/2022' }), [1004, 1001]);
  assert.deepEqual(orderIds(db, { from: '2022-01-30', to: '2022-03-15' }), [1009, 1008, 1007, 1004]);
  assert.deepEqual(orderIds(db, { from: '2022-03-01' }), [1009, 1008, 1007]);
  assert.deepEqual(orderIds(db, { to: '2022-01-30' }), [1004, 1001]);
  assert.equal(db.orders[3].date, '15/03/2022');
});

test('the browser’s string settlement amount is added numerically', () => {
  const db = customerFixture();

  const result = ledger.recordSettlement(db, 1, '500', 'cash', 'Part payment');

  assert.equal(result.ok, true);
  assert.equal(result.customer.totalSettled, 1700);
  assert.equal(result.customer.balance, 732.01);
  assert.equal(ledger.listCustomers(db)[0].balance, 732.01);
  assert.equal(result.settlement.amount, 500);
  assert.equal(result.settlement.mode, 'cash');
  assert.equal(result.settlement.note, 'Part payment');
});

test('settlements accept saved numeric strings and retain decimal amounts', () => {
  const db = customerFixture();
  Object.assign(db.customers[0], { openingBalance: '450', totalBilled: '1982.01', totalSettled: '1200' });

  const result = ledger.recordSettlement(db, 1, 500.25);

  assert.equal(result.ok, true);
  assert.equal(result.customer.totalSettled, 1700.25);
  assert.equal(result.customer.balance, 731.76);
  assert.equal(ledger.listCustomers(db)[0].balance, 731.76);
  assert.equal(result.settlement.amount, 500.25);
});

test('malformed and non-finite payments leave balances and receipts unchanged', () => {
  const db = customerFixture();

  for (const amount of ['500rupees', '', ' ', '-10', 'Infinity', Infinity, NaN, true, [500]]) {
    assert.equal(ledger.recordSettlement(db, 1, amount).ok, false, String(amount));
    assert.deepEqual(db, customerFixture());
  }
});
