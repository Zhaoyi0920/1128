import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openDatabase, seedDemo } from '../src/db.js';
import { LogisticsService } from '../src/service.js';
import { createApp } from '../src/server.js';

const password = 'test-admin-password-123';
async function start(t) {
  const db = openDatabase(':memory:');
  seedDemo(new LogisticsService(db));
  const server = createApp({ db, password });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, extra = {}) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { base, request };
}

test('登录保护、CSRF、业务接口和退出会话完整流程', async t => {
  const { request } = await start(t);
  assert.equal((await request('/api/dashboard')).status, 401);
  assert.equal((await request('/api/login', { password: 'wrong' })).status, 401);
  const login = await request('/api/login', { password });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await login.json();
  const auth = { Cookie: cookie, 'X-CSRF-Token': csrf };
  assert.equal((await request('/api/orders', {}, { Cookie: cookie })).status, 403);
  assert.equal((await request('/api/orders', {}, { ...auth, Origin: 'https://example.org' })).status, 403);
  const dashboard = await request('/api/dashboard', undefined, auth);
  assert.equal((await dashboard.json()).products.length, 3);
  const response = await request('/api/orders', { customer_id: 1, destination: 'HTTP 测试', items: [{ product_id: 1, quantity: 2 }] }, auth);
  assert.equal(response.status, 201);
  const order = await response.json();
  assert.equal((await request(`/api/orders/${order.id}/status`, { status: 'shipped', carrier: '测试承运商', tracking_number: 'T001' }, auth)).status, 200);
  assert.equal((await request(`/api/orders/${order.id}/tracking`, { message: '运输节点' }, auth)).status, 201);
  assert.equal((await request(`/api/orders/${order.id}/status`, { status: 'delivered' }, auth)).status, 200);
  assert.equal((await request('/api/logout', {}, auth)).status, 200);
  assert.equal((await request('/api/dashboard', undefined, auth)).status, 401);
});

test('登录失败限流及静态路径边界', async t => {
  const { request } = await start(t);
  for (let i = 0; i < 5; i++) assert.equal((await request('/api/login', { password: 'incorrect' })).status, 401);
  assert.equal((await request('/api/login', { password })).status, 429);
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await request('/src/server.js')).status, 404);
  assert.equal((await request('/data/logistics.sqlite')).status, 404);
});

test('畸形 JSON 和超大请求返回明确错误', async t => {
  const { base, request } = await start(t);
  const raw = body => fetch(base + '/api/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body });
  assert.equal((await raw('{')).status, 400);
  assert.equal((await raw('[]')).status, 400);
  assert.equal((await raw(JSON.stringify({ password: 'x'.repeat(70000) }))).status, 413);
  assert.equal((await request('/api/login', { password }, { 'Content-Type': 'text/plain' })).status, 415);
});
