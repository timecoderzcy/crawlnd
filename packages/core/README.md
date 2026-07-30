# crawlnd

Crawlnd **爬虫运行时**：Spider 模型、请求调度、可插拔 Frontier、请求指纹去重（`dedupe`）、robots / 域名校验。

零业务站点知识；不读 `.env`、不连 MySQL。

## 安装

```bash
npm i crawlnd
# Redis Frontier 需要
npm i ioredis
```

## 快速开始

```ts
import { Crawlnd, Spider } from 'crawlnd';

const spider = new Spider({
  name: 'demo',
  startUrls: ['https://example.com/'],
  // 或 seeds: async () => [{ url: '...', method: 'GET' }],
});

spider.on('afterResponse', async (ctx) => {
  console.log(ctx.response?.status, ctx.request.url);
  // 继续入队
  // ctx.sink?.submit({ url: 'https://example.com/page/2', tag: 'follow' });
});

const app = new Crawlnd({
  name: 'my-app',
  concurrentRequests: 4,
  obeyRobotsTxt: false,
});
app.useSpider(spider);
await app.crawl();           // 全部
// await app.crawl('demo');  // 按 name
```

## 使用案例

### 1. JSON 列表翻页 + 详情 follow

```ts
import { Crawlnd, Spider } from 'crawlnd';

const spider = new Spider({
  name: 'products',
  seeds: () => [
    {
      url: 'https://api.example.com/search',
      method: 'POST',
      json: { keyword: '甲醇', pageNO: 1, pageSize: 20 },
      tag: 'list',
      state: { pageNO: 1 },
    },
  ],
});

spider.on('afterResponse', 'list', async (ctx) => {
  const body = ctx.response?.body as {
    data?: { id: number; name: string }[];
    hasMore?: boolean;
  };
  const items = body?.data ?? [];
  for (const item of items) {
    ctx.sink?.submit({
      url: `https://api.example.com/item/${item.id}`,
      tag: 'detail',
      state: { id: item.id, name: item.name },
    });
  }
  const pageNO = Number(ctx.state.pageNO ?? 1);
  if (body?.hasMore) {
    ctx.sink?.submit({
      url: 'https://api.example.com/search',
      method: 'POST',
      json: { keyword: '甲醇', pageNO: pageNO + 1, pageSize: 20 },
      tag: 'list',
      state: { pageNO: pageNO + 1 },
    });
  }
});

spider.on('afterResponse', 'detail', async (ctx) => {
  console.log('detail', ctx.state.id, ctx.response?.body);
});

const app = new Crawlnd({ concurrentRequests: 4, obeyRobotsTxt: false });
app.useSpider(spider);
await app.crawl('products');
```

### 2. HTML 解析（CSS / XPath）

```ts
spider.on('afterResponse', async (ctx) => {
  const title = ctx.response?.select('h1')?.text();
  const links = ctx.response?.selectAll('a.item') ?? [];
  for (const a of links) {
    const href = a.attr('href');
    if (href) {
      ctx.sink?.submit({ url: new URL(href, ctx.request.url).href });
    }
  }
  // XPath：以 // 或 ( 等开头
  const price = ctx.response?.select('//span[@class="price"]')?.text();
  console.log({ title, price, count: links.length });
});
```

### 3. 表单 POST、query、路径占位

```ts
const spider = new Spider({
  name: 'form-demo',
  seeds: () => [
    // application/x-www-form-urlencoded
    {
      url: 'https://example.com/login',
      method: 'POST',
      data: { user: 'a', pass: 'b' },
    },
    // query 合并
    {
      url: 'https://example.com/search',
      query: { q: '原油', page: '1' },
    },
    // 路径占位 {id} 或 :id
    {
      url: 'https://example.com/api/item/{id}',
      params: { id: '42' },
    },
  ],
});
```

Body 优先级：`json` > `formData` > `data`。

### 4. Cookie、代理、默认头

```ts
const spider = new Spider({
  name: 'authed',
  defaultHeaders: {
    'User-Agent': 'crawlnd-demo/1.0',
    Accept: 'application/json',
  },
  seeds: () => [
    {
      url: 'https://example.com/api/me',
      cookies: { session: 'abc', token: 'xyz' },
      proxy: { url: 'http://127.0.0.1:7890' },
    },
  ],
});

