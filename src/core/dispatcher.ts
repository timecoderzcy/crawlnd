import type {
    CrawlContext,
    CrawlRequest,
    CrawlResponse,
    CrawlResponseBody,
    JsonValue,
    RespondInit,
} from './context.js';
import { createResponseBodySelectors } from './html-select.js';

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
 * 否则发起 fetch 并按 content-type 解析为 string / Buffer / JsonValue，最后织入 select / selectAll
 */
export async function dispatchFetch(ctx: CrawlContext): Promise<void> {
    if (ctx.response !== undefined) {
        return;
    }
    const { url, method, headers, body } = ctx.request;
    const init: RequestInit = {
        method: method ?? 'GET',
        headers: headers as HeadersInit,
    };
    if (body !== undefined) {
        init.body = body;
    }
    const res = await fetch(url, init);
    const headerMap: Record<string, string> = {};
    res.headers.forEach((value, key) => {
        headerMap[key] = value;
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
        headers: headerMap,
        url: res.url,
        redirected: res.redirected,
        body: responseBody,
        res: res,
        select: selectors.select,
        selectAll: selectors.selectAll,
    };
}
