# @crawlnd/admin

Crawlnd **管理控制面插件**：Spider 注册表、Run / Schedule / Profile、鉴权、HTTP API、Job Supervisor、Worker 执行辅助。

依赖 `crawlnd`、`@crawlnd/utils`；通过 `registerSpider` 注入你自己的 Spider，框架不捆绑示例爬虫。  
启动前必须 **`configureAdmin`** 注入 env 与 MySQL pool。

## 安装

```bash
npm i @crawlnd/admin crawlnd @crawlnd/utils
npm i mysql2 ioredis hono @hono/node-server croner
```

## 最小装配

```ts
import {
  configureAdmin,
  registerSpiders,
  startAdminServer,
  shutdownAdmin,
  type AdminEnv,
  type SpiderDefinition,
} from '@crawlnd/admin';
import { configureJobStatsRedis } from '@crawlnd/utils';
import mysql from 'mysql2/promise';
import Redis from 'ioredis';

const pool = mysql.createPool({ /* ... */ });
const env: AdminEnv = {
  mysql: { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'dz' },
  redis: { host: '127.0.0.1', port: 6379 },
  admin: {
    host: '127.0.0.1',
    port: 8787,
    schedulerIntervalMs: 15_000,
    password: 'change-me',          // 非空则启用 JWT
    jwtSecret: 'change-me',
    tokenTtlSeconds: 7 * 24 * 3600,
  },
  crawl: {
    concurrentRequests: 4,
    concurrentSpiders: 1,
    obeyRobotsTxt: false,
    frontier: 'memory',             // 或 'redis'
    frontierLeaseMs: 60_000,
    jobStableWindowMs: 5_000,
    supervisorIntervalMs: 2_000,
  },
  worker: {
    maxJobs: 1,
    pollIntervalMs: 2_000,
    id: `worker-${process.pid}`,
  },
};

configureAdmin({
  env,
  getPool: () => pool,
  closePool: async () => { await pool.end(); },
});
configureJobStatsRedis(() => new Redis({ host: env.redis.host, port: env.redis.port }));

registerSpiders([/* SpiderDefinition[] */]);

await startAdminServer({
  beforeListen: () => {
    // 可在此再 register
  },
});
```

本仓库示例：`src/bootstrap/runtime.ts` + `src/apps/admin-main.ts`。

---

## 注册 Spider

```ts
import {
  registerSpider,
  registerSpiders,
  commonPageSeedProperties,
  stringLinesField,
  withUi,
  UI_WIDGET,
  type SpiderDefinition,
} from '@crawlnd/admin';
import { createMySpider } from './my-spider.js';

const def: SpiderDefinition = {
  name: 'mySpider',
  label: '我的爬虫',
  description: '...',
  paramSchema: {
    type: 'object',
    required: ['keyword', 'pagination'],
    properties: {
      ...commonPageSeedProperties, // keyword + pagination-mode
    },
  },
  create: (params, ctx) =>
    createMySpider(String(params.keyword), /* ... */, {
      runId: ctx?.runId,
      spiderConfig: ctx?.spiderConfig,
      frontierType: ctx?.frontierType,
    }),
};

registerSpider(def);
// 或 registerSpiders([def, ...])
```

### 表单辅助

| 工具 | 用途 |
|------|------|
| `commonPageSeedProperties` | keyword + pagination |
| `stringLinesField` | textarea 多行 → `string[]` |
| `objectTableField` | 可编辑表格 |
| `withUi` / `UI_WIDGET` | `x-ui-widget` 等扩展 |
| `customFormSchema` | 整表自定义表单 |

`GET /api/spiders` 返回 `name/label/description/paramSchema`（及默认 Profile id）。

`SpiderCreateContext`：`{ runId?, spiderConfig?, frontierType? }`。

---

## HTTP API 概要

鉴权：`ADMIN_PASSWORD`（注入的 `env.admin.password`）非空则需 Bearer JWT。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | `{ password }` → token |
| GET | `/api/health` | 健康检查 |
| GET | `/api/spiders` | 已注册 Spider |
| GET/POST | `/api/runs` | 列表 / 创建 |
| GET | `/api/runs/:id` | 详情（含 `frontierType`） |
| GET | `/api/runs/:id/frontier` | 队列 depth/inflight/stats |
| POST | `/api/runs/:id/stop` | 取消 |
| GET | `/api/runs/:id/logs` | 任务日志 |
| GET | `/api/logs` | 全局日志 |
| CRUD | `/api/schedules` | 定时计划 |
| CRUD | `/api/app-profiles` 等 | 配置套餐 |
| GET | `/api/stats/overview` | 平台概览 |