const app = new Crawlnd({
  defaultHeaders: { 'X-App': 'demo' }, // 工程头 ← Spider 头 ← 单次请求头
  validDomains: ['example.com'],       // 仅允许该域（含子域）
  obeyRobotsTxt: true,
});
```

### 5. `state` 在列表 → 详情间传业务字段

```ts
// 列表提交详情时带上 state（不进入 HTTP）
ctx.sink?.submit({
  url: detailUrl,
  tag: 'detail',
  state: { keyword: '甲醇', listPage: 3, raw: item },
});

spider.on('afterResponse', 'detail', (ctx) => {
  // ctx.state.spider 由框架注入；业务字段来自入队 state
  const { keyword, listPage, raw } = ctx.state as {
    keyword?: string;
    listPage?: number;
    raw?: unknown;
  };
  console.log(keyword, listPage, raw);
});
```

### 6. 短路 `respond`（单测 / Mock）

```ts
spider.on('beforeRequest', (ctx) => {
  if (ctx.request.url.includes('/mock')) {
    ctx.respond({ ok: true, items: [] }, { status: 200 });
    // 不会发真实 HTTP，仍会走 afterResponse
  }
});

spider.on('afterResponse', (ctx) => {
  console.log(ctx.response?.body); // { ok: true, items: [] }
});
```

### 7. 多 Spider 并行 + 工程级钩子

```ts
const a = new Spider({ name: 'a', startUrls: ['https://a.example/'] });
const b = new Spider({ name: 'b', startUrls: ['https://b.example/'] });

const app = new Crawlnd({
  concurrentSpiders: 2,
  concurrentRequests: 4,
  obeyRobotsTxt: false,
});

app.on('open', (spider) => console.log('start', spider.getName()));
app.on('error', '*', (err, ctx) => {
  console.error(ctx.request.url, err);
});
app.on('close', (spider) => console.log('done', spider.getName()));

app.useSpider([a, b]);
await app.crawl(); // a、b 并行；任一失败会汇总抛出
```

只跑其中一个：`await app.crawl('a')`。  
或：`await a.runOn(app)`（等价于 `app.crawl(a.getName())`）。

### 8. 限速（delay）

```ts
const app = new Crawlnd({
  delay: 500,              // 任意两次请求开始至少间隔 500ms
  // delay>0 时 concurrentRequests 强制为 1
  obeyRobotsTxt: false,
});
```

### 9. 请求去重：本地文件断点续爬

```ts
const spider = new Spider({
  name: 'news',
  seeds: () =>
    Array.from({ length: 10 }, (_, i) => ({
      url: `https://example.com/page/${i + 1}`,
    })),
});

// 成功抓过的指纹写入 ./data/dedupe/news/seed.json，下次自动跳过
spider.dedupe({ stateDir: './data/dedupe' });

spider.on('afterResponse', async (ctx) => {
  // ...
});

const app = new Crawlnd({ obeyRobotsTxt: false });
app.useSpider(spider);
await app.crawl();
```

仅对 follow 去重：

```ts
spider.dedupe('follow', { stateFile: './data/follow-seen.json' });
```

### 10. 请求去重：Redis 自定义

```ts
import Redis from 'ioredis';
import { computeRequestFingerprintHash } from 'crawlnd';

const redis = new Redis();
spider.dedupe({
  async isDone(fp) {
    return (await redis.sismember('crawlnd:demo:req', fp)) === 1;
  },
  async markDone(fp) {
    await redis.sadd('crawlnd:demo:req', fp);
  },
});

// 也可手动算指纹
const fp = computeRequestFingerprintHash({
  url: 'https://example.com/a',
  method: 'GET',
});
```

### 11. 错误处理（单条失败不中断整轮）

```ts
spider.on('error', '*', (err, ctx) => {
  console.error('failed', ctx.request.url, err);
  // 监听后错误仍会向上抛到队列任务；其它已入队请求会继续跑
});

