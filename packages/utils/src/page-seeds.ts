import type { CrawlQueuedRequest } from 'crawlnd';

/**
 * 分页模式（互斥，由 mode 区分）：
 * - single：只抓 pageNO 一页
 * - range：抓闭区间 from..to（前 N 页用 from=1, to=N）
 */
export type PageSeedOptions =
    | { mode: 'single'; pageNO: number; pageSize?: number }
    | { mode: 'range'; from: number; to: number; pageSize?: number };

/**
 * 按分页模式生成 seeds 工厂。
 * `build(pageNO, pageSize)` 由各站点自定义请求体。
 */
export function createPageSeeds(
    options: PageSeedOptions,
    build: (pageNO: number, pageSize: number) => CrawlQueuedRequest,
): () => CrawlQueuedRequest[] {
    const pageSize = options.pageSize ?? 20;
    const pages = resolvePageNumbers(options);
    return () => pages.map((pageNO) => build(pageNO, pageSize));
}

export function resolvePageNumbers(options: PageSeedOptions): number[] {
    switch (options.mode) {
        case 'single': {
            if (!Number.isInteger(options.pageNO) || options.pageNO < 1) {
                throw new Error(`single 模式 pageNO 须为正整数，收到 ${options.pageNO}`);
            }
            return [options.pageNO];
        }
        case 'range': {
            const { from, to } = options;
            if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
                throw new Error(`range 模式 from/to 须为正整数，收到 from=${from} to=${to}`);
            }
            if (from > to) {
                throw new Error(`range 模式非法：from(${from}) > to(${to})`);
            }
            return Array.from({ length: to - from + 1 }, (_, i) => from + i);
        }
        default: {
            const _exhaustive: never = options;
            throw new Error(`未知分页模式：${JSON.stringify(_exhaustive)}`);
        }
    }
}

/**
 * 从管理台 / API 的松散 params 解析成分页选项。
 * 支持：
 * 1) 嵌套 `pagination: { mode, ... }`
 * 2) 顶层扁平 `{ mode, pageNO|from,to, pageSize? }`
 */
export function parsePageSeedOptions(params: Record<string, unknown>): PageSeedOptions {
    const raw =
        params.pagination !== undefined && typeof params.pagination === 'object' && params.pagination !== null
            ? { ...(params.pagination as Record<string, unknown>) }
            : { ...params };

    const pageSize =
        typeof raw.pageSize === 'number'
            ? raw.pageSize
            : typeof params.pageSize === 'number'
              ? params.pageSize
              : undefined;

    const mode = raw.mode;
    if (mode === 'single') {
        const pageNO = Number(raw.pageNO);
        return { mode: 'single', pageNO, ...(pageSize !== undefined ? { pageSize } : {}) };
    }
    if (mode === 'range') {
        // 兼容旧字段 range: [from, to]
        if (Array.isArray(raw.range) && raw.range.length === 2) {
            return {
                mode: 'range',
                from: Number(raw.range[0]),
                to: Number(raw.range[1]),
                ...(pageSize !== undefined ? { pageSize } : {}),
            };
        }
        // from/to 为主；兼容 start/end
        const from = Number(raw.from ?? raw.start);
        const to = Number(raw.to ?? raw.end);
        return {
            mode: 'range',
            from,
            to,
            ...(pageSize !== undefined ? { pageSize } : {}),
        };
    }

    throw new Error(`缺少或非法的分页 mode（single|range），收到：${String(mode)}`);
}
