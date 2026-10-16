import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 所有业务数据落盘；测试可传入 :memory:，互不污染。 */
export function openDatabase(filename = 'data/logistics.sqlite') {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      phone TEXT NOT NULL, address TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY, sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
      reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0 AND reserved <= stock),
      threshold INTEGER NOT NULL DEFAULT 10 CHECK(threshold >= 0)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      destination TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','shipped','delivered','cancelled')),
      carrier TEXT NOT NULL DEFAULT '', tracking_number TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS order_items (
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      PRIMARY KEY(order_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS tracking_events (
      id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS inventory_logs (
      id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
      delta INTEGER NOT NULL CHECK(delta != 0), reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  return db;
}

/** 示例客户、商品全部为虚构资料；库存通过正式入库接口录入。 */
export function seedDemo(service) {
  const db = service.db;
  const existing = db.prepare(`SELECT
    (SELECT COUNT(*) FROM customers) + (SELECT COUNT(*) FROM products) +
    (SELECT COUNT(*) FROM orders) AS n`).get().n;
  if (existing > 0) return;
  service.transaction(() => {
    service.createCustomer({ name: '示例客户 A', phone: '13800000000', address: '上海市示例收货点 A' });
    service.createCustomer({ name: '示例客户 B', phone: '13900000000', address: '杭州市示例收货点 B' });
    for (const [sku, name, stock, threshold] of [
      ['PKG-001', '标准包装箱', 120, 20],
      ['PKG-002', '防震填充袋', 8, 15],
      ['PKG-003', '封箱胶带', 60, 10],
    ]) {
      const product = service.createProduct({ sku, name, threshold });
      service.adjustStockWithinTransaction(product.id, stock, '演示初始化入库');
    }
  });
}
