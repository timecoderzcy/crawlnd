# Crawlnd Admin API（前端对接）

> 管理台 HTTP API 契约。启动：`npm run admin`  
> Base URL 默认：`http://127.0.0.1:8787`（`.env`：`ADMIN_HOST` / `ADMIN_PORT`）  
> CORS：已对 `/api/*` 开放 `*`。  
> **鉴权：** 配置了 `ADMIN_PASSWORD` 后，除白名单外均需 `Authorization: Bearer <token>`（单人密码门）。  
> **新建任务表单（动态 schema / widget）：** [`param-schema-and-forms.md`](./param-schema-and-forms.md)

---

## 约定

| 项 | 说明 |
|----|------|
| 数据格式 | JSON，`Content-Type: application/json` |
| 时间字段 | ISO 8601 字符串（如 `2026-07-29T08:12:00.000Z`），或 `null` |
| 成功创建 | 多数返回 `201` + 资源体；列表为 `{ items: T[] }` |
| 业务/参数错误 | `400` + `{ "error": "说明文字" }` |
| 资源不存在 | `404` + `{ "error": "…" }` |
| 字段命名 | 响应为 **camelCase** |
| 鉴权 | 见下文「鉴权」；`401` + `{ "error": "…" }` |

**分页 params（卓创 / 商务部）：**

| mode | 必填字段 | 含义 |
|------|----------|------|
| `single` | `pageNO` | 只抓一页 |
| `range` | `from`, `to` | 闭区间；前 N 页 = `from: 1, to: N` |

---

## 类型一览

```ts
type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
type RunTriggerType = 'manual' | 'schedule'
type OverlapPolicy = 'skip' | 'queue' | 'replace'  // 一期仅实现 skip

interface CrawlRunStats {
  pages: number
  items: number
  saved: number
  skipped: number
  errors: number
}

/** 单次覆盖（浅覆盖 App 配置） */
interface CrawlRunOptions {
  concurrentRequests?: number  // 1..32
  concurrentSpiders?: number   // 1..8
  delay?: number               // ms；>0 时强制串行
  obeyRobotsTxt?: boolean
}

/** App / 工程级配置（存 Profile + Run snapshot） */
interface CrawlAppConfig {
  concurrentRequests?: number
  concurrentSpiders?: number
  delay?: number
  obeyRobotsTxt?: boolean
  defaultHeaders?: Record<string, string>
  validDomains?: string[]
}

/** Spider 运行时配置（不含 keyword 等业务 params） */
interface CrawlSpiderConfig {
  defaultHeaders?: Record<string, string>  // 覆盖站点内置同名头
  validDomains?: string[]
}

interface AppProfile {
  id: number
  name: string
  description: string
  config: CrawlAppConfig
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

interface SpiderProfile {
  id: number
  spider: string
  name: string
  description: string
  config: CrawlSpiderConfig
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

interface CrawlRun {
  id: number
  spider: string
  params: Record<string, unknown>
  options: CrawlRunOptions
  appProfileId: number | null
  spiderProfileId: number | null
  appConfig: CrawlAppConfig      // 执行时固化的 snapshot
  spiderConfig: CrawlSpiderConfig
  status: RunStatus
  triggerType: RunTriggerType
  scheduleId: number | null
  stats: CrawlRunStats | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

interface SpiderMeta {
  name: string
  label: string
  description: string
  paramSchema: {
    type: 'object'
    required?: string[]
    properties: Record<string, Record<string, unknown>>
  }
  defaultSpiderProfileId: number | null
}

interface CrawlSchedule {
  id: number
  name: string
  spider: string
  params: Record<string, unknown>
  options: CrawlRunOptions
  appProfileId: number | null
  spiderProfileId: number | null
  appConfig: CrawlAppConfig
  spiderConfig: CrawlSpiderConfig
  cron: string
  timezone: string
  enabled: boolean
  overlapPolicy: OverlapPolicy
  nextRunAt: string | null
  lastRunAt: string | null
  lastRunId: number | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

interface CrawlLogRow {
  id: number
  ts: string
  spider: string
  level: string
  event: string | null
  message: string
  fields: unknown | null
  runId: number | null
}
```

