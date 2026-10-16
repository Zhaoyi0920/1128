import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, seedDemo } from '../src/db.js';
import { LogisticsService } from '../src/service.js';

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const service = new LogisticsService(db);
  seedDemo(service);
  const [customer] = service.snapshot().customers;
  const [product, second] = service.snapshot().products;
  const order = (quantity = 3) => service.createOrder({ customer_id: customer.id, destination: '测试收货点', items: [{ product_id: product.id, quantity }] });
  return { db, service, customer, product, second, order };
}

test('种子数据只初始化一次且包含真实入库流水', t => {
  const { service } = fixture(t);
  seedDemo(service);
  assert.equal(service.snapshot().customers.length, 2);
  assert.equal(service.snapshot().inventoryLogs.length, 3);
  assert.equal(service.snapshot().metrics.lowStock, 1);
});

test('创建→发货→物流节点→签收，库存只扣减一次', t => {
  const { service, product, order } = fixture(t);
  const o = order(3);
  assert.equal(service.getProduct(product.id).stock, 120);
  assert.equal(service.getProduct(product.id).reserved, 3);
  service.transitionOrder(o.id, { status: 'shipped', carrier: '测试承运商', tracking_number: 'TEST001' });
  assert.equal(service.getProduct(product.id).stock, 117);
  assert.equal(service.getProduct(product.id).reserved, 0);
  assert.throws(() => service.transitionOrder(o.id, { status: 'shipped' }), /不允许/);
  service.appendTracking(o.id, { message: '已到达分拨中心' });
  service.transitionOrder(o.id, { status: 'delivered' });
  assert.equal(service.getOrder(o.id).events.length, 4);
  assert.equal(service.getProduct(product.id).stock, 117);
  assert.throws(() => service.appendTracking(o.id, { message: '非法后续节点' }), /只有运输中/);
});

test('库存不足会回滚整单以及前面商品的预占', t => {
  const { service, customer, product, second } = fixture(t);
  assert.throws(() => service.createOrder({ customer_id: customer.id, destination: '测试', items: [
    { product_id: product.id, quantity: 10 }, { product_id: second.id, quantity: 999 },
  ] }), /库存不足/);
  assert.equal(service.snapshot().orders.length, 0);
  assert.equal(service.getProduct(product.id).reserved, 0);
});

test('重复商品合并并阻止拆行超卖', t => {
  const { service, customer, product } = fixture(t);
  assert.throws(() => service.createOrder({ customer_id: customer.id, destination: '测试', items: [
    { product_id: product.id, quantity: 80 }, { product_id: product.id, quantity: 80 },
  ] }), /库存不足/);
  assert.equal(service.getProduct(product.id).reserved, 0);
  const o = service.createOrder({ customer_id: customer.id, destination: '测试', items: [
    { product_id: product.id, quantity: 2 }, { product_id: product.id, quantity: 3 },
  ] });
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].quantity, 5);
});

test('取消订单释放预占，禁止已取消订单再次发货', t => {
  const { service, product, order } = fixture(t);
  const o = order(120);
  assert.throws(() => order(1), /库存不足/);
  service.transitionOrder(o.id, { status: 'cancelled' });
  assert.equal(service.getProduct(product.id).available, 120);
  assert.equal(service.getProduct(product.id).stock, 120);
  assert.throws(() => service.transitionOrder(o.id, { status: 'shipped' }), /不允许/);
});

test('负库存、预占盘亏和零调整被阻止，失败操作不留流水', t => {
  const { service, product, order } = fixture(t);
  order(115);
  const before = service.snapshot().inventoryLogs.length;
  assert.throws(() => service.adjustStock(product.id, { delta: -10, reason: '盘亏' }), /不能低于/);
  assert.throws(() => service.adjustStock(product.id, { delta: 0, reason: '无变动' }), /不能为零/);
  assert.equal(service.getProduct(product.id).stock, 120);
  assert.equal(service.snapshot().inventoryLogs.length, before);
});

test('发货必填承运商及运单号，失败时保留原订单和库存', t => {
  const { service, product, order } = fixture(t);
  const o = order();
  assert.throws(() => service.transitionOrder(o.id, { status: 'shipped', carrier: '承运商' }), /运单号/);
  assert.equal(service.getOrder(o.id).status, 'pending');
  assert.equal(service.getProduct(product.id).reserved, 3);
});

test('非法输入、重复 SKU 和不存在的客户被拒绝', t => {
  const { service, order } = fixture(t);
  assert.throws(() => order(-1), /整数/);
  assert.throws(() => order(1.2), /整数/);
  assert.throws(() => service.createProduct({ sku: 'PKG-001', name: '重复' }), /SKU 已存在/);
  assert.throws(() => service.createOrder({ customer_id: 999, destination: '测试', items: [{ product_id: 1, quantity: 1 }] }), /客户不存在/);
  assert.equal(service.snapshot().orders.length, 0);
});

test('关闭并重新打开 SQLite 后订单和预占仍然存在', () => {
  const directory = mkdtempSync(join(tmpdir(), 'logistics-test-'));
  const filename = join(directory, 'db.sqlite');
  let db;
  try {
    db = openDatabase(filename);
    const service = new LogisticsService(db);
    seedDemo(service);
    const o = service.createOrder({ customer_id: 1, destination: '持久化测试', items: [{ product_id: 1, quantity: 7 }] });
    db.close(); db = openDatabase(filename);
    const reopened = new LogisticsService(db);
    assert.equal(reopened.getOrder(o.id).destination, '持久化测试');
    assert.equal(reopened.getProduct(1).reserved, 7);
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});
