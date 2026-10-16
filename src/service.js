import { randomUUID } from 'node:crypto';

export class BusinessError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function requiredText(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new BusinessError(`${label}不能为空且长度不能超过 ${max} 个字符`);
  return value.trim();
}

function integer(value, label, min = 1, max = 1000000) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new BusinessError(`${label}必须是 ${min} 到 ${max} 之间的整数`);
  return value;
}

/** 业务层独立于 HTTP：库存预占和状态迁移统一在这里维护。 */
export class LogisticsService {
  constructor(db) { this.db = db; }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getCustomer(id) {
    const row = this.db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!row) throw new BusinessError('客户不存在', 404);
    return row;
  }

  getProduct(id) {
    const row = this.db.prepare('SELECT *, stock - reserved AS available FROM products WHERE id = ?').get(id);
    if (!row) throw new BusinessError('商品不存在', 404);
    return row;
  }

  createCustomer(input) {
    const name = requiredText(input.name, '客户名称', 80);
    const phone = requiredText(input.phone, '联系电话', 32);
    const address = requiredText(input.address, '收货地址', 300);
    const row = this.db.prepare('INSERT INTO customers(name, phone, address) VALUES (?, ?, ?)').run(name, phone, address);
    return this.getCustomer(Number(row.lastInsertRowid));
  }

  createProduct(input) {
    const sku = requiredText(input.sku, 'SKU', 40);
    const name = requiredText(input.name, '商品名称', 100);
    const threshold = integer(input.threshold ?? 10, '预警阈值', 0);
    try {
      const row = this.db.prepare('INSERT INTO products(sku, name, threshold) VALUES (?, ?, ?)').run(sku, name, threshold);
      return this.getProduct(Number(row.lastInsertRowid));
    } catch (error) {
      if (error.message.includes('UNIQUE')) throw new BusinessError('SKU 已存在', 409);
      throw error;
    }
  }

  adjustStock(id, input) {
    const delta = integer(input.delta, '调整数量', -1000000);
    if (!delta) throw new BusinessError('调整数量不能为零');
    const reason = requiredText(input.reason, '调整原因');
    return this.transaction(() => this.adjustStockWithinTransaction(id, delta, reason));
  }

  adjustStockWithinTransaction(id, delta, reason) {
    this.getProduct(id);
    // 条件更新保证盘亏不能占用已经锁给订单的库存。
    const result = this.db.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND stock + ? >= reserved').run(delta, id, delta);
    if (!result.changes) throw new BusinessError('调整后库存不能低于已预占数量', 409);
    this.db.prepare('INSERT INTO inventory_logs(product_id, delta, reason) VALUES (?, ?, ?)').run(id, delta, reason);
    return this.getProduct(id);
  }

  createOrder(input) {
    const customerId = integer(input.customer_id, '客户编号');
    const destination = requiredText(input.destination, '目的地址', 300);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50)
      throw new BusinessError('订单需要 1 到 50 条商品明细');
    // 重复商品合并后再校验，避免拆行绕过可用库存检查。
    const quantities = new Map();
    for (const item of input.items) {
      if (!item || typeof item !== 'object') throw new BusinessError('商品明细格式错误');
      const id = integer(item.product_id, '商品编号');
      const quantity = integer(item.quantity, '商品数量');
      quantities.set(id, integer((quantities.get(id) || 0) + quantity, '商品总数量'));
    }
    return this.transaction(() => {
      this.getCustomer(customerId);
      const number = `WL-${randomUUID().toUpperCase()}`;
      const result = this.db.prepare('INSERT INTO orders(number, customer_id, destination) VALUES (?, ?, ?)').run(number, customerId, destination);
      const orderId = Number(result.lastInsertRowid);
      for (const [id, quantity] of quantities) {
        const product = this.getProduct(id);
        const update = this.db.prepare('UPDATE products SET reserved = reserved + ? WHERE id = ? AND stock - reserved >= ?').run(quantity, id, quantity);
        if (!update.changes) throw new BusinessError(`${product.name} 可用库存不足`, 409);
        this.db.prepare('INSERT INTO order_items(order_id, product_id, quantity) VALUES (?, ?, ?)').run(orderId, id, quantity);
      }
      this.addEvent(orderId, '订单已创建，库存已预占');
      return this.getOrder(orderId);
    });
  }

  getOrder(id) {
    const row = this.db.prepare(`SELECT o.*, c.name AS customer_name FROM orders o
      JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`).get(id);
    if (!row) throw new BusinessError('订单不存在', 404);
    row.items = this.db.prepare(`SELECT i.*, p.sku, p.name FROM order_items i
      JOIN products p ON p.id = i.product_id WHERE i.order_id = ?`).all(id);
    row.events = this.db.prepare('SELECT * FROM tracking_events WHERE order_id = ? ORDER BY id').all(id);
    return row;
  }

  addEvent(id, message) {
    this.db.prepare('INSERT INTO tracking_events(order_id, message) VALUES (?, ?)').run(id, message);
  }

  transitionOrder(id, input) {
    const target = requiredText(input.status, '订单状态', 20);
    return this.transaction(() => {
      const order = this.getOrder(id);
      const transitions = { pending: ['shipped', 'cancelled'], shipped: ['delivered'], delivered: [], cancelled: [] };
      if (!transitions[order.status].includes(target)) throw new BusinessError('不允许该状态变更，请刷新后重试', 409);
      let carrier = order.carrier, tracking = order.tracking_number;
      if (target === 'shipped') {
        carrier = requiredText(input.carrier, '承运商', 80);
        tracking = requiredText(input.tracking_number, '运单号', 80);
      }
      for (const item of order.items) {
        if (target === 'shipped') {
          this.db.prepare('UPDATE products SET stock = stock - ?, reserved = reserved - ? WHERE id = ?').run(item.quantity, item.quantity, item.product_id);
          this.db.prepare('INSERT INTO inventory_logs(product_id, delta, reason) VALUES (?, ?, ?)').run(item.product_id, -item.quantity, `订单 ${order.number} 发货出库`);
        } else if (target === 'cancelled') {
          this.db.prepare('UPDATE products SET reserved = reserved - ? WHERE id = ?').run(item.quantity, item.product_id);
        }
      }
      this.db.prepare('UPDATE orders SET status = ?, carrier = ?, tracking_number = ? WHERE id = ?').run(target, carrier, tracking, id);
      this.addEvent(id, { shipped: `已发货：${carrier} / ${tracking}`, delivered: '收件人已签收', cancelled: '订单已取消，预占库存已释放' }[target]);
      return this.getOrder(id);
    });
  }

  appendTracking(id, input) {
    const message = requiredText(input.message, '物流节点', 300);
    return this.transaction(() => {
      const order = this.getOrder(id);
      if (order.status !== 'shipped') throw new BusinessError('只有运输中的订单可新增物流节点', 409);
      this.addEvent(id, message);
      return this.getOrder(id);
    });
  }

  snapshot() {
    const customers = this.db.prepare('SELECT * FROM customers ORDER BY id DESC').all();
    const products = this.db.prepare('SELECT *, stock - reserved AS available FROM products ORDER BY id').all();
    const orders = this.db.prepare(`SELECT o.*, c.name AS customer_name FROM orders o
      JOIN customers c ON c.id = o.customer_id ORDER BY o.id DESC`).all();
    const inventoryLogs = this.db.prepare(`SELECT l.*, p.name, p.sku FROM inventory_logs l
      JOIN products p ON p.id = l.product_id ORDER BY l.id DESC LIMIT 100`).all();
    return { customers, products, orders, inventoryLogs, metrics: {
      total: orders.length, pending: orders.filter(o => o.status === 'pending').length,
      shipped: orders.filter(o => o.status === 'shipped').length,
      delivered: orders.filter(o => o.status === 'delivered').length,
      lowStock: products.filter(p => p.available <= p.threshold).length,
    } };
  }
}