**配置解析顺序：** 指定 Profile → 该层默认 Profile → `.env` / 空 Spider 配置；再用 `options` 浅覆盖 App；结果写入 Run/Schedule 的 `appConfig` / `spiderConfig` snapshot。

---

## 接口列表

| 方法 | 路径 | 说明 | 需登录 |
|------|------|------|--------|
| GET | `/api/health` | 健康检查 | 否 |
| GET | `/api/auth/status` | 是否启用鉴权 | 否 |
| POST | `/api/auth/login` | 密码登录拿 token | 否 |
| GET | `/api/auth/me` | 当前登录主体 | 是* |
| GET | `/api/stats/overview` | 全平台基础概览（仪表盘） | 是* |
| GET | `/api/spiders` | Spider 目录 + 表单 schema | 是* |
| GET | `/api/app-profiles` | App 配置套餐列表 | 是* |
| POST | `/api/app-profiles` | 创建 App 配置 | 是* |
| GET | `/api/app-profiles/:id` | App 配置详情 | 是* |
| PATCH | `/api/app-profiles/:id` | 更新 App 配置 | 是* |
| DELETE | `/api/app-profiles/:id` | 删除（不能删默认） | 是* |
| POST | `/api/app-profiles/:id/set-default` | 设为全局默认 | 是* |
| GET | `/api/spider-profiles` | Spider 配置列表（`?spider=`） | 是* |
| POST | `/api/spider-profiles` | 创建 Spider 配置 | 是* |
| GET | `/api/spider-profiles/:id` | Spider 配置详情 | 是* |
| PATCH | `/api/spider-profiles/:id` | 更新 | 是* |
| DELETE | `/api/spider-profiles/:id` | 删除 | 是* |
| POST | `/api/spider-profiles/:id/set-default` | 设为该站默认 | 是* |
| GET | `/api/runs` | 任务列表 | 是* |
| POST | `/api/runs` | 创建并启动任务 | 是* |
| GET | `/api/runs/:id` | 任务详情 | 是* |
| POST | `/api/runs/:id/stop` | 停止任务 | 是* |
| GET | `/api/runs/:id/logs` | 任务日志 | 是* |
| GET | `/api/logs` | 全局日志（可筛选） | 是* |
| GET | `/api/schedules` | 计划列表 | 是* |
| POST | `/api/schedules` | 创建计划 | 是* |
| GET | `/api/schedules/:id` | 计划详情（含最近 Runs） | 是* |
| PATCH | `/api/schedules/:id` | 更新计划 | 是* |
| DELETE | `/api/schedules/:id` | 删除计划 | 是* |
| POST | `/api/schedules/:id/enable` | 启用 | 是* |
| POST | `/api/schedules/:id/disable` | 禁用 | 是* |
| POST | `/api/schedules/:id/trigger` | 立即触发一次 | 是* |

\* `ADMIN_PASSWORD` 为空时鉴权关闭，标「是」的接口也可直接访问（仅建议本机临时调试）。

---

## 0. 鉴权（单人密码门）

### 环境变量

| 变量 | 说明 |
|------|------|
| `ADMIN_PASSWORD` | 登录密码；**非空则启用鉴权** |
| `ADMIN_JWT_SECRET` | 可选，JWT 密钥；默认回退到 `ADMIN_PASSWORD` |
| `ADMIN_TOKEN_TTL_SECONDS` | 可选，token 秒数，默认 `604800`（7 天） |

### 登录

`POST /api/auth/login`

```json
{ "password": "change-me" }
```

**响应 `200`**

```json
{
  "token": "<jwt>",
  "tokenType": "Bearer",
  "expiresAt": "2026-08-05T08:00:00.000Z"
}
```

**响应 `401`：** `{ "error": "密码错误" }`

### 后续请求

```http
Authorization: Bearer <token>
```

### 状态 / 探活

- `GET /api/auth/status` → `{ "authRequired": true }`（前端据此决定是否跳登录页）
- `GET /api/auth/me` → `{ "sub": "admin", "authRequired": true }`（需 token）

### 前端建议

```ts
// 登录后
localStorage.setItem('admin_token', data.token)

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('admin_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

http.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('admin_token')
      // router.push('/login')
    }
    return Promise.reject(err)
  },
)
```

