# @crawlnd/utils

Crawlnd **通用工具**（与具体 Spider 实现无关）：分页种子、统一日志、日志持久化、条目 Redis 去重、分布式 Job stats。

依赖：`crawlnd`；部分功能需要 `ioredis` / `mysql2`。

## 安装

```bash
npm i @crawlnd/utils crawlnd
# 按需
npm i ioredis mysql2
```

## 分页种子 `page-seeds`

```ts
import { createPageSeeds, parsePageSeedOptions, type PageSeedOptions } from '@crawlnd/utils';
import { Spider } from 'crawlnd';

const options: PageSeedOptions =
  { mode: 'single', pageNO: 1, pageSize: 20 };
  // 或 { mode: 'range', from: 1, to: 10, pageSize: 20 }

const spider = new Spider({
  name: 'demo',
  seeds: createPageSeeds(options, (pageNO, pageSize) => ({
    url: 'https://api.example.com/search',
    method: 'POST',
    json: { pageNO, pageSize, keyword: '原油' },
  })),
});
```

### 从管理台 params 解析

```ts
import { parsePageSeedOptions } from '@crawlnd/utils';

// 支持嵌套 pagination 或顶层扁平字段
const opts = parsePageSeedOptions({
  pagination: { mode: 'range', from: 1, to: 3 },
  // 兼容 start/end → from/to
  // pagination: { mode: 'range', start: 1, end: 3 },
});
```

`resolvePageNumbers(options)`：只算出页码数组。

---

## 统一日志 `attachSpiderLogger`

```ts
import { attachSpiderLogger, getAttachedCrawlStats } from '@crawlnd/utils';
import { getPool } from './db'; // 应用侧

const log = attachSpiderLogger(spider, {
  name: 'demo',                    // 默认 spider.getName()
  meta: { keyword: '原油' },
  locale: 'zh',                    // 'zh' | 'en' | 'both'
  level: 'info',
  runId: 123,                      // 写入 crawl_logs.run_id
  frontierType: 'redis',           // 为 redis 时自动把 stats 增量写入 Redis
  unitField: 'page',               // 或 'phone' 等
  getUnit: (req) => req.state?.phone as string,
  persist: {
    enabled: true,
    console: true,
    database: { pool: getPool(), table: 'crawl_logs' },
    // file: { path: './logs/demo.jsonl' },
  },
  onClose: async () => { /* 关连接等 */ },
});

spider.on('afterResponse', async (ctx) => {
  // 解析后累计 stats + 打 page 日志
  log.page(ctx, {
    items: 20,
    new: 5,      // saved
    skip: 15,
    total: 100,
    msg: 'ok',
  });
});

// 任务结束读本地累计（memory 模式）
const stats = getAttachedCrawlStats(spider);
// { pages, items, saved, skipped, errors }
```

### 手动日志

```ts
log.info('hello', { foo: 1 });
log.warn('...');
log.error('...');
log.debug('...');
```

### `frontierType: 'redis'`

自动启用远程 Job stats（`HINCRBY`）。应用侧可注入 Redis 工厂：

```ts
import { configureJobStatsRedis } from '@crawlnd/utils';
import Redis from 'ioredis';

configureJobStatsRedis(() => new Redis({ host: '127.0.0.1', port: 6379 }));
```

也可显式传入：

```ts
attachSpiderLogger(spider, {
  runId: 1,
  remoteStats: createAutoRedisJobStatsRemote(1),
  // 或 remoteStats: false 关闭
});
```

---

## 日志持久化 `createPersistSinks`

一般由 `attachSpiderLogger({ persist })` 间接使用；也可自建：

```ts
import { createPersistSinks } from '@crawlnd/utils';

const sinks = createPersistSinks({
  file: { path: './out.jsonl' },
  database: { pool, table: 'crawl_logs' },
});
await sinks[0].write({ ts, spider, level, event, message, runId, fields });
await sinks[0].close();
```

---

## 条目级 Redis 去重 `createRedisItemDeduper`

用于「解析出的业务记录」是否入库，**不是**请求指纹去重。

```ts
import { createRedisItemDeduper } from '@crawlnd/utils';
import Redis from 'ioredis';

const redis = new Redis();
const deduper = createRedisItemDeduper<MyItem>(redis, {
  setKey: 'crawlnd:mySpider:items',
  keyOf: (item) => String(item.id), // 返回 null/'' 则跳过该条
});

const fresh = await deduper.filter(items);
// ... 入库 fresh
await deduper.mark(fresh);
```

与 `spider.dedupe`（`crawlnd`）分工：

| | 请求级 `dedupe` | 条目级 `createRedisItemDeduper` |
|--|----------------|----------------------------------|
| 时机 | 入队 / 请求成功 | afterResponse 解析后 |
| 键 | 请求指纹 | 业务主键 |
| 目的 | 少打 HTTP | 少重复入库 |

---

## 分布式 Job stats

多 Worker 聚合 pages/items/saved/skipped/errors，供 Supervisor 回写 `crawl_runs.stats`。

```ts
import {
  createRedisJobStatsRemote,
  readAggregatedJobStats,
  clearAggregatedJobStats,
  configureJobStatsRedis,
} from '@crawlnd/utils';

configureJobStatsRedis(() => redis);

const remote = createRedisJobStatsRemote(redis, runId);
await remote.incr({ pages: 1, items: 10, saved: 8, skipped: 2 });

const stats = await readAggregatedJobStats(runId);
await clearAggregatedJobStats(runId);
```

Redis key：`crawlnd:jobstats:{runId}`（Hash）。

也可用 `getRedisJobStats(redis, runId)` / `clearRedisJobStats(redis, runId)` 显式传客户端。

---

## 导出一览

| 符号 | 用途 |
|------|------|
| `createPageSeeds` / `parsePageSeedOptions` / `resolvePageNumbers` | 分页种子 |
| `attachSpiderLogger` / `getAttachedCrawlStats` | 生命周期日志 + stats |
| `createPersistSinks` | JSONL / MySQL 落库 |
| `createRedisItemDeduper` | 条目去重 |
| `createRedisJobStatsRemote` 等 | Job stats 聚合 |
| `configureJobStatsRedis` | 注入 Redis 工厂 |
| `defaultGetPage` / `formatSeedSummary` | 辅助 |

## 依赖关系

```
应用 / admin
    ↓
@crawlnd/utils
    ↓
crawlnd
```
