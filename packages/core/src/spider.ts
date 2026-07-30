import type { CrawlContext, CrawlQueuedRequest } from './context.js';
import { REQUEST_TAG_SEED } from './context.js';
import type { Crawlnd } from './crawlnd.js';
import { join } from 'node:path';
import { SeedFingerprintFileStore } from './seed-fingerprint-file.js';

/**
 * 将片段转为可作为单级目录/文件名的安全字符串（去除路径分隔符与非法字符）
 */
export function safePathSegment(raw: string): string {
    const s = raw
        .replace(/[/\\:*?"<>|\x00-\x1f]/g, '_')
        .replace(/_+/g, '_')
        .trim();
    if (s === '' || s === '.' || s === '..') {
        return '_';
    }
    return s;
}

/**
 * 按 tag 的请求指纹去重配置：三选一
 * - 非空 `stateFile`：显式 JSON 文件路径（优先级最高）
 * - 非空 `stateDir`：自动使用 `{stateDir}/{spiderName}/{safeTag}.json`
 * - 同时提供 `isDone` 与 `markDone`：自定义存储
 *
 * 语义是「见过的请求跳过」，不是业务增量同步。与 Job 级 `DupeFilter` 可并存。
 */
export interface SpiderDedupeOptions {
    /** 本地 JSON 数组文件路径（元素为指纹 hex）；与 `stateDir`、手写回调三选一，且优先于 `stateDir` */
    stateFile?: string;
    /**
     * 状态根目录；实际文件为 `{stateDir}/{spiderName}/{safeTag}.json`（spiderName、tag 经安全化）。
     * 与 `stateFile` 同时存在时以 `stateFile` 为准。
     */
    stateDir?: string;
    /** 与 `markDone` 成对出现；与文件类选项三选一 */
    isDone?: (fingerprintHash: string) => boolean | Promise<boolean>;
    /** 与 `isDone` 成对出现；与文件类选项三选一 */
    markDone?: (fingerprintHash: string) => void | Promise<void>;
}

/** 解析后的单 tag 去重规则（供 Crawlnd 调度） */
export type SpiderDedupeResolved = {
    isDone: (fingerprintHash: string) => boolean | Promise<boolean>;
    markDone: (fingerprintHash: string) => void | Promise<void>;
    /** 持久化到本地文件时：每轮 Spider 开跑前刷新磁盘 */
    reloadFromDisk?: () => Promise<void>;
};

export interface SpiderOptions {
    /** 必填，用于 Crawlnd.crawl(name) 筛选；是否全局唯一由调用方约定 */
    name: string;
    /** 起始 URL，依次转为 GET 请求；与 seeds 同时存在时 seeds 优先 */
    startUrls?: string[];
    /** 自定义种子请求（可异步返回） */
    seeds?: () => CrawlQueuedRequest[] | Promise<CrawlQueuedRequest[]>;
    /** 默认请求头 */
    defaultHeaders?: Record<string, string>;
    /**
     * 本 Spider 允许的域名；省略或空数组表示不在 Spider 层限制（仍可能受 CrawlndOptions.validDomains 约束）。
     * 规则同工程级；与工程同时为非空时须同时满足。
     */
    validDomains?: string[];
}

/** Spider 生命周期事件名（与 spider.on / app.on 一致） */
export type SpiderEvent = 'open' | 'seeds' | 'beforeRequest' | 'afterResponse' | 'error' | 'close';

/** 各事件对应的监听函数签名 */
export type SpiderHandler = {
    /** 本轮开始，尚未 resolveSeeds */
    open: () => void | Promise<void>;
    /** 种子列表已解析，尚未发第一条请求 */
    seeds: (requests: CrawlQueuedRequest[]) => void | Promise<void>;
    /** 即将 fetch */
    beforeRequest: (ctx: CrawlContext) => void | Promise<void>;
    /** fetch 成功且已写入 ctx.response */
    afterResponse: (ctx: CrawlContext) => void | Promise<void>;
    /** fetch 或 afterResponse 内抛错；监听后仍会向上抛出 */
    error: (err: unknown, ctx: CrawlContext) => void | Promise<void>;
    /** 本轮结束（含种子为空、中途抛错也会触发） */
    close: () => void | Promise<void>;
};

/** 带可选 request.tag 过滤的监听项 */
export type TaggedHook = {
    tag?: string;
    fn: (...args: unknown[]) => unknown;
};

/** 两参数 on(event, listener) 且第二项为函数时，对以下事件默认按 seed 过滤 */
export function listenerTagForTwoArgOn(event: SpiderEvent): string | undefined {
    if (event === 'beforeRequest' || event === 'afterResponse' || event === 'error') {
        return REQUEST_TAG_SEED;
    }
    return undefined;
}

/**
 * 仅对带 CrawlContext 的事件按 ctx.request.tag 过滤；其余事件不因 tag 跳过
 */
export function hookMatchesRequestTag(event: string, tagFilter: string | undefined, args: unknown[]): boolean {
    if (tagFilter === undefined || tagFilter === '*') {
        return true;
    }
    let ctx: CrawlContext | undefined;
    if (event === 'beforeRequest' || event === 'afterResponse') {
        ctx = args[0] as CrawlContext;
    } else if (event === 'error') {
        ctx = args[1] as CrawlContext;
    } else {
        return true;
    }
    return ctx.request.tag === tagFilter;
}

export class Spider {
    private options: SpiderOptions;
    private listeners: Partial<Record<SpiderEvent, TaggedHook[]>> = {};
    /** 按 request.tag 匹配的去重规则（`dedupe` 注册） */
    private dedupeByTag = new Map<string, SpiderDedupeResolved>();

    constructor(options: SpiderOptions) {
        if (options.name.trim() === '') {
            throw new Error('Spider 的 options.name 不能为空字符串或纯空白');
        }
        this.options = options;
    }

    /**
     * 按 tag 配置请求指纹去重：仅当 `ctx.request.tag` 与注册 tag 一致时参与 isDone / markDone（指纹不含 tag）。
     * 单参时 tag 固定为 `seed`；`stateFile` 优先于 `stateDir`；否则 `stateDir` 生成 `{stateDir}/{spiderName}/{safeTag}.json`；再否则须 `isDone`+`markDone`；同一 tag 不可重复注册。
     */
    dedupe(options: SpiderDedupeOptions): void;
    dedupe(tag: string, options: SpiderDedupeOptions): void;
    dedupe(a: string | SpiderDedupeOptions, b?: SpiderDedupeOptions): void {
        const tag = b === undefined ? REQUEST_TAG_SEED : String(a).trim();
        const opts = (b === undefined ? a : b) as SpiderDedupeOptions;
        if (tag === '' || tag === '*') {
            throw new Error('dedupe 的 tag 不能为空或 *');
        }
        if (this.dedupeByTag.has(tag)) {
            throw new Error(`dedupe：tag「${tag}」已存在，请勿重复注册`);
        }
        const explicitFile = opts.stateFile?.trim();
        if (explicitFile !== undefined && explicitFile !== '') {
            this.registerFileStoreForTag(tag, explicitFile);
            return;
        }
        const dir = opts.stateDir?.trim();
        if (dir !== undefined && dir !== '') {
            const resolved = join(dir, safePathSegment(this.getName()), `${safePathSegment(tag)}.json`);
            this.registerFileStoreForTag(tag, resolved);
            return;
        }
        if (opts.isDone === undefined || opts.markDone === undefined) {
            throw new Error('dedupe：请提供 stateFile、stateDir，或同时提供 isDone 与 markDone');
        }
        this.dedupeByTag.set(tag, {
            isDone: opts.isDone,
            markDone: opts.markDone,
        });
    }

    /** 为某 tag 注册基于文件的指纹存储 */
    private registerFileStoreForTag(tag: string, absoluteOrRelativePath: string): void {
        const store = new SeedFingerprintFileStore(absoluteOrRelativePath);
        const h = store.asHandlers();
        this.dedupeByTag.set(tag, {
            isDone: h.isDone,
            markDone: h.markDone,
            reloadFromDisk: () => store.reloadFromDisk(),
        });
    }

    /** 供 Crawlnd 解析某 tag 是否启用去重 */
    getDedupeRuleForTag(tag: string | undefined): SpiderDedupeResolved | undefined {
        if (tag === undefined || tag === '') {
            return undefined;
        }
        return this.dedupeByTag.get(tag);
    }

    /** 所有基于本地文件的去重规则在开跑前从磁盘刷新 */
    async reloadFileDedupes(): Promise<void> {
        for (const rule of this.dedupeByTag.values()) {
            if (rule.reloadFromDisk !== undefined) {
                await rule.reloadFromDisk();
            }
        }
    }

    /**
     * 注册生命周期监听；同一事件可多次 on，按注册顺序依次 await。
     * 两参数且第二项为函数时：beforeRequest / afterResponse / error 默认仅当 ctx.request.tag 为 seed 时触发；open/seeds/close 不受影响。
     * 三参数时第二项为 tag：仅当 ctx.request.tag === tag 会触发（上述三事件）；tag 为 '*' 时表示不过滤 tag。open/seeds/close 带 tag 时 tag 不参与过滤，仍会执行。
     */
    on<E extends SpiderEvent>(event: E, listener: SpiderHandler[E]): void;
    on<E extends SpiderEvent>(event: E, tag: string, listener: SpiderHandler[E]): void;
    on<E extends SpiderEvent>(event: E, arg2: SpiderHandler[E] | string, arg3?: SpiderHandler[E]): void {
        const bucket = ((this.listeners[event] ??= []) as TaggedHook[]);
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

    /**
     * 触发事件（由 Crawlnd 调度调用；业务侧一般不需要直接调用）
     */
    async emit<E extends SpiderEvent>(
        event: E,
        ...args: E extends 'open'
            ? []
            : E extends 'seeds'
            ? [CrawlQueuedRequest[]]
            : E extends 'beforeRequest' | 'afterResponse'
            ? [CrawlContext]
            : E extends 'error'
            ? [unknown, CrawlContext]
            : E extends 'close'
            ? []
            : never
    ): Promise<void> {
        const list = this.listeners[event];
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

    /**
     * 在已注册本实例的 Crawlnd 上只跑自己（等价于 app.crawl(this.getName())）
     */
    async runOn(app: Crawlnd): Promise<void> {
        await app.crawl(this.getName());
    }

    /** 与构造时校验一致，始终返回非空名称 */
    getName(): string {
        return this.options.name;
    }

    /** 本 Spider 在 options 中配置的 defaultHeaders（与工程级合并由 Crawlnd 在发请求前完成） */
    getDefaultHeaders(): Record<string, string> | undefined {
        return this.options.defaultHeaders;
    }

    /** 本 Spider 的 validDomains（供 Crawlnd 调度前校验） */
    getValidDomains(): readonly string[] | undefined {
        return this.options.validDomains;
    }

    /**
     * 解析本 Spider 的种子请求列表：seeds 优先，否则由 startUrls 生成 GET
     */
    async resolveSeeds(): Promise<CrawlQueuedRequest[]> {
        if (this.options.seeds) {
            return Promise.resolve(this.options.seeds());
        }
        const urls = this.options.startUrls ?? [];
        return urls.map((url) => ({ url, method: 'GET', headers: {} }));
    }

    static sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