启动时先调 `GET /api/auth/status`：`authRequired === true` 且无 token → 登录页。

---

## 1. 健康检查

`GET /api/health`

**响应 `200`**

```json
{ "ok": true }
```

---

## 1.1 全平台概览（仪表盘）

`GET /api/stats/overview`

聚合 `crawl_runs` / `crawl_schedules` / `crawl_logs` 的基础指标，供首页卡片使用。

**响应 `200` 示例**

```json
{
  "generatedAt": "2026-07-29T09:40:00.000Z",
  "runs": {
    "total": 120,
    "byStatus": {
      "pending": 0,
      "running": 1,
      "succeeded": 100,
      "failed": 15,
      "cancelled": 4
    },
    "byTrigger": { "manual": 80, "schedule": 40 },
    "successRate": 0.8696,
    "last24h": 8,
    "last7d": 35,
    "active": 1
  },
  "totals": {
    "pages": 500,
    "items": 12000,
    "saved": 8000,
    "skipped": 4000,
    "errors": 12
  },
  "bySpider": [
    {
      "spider": "exampleSpider",
      "total": 70,
      "succeeded": 60,
      "failed": 8,
      "successRate": 0.8824
    }
  ],
  "schedules": { "total": 3, "enabled": 2 },
  "logs": { "total": 5000, "errors": 40 }
}
```

| 字段 | 说明 |
|------|------|
| `runs.successRate` | `succeeded / (succeeded + failed)`，无样本时为 `null` |
| `runs.active` | `pending + running` |
| `totals` | 所有带 `stats` 的 Run 累加（pages/items/saved/skipped/errors） |
| `bySpider[].successRate` | 同上，按站点 |

前端可用 `a-statistic`；建议仪表盘每 15~30s 轮询一次。

```ts
export const getOverviewStats = () => http.get<PlatformOverview>('/api/stats/overview')
```

---

## 2. Spider 列表

`GET /api/spiders`

用 `paramSchema` **动态**渲染新建 Run / Schedule 表单。  

**前端硬性要求：** 不要写死分页或关键词字段；必须按当前 Spider 的 `paramSchema`（含 `x-ui-widget` / `x-ui-form`）渲染。完整约定见 [`param-schema-and-forms.md`](./param-schema-and-forms.md)。

**响应 `200`**

```json
{
  "defaultAppProfileId": 1,
  "items": [
    {
      "name": "exampleSpider",
      "label": "卓创资讯",
      "description": "卓创资讯价格搜索（JSON API）",
      "defaultSpiderProfileId": null,
      "paramSchema": {
        "type": "object",
        "required": ["keyword", "pagination"],
        "properties": {
          "keyword": { "type": "string", "title": "关键词", "minLength": 1 },
          "pageSize": { "type": "integer", "title": "每页条数", "default": 20, "minimum": 1 },
          "pagination": {
            "type": "object",
            "title": "分页",
            "required": ["mode"],
            "properties": {
              "mode": { "type": "string", "enum": ["single", "range"], "title": "分页模式" },
              "pageNO": { "type": "integer", "title": "页码（single）", "minimum": 1 },
              "from": { "type": "integer", "title": "起始页（range）", "minimum": 1 },
              "to": { "type": "integer", "title": "结束页（range）", "minimum": 1 }
            }
          }
        }
      }
    }
  ]
}
```

当前内置 Spider：`exampleSpider` | `exampleSpider` | `exampleSpider`。

---

## 2.1 App / Spider 配置套餐（Profile）

配置存表，前端下拉选用。启动 admin 时若无默认 App Profile，会自动插入「系统默认」（内容来自 `.env`）。

### App Profiles

| 方法 | 路径 |
|------|------|
| GET | `/api/app-profiles` → `{ items: AppProfile[] }` |
| POST | `/api/app-profiles` |
| GET/PATCH/DELETE | `/api/app-profiles/:id` |
| POST | `/api/app-profiles/:id/set-default` |

创建示例：

```json
{
  "name": "保守限速",
  "description": "低并发 + 间隔",
  "isDefault": false,
  "config": {
    "concurrentRequests": 2,
    "delay": 500,
    "obeyRobotsTxt": false
  }
}
```

