import test from 'node:test';
import assert from 'node:assert/strict';
import { availableItems, credentials, DeliveryError, digest, email, integer, makeSnapshot, normalizeOrder, orderHash, safeEqual, signatureSvg, validateStrokes, verifyPin } from './delivery-core.server.js';
import { deliveryForm, requireCsrf } from './delivery-access.server.js';
import { rawOrder, strokes } from '../../tests/deliveries/fixtures.mjs';
const order = normalizeOrder(rawOrder());
const rep = { id: 'rep-test', name: 'Example Representative' };
const input = { quantities: { [order.items[0].id]: '3' }, packages: '2', scheduledDate: '2026-10-17', instructions: '' };
const make = (options = input, notes = []) => makeSnapshot(order, notes, options, rep, 42, new Date('2026-10-12T12:00:00Z'));
test('partial delivery includes only selected quantities and no prices', () => {
  const s = make(); assert.equal(s.totalQuantity, 3); assert.equal(s.items.length, 1); assert.equal(s.items[0].quantity, 3); assert.equal(s.documentNumber, 'DN-2026-000042'); assert.equal(s.items[0].remainingUnallocated, 7); assert.equal('price' in s.items[0], false);
});
test('ready notes reserve quantities and signed notes remain deducted', () => {
  const snapshot = make();
  const available = availableItems(order, [{ id: 'one', status: 'READY', snapshot }, { id: 'two', status: 'SIGNED', snapshot }, { id: 'three', status: 'VOID', snapshot }]);
  assert.equal(available[0].available, 4); assert.equal(available[0].reserved, 3); assert.equal(available[0].signed, 3);
  assert.equal(availableItems(order, [{ id: 'one', status: 'READY', snapshot }], 'one')[0].available, 10);
});
test('over-allocation, empty selection, unknown items and fractional values fail closed', () => {
  for (const quantities of [{ [order.items[0].id]: 11 }, {}, { fake: 2 }, { [order.items[0].id]: 1.5 }, { [order.items[0].id]: -1 }, { [order.items[0].id]: '1e1' }]) assert.throws(() => make({ ...input, quantities }), DeliveryError);
});
test('non-physical and refunded lines cannot be newly allocated', () => {
  const changed = structuredClone(order); changed.items[0].quantity = 0; changed.items[1].requiresShipping = false;
  assert.deepEqual(availableItems(changed, []), []);
});
test('order fingerprint detects goods and address changes, not unrelated update timestamps', () => {
  assert.equal(orderHash(order), orderHash({ ...order, updatedAt: '2026-10-13T00:00:00Z' }));
  assert.notEqual(orderHash(order), orderHash({ ...order, address: ['Changed address'] }));
  const changed = structuredClone(order); changed.items[0].quantity--;
  assert.notEqual(orderHash(order), orderHash(changed));
  assert.equal(orderHash(order), orderHash({ ...order, items: [...order.items].reverse() }));
});
test('invalid dates and integer inputs return validation errors', () => {
  for (const value of ['2026-02-30', '2026-99-99', 'not a date']) assert.throws(() => make({ ...input, scheduledDate: value }), DeliveryError);
  for (const value of ['-1','1.1','NaN','',Infinity]) assert.throws(() => integer(value), DeliveryError);
});
test('signature requires bounded numeric strokes, not a dot or supplied SVG', () => {
  assert.deepEqual(validateStrokes(strokes), strokes);
  for (const value of [[], '<svg/>', [[[0,0]]], [Array(10).fill([0.2,0.2])], [[[0,0],[2,0]]], [Array(6001).fill([0.1,0.2])]]) assert.throws(() => validateStrokes(value), DeliveryError);
  assert.match(signatureSvg(strokes), /<path d="M/); assert.ok(!signatureSvg(strokes).includes('script'));
});
test('representative PINs are salted, verified and not stored in plaintext', () => {
  const c = credentials(); assert.equal(c.pin.length, 8); assert.equal(c.access.length, 64); assert.notEqual(c.pinHash, c.pin); assert.equal(c.accessHash, digest(c.access)); assert.equal(verifyPin(c.pin, c.pinHash), true); assert.equal(verifyPin('invalid', c.pinHash), false);
});
test('constant-time token comparison safely rejects Unicode length mismatches', () => {
  assert.equal(safeEqual('ab', '\u00e9\u00e9'), false); assert.equal(safeEqual('token', 'token'), true); assert.equal(safeEqual(null, 'token'), false);
  assert.throws(() => requireCsrf({ csrf: 'known' }, 'wrong'), DeliveryError);
});
test('email destinations reject header injection', () => {
  assert.equal(email('crew@example.test'), 'crew@example.test');
  assert.throws(() => email('crew@example.test\r\nBcc:other@example.test'), DeliveryError);
});
test('form handler rejects cross-origin submissions and oversized bodies', async () => {
  const before = process.env.SHOPIFY_APP_URL; process.env.SHOPIFY_APP_URL = 'https://example.test';
  try {
    await assert.rejects(deliveryForm(new Request('https://example.test/delivery', { method: 'POST', headers: { Origin: 'https://attacker.test', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'intent=sign' })), e => e.status === 403);
    await assert.rejects(deliveryForm(new Request('https://example.test/delivery', { method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'x='.padEnd(512001, 'a') })), e => e.status === 413);
    const form = await deliveryForm(new Request('https://example.test/delivery', { method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'intent=login&pin=12345678' }));
    assert.equal(form.get('pin'), '12345678');
  } finally { if (before === undefined) delete process.env.SHOPIFY_APP_URL; else process.env.SHOPIFY_APP_URL = before; }
});
