import type { CrawlContext, CrawlQueuedRequest, CrawlRequest, CrawlTaskSink } from './context.js';
import { REQUEST_TAG_FOLLOW, REQUEST_TAG_SEED } from './context.js';
import { buildShortCircuitResponse, dispatchFetch } from './dispatcher.js';
import {
    fetchRobotsTxt,
    isUrlAllowedByRobots,
    pickUserAgent,
    type ParsedRobots,
} from './robots.js';
import {
    hookMatchesRequestTag,
    listenerTagForTwoArgOn,
    Spider,
    type SpiderEvent,
    type TaggedHook,
} from './spider.js';
import PQueue from 'p-queue';

export type {
    CrawlContext,
    CrawlQueuedRequest,
    CrawlRequest,
    CrawlResponse,
    CrawlResponseBody,
    CrawlTaskSink,
    JsonObject,
    JsonPrimitive,
    JsonValue,
    RespondInit,
} from './context.js';
export type { HtmlSelection } from './html-select.js';
export { REQUEST_TAG_SEED, REQUEST_TAG_FOLLOW } from './context.js';
export { dispatchFetch } from './dispatcher.js';

export interface CrawlndOptions {
    name?: string;
    version?: string;
    /**
     * 为 true 时：在每条正式请求前确保已拉取该 URL origin 的 robots.txt（种子会在入队前预取涉及 origin），
     * 并按 User-agent 命中的分组校验 Allow/Disallow；robots.txt 返回 404 视为无限制。
     */
    obeyRobotsTxt?: boolean;
    /** 毫秒；大于 0 时强制串行（concurrentRequests 视为 1），且任意两次请求开始之间休眠；与动态入队可同时使用 */
    delay?: number;
    /** 并发 worker 数；与 delay 同时配置时以 delay 为准（串行） */
    concurrentRequests?: number;
    /** 默认请求头 */
    defaultHeaders?: Record<string, string>;
    /**
     * 允许发起请求的域名白名单；省略或空数组表示不在工程层限制。
     * 每条为不含端口的域名，如 `douban.com` 会匹配 `movie.douban.com`；`*.douban.com` 与 `douban.com` 等价。
     * 若与 SpiderOptions.validDomains 同时为非空，则 hostname 须**同时**满足两边的至少一条规则。
     */
    validDomains?: string[];
}

/** 工程级生命周期事件名（与 SpiderEvent 相同字符串，便于统一订阅） */
export type CrawlndEvent = SpiderEvent;

/** 工程级 hook：与 Spider 事件同名，但 open/seeds/close 会带上当前 Spider，便于汇总所有爬虫 */
export type CrawlndHandler = {
    open: (spider: Spider) => void | Promise<void>;
    seeds: (spider: Spider, requests: CrawlQueuedRequest[]) => void | Promise<void>;
    beforeRequest: (ctx: CrawlContext) => void | Promise<void>;
    afterResponse: (ctx: CrawlContext) => void | Promise<void>;
    error: (err: unknown, ctx: CrawlContext) => void | Promise<void>;
    close: (spider: Spider) => void | Promise<void>;
};

class Crawlnd {
    private options: CrawlndOptions;
    private spiders: Spider[] = [];
    private appListeners: Partial<Record<CrawlndEvent, TaggedHook[]>> = {};
    /** obeyRobotsTxt 时按 origin 缓存已解析的 robots.txt */
    private robotsByOrigin = new Map<string, ParsedRobots>();

    constructor(options: CrawlndOptions = {}) {
        this.options = {
            ...options,
            concurrentRequests: options.concurrentRequests ?? 16,
            obeyRobotsTxt: options.obeyRobotsTxt ?? true,
        };
    }

    /**
     * 注册工程级生命周期；任一 Spider 进入对应阶段时都会触发，且先于该 Spider 自身 `on` 回调执行。
     * 两参数且第二项为函数时：beforeRequest / afterResponse / error 默认仅当 ctx.request.tag 为 seed 时触发；open/seeds/close 不受影响。
     * 三参数时第二项为 tag：仅当 ctx.request.tag === tag 会触发（上述三事件）；tag 为 '*' 时表示不过滤 tag。open/seeds/close 带 tag 时 tag 不参与过滤，仍会执行。
     */
    on<E extends CrawlndEvent>(event: E, listener: CrawlndHandler[E]): void;
    on<E extends CrawlndEvent>(event: E, tag: string, listener: CrawlndHandler[E]): void;
    on<E extends CrawlndEvent>(event: E, arg2: CrawlndHandler[E] | string, arg3?: CrawlndHandler[E]): void {
        const bucket = ((this.appListeners[event] ??= []) as TaggedHook[]);
        if (typeof arg2 === 'string' && arg3 !== undefined) {
            bucket.push({ tag: arg2, fn: arg3 as (...args: unknown[]) => unknown });
        } else if (typeof arg2 === 'function') {
            bucket.push({
                tag: listenerTagForTwoArgOn(event),
                fn: arg2 as (...args: unknown[]) => unknown,
            });
        } else {
            bucket.push({ fn: arg2 as unknown as (...args: unknown[]) => unknown });
        }
    }

