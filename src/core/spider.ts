import type { CrawlContext, CrawlQueuedRequest } from './context.js';
import { REQUEST_TAG_SEED } from './context.js';
import type { Crawlnd } from './crawlnd.js';

export interface SpiderOptions {
    /** 必填，用于 Crawlnd.crawl(name) 筛选；是否全局唯一由调用方约定 */
    name: string;
    /** 起始 URL，依次转为 GET 请求；与 getSeeds 同时存在时 getSeeds 优先 */
    startUrls?: string[];
    /** 自定义种子请求（可异步返回） */
    getSeeds?: () => CrawlQueuedRequest[] | Promise<CrawlQueuedRequest[]>;
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

    constructor(options: SpiderOptions) {
        if (options.name.trim() === '') {
            throw new Error('Spider 的 options.name 不能为空字符串或纯空白');
        }
        this.options = options;
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
     * 解析本 Spider 的种子请求列表：getSeeds 优先，否则由 startUrls 生成 GET
     */
    async resolveSeeds(): Promise<CrawlQueuedRequest[]> {
        if (this.options.getSeeds) {
            return Promise.resolve(this.options.getSeeds());
        }
        const urls = this.options.startUrls ?? [];
        return urls.map((url) => ({ url, method: 'GET', headers: {} }));
    }
}
