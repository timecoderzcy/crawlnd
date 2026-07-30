import type {
    CrawlContext,
    CrawlRequest,
    CrawlResponse,
    CrawlResponseBody,
    JsonValue,
    RespondInit,
} from './context.js';
import { createResponseBodySelectors } from './html-select.js';
import { fetch as undiciFetch, ProxyAgent, type RequestInit as UndiciRequestInit } from 'undici';

/** 不区分大小写地从 headers 中取 header（用于推断 select / selectAll 的 markup 模式） */
function pickHeaderInsensitive(
    headers: Record<string, string> | undefined,
    name: string,
): string | undefined {
    if (!headers) {
        return undefined;
    }
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lower) {
            return v;
        }
    }
    return undefined;
}

/** 查找 headers 中与 name 大小写不敏感匹配的键名（用于在原对象上写入 Cookie 等） */
function findHeaderKey(headers: Record<string, string>, name: string): string | undefined {
    const lower = name.toLowerCase();
    for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === lower) {
            return k;
        }
    }
    return undefined;
}

/**
 * 将 params 写入 url：先替换 `{key}`，再替换路径段形式的 `:key`（避免误伤 `https:` 中的冒号）
 */
function applyUrlParams(urlStr: string, params: Record<string, string> | undefined): string {
    if (!params || Object.keys(params).length === 0) {
        return urlStr;
    }
    let out = urlStr;
    for (const [k, v] of Object.entries(params)) {
        const enc = encodeURIComponent(v);
        out = out.split(`{${k}}`).join(enc);
        out = out.replace(new RegExp(`(^|/):${escapeRegExp(k)}(?=/|\\?|#|$)`, 'g'), `$1${enc}`);
    }
    return out;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 将 query 合并进 URL（同名键以 query 为准覆盖） */
function applyQuery(urlStr: string, query: Record<string, string> | undefined): string {
    if (!query || Object.keys(query).length === 0) {
        return urlStr;
    }
    const u = new URL(urlStr);
    for (const [k, v] of Object.entries(query)) {
        u.searchParams.set(k, v);
    }
    return u.toString();
}

/** 合并 cookies 到请求头中的 Cookie 字段 */
function mergeCookiesIntoHeaders(
    headers: Record<string, string>,
    cookies: Record<string, string> | undefined,
): void {
    if (!cookies || Object.keys(cookies).length === 0) {
        return;
    }
    const cookieStr = Object.entries(cookies)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('; ');
    const cookieKey = findHeaderKey(headers, 'cookie');
    if (cookieKey !== undefined) {
        headers[cookieKey] = `${headers[cookieKey]}; ${cookieStr}`;
    } else {
        headers['Cookie'] = cookieStr;
    }
}

/** 若尚未设置 Content-Type，则写入默认值 */
function ensureContentType(headers: Record<string, string>, value: string): void {
    if (!pickHeaderInsensitive(headers, 'content-type')) {
        headers['Content-Type'] = value;
    }
}

/**
 * 从 proxy 配置解析出代理 URL：优先 `url` 键，否则取第一个以 http:// 或 https:// 开头的值
 */
function resolveProxyUrl(proxy: Record<string, string> | undefined): string | undefined {
    if (!proxy || Object.keys(proxy).length === 0) {
        return undefined;
    }
    const direct = proxy.url?.trim();
    if (direct) {
        return direct;
    }
    for (const v of Object.values(proxy)) {
        const t = v.trim();
        if (t.startsWith('http://') || t.startsWith('https://')) {
            return t;
        }
    }
    return undefined;
}

/**
 * 按 json > formData > data 优先级构造请求体，并视情况补 Content-Type
 */
function attachRequestBody(
    headers: Record<string, string>,
    init: RequestInit,
    request: CrawlRequest,
): void {
    const { json, formData, data } = request;
    if (json !== undefined) {
        init.body = JSON.stringify(json);
        ensureContentType(headers, 'application/json; charset=utf-8');
        return;
    }
    if (formData !== undefined && Object.keys(formData).length > 0) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(formData)) {
            fd.append(k, v);
        }
        init.body = fd;
        return;
    }
    if (data !== undefined && Object.keys(data).length > 0) {
        init.body = new URLSearchParams(data).toString();
        ensureContentType(headers, 'application/x-www-form-urlencoded; charset=utf-8');
    }
}

/**
 * 基于 ctx.request 与用户提供的 body / init 构造一个完整 CrawlResponse：
 * - status 默认 200；statusText 默认 'OK'；url 默认取 request.url；redirected 默认 false
 * - select / selectAll 自动按 init.headers 中的 content-type 织入
 * 用于 ctx.respond 短路赋值场景；不会发起实际网络请求
 */
export function buildShortCircuitResponse(
    request: CrawlRequest,
    body: CrawlResponseBody,
    init?: RespondInit,
): CrawlResponse {
    const headers = init?.headers;
    const ct = pickHeaderInsensitive(headers, 'content-type') ?? '';
    const selectors = createResponseBodySelectors(body, ct);
    return {
        status: init?.status ?? 200,
        statusText: init?.statusText ?? 'OK',
        headers: headers,
        url: init?.url ?? request.url,
        redirected: init?.redirected ?? false,
        body: body,
        select: selectors.select,
        selectAll: selectors.selectAll,
    };
}

/**
 * 默认派发：当 ctx.response 已被 hook 提前赋值（短路）时，直接跳过网络请求；
 * 否则按 query / params / data / json / formData / cookies / proxy 组装请求后 fetch，
 * 并按 content-type 解析为 string / Buffer / JsonValue，最后织入 select / selectAll
 */
export async function dispatchFetch(ctx: CrawlContext): Promise<void> {
    if (ctx.response !== undefined) {
        return;
    }
    const { url, method, headers, query, params, proxy, cookies } = ctx.request;

    let finalUrl = applyUrlParams(url, params);
    finalUrl = applyQuery(finalUrl, query);

    const headerMap: Record<string, string> = { ...(headers ?? {}) };
    mergeCookiesIntoHeaders(headerMap, cookies);

    const init: RequestInit = {
        method: method ?? 'GET',
        headers: headerMap as HeadersInit,
    };
    attachRequestBody(headerMap, init, ctx.request);

    const proxyUrl = resolveProxyUrl(proxy);
    let res: Response;
    if (proxyUrl !== undefined) {
        const agent = new ProxyAgent(proxyUrl);
        try {
            const undiciInit: UndiciRequestInit = {
                method: init.method,
                headers: init.headers,
                body: init.body as UndiciRequestInit['body'],
                dispatcher: agent,
            };
            res = (await undiciFetch(finalUrl, undiciInit)) as unknown as Response;
        } finally {
            await agent.close();
        }
    } else {
        res = await fetch(finalUrl, init);
    }

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
    });
    const ct = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    let responseBody: CrawlResponseBody;
    if (ct.includes('json')) {
        responseBody = JSON.parse(buf.toString('utf8')) as JsonValue;
    } else if (/^(image|video|audio)\//.test(ct) || ct === 'application/octet-stream') {
        responseBody = buf;
    } else {
        responseBody = buf.toString('utf8');
    }
    const selectors = createResponseBodySelectors(responseBody, res.headers.get('content-type') ?? '');
    ctx.response = {
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
        url: res.url,
        redirected: res.redirected,
        body: responseBody,
        res: res,
        select: selectors.select,
        selectAll: selectors.selectAll,
    };
}
