import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { openDatabase, seedDemo } from './db.js';
import { BusinessError, LogisticsService, requiredText } from './service.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const SESSION_TTL = 8 * 60 * 60 * 1000;

async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new BusinessError('请使用 application/json', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new BusinessError('请求体不能超过 64 KiB', 413);
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new BusinessError('JSON 格式错误'); }
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/** 只提供明确列出的静态资源，拒绝任意文件路径访问。 */
export function createApp({ db, password, secureCookies = false }) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('管理员密码至少需要 12 个字符');
  const service = new LogisticsService(db);
  const salt = randomBytes(16), passwordHash = scryptSync(password, salt, 64);
  const sessions = new Map(), attempts = new Map();
  const cookie = value => `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${value ? SESSION_TTL / 1000 : 0}${secureCookies ? '; Secure' : ''}`;
  const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (req.method === 'GET' && staticFiles[path]) {
        const [filename, type] = staticFiles[path];
        const content = await readFile(resolve(publicDir, filename));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(content);
      }
      if (!path.startsWith('/api/')) throw new BusinessError('资源不存在', 404);

      // 所有写入要求同源 JSON；登录也受保护。反向代理部署时应保留 Host。
      if (!['GET', 'HEAD'].includes(req.method)) {
        const origin = req.headers.origin;
        const protocol = secureCookies ? 'https' : 'http';
        if (origin !== `${protocol}://${req.headers.host}`) throw new BusinessError('请求来源不合法', 403);
      }
      const now = Date.now();
      for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      const sessionId = /(?:^|;\s*)sid=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const session = sessions.get(sessionId);

      if (path === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        const entry = attempts.get(ip) || { count: 0, until: now + 60000 };
        if (entry.count >= 5) throw new BusinessError('登录尝试过多，请一分钟后重试', 429);
        const data = await jsonBody(req);
        const supplied = requiredText(data.password, '密码', 256);
        const valid = timingSafeEqual(scryptSync(supplied, salt, 64), passwordHash);
        if (!valid) {
          entry.count++;
          attempts.set(ip, entry);
          throw new BusinessError('密码错误', 401);
        }
        attempts.delete(ip);
        if (sessions.size >= 1000) throw new BusinessError('会话数量已达上限', 503);
        if (sessionId) sessions.delete(sessionId);
        const id = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex');
        sessions.set(id, { csrf, expires: now + SESSION_TTL });
        res.setHeader('Set-Cookie', cookie(id));
        return send(res, 200, { csrf });
      }
      if (!session) throw new BusinessError('请先登录', 401);
      if (req.method !== 'GET' && req.headers['x-csrf-token'] !== session.csrf) throw new BusinessError('会话校验失败，请重新登录', 403);
      if (path === '/api/session' && req.method === 'GET') return send(res, 200, { csrf: session.csrf });
      if (path === '/api/logout' && req.method === 'POST') {
        sessions.delete(sessionId);
        res.setHeader('Set-Cookie', cookie(''));
        return send(res, 200, { ok: true });
      }
      if (path === '/api/dashboard' && req.method === 'GET') return send(res, 200, service.snapshot());
      let match;
      if (req.method === 'GET' && (match = /^\/api\/orders\/(\d+)$/.exec(path))) return send(res, 200, service.getOrder(Number(match[1])));
      if (req.method === 'POST') {
        const data = await jsonBody(req);
        if (path === '/api/customers') return send(res, 201, service.createCustomer(data));
        if (path === '/api/products') return send(res, 201, service.createProduct(data));
        if (path === '/api/orders') return send(res, 201, service.createOrder(data));
        if ((match = /^\/api\/products\/(\d+)\/stock$/.exec(path))) return send(res, 200, service.adjustStock(Number(match[1]), data));
        if ((match = /^\/api\/orders\/(\d+)\/status$/.exec(path))) return send(res, 200, service.transitionOrder(Number(match[1]), data));
        if ((match = /^\/api\/orders\/(\d+)\/tracking$/.exec(path))) return send(res, 201, service.appendTracking(Number(match[1]), data));
      }
      throw new BusinessError('接口不存在', 404);
    } catch (error) {
      if (!(error instanceof BusinessError)) console.error(error);
      if (!res.headersSent) send(res, error.status || 500, { error: error instanceof BusinessError ? error.message : '服务器内部错误' });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

// 直接执行时启动；被测试导入时不会监听端口。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDatabase(process.env.DB_PATH || 'data/logistics.sqlite');
  if (process.env.SEED_DEMO !== 'false') seedDemo(new LogisticsService(db));
  const password = process.env.ADMIN_PASSWORD || randomBytes(12).toString('base64url');
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const server = createApp({ db, password, secureCookies: process.env.SECURE_COOKIES === 'true' });
  server.listen(port, host, () => {
    console.log(`物流管理信息系统已启动：http://${host}:${port}`);
    if (!process.env.ADMIN_PASSWORD) console.log(`本次启动的管理员密码：${password}`);
  });
  const shutdown = () => server.close(() => { db.close(); process.exit(0); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