    private async emitApp<E extends CrawlndEvent>(
        event: E,
        ...args: E extends 'open'
            ? [Spider]
            : E extends 'seeds'
            ? [Spider, CrawlQueuedRequest[]]
            : E extends 'beforeRequest' | 'afterResponse'
            ? [CrawlContext]
            : E extends 'error'
            ? [unknown, CrawlContext]
            : E extends 'close'
            ? [Spider]
            : never
    ): Promise<void> {
        const list = this.appListeners[event];
        if (!list?.length) {
            return;
        }
        for (const entry of list) {
            if (!hookMatchesRequestTag(event, entry.tag, args)) {
                continue;
            }
            await Promise.resolve(entry.fn(...(args as unknown[])));
        }
    }

    useSpider(spider: Spider | Spider[]) {
        const list = Array.isArray(spider) ? spider : [spider];
        this.spiders.push(...list);
    }

    getSpiders(): readonly Spider[] {
        return this.spiders;
    }

    /**
     * 调度 Spider：无参时跑全部已注册实例；传入 name 或 name 列表时只跑匹配 `SpiderOptions.name` 的实例（顺序与参数一致，同名多次注册会多次执行）
     */
    async crawl(): Promise<void>;
    async crawl(name: string): Promise<void>;
    async crawl(names: readonly string[]): Promise<void>;
    async crawl(names?: string | readonly string[]): Promise<void> {
        const targets = this.resolveCrawlTargets(names);
        for (const spider of targets) {
            await this.crawlSpider(spider);
        }
    }

    /** 按名称解析待抓取的 Spider；未传参表示全部 */
    private resolveCrawlTargets(names?: string | readonly string[]): Spider[] {
        if (names === undefined) {
            return [...this.spiders];
        }
        const wanted = typeof names === 'string' ? [names] : [...names];
        if (wanted.length === 0) {
            return [];
        }
        return this.spidersMatchingNames(wanted);
    }

    /** 按 wanted 顺序收集 Spider；任一名称未匹配则抛错 */
    private spidersMatchingNames(wanted: readonly string[]): Spider[] {
        const result: Spider[] = [];
        for (const name of wanted) {
            const found = this.spiders.filter((s) => s.getName() === name);
            if (found.length === 0) {
                const known = this.spiders.map((s) => s.getName());
                throw new Error(
                    `未找到名为「${name}」的 Spider。已注册的名称：${known.length > 0 ? known.join('、') : '（无）'}`
                );
            }
            result.push(...found);
        }
        return result;
    }

    private async crawlSpider(spider: Spider): Promise<void> {
        await this.emitApp('open', spider);
        await spider.emit('open');
        try {
            const seeds = await spider.resolveSeeds();
            await this.emitApp('seeds', spider, seeds);
            await spider.emit('seeds', seeds);
            if (seeds.length === 0) {
                return;
            }

            if (this.options.obeyRobotsTxt) {
                const origins = [...new Set(seeds.map((s) => new URL(s.url).origin))];
                for (const origin of origins) {
                    await this.ensureRobotsForOrigin(origin, spider);
                }
            }

            const delayMs = Math.max(0, this.options.delay ?? 0);
            const concurrent = delayMs > 0 ? 1 : Math.max(1, this.options.concurrentRequests ?? 16);

            const queue = new PQueue({ concurrency: concurrent });
            let serial = 0;

            const sink: CrawlTaskSink = {
                submit(more: CrawlQueuedRequest | CrawlQueuedRequest[]) {
                    const list = Array.isArray(more) ? more : [more];
                    for (const item of list) {
                        const req: CrawlQueuedRequest = {
                            ...item,
                            tag: item.tag ?? REQUEST_TAG_FOLLOW,
                        };
                        queue.add(() => runTask(req));
                    }
                },
            };

            const runTask = async (req: CrawlQueuedRequest) => {
                if (delayMs > 0) {
                    const i = ++serial;
                    if (i > 1) {
                        await sleep(delayMs);
                    }
                }
                try {
                    await this.dispatchOne(spider, req, sink);
                } catch {
                    /* 错误已在 dispatchOne 中 emit，其它队列任务继续执行 */
                }
            };

            for (const s of seeds) {
                const seedReq: CrawlQueuedRequest = {
                    ...s,
                    tag: s.tag ?? REQUEST_TAG_SEED,
                };
                queue.add(() => runTask(seedReq));
            }
            await queue.onIdle();
        } finally {
            await spider.emit('close');
            await this.emitApp('close', spider);
        }
    }

    /**
     * 合并请求头：工程 defaultHeaders <- Spider defaultHeaders <- 单次 request.headers，后者覆盖同名键
     */
    private buildRequestWithDefaults(spider: Spider, request: CrawlRequest): CrawlRequest {
        return {
            ...request,
            headers: mergeHeaders(this.options.defaultHeaders, spider.getDefaultHeaders(), request.headers),
        };
    }