spider.on('afterResponse', async (ctx) => {
  if ((ctx.response?.status ?? 0) >= 400) {
    throw new Error(`HTTP ${ctx.response?.status}`);
  }
});
```

### 12. 本机 MemoryFrontier 显式注入

```ts
import { Crawlnd, MemoryFrontier, MemoryDupeFilter, computeRequestFingerprintHash } from 'crawlnd';

const frontier = new MemoryFrontier({
  dupeFilter: new MemoryDupeFilter(),
  fingerprint: (req) => computeRequestFingerprintHash(req),
});

const app = new Crawlnd({
  frontier,
  jobId: 'local-job-1',
  obeyRobotsTxt: false,
});
```

### 13. Redis 分布式：协调进程 + Worker

```ts
import {
  Crawlnd,
  Spider,
  RedisFrontier,
  RedisDupeFilter,
  computeRequestFingerprintHash,
} from 'crawlnd';
import Redis from 'ioredis';

function createApp(jobId: string) {
  const redis = new Redis();
  const frontier = new RedisFrontier(redis, {
    dupeFilter: new RedisDupeFilter(redis),
    fingerprint: (req) => computeRequestFingerprintHash(req),
    defaultLeaseMs: 60_000,
  });
  const spider = new Spider({
    name: 'dist-demo',
    seeds: () => [{ url: 'https://example.com/page/1' }],
  });
  spider.on('afterResponse', async (ctx) => {
    /* 解析 + sink.submit */
  });
  const app = new Crawlnd({
    frontier,
    jobId,
    concurrentRequests: 4,
    obeyRobotsTxt: false,
  });
  app.useSpider(spider);
  return { app, spider, frontier, redis };
}

// —— 机器 A：只入种子 ——
const jobId = '1001';
{
  const { app, spider } = createApp(jobId);
  const { seeded } = await app.seedJob(spider, jobId);
  console.log('seeded', seeded);
  await app.emitSpiderClose(spider);
}

// —— 机器 B/C：多 Worker 拉取 ——
{
  const { app, spider, frontier } = createApp(jobId);
  await app.runFetchLoop(spider, jobId, { emitLifecycle: true });
  // 完成判定一般由外部 Supervisor 看 depth/inflight；
  // 也可自行：
  // while (await frontier.depth(jobId) + await frontier.inflight(jobId) > 0) ...
}

// 取消
// await frontier.setCancelled(jobId, true);

// 回收过期租约（Supervisor 周期调用）
// await frontier.reclaimExpired(jobId);
```

### 14. 单次 `dispatchFetch`（不跑整轮调度）

```ts
import { dispatchFetch, type CrawlContext } from 'crawlnd';

const ctx: CrawlContext = {
  request: {
    url: 'https://httpbin.org/get',
    query: { hello: 'world' },
  },
  state: {},
};

await dispatchFetch(ctx);
console.log(ctx.response?.status, ctx.response?.body);
```

---

## CrawlndOptions

| 字段 | 说明 |
|------|------|
| `concurrentRequests` | 单 Spider 内 HTTP 并发（默认 16） |
| `concurrentSpiders` | 多 Spider 并行数（默认 1） |
| `delay` | ms；`>0` 时强制串行并间隔休眠 |
| `obeyRobotsTxt` | 是否遵守 robots.txt |
| `defaultHeaders` / `validDomains` | 工程级默认头 / 域名白名单 |
| `frontier` | 自定义 `Frontier`（默认 `MemoryFrontier`） |
| `dupeFilter` | 可选引擎级去重（需 Frontier 支持入队过滤） |
| `jobId` | 作用域 id；分布式时通常等于 runId |

## Spider

### 构造

```ts
new Spider({
  name: 'must-be-non-empty',
  startUrls?: string[],
  seeds?: () => CrawlQueuedRequest[] | Promise<...>,
  defaultHeaders?: Record<string, string>,
  validDomains?: string[],
});
```

`seeds` 优先于 `startUrls`。

### 生命周期

```ts
spider.on('open', () => {});
spider.on('seeds', (reqs) => {});
spider.on('beforeRequest', (ctx) => {});      // 两参数时默认仅 tag=seed
spider.on('afterResponse', (ctx) => {});
spider.on('error', (err, ctx) => {});
spider.on('close', () => {});

