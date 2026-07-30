/**
 * 单次抓取在洋葱模型中流动的上下文（类 Koa 的 ctx）
 */
import type { HtmlSelection } from './html-select.js';

/** 默认：来自 resolveSeeds / 本轮首批入队 */
export const REQUEST_TAG_SEED = 'seed' as const;
/** 默认：来自 sink.submit 的后续请求 */
export const REQUEST_TAG_FOLLOW = 'follow' as const;

export type CrawlRequestMethod = "GET" | "POST";

export interface CrawlRequest {
    url: string;
    method?: CrawlRequestMethod;
    headers?: Record<string, string>;
    /** 追加到 URL 的查询串（与 url 中已有 query 合并，同名键以本字段为准） */
    query?: Record<string, string>;
    /** 替换 url 中的路径占位：`{key}` 或 `:key`（值会经 encodeURIComponent） */
    params?: Record<string, string>;
    /** application/x-www-form-urlencoded 请求体；与 json、formData 同时存在时优先级最低 */
    data?: Record<string, string>;
    /** application/json 请求体；与 formData、data 同时存在时优先于二者 */
    json?: JsonValue;
    /** multipart/form-data 请求体（仅字符串字段）；与 json 同时存在时以 json 为准 */
    formData?: Record<string, string>;
    /** 合并为 Cookie 请求头（与 headers 里已有 Cookie 用分号拼接） */
    cookies?: Record<string, string>;
    /** HTTP 代理：优先读取 `url` 键，形如 `{ url: 'http://127.0.0.1:7890' }`；未配置 `url` 时取首个值为 http(s) 的项 */
    proxy?: Record<string, string>;
    /**
     * 请求分类；未指定时首批为 seed、sink.submit 为 follow，也可 submit 时自定义
     */
    tag?: string;
}

/**
 * 入队用请求：在 `CrawlRequest` 上可选带 `state`，派发时合并进该次请求的 `ctx.state`（不参与 HTTP）
 */
export type CrawlQueuedRequest = CrawlRequest & {
    /** 与 `ctx.state` 同语义；仅入队携带，派发后写入本条 `ctx.state`（在框架注入的 `spider` 之后浅合并） */
    state?: Record<string, unknown>;
};

/**
 * 本轮 Spider 的**唯一入队口**：种子、解析后追加的请求都走这里，与类内部调度共用同一实现
 */
export interface CrawlTaskSink {
    /** 单条可含 `state`，见 `CrawlQueuedRequest` */
    submit(req: CrawlQueuedRequest | CrawlQueuedRequest[]): void;
}

/** JSON 标量 */
export type JsonPrimitive = string | number | boolean | null;

/** JSON 对象形态 */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * JSON.parse 的典型结果（对象、数组或标量根节点）
 */
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

/**
 * HTTP 响应体在爬虫里常见的几种形态（与 fetch + Node 常见用法对齐）
 * - string：按 UTF-8 解码后的文本、HTML 等
 * - Buffer：二进制（图片等），便于 fs 落盘
 * - Uint8Array / ArrayBuffer：字节视图
 * - Blob：需保留 Blob 语义或交给 Web API 时使用
 * - JsonValue：已按 JSON 解析后的结构
 */
export type CrawlResponseBody = string | Buffer | Uint8Array | ArrayBuffer | Blob | JsonValue;

export interface CrawlResponse {
    /** HTTP 状态码 */
    status: number;
    /** 状态短语，如 OK */
    statusText?: string;
    headers?: Record<string, string>;
    /** 重定向后的最终 URL（与 Fetch API 的 response.url 一致） */
    url?: string;
    /** 是否发生过重定向 */
    redirected?: boolean;
    /** 响应体：由调度层按 Content-Type 等填充为文本、二进制或 JSON */
    body?: CrawlResponseBody;
    /** 原始 Response 对象，用于框架内部调试或 hook 扩展 */
    res?: Response;
    /**
     * 在 HTML/XML 文本响应上选择节点：以 `(`、`//`、`./`、`../` 开头，或以 `/` 后接字母、`@`、`_` 的视为 XPath，否则为 CSS（querySelector）。
     * 返回 HtmlSelection 包装：可继续 `.select(...)` 链式定位子元素，或 `.text()` / `.attr(name)` / `.html()` 取值。
     * 非 HTML/XML 或解析失败、未命中均返回 null。
     */
    select: (selector: string) => HtmlSelection | null;
    /**
     * 与 `select` 同语义但匹配全部命中节点：XPath 走 xpath.select，CSS 走 querySelectorAll。
     * 返回 HtmlSelection 数组（每项支持继续链式 select / selectAll）；未命中或正文不可解析时返回空数组。
     */
    selectAll: (selector: string) => HtmlSelection[];
}

/**
 * `ctx.respond` 的可选初始化字段：未提供时使用调度层默认值（status=200、statusText='OK'、url=ctx.request.url、redirected=false）
 */
export interface RespondInit {
    /** 默认 200 */
    status?: number;
    /** 默认 'OK' */
    statusText?: string;
    /** 响应头；select / selectAll 会从这里读取 content-type 推断 markup */
    headers?: Record<string, string>;
    /** 默认 ctx.request.url */
    url?: string;
    /** 默认 false */
    redirected?: boolean;
}

export interface CrawlContext {
    request: CrawlRequest;
    response?: CrawlResponse;
    /**
     * 扩展数据：框架会注入 `spider`；入队时若在 `submit`/种子项上携带 `state`，会浅合并进来；同一请求周期内可在钩子中继续读写
     */
    state: Record<string, unknown>;
    /**
     * 在 beforeRequest / afterResponse 内由调度器注入：与框架内部入队共用同一套 submit
     */
    sink?: CrawlTaskSink;
    /**
     * 短路当前请求：在 beforeRequest 中调用即可不发实际网络请求，直接以 body 作为响应进入 afterResponse 链。
     * 自动织入 select / selectAll（基于 init.headers 的 content-type 推断）。
     * 由调度器在 beforeRequest 起注入；高级用户也可直接对 ctx.response 整体赋值（需自行保证 select / selectAll 等字段完整）。
     */
    respond?: (body: CrawlResponseBody, init?: RespondInit) => void;
}
