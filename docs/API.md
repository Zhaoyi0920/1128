# HTTP API 说明

默认地址：`http://127.0.0.1:3000`。除登录和静态资源外，所有接口均需要有效会话。请求与响应均使用 UTF-8 JSON；写请求最大 64 KiB。

## 认证约定

1. `POST /api/login`，JSON 请求体为 `{"password":"你的管理员密码"}`。
2. 保存响应的 `sid` Cookie 和 JSON 中的 `csrf`。
3. 后续请求携带 Cookie；写请求还须携带 `X-CSRF-Token: <csrf>`。
4. 所有 POST 均须携带与服务器访问地址一致的 `Origin`，例如 `http://127.0.0.1:3000`。浏览器前端会自动携带该头。
5. 会话有效期为八小时；重启服务后需重新登录。每个来源 IP 一分钟内累计五次错误密码后暂时限制登录。

`sid` 使用 HttpOnly、SameSite=Strict Cookie。`SECURE_COOKIES=true` 时附加 Secure，写请求 Origin 也必须使用 HTTPS。

## 接口表

| 方法 | 路径 | 作用 | 成功状态 |
| --- | --- | --- | --- |
| POST | `/api/login` | 登录并设置 Cookie | 200 |
| GET | `/api/session` | 读取当前会话 CSRF 令牌 | 200 |
| POST | `/api/logout` | 注销当前会话 | 200 |
| GET | `/api/dashboard` | 客户、商品、订单、最近库存流水和统计 | 200 |
| POST | `/api/customers` | 添加客户 | 201 |
| POST | `/api/products` | 添加商品，初始库存 0 | 201 |
| POST | `/api/products/:id/stock` | 入库或盘亏 | 200 |
| POST | `/api/orders` | 创建订单并预占库存 | 201 |
| GET | `/api/orders/:id` | 订单详情、商品明细及物流轨迹 | 200 |
| POST | `/api/orders/:id/status` | 发货、签收或取消 | 200 |
| POST | `/api/orders/:id/tracking` | 为运输中订单追加物流节点 | 201 |

## 请求体示例

### 添加客户

```json
{"name":"示例客户 C","phone":"13700000000","address":"南京市示例收货点 C"}
```

### 添加商品

```json
{"sku":"PKG-004","name":"加固包装袋","threshold":15}
```

`sku` 必须唯一；`threshold` 可省略，默认为 10。数值字段必须是 JSON 整数，不能使用字符串或小数。

### 入库与盘亏

```json
{"delta":100,"reason":"采购入库"}
```

盘亏示例：`{"delta":-2,"reason":"破损盘亏"}`。不能使实物库存低于预占库存。

### 创建订单

```json
{
  "customer_id":1,
  "destination":"上海市示例收货点 A",
  "items":[
    {"product_id":1,"quantity":3},
    {"product_id":3,"quantity":2}
  ]
}
```

商品明细为 1–50 行；同一商品重复出现会合并数量；每种商品合并后数量不超过 1,000,000。订单创建失败时，库存预占和订单记录全部回滚。

### 状态迁移

发货（必填承运商、运单号）：

```json
{"status":"shipped","carrier":"示例承运商","tracking_number":"DEMO-10001"}
```

签收：`{"status":"delivered"}`。取消待发货订单：`{"status":"cancelled"}`。不提供任意状态覆盖接口。

### 追加轨迹

```json
{"message":"已到达杭州分拨中心，等待派送"}
```

## 响应形状

- 客户：`id, name, phone, address`。
- 商品：`id, sku, name, stock, reserved, threshold, available`。
- 订单详情：`id, number, customer_id, customer_name, destination, status, carrier, tracking_number, created_at, items, events`。
- 仪表盘：`customers[], products[], orders[], inventoryLogs[], metrics`，其中 `metrics` 包含 `total, pending, shipped, delivered, lowStock`。订单列表不包含明细和轨迹，请调用详情接口获取。
- 时间字段为 ISO 8601 UTC 字符串。
- 错误统一为 `{"error":"中文错误信息"}`。

| HTTP 状态 | 含义 |
| --- | --- |
| 400 | 输入校验或 JSON 格式错误 |
| 401 | 未登录、会话过期或密码错误 |
| 403 | Origin 或 CSRF 校验失败 |
| 404 | 接口或业务记录不存在 |
| 409 | SKU 重复、库存不足或非法状态迁移 |
| 413 | 请求体过大 |
| 415 | 写请求不是 application/json |
| 429 | 登录尝试次数过多 |
| 500 | 未预期的服务端错误，详细信息写入服务端日志 |

## 命令行调用示例（Bash）

```bash
read -rsp '管理员密码: ' ADMIN_PASSWORD
echo
# 需要 curl 和 jq；这些工具仅用于命令行演示，系统本身不依赖它们。
LOGIN=$(printf '%s' "$ADMIN_PASSWORD" | jq -Rs '{password:.}' | curl -sS -c cookies.txt \
  -H 'Origin: http://127.0.0.1:3000' \
  -H 'Content-Type: application/json' \
  --data-binary @- http://127.0.0.1:3000/api/login)
CSRF=$(printf '%s' "$LOGIN" | jq -r '.csrf')
curl -sS -b cookies.txt http://127.0.0.1:3000/api/dashboard
curl -sS -b cookies.txt \
  -H 'Origin: http://127.0.0.1:3000' \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: $CSRF" \
  -d '{"customer_id":1,"destination":"测试地址","items":[{"product_id":1,"quantity":1}]}' \
  http://127.0.0.1:3000/api/orders
rm cookies.txt
unset ADMIN_PASSWORD CSRF LOGIN
```

以上客户和商品编号适用于默认演示数据库。密码、Cookie 和 CSRF 值属于本地会话资料，不应提交至仓库。