    /**
     * 在 beforeRequest 之前校验 request.url 的 hostname 是否满足工程级与本 Spider 的 validDomains（若配置了非空列表）
     */
    private assertRequestHostnameAllowed(spider: Spider, requestUrl: string): void {
        let hostname: string;
        try {
            hostname = new URL(requestUrl).hostname;
        } catch {
            throw new Error(`validDomains 校验需要绝对 URL，无法解析：${requestUrl}`);
        }
        const appDomains = this.options.validDomains;
        const spiderDomains = spider.getValidDomains();
        const appActive = appDomains !== undefined && appDomains.length > 0;
        const spiderActive = spiderDomains !== undefined && spiderDomains.length > 0;
        if (!appActive && !spiderActive) {
            return;
        }
        if (appActive && !hostnameMatchesAnyDomain(hostname, appDomains!)) {
            throw new Error(`URL 的域名不在 Crawlnd.validDomains 允许范围内：${requestUrl}`);
        }
        if (spiderActive && !hostnameMatchesAnyDomain(hostname, spiderDomains!)) {
            throw new Error(`URL 的域名不在本 Spider.validDomains 允许范围内：${requestUrl}`);
        }
    }

    /** 拉取并缓存 origin 的 robots.txt（已缓存则直接返回） */
    private async ensureRobotsForOrigin(origin: string, spider: Spider): Promise<ParsedRobots> {
        const cached = this.robotsByOrigin.get(origin);
        if (cached !== undefined) {
            return cached;
        }
        const headers = mergeHeaders(this.options.defaultHeaders, spider.getDefaultHeaders(), {});
        const parsed = await fetchRobotsTxt(origin, headers);
        this.robotsByOrigin.set(origin, parsed);
        return parsed;
    }

    /** obeyRobotsTxt 时校验 URL 是否被 robots 允许 */
    private async assertRobotsAllowsUrl(
        spider: Spider,
        requestUrl: string,
        headers: Record<string, string> | undefined,
    ): Promise<void> {
        const u = new URL(requestUrl);
        const parsed = await this.ensureRobotsForOrigin(u.origin, spider);
        const ua = pickUserAgent(headers);
        if (!isUrlAllowedByRobots(parsed, ua, u.pathname || '/')) {
            throw new Error(`robots.txt not allows：${requestUrl}`);
        }
    }

    /**
     * 单次请求：合并默认头、校验 validDomains 后构造 ctx；sink / respond 在 beforeRequest 起注入。
     * 若 hook 在 beforeRequest 中调用了 ctx.respond 或直接给 ctx.response 赋值，dispatchFetch 会跳过网络请求，
     * 直接进入 afterResponse 链（短路）。
     */
    private async dispatchOne(spider: Spider, request: CrawlQueuedRequest, sink?: CrawlTaskSink): Promise<void> {
        const { state: queuedState, ...reqCore } = request;
        const mergedRequest = this.buildRequestWithDefaults(spider, reqCore);
        const ctx: CrawlContext = {
            request: mergedRequest,
            state: { spider, ...(queuedState ?? {}) },
        };
        if (sink !== undefined) {
            ctx.sink = sink;
        }
        ctx.respond = (body, init) => {
            ctx.response = buildShortCircuitResponse(ctx.request, body, init);
        };
        try {
            this.assertRequestHostnameAllowed(spider, mergedRequest.url);
            if (this.options.obeyRobotsTxt) {
                await this.assertRobotsAllowsUrl(spider, mergedRequest.url, mergedRequest.headers);
            }
            await this.emitApp('beforeRequest', ctx);
            await spider.emit('beforeRequest', ctx);
            await dispatchFetch(ctx);
            await this.emitApp('afterResponse', ctx);
            await spider.emit('afterResponse', ctx);
        } catch (err) {
            await this.emitApp('error', err, ctx);
            await spider.emit('error', err, ctx);
            throw err;
        } finally {
            delete ctx.sink;
            delete ctx.respond;
        }
    }
}

/** 按参数顺序合并；后者覆盖前者同名键 */
function mergeHeaders(...layers: Array<Record<string, string> | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const layer of layers) {
        if (!layer) {
            continue;
        }
        for (const [k, v] of Object.entries(layer)) {
            out[k] = v;
        }
    }
    return out;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * hostname 是否命中 domains 中任一条（大小写不敏感；`douban.com` 匹配自身及任意子域）
 */
function hostnameMatchesAnyDomain(hostname: string, domains: readonly string[]): boolean {
    const host = hostname.toLowerCase();
    for (const raw of domains) {
        const entry = raw.trim().toLowerCase();
        if (entry === '') {
            continue;
        }
        const base = entry.startsWith('*.') ? entry.slice(2) : entry;
        if (base === '') {
            continue;
        }
        if (host === base || host.endsWith('.' + base)) {
            return true;
        }
    }
    return false;
}

export { Spider } from './spider.js';
export type { SpiderEvent, SpiderHandler, SpiderOptions } from './spider.js';
export { Crawlnd };