注意：`delay > 0` 时框架强制串行（忽略并发）。不能删除当前默认 App Profile。

### Spider Profiles

| 方法 | 路径 |
|------|------|
| GET | `/api/spider-profiles?spider=exampleSpider` |
| POST | `/api/spider-profiles` |
| GET/PATCH/DELETE | `/api/spider-profiles/:id` |
| POST | `/api/spider-profiles/:id/set-default` |

创建示例：

```json
{
  "spider": "exampleSpider",
  "name": "默认头覆盖",
  "isDefault": true,
  "config": {
    "defaultHeaders": { "User-Agent": "CrawlndAdmin/1.0" },
    "validDomains": ["sci99.com", "*.sci99.com"]
  }
}
```

`defaultHeaders` 与站点内置头合并，**同名键以 Profile 为准**。不要把长期 Cookie 明文存库（有泄露风险）。

---

## 3. 任务 Run

### 3.1 列表

`GET /api/runs`

| Query | 类型 | 默认 | 说明 |
|-------|------|------|------|
| `limit` | number | `50` | 最大 `200` |
| `scheduleId` | number | — | 只返回该计划产生的 Run |

**响应 `200`：** `{ "items": CrawlRun[] }`（按 id 倒序）

### 3.2 创建并启动

`POST /api/runs`

**请求体**