### 创建 Run

```http
POST /api/runs
Authorization: Bearer <token>
Content-Type: application/json

{
  "spider": "exampleSpider",
  "frontier": "redis",
  "params": {
    "keyword": "甲醇",
    "pagination": { "mode": "range", "from": 1, "to": 2 }
  },
  "options": { "concurrentRequests": 2 },
  "appProfileId": 1,
  "spiderProfileId": null
}
```

- `frontier` 省略则用 `env.crawl.frontier`
- `memory`：Admin 进程内执行
- `redis`：只 seed 入 Redis，需另起 Worker

程序化：

```ts
import { createRun, stopRun, getRun } from '@crawlnd/admin';

const run = await createRun({
  spider: 'exampleSpider',
  params: { ... },
  frontier: 'redis',
});
await stopRun(run.id);
```

---

## 分布式 Worker

```ts
import {
  configureAdmin,
  ensureAdminTables,
  listRunningRedisRuns,
  executeWorkerFetchLoop,
  quitSharedRedis,
} from '@crawlnd/admin';

// 先 configureAdmin + registerSpiders
await ensureAdminTables();

setInterval(async () => {
  for (const run of await listRunningRedisRuns()) {
    void executeWorkerFetchLoop(run);
  }
}, env.worker.pollIntervalMs);
```

本仓库：`npm run worker` → `src/apps/worker-main.ts`。

多机：共享 MySQL + Redis；多台只跑 worker；Admin 建议单实例（Scheduler）。

Supervisor（随 `startAdminServer` 启动）负责：

- 回收过期 lease  
- depth+inflight 稳定窗口后写终态  
- 读 Redis 聚合 stats 回写 `crawl_runs`  
- 处理 `cancel_requested`

也可手动：`startJobSupervisor()` / `stopJobSupervisor()`。

---

## Profile / Schedule / Stats

```ts
import {
  listAppProfiles,
  createAppProfile,
  seedDefaultAppProfile,
  createSchedule,
  listSchedules,
  triggerSchedule,
  getPlatformOverview,
} from '@crawlnd/admin';

await seedDefaultAppProfile();
await createSchedule({
  name: 'daily',
  spider: 'exampleSpider',
  params: { ... },
  cron: '0 8 * * *',
  timezone: 'Asia/Shanghai',
});
```

Schedule 到点走同一套 `createRun`；重叠策略一期主要为 `skip`。

---

## Frontier 工厂

```ts
import {
  createFrontier,
  resolveFrontierType,
  getSharedRedis,
  quitSharedRedis,
} from '@crawlnd/admin';

const frontier = createFrontier('redis'); // 或 'memory'
const type = resolveFrontierType('redis');
```

`createFrontier('redis')` 会挂 `RedisDupeFilter`（Job 级入队去重）。

---

## 鉴权

```ts
import {
  loginWithPassword,
  verifyAccessToken,
  isAuthEnabled,
  createAuthMiddleware,
} from '@crawlnd/admin';
```

`createAdminApp()` 已挂中间件；白名单含 `/api/health`、`/api/auth/login`、`/api/auth/status`。

---

## 仅挂路由（测试 / 自定义 listen）

```ts
import { createAdminApp } from '@crawlnd/admin';

const app = createAdminApp();
// app.fetch 交给任意 Node HTTP 适配器
```

`startAdminServer` 会：`ensure*Tables`、seed 默认 App Profile、listen、startScheduler、startJobSupervisor。

`shutdownAdmin()`：停调度 / Supervisor，关 Redis（若有）与 pool。

---

## 环境变量约定（由应用映射进 AdminEnv）

| 变量 | 含义 |
|------|------|
| `MYSQL_*` | 控制面库 |
| `REDIS_*` | Frontier / stats / 条目去重 |
| `ADMIN_HOST` / `ADMIN_PORT` | 监听 |
| `ADMIN_PASSWORD` | 非空启用鉴权 |
| `CRAWL_FRONTIER` | `memory` \| `redis` |
| `CRAWL_CONCURRENT_REQUESTS` 等 | 默认并发 |
| `WORKER_ID` / `WORKER_MAX_JOBS` | Worker |

由你的应用自行映射环境变量后传入 `configureAdmin`。

---

## 包依赖

```
your app (registerSpider + bootstrap)
        ↓
 @crawlnd/admin
    ↓        ↓
 @crawlnd/utils → crawlnd
```

框架包之间不依赖任何示例爬虫代码。
