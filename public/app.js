const $ = selector => document.querySelector(selector);
const labels = { pending: '待发货', shipped: '运输中', delivered: '已签收', cancelled: '已取消' };
const titles = { dashboard: '运营总览', orders: '订单与运输', inventory: '库存管理', customers: '客户档案' };
let state = { customers: [], products: [], orders: [], inventoryLogs: [], metrics: {} };
let currentView = 'dashboard', csrf = '';

// 所有来自用户/数据库的文本先转义，再插入模板，阻止 HTML 注入。
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
const badge = status => `<span class="badge ${esc(status)}">${esc(labels[status] || status)}</span>`;
const button = (action, text, id = '') => `<button class="text-button" data-action="${action}" data-id="${id}">${text}</button>`;
const table = (heads, rows) => `<div class="table-wrap"><table><thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${heads.length}" class="empty">暂无数据，请先添加记录</td></tr>`}</tbody></table></div>`;

async function api(path, body) {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(data.error || '请求失败');
  }
  return data;
}

function showLogin() {
  $('#login').hidden = false;
  $('#workspace').hidden = true;
  $('#modal').close();
  csrf = '';
}

function notify(message, error = false) {
  $('#notice').hidden = false;
  $('#notice').textContent = message;
  $('#notice').className = error ? 'error' : '';
}

async function refresh() {
  state = await api('/dashboard');
  $('#login').hidden = true;
  $('#workspace').hidden = false;
  render();
}

function orderRows(orders) {
  return orders.map(o => `<tr data-status="${esc(o.status)}" data-search="${esc([o.number, o.customer_name, o.destination, labels[o.status], date(o.created_at)].join(' '))}"><td class="number" title="${esc(o.number)}">${esc(o.number.slice(0, 15))}…</td><td>${esc(o.customer_name)}</td><td>${esc(o.destination)}</td><td>${badge(o.status)}</td><td>${date(o.created_at)}</td><td>${button('detail', '查看详情', o.id)}</td></tr>`).join('');
}

function render() {
  $('#page-title').textContent = titles[currentView];
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === currentView));
  if (currentView === 'dashboard') renderDashboard();
  if (currentView === 'orders') renderOrders();
  if (currentView === 'inventory') renderInventory();
  if (currentView === 'customers') renderCustomers();
}

function renderDashboard() {
  const m = state.metrics;
  const cards = [['全部订单', m.total, '覆盖订单完整生命周期'], ['待发货', m.pending, '库存已预占，等待出库'], ['运输中', m.shipped, '持续跟进运输状态'], ['库存预警', m.lowStock, '可用数量不高于预警阈值']];
  const low = state.products.filter(p => p.available <= p.threshold);
  $('#content').innerHTML = `<div class="cards">${cards.map(c => `<div class="card"><p>${c[0]}</p><strong class="number">${c[1]}</strong><small>${c[2]}</small></div>`).join('')}</div>
    <div class="callout">业务流程：建立客户与商品档案 → 入库 → 创建订单 → 发货 → 签收。库存与订单状态自动联动。</div>
    <div class="panel"><div class="panel-head"><h2>最近订单</h2><button data-action="new-order">＋ 创建订单</button></div>${table(['订单编号', '客户', '目的地址', '状态', '创建时间', '操作'], orderRows(state.orders.slice(0, 6)))}</div>
    <div class="grid-two"><div class="panel"><h2>补货关注</h2>${low.map(p => `<div class="metric-row"><span>${esc(p.name)}<small class="muted"> / ${esc(p.sku)}</small></span><strong class="danger">${p.available} 件</strong></div>`).join('') || '<p class="muted">当前库存充足</p>'}</div>
    <div class="panel"><h2>履约进度</h2><div class="metric-row"><span>已签收</span><strong>${m.delivered} 单</strong></div><div class="metric-row"><span>客户档案</span><strong>${state.customers.length} 个</strong></div><div class="metric-row"><span>商品种类</span><strong>${state.products.length} 种</strong></div></div></div>`;
}

function renderOrders() {
  $('#content').innerHTML = `<div class="panel"><div class="toolbar"><input id="search" placeholder="搜索订单、客户或地址" aria-label="搜索订单"><select id="status-filter" aria-label="筛选状态"><option value="">全部状态</option>${Object.entries(labels).map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select><div class="actions"><button data-action="export" class="secondary">导出 CSV</button><button data-action="new-order">＋ 创建订单</button></div></div>${table(['订单编号', '客户', '目的地址', '状态', '创建时间', '操作'], orderRows(state.orders))}</div>`;
  bindFilter();
}

function renderInventory() {
  $('#content').innerHTML = `<div class="panel"><div class="toolbar"><input id="search" placeholder="搜索 SKU 或商品" aria-label="搜索库存"><button data-action="new-product">＋ 新建商品</button></div>${table(['SKU', '商品名称', '实物库存', '预占库存', '可用库存', '预警阈值', '操作'], state.products.map(p => `<tr><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${p.stock}</td><td>${p.reserved}</td><td class="${p.available <= p.threshold ? 'danger' : ''}">${p.available}${p.available <= p.threshold ? ' · 需补货' : ''}</td><td>${p.threshold}</td><td>${button('stock', '入库 / 调整', p.id)}</td></tr>`).join(''))}</div>
    <div class="panel"><h2>最近 100 条库存流水</h2>${table(['时间', 'SKU', '商品名称', '变动数量', '原因'], state.inventoryLogs.map(l => `<tr><td>${date(l.created_at)}</td><td>${esc(l.sku)}</td><td>${esc(l.name)}</td><td class="number">${l.delta > 0 ? '+' : ''}${l.delta}</td><td>${esc(l.reason)}</td></tr>`).join(''))}</div>`;
  bindFilter();
}

function renderCustomers() {
  $('#content').innerHTML = `<div class="panel"><div class="toolbar"><input id="search" placeholder="搜索客户、电话或地址" aria-label="搜索客户"><button data-action="new-customer">＋ 添加客户</button></div>${table(['编号', '客户名称', '联系电话', '收货地址'], state.customers.map(c => `<tr><td>${c.id}</td><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${esc(c.address)}</td></tr>`).join(''))}</div>`;
  bindFilter();
}

function bindFilter() {
  const filter = () => {
    const query = $('#search').value.trim().toLowerCase(), status = $('#status-filter')?.value;
    document.querySelectorAll('#content .panel:first-child tbody tr').forEach(row => {
      row.hidden = !(row.dataset.search || row.textContent).toLowerCase().includes(query) || Boolean(status && row.dataset.status !== status);
    });
  };
  $('#search').addEventListener('input', filter);
  $('#status-filter')?.addEventListener('change', filter);
}

function modal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal-error').textContent = '';
  if (!$('#modal').open) $('#modal').showModal();
}

const field = (name, title, type = 'text', max = 100) => `<label>${title}<input name="${name}" type="${type}" ${type === 'number' ? 'min="0" max="1000000" step="1"' : `maxlength="${max}"`} required></label>`;
const form = fields => `<form id="edit-form"><div class="form-grid">${fields}</div><div class="form-footer"><button type="submit">保存</button></div></form>`;

function bindForm(handler) {
  $('#edit-form').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('[type="submit"]');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    submit.disabled = true;
    try {
      await handler(values);
      $('#modal').close();
      await refresh();
      notify('操作成功，数据已保存');
    } catch (error) { $('#modal-error').textContent = error.message; }
    finally { submit.disabled = false; }
  });
}

function newCustomer() {
  modal('添加客户', form(`${field('name', '客户名称', 'text', 80)}${field('phone', '联系电话', 'tel', 32)}<div class="full">${field('address', '收货地址', 'text', 300)}</div>`));
  bindForm(values => api('/customers', values));
}

function newProduct() {
  modal('新建商品', form(`${field('sku', '商品 SKU', 'text', 40)}${field('name', '商品名称')}${field('threshold', '库存预警阈值', 'number')}<p class="muted">新商品初始库存为 0，保存后请进行入库操作。</p>`));
  $('#edit-form [name="threshold"]').value = 10;
  bindForm(values => api('/products', { ...values, threshold: Number(values.threshold) }));
}

function adjustStock(id) {
  const product = state.products.find(p => p.id === id);
  modal(`库存调整 · ${product.name}`, form(`<p class="full muted">实物 ${product.stock} / 预占 ${product.reserved} / 可用 ${product.available}。正数表示入库，负数表示盘亏。</p>${field('delta', '调整数量（件）', 'number')}${field('reason', '调整原因', 'text', 200)}`));
  $('#edit-form [name="delta"]').min = -1000000;
  bindForm(values => api(`/products/${id}/stock`, { ...values, delta: Number(values.delta) }));
}

function addItem() {
  const row = document.createElement('div');
  row.className = 'item-row';
  row.innerHTML = `<select name="product" aria-label="商品" required>${state.products.map(p => `<option value="${p.id}">${esc(p.name)} / ${esc(p.sku)}（可用 ${p.available}）</option>`).join('')}</select><input name="quantity" type="number" min="1" max="1000000" step="1" value="1" aria-label="数量" required><button type="button" class="secondary" data-action="remove-item" aria-label="移除此商品">×</button>`;
  $('#order-items').append(row);
}

function newOrder() {
  if (!state.customers.length || !state.products.length) return notify('请先添加客户与商品，并完成入库', true);
  modal('创建物流订单', form(`<label class="full">客户<select name="customer_id" id="order-customer" required>${state.customers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label><div class="full">${field('destination', '目的地址', 'text', 300)}</div><div class="full"><p>商品明细</p><div id="order-items"></div><button type="button" data-action="add-item" class="secondary">＋ 添加一行</button></div>`));
  const fillAddress = () => { $('#edit-form [name="destination"]').value = state.customers.find(c => c.id === Number($('#order-customer').value)).address; };
  $('#order-customer').addEventListener('change', fillAddress);
  fillAddress(); addItem();
  bindForm(values => {
    const items = [...document.querySelectorAll('.item-row')].map(row => ({ product_id: Number(row.querySelector('select').value), quantity: Number(row.querySelector('input').value) }));
    return api('/orders', { customer_id: Number(values.customer_id), destination: values.destination, items });
  });
}

async function showOrder(id) {
  const order = await api(`/orders/${id}`);
  const actions = order.status === 'pending' ? `<div class="form-footer"><button data-action="cancel-order" class="secondary" data-id="${id}">取消订单</button><button data-action="ship-order" data-id="${id}">安排发货</button></div>` : order.status === 'shipped' ? `<div class="form-footer"><button data-action="track-order" class="secondary" data-id="${id}">添加物流节点</button><button data-action="deliver-order" data-id="${id}">确认签收</button></div>` : '';
  modal('订单详情', `<div class="details"><p><b>完整订单号：</b>${esc(order.number)}</p><p><b>客户：</b>${esc(order.customer_name)}　${badge(order.status)}</p><p><b>目的地址：</b>${esc(order.destination)}</p>${order.carrier ? `<p><b>承运商：</b>${esc(order.carrier)} / ${esc(order.tracking_number)}</p>` : ''}</div>${table(['SKU', '商品', '数量'], order.items.map(i => `<tr><td>${esc(i.sku)}</td><td>${esc(i.name)}</td><td>${i.quantity}</td></tr>`).join(''))}<h2>物流轨迹</h2><ol class="timeline">${order.events.map(e => `<li><small>${date(e.created_at)}</small>${esc(e.message)}</li>`).join('')}</ol>${actions}`);
}

function shipOrder(id) {
  modal('安排发货', form(`${field('carrier', '承运商', 'text', 80)}${field('tracking_number', '运单号', 'text', 80)}<p class="full muted">保存后系统将扣减实物库存，订单进入运输中。</p>`));
  bindForm(values => api(`/orders/${id}/status`, { status: 'shipped', ...values }));
}

function trackOrder(id) {
  modal('添加物流节点', form(`<div class="full">${field('message', '物流进展（例如：已到达杭州分拨中心）', 'text', 300)}</div>`));
  bindForm(values => api(`/orders/${id}/tracking`, values));
}

function confirmStatus(id, status) {
  const message = status === 'cancelled' ? '确认取消该订单？预占库存将释放，订单不能恢复。' : '确认收件人已签收？确认后订单完成。';
  modal(status === 'cancelled' ? '取消订单' : '确认签收', form(`<p class="full">${message}</p>`));
  bindForm(() => api(`/orders/${id}/status`, { status }));
}

function exportCsv() {
  // CSV 双引号转义，并给公式前缀加单引号，避免表格软件执行单元格内容。
  const cell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const query = $('#search')?.value.trim().toLowerCase() || '', status = $('#status-filter')?.value;
  const orders = state.orders.filter(o => (!status || o.status === status) && [o.number, o.customer_name, o.destination, labels[o.status], date(o.created_at)].join(' ').toLowerCase().includes(query));
  const rows = [['订单编号', '客户', '目的地址', '状态', '承运商', '运单号', '创建时间'], ...orders.map(o => [o.number, o.customer_name, o.destination, labels[o.status], o.carrier, o.tracking_number, o.created_at])];
  const blob = new Blob(['\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = '物流订单.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const id = Number(target.dataset.id);
  const actions = {
    'new-customer': newCustomer, 'new-product': newProduct, 'new-order': newOrder,
    stock: () => adjustStock(id), detail: () => showOrder(id), 'add-item': addItem,
    'remove-item': () => { if (document.querySelectorAll('.item-row').length > 1) target.closest('.item-row').remove(); },
    'ship-order': () => shipOrder(id), 'track-order': () => trackOrder(id),
    'cancel-order': () => confirmStatus(id, 'cancelled'), 'deliver-order': () => confirmStatus(id, 'delivered'), export: exportCsv,
  };
  try { await actions[target.dataset.action]?.(); }
  catch (error) { notify(error.message, true); }
});

document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { currentView = b.dataset.view; $('#notice').hidden = true; render(); }));
$('#refresh').addEventListener('click', () => refresh().catch(e => notify(e.message, true)));
$('#close-modal').addEventListener('click', () => $('#modal').close());
$('#logout').addEventListener('click', async () => { try { await api('/logout', {}); showLogin(); } catch (e) { notify(e.message, true); } });
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const loginForm = event.currentTarget;
  const submit = loginForm.querySelector('button');
  submit.disabled = true; $('#login-error').textContent = '';
  try {
    const data = await api('/login', { password: new FormData(loginForm).get('password') });
    csrf = data.csrf; loginForm.reset(); await refresh();
  } catch (e) { $('#login-error').textContent = e.message; }
  finally { submit.disabled = false; }
});

// 刷新页面时通过 HttpOnly Cookie 恢复会话，密码不写入浏览器存储。
api('/session').then(data => { csrf = data.csrf; return refresh(); }).catch(error => {
  if (csrf) $('#login-error').textContent = error.message;
});