// 按 tag 过滤（第三种重载）
spider.on('afterResponse', 'follow', (ctx) => {});
spider.on('afterResponse', '*', (ctx) => {}); // 不过滤 tag
```

工程级 `app.on(...)` 同名事件会**先于** Spider 钩子执行。

### 请求与上下文

```ts
interface CrawlQueuedRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  query?: Record<string, string>;
  params?: Record<string, string>;   // 路径占位 {key} / :key
  data?: Record<string, string>;     // x-www-form-urlencoded
  json?: JsonValue;
  formData?: Record<string, string>;
  cookies?: Record<string, string>;
  proxy?: { url: string } | Record<string, string>;
  tag?: string;                      // 默认 seed / follow
  state?: Record<string, unknown>;   // 不进 HTTP，进 ctx.state
}
```

`ctx.sink.submit(req | req[])`：动态入队，默认 `tag=follow`。  
`ctx.respond(body, init?)`：短路，不发真请求。

HTML 响应体可挂选择器（见 `dispatchFetch` / html-select）。

### 请求指纹去重 `dedupe`

管的是「这条 **HTTP 请求**还要不要发」，**不是**业务条目去重。

```ts
// 本地文件
spider.dedupe({ stateDir: './data/dedupe' });
spider.dedupe('follow', { stateFile: './data/follow.json' });

// 自定义（含 Redis）
spider.dedupe({
  async isDone(fp) {
    return (await redis.sismember('my:req', fp)) === 1;
  },
  async markDone(fp) {
    await redis.sadd('my:req', fp);
  },
});
```

指纹由 `computeRequestFingerprintHash` 计算（url/method/query/params/body/state，不含 headers/tag）。

相关导出：`SeedFingerprintFileStore`、`safePathSegment`。

## Frontier（可插拔队列）

默认本机 `MemoryFrontier`。分布式用 `RedisFrontier`。

```ts
import {
  Crawlnd,
  RedisFrontier,
  RedisDupeFilter,
  computeRequestFingerprintHash,
  type CrawlQueuedRequest,
} from 'crawlnd';
import Redis from 'ioredis';

const redis = new Redis();
const frontier = new RedisFrontier(redis, {
  dupeFilter: new RedisDupeFilter(redis),
  fingerprint: (req: CrawlQueuedRequest) => computeRequestFingerprintHash(req),
  defaultLeaseMs: 60_000,
});

const app = new Crawlnd({ frontier, jobId: '42' });
```

### 接口要点

| 方法 | 作用 |
|------|------|
| `push(scopeId, reqs)` | 入队 |
| `fetch(scopeId, { leaseMs, waitMs })` | 租约取出 |
| `ack` / `nack` | 完成 / 失败（可 requeue） |
| `depth` / `inflight` | 待抓 / 在途 |
| `setCancelled` / `isCancelled` | 取消 |
| `close` | 清理 |

`MemoryDupeFilter` / `RedisDupeFilter` 实现 `DupeFilter`（`isSeen` / `markSeen`）。

### 分布式 API：`seedJob` / `runFetchLoop`

```ts
// 协调侧：只入种子
await app.seedJob(spider, jobId);
await app.emitSpiderClose(spider);

// Worker 侧：拉取直到队列空且 inflight=0，或 cancelled
await app.runFetchLoop(spider, jobId, { emitLifecycle: true });
```

本机 `crawl()` = `seedJob` + `runFetchLoop` + `frontier.close`。

`RedisFrontier.reclaimExpired(scopeId)`：Supervisor 回收过期租约。

## 常量与工具

```ts
import {
  REQUEST_TAG_SEED,
  REQUEST_TAG_FOLLOW,
  dispatchFetch,
  computeRequestFingerprintHash,
} from 'crawlnd';
```

## 与其它包

| 包 | 关系 |
|----|------|
| `@crawlnd/utils` | 依赖 core；提供 logger、分页种子、条目 Redis 去重 |
| `@crawlnd/admin` | 依赖 core；管理 API / Worker |

条目级去重请用 `@crawlnd/utils` 的 `createRedisItemDeduper`，不要用 `spider.dedupe`。
