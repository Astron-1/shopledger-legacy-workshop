const assert = require('node:assert/strict');
const test = require('node:test');

const inventory = require('../lib/inventory');
const orders = require('../lib/orders');

test('wholesale reservations reduce sellable stock and excess orders are rejected', () => {
  const chilli = { id: 11, name: 'Byadgi Chilli Powder', stock: 4, reserved: 3 };

  assert.equal(inventory.getSellableStock(chilli), 1);
  assert.deepEqual(inventory.check([chilli], [{ id: 11, qty: 2 }]), {
    ok: false,
    msg: 'Byadgi Chilli Powder is out of stock (1 sellable available)'
  });
  assert.deepEqual(inventory.check([chilli], [{ id: 99, qty: 1 }]), {
    ok: false,
    msg: 'Unknown product 99'
  });
  assert.deepEqual(chilli, { id: 11, name: 'Byadgi Chilli Powder', stock: 4, reserved: 3 });
});

test('committing an order below sellable stock deducts physical stock', () => {
  const product = { id: 4, stock: 8, reserved: 3 };
  const items = [{ id: 4, qty: 2 }];

  assert.deepEqual(inventory.check([product], items), { ok: true });
  inventory.reserve([product], items);
  assert.deepEqual(product, { id: 4, stock: 6, reserved: 3 });
});

function pendingOrderFixture() {
  return {
    products: [{ id: 6, stock: 1, reserved: 0 }, { id: 4, stock: 8, reserved: 3 }],
    customers: [{ id: 4, totalBilled: 1507, balance: 1507 }],
    orders: [{
      id: 1007,
      status: 'pending',
      paymentMode: 'khata',
      customerId: 4,
      total: 1407,
      items: [{ id: 6, qty: 2 }, { id: 4, qty: 2 }]
    }]
  };
}

test('cancelling a pending order records the reason and reverses the khata debit once', () => {
  const db = pendingOrderFixture();
  const result = orders.cancel(db, '1007', 'Cancelled from Order Register');

  assert.equal(result.ok, true);
  assert.equal(result.order.status, 'cancelled');
  assert.match(result.order.cancelledAt, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(result.order.cancelReason, 'Cancelled from Order Register');
  assert.deepEqual(orders.cancel(db, 1007), {
    ok: false,
    error: 'Order #1007 is already cancelled'
  });
  assert.deepEqual(db.customers, [{ id: 4, totalBilled: 100, balance: 100 }]);
});

test('checkout can sell the last unit of DRY-001 and SPC-001', () => {
  const products = [
    { id: 6, sku: 'DRY-001', name: 'A2 Gir Cow Ghee 500ml', stock: 1, reserved: 0 },
    { id: 11, sku: 'SPC-001', name: 'Byadgi Chilli Powder', stock: 4, reserved: 3 }
  ];
  const items = [{ id: 6, qty: 1 }, { id: 11, qty: 1 }];

  assert.deepEqual(inventory.check(products, items), { ok: true });
  inventory.reserve(products, items);
  assert.deepEqual(products.map(product => product.stock), [0, 3]);
  assert.deepEqual(products.map(product => product.reserved), [0, 3]);
  assert.deepEqual(products.map(inventory.getSellableStock), [0, 0]);
  for (const item of items) {
    assert.equal(inventory.check(products, [item]).ok, false);
  }
});

test('checkout checks the combined quantity of repeated product lines', () => {
  const products = [{ id: 4, name: 'Sunflower Oil', stock: 8, reserved: 3 }];
  const firstLine = { id: 4, qty: 2 };

  assert.deepEqual(inventory.check(products, [firstLine, { id: 4, qty: 3 }]), { ok: true });
  assert.deepEqual(inventory.check(products, [firstLine, { id: 4, qty: 4 }]), {
    ok: false,
    msg: 'Sunflower Oil is out of stock (5 sellable available)'
  });
  assert.equal(products[0].stock, 8);
});

test('cancelling pending order #1007 restores physical stock exactly once', () => {
  const db = pendingOrderFixture();

  assert.equal(orders.cancel(db, 1007).ok, true);
  const restored = [{ id: 6, stock: 3, reserved: 0 }, { id: 4, stock: 10, reserved: 3 }];
  assert.deepEqual(db.products, restored);
  assert.equal(orders.cancel(db, 1007).ok, false);
  assert.deepEqual(db.products, restored);
});

test('cancellation also restores stock for saved items with a productId', () => {
  const products = [{ id: 4, stock: '8', reserved: 3 }];

  inventory.release(products, [{ productId: 4, qty: '2' }, { productId: 99, qty: 1 }]);

  assert.deepEqual(products, [{ id: 4, stock: 10, reserved: 3 }]);
});