```json
{
  "spider": "exampleSpider",
  "params": {
    "keyword": "原油",
    "pageSize": 20,
    "pagination": { "mode": "range", "from": 1, "to": 3 }
  },
  "appProfileId": 1,
  "spiderProfileId": null,
  "options": {
    "concurrentRequests": 4
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `spider` | 是 | 须为已注册 name |
| `params` | 否 | 默认 `{}`；字段以该站 `paramSchema` 为准 |
| `appProfileId` | 否 | 省略则用默认 App Profile / `.env` |
| `spiderProfileId` | 否 | 省略则用该站默认 Spider Profile（可无） |
| `options` | 否 | 单次浅覆盖 App 配置 |
| `options.concurrentRequests` | 否 | 1..32 |

前端建议：App / Spider Profile 下拉 + **SchemaForm（仅跟 paramSchema）** + 可选 `options`；表单规则见 [`param-schema-and-forms.md`](./param-schema-and-forms.md)。

**响应 `201`：** `CrawlRun`（初始多为 `pending` / `running`）  
**响应 `400`：** spider 未知、params 非法等

### 3.3 详情

`GET /api/runs/:id`

**响应 `200`：** `CrawlRun`  
**响应 `404`：** `{ "error": "任务不存在" }`

建议详情页每 **3s** 轮询，直至 `status` 为终态：`succeeded` | `failed` | `cancelled`。

### 3.4 停止

`POST /api/runs/:id/stop`

协作式取消：标记 `cancelled`；当前请求轮次可能仍会跑完。

**响应 `200`：** 更新后的 `CrawlRun`  
已终态则原样返回。

### 3.5 日志

`GET /api/runs/:id/logs?limit=200`

| Query | 默认 | 上限 |
|-------|------|------|
| `limit` | `200` | `1000` |

**响应 `200`**

```json
{
  "items": [
    {
      "id": 1,
      "ts": "2026-07-29T08:12:00.000Z",
      "spider": "exampleSpider",
      "level": "info",
      "event": "start",
      "message": "开始",
      "fields": { "keyword": "原油", "pageSize": 20 },
      "runId": 7
    },
    { "event": "seeds", "message": "种子", "runId": 7 },
    { "event": "page", "message": "分页", "runId": 7 },
    { "event": "done", "message": "完成", "runId": 7 }
  ]
}
```

典型 `event`：`start` → `seeds` → `page`（可多条）→ `done`；失败时有 `error`。  
与详情一起轮询即可（一期无 SSE）。

### 3.6 全局日志

`GET /api/logs`

按 id **倒序**（最新在前）。任务详情内日志仍用 `GET /api/runs/:id/logs`（正序）。

| Query | 类型 | 默认 | 说明 |
|-------|------|------|------|
| `limit` | number | `100` | 最大 `1000` |
| `beforeId` | number | — | `id < beforeId`，用于加载更旧一页 |
| `spider` | string | — | 如 `exampleSpider` |
| `level` | string | — | `debug` / `info` / `warn` / `error` |
| `event` | string | — | 如 `page`、`error` |
| `runId` | number | — | 按任务过滤 |

**响应 `200`：** `{ "items": CrawlLogRow[] }`

```ts
// 首页
http.get('/api/logs', { params: { limit: 100 } })
// 下一页（更旧）：取当前列表最后一条的 id
http.get('/api/logs', { params: { limit: 100, beforeId: lastItem.id } })
// 筛选
http.get('/api/logs', { params: { spider: 'exampleSpider', level: 'error' } })
```

---

## 4. 定时计划 Schedule

模型：**Schedule = 配置；到点调用与手动相同的 createRun**（`triggerType=schedule`）。  
调度挂在 admin 进程内（默认约 15s tick）。**仅支持单实例 admin**。

重叠策略一期仅 **`skip`**：该计划仍有 `pending`/`running` Run 则跳过本拍，`lastError` 可能为 `skipped: previous run still active`。

### 4.1 列表

`GET /api/schedules` → `{ "items": CrawlSchedule[] }`

### 4.2 创建

`POST /api/schedules`

```json
{
  "name": "卓创原油每日",
  "spider": "exampleSpider",
  "params": {
    "keyword": "原油",
    "pageSize": 20,
    "pagination": { "mode": "range", "from": 1, "to": 5 }
  },
  "options": {
    "concurrentRequests": 4
  },
  "appProfileId": 1,
  "spiderProfileId": null,
  "cron": "0 8 * * *",
  "timezone": "Asia/Shanghai",
  "overlapPolicy": "skip",
  "enabled": true
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 展示名 |
| `spider` | 是 | 已注册 Spider |
| `cron` | 是 | 5 段 cron |
| `params` | 否 | 与 `POST /api/runs` 同结构 |
| `options` / `appProfileId` / `spiderProfileId` | 否 | 同 Run；会固化进 schedule snapshot |
| `timezone` | 否 | 默认 `Asia/Shanghai` |
| `enabled` | 否 | 默认 `true` |
| `overlapPolicy` | 否 | 默认 `skip`；一期勿传其它值 |

**响应 `201`：** `CrawlSchedule`（含算出的 `nextRunAt`）

### 4.3 详情

`GET /api/schedules/:id`

**响应 `200`：** `CrawlSchedule & { recentRuns: CrawlRun[] }`  
`recentRuns` 为该计划最近约 20 条 Run。

### 4.4 更新

`PATCH /api/schedules/:id`

可部分更新：`name` / `spider` / `params` / `options` / `appProfileId` / `spiderProfileId` / `cron` / `timezone` / `enabled` / `overlapPolicy`。  
改 cron/timezone 或重新启用会重算 `nextRunAt`；禁用时 `nextRunAt` 为 `null`。改配置相关字段会重算 snapshot。

**响应 `200`：** `CrawlSchedule`

### 4.5 删除

`DELETE /api/schedules/:id` → `{ "ok": true }`  
不级联删除历史 Run。

### 4.6 启用 / 禁用

- `POST /api/schedules/:id/enable` → `CrawlSchedule`
- `POST /api/schedules/:id/disable` → `CrawlSchedule`

禁用**不会**停止正在跑的 Run；停 Run 用 `POST /api/runs/:id/stop`。

### 4.7 立即触发

`POST /api/schedules/:id/trigger`

立刻按计划 params 创建一次 Run（`triggerType=schedule`，计入该计划历史），**不改动** cron 下一拍。

**响应 `201`：** `CrawlRun`

---

## 5. 前端联调建议

```ts
// axios 示例
import axios from 'axios'

export const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8787',
  timeout: 15000,
})

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('admin_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

export const getAuthStatus = () =>
  http.get<{ authRequired: boolean }>('/api/auth/status')

export const login = (password: string) =>
  http.post<{ token: string; tokenType: string; expiresAt: string }>('/api/auth/login', { password })

export const listSpiders = () => http.get<{ items: SpiderMeta[] }>('/api/spiders')
export const listRuns = (params?: { limit?: number; scheduleId?: number }) =>
  http.get<{ items: CrawlRun[] }>('/api/runs', { params })
export const createRun = (body: {
  spider: string
  params: Record<string, unknown>
  options?: CrawlRunOptions
  appProfileId?: number | null
  spiderProfileId?: number | null
}) => http.post<CrawlRun>('/api/runs', body)

export const listAppProfiles = () => http.get<{ items: AppProfile[] }>('/api/app-profiles')
export const createAppProfile = (body: unknown) => http.post<AppProfile>('/api/app-profiles', body)
export const updateAppProfile = (id: number, body: unknown) =>
  http.patch<AppProfile>(`/api/app-profiles/${id}`, body)
export const deleteAppProfile = (id: number) => http.delete(`/api/app-profiles/${id}`)
export const setDefaultAppProfile = (id: number) =>
  http.post<AppProfile>(`/api/app-profiles/${id}/set-default`)

export const listSpiderProfiles = (spider?: string) =>
  http.get<{ items: SpiderProfile[] }>('/api/spider-profiles', { params: { spider } })
export const createSpiderProfile = (body: unknown) =>
  http.post<SpiderProfile>('/api/spider-profiles', body)
export const updateSpiderProfile = (id: number, body: unknown) =>
  http.patch<SpiderProfile>(`/api/spider-profiles/${id}`, body)
export const deleteSpiderProfile = (id: number) => http.delete(`/api/spider-profiles/${id}`)
export const setDefaultSpiderProfile = (id: number) =>
  http.post<SpiderProfile>(`/api/spider-profiles/${id}/set-default`)
export const getRun = (id: number) => http.get<CrawlRun>(`/api/runs/${id}`)
export const stopRun = (id: number) => http.post<CrawlRun>(`/api/runs/${id}/stop`)
export const getRunLogs = (id: number, limit = 200) =>
  http.get<{ items: CrawlLogRow[] }>(`/api/runs/${id}/logs`, { params: { limit } })

export const listLogs = (params?: {
  limit?: number
  beforeId?: number
  spider?: string
  level?: string
  event?: string
  runId?: number
}) => http.get<{ items: CrawlLogRow[] }>('/api/logs', { params })

export const listSchedules = () => http.get<{ items: CrawlSchedule[] }>('/api/schedules')
export const createSchedule = (body: unknown) => http.post<CrawlSchedule>('/api/schedules', body)
export const getSchedule = (id: number) =>
  http.get<CrawlSchedule & { recentRuns: CrawlRun[] }>(`/api/schedules/${id}`)
export const updateSchedule = (id: number, body: unknown) =>
  http.patch<CrawlSchedule>(`/api/schedules/${id}`, body)
export const deleteSchedule = (id: number) => http.delete(`/api/schedules/${id}`)
export const enableSchedule = (id: number) => http.post<CrawlSchedule>(`/api/schedules/${id}/enable`)
export const disableSchedule = (id: number) => http.post<CrawlSchedule>(`/api/schedules/${id}/disable`)
export const triggerSchedule = (id: number) => http.post<CrawlRun>(`/api/schedules/${id}/trigger`)
```

**状态展示建议**

| status | Ant Design Vue `a-tag` |
|--------|-------------------------|
| `pending` | default |
| `running` | processing |
| `succeeded` | success |
| `failed` | error |
| `cancelled` | warning |

**错误处理：** 读 `error` 字段（HTTP 体或 Run/Schedule 上的 `error` / `lastError`）用 `message.error` / `a-alert` 展示。

---

## 6. 未包含（二期）

> 完整路线图见 [`capabilities-and-roadmap.md`](./capabilities-and-roadmap.md)。  
> 注：单人密码门鉴权已在一期完成，不在下列清单内。

- SSE / WebSocket 实时日志  
- 结果价格表查询 API  
- `overlapPolicy` 的 `queue` / `replace`  
- 多 admin 实例分布式调度  
- 取消粒度细化、进行中 stats 回写  

产品与页面规划见：[`admin-frontend-prep.md`](./admin-frontend-prep.md)
