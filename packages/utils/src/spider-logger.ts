import type { CrawlContext, CrawlQueuedRequest, CrawlRequest, Spider } from 'crawlnd';
import {
    createPersistSinks,
    type FileLogSinkOptions,
    type LogRecord,
    type LogSink,
    type MysqlLogSinkOptions,
} from './log-persist.js';
import {
    createAutoRedisJobStatsRemote,
    type JobStatsDelta,
    type JobStatsRemote,
} from './redis-job-stats.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 日志语言：中文 / 英文 / 中英双语（默认） */
export type LogLocale = 'zh' | 'en' | 'both';

export interface CrawlStats {
    pages: number;
    items: number;
    saved: number;
    skipped: number;
    errors: number;
}

export interface PageLogInfo {
    /** 本页条目数 */
    items?: number;
    /** 新入库数 */
    new?: number;
    /** 去重跳过数 */
    skip?: number;
    /** 接口声明的总数 */
    total?: number | string;
    /** 接口提示信息 */
    msg?: string;
    /** 额外字段 */
    extra?: Record<string, unknown>;
}

export interface LogPersistOptions {
    enabled: boolean;
    /** 同时打控制台，默认 true */
    console?: boolean;
    file?: FileLogSinkOptions;
    database?: MysqlLogSinkOptions;
}

export type SpiderLogEventKey = 'start' | 'seeds' | 'page' | 'request' | 'error' | 'done' | 'failed';

type EventKey = SpiderLogEventKey;

export interface SpiderLoggerOptions {
    /** 日志前缀，默认 spider.getName() */
    name?: string;
    /** open 时打印的元信息，如 keyword、pageSize */
    meta?: Record<string, unknown>;
    /** 最低输出级别，默认 info */
    level?: LogLevel;
    /** 日志语言，默认 both（中英双语） */
    locale?: LogLocale;
    /** 是否打印时间戳，默认 false */
    timestamp?: boolean;
    /** 是否在 beforeRequest 打印请求，默认 false */
    logRequest?: boolean;
    /** 日志持久化：本地 JSONL 和/或 MySQL */
    persist?: LogPersistOptions;
    /** 关联管理台任务 ID，写入 LogRecord.runId */
    runId?: number;
    /**
     * 本 Run 的 frontier。为 `redis` 且提供 `runId` 时，自动把 stats 增量写入 Redis。
     * 显式传入 `remoteStats` 时以 remoteStats 为准；`remoteStats: false` 关闭远程。
     */
    frontierType?: 'memory' | 'redis';
    /**
     * 远程 stats 后端（多 Worker 聚合）。
     * `false`：禁用；省略且 frontierType=redis：自动接 Redis。
     */
    remoteStats?: JobStatsRemote | false;
    /** 关闭时额外清理（连接池等）；在 persist sink flush 之后调用 */
    onClose?: () => void | Promise<void>;
    /**
     * 从请求取业务标识（页码 / 手机号 / id 等）。
     * 未设时回退 `getPage`，再回退默认页码推断。
     */
    getUnit?: (request: CrawlRequest | CrawlQueuedRequest) => string | number | undefined;
    /**
     * @deprecated 使用 `getUnit`；保留兼容分页站
     */
    getPage?: (request: CrawlRequest | CrawlQueuedRequest) => string | number | undefined;
    /**
     * 单条进度日志里标识字段的 key，默认 `page`（中文「页码」）。
     * 批量站可设为 `phone` 等。
     */
    unitField?: string;
    /**
     * 种子汇总字段 key。
     * 默认：unitField==='page' → `pageRange`；否则 → `${unitField}Summary`（如 phoneSummary）。
     */
    rangeField?: string;
    /**
     * 种子汇总格式：
     * - `range`：连续页码用 `[首..末]`（默认，仅 unitField==='page'）
     * - `list`：离散标识；≤seedListMax 全列出，否则 `首 … 末（共 N 个）`
     */
    seedSummaryMode?: 'range' | 'list';
    /** list 模式下全量列出的上限，默认 10 */
    seedListMax?: number;
    /** 覆盖事件文案，如 page → { zh: '进度', en: 'item' } */
    eventLabels?: Partial<Record<SpiderLogEventKey, { zh: string; en: string }>>;
    /** 覆盖字段文案 */
    fieldLabels?: Record<string, { zh: string; en: string }>;
}

const LEVEL_RANK: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

const PAGE_KEYS = ['pageNO', 'pageNumber', 'pageNo', 'page', 'page_no'] as const;

const EVENT_I18N: Record<EventKey, { zh: string; en: string }> = {
    start: { zh: '开始', en: 'start' },
    seeds: { zh: '种子', en: 'seeds' },
    page: { zh: '分页', en: 'page' },
    request: { zh: '请求', en: 'request' },
    error: { zh: '错误', en: 'error' },
    done: { zh: '完成', en: 'done' },
    failed: { zh: '失败', en: 'failed' },
};

const FIELD_I18N: Record<string, { zh: string; en: string }> = {
    keyword: { zh: '关键词', en: 'keyword' },
    pageSize: { zh: '页大小', en: 'pageSize' },
    count: { zh: '数量', en: 'count' },
    /** 完成日志里 stats.pages：处理批次数 */
    pages: { zh: '批次数', en: 'batches' },
    /** 种子汇总：页码首..末 */
    pageRange: { zh: '页码范围', en: 'pageRange' },
    page: { zh: '页码', en: 'page' },
    phone: { zh: '手机号', en: 'phone' },
    /** 种子汇总（离散列表 / 摘要），勿与单条进度的 phone 混淆 */
    phoneSummary: { zh: '手机号', en: 'phoneSummary' },
    /** @deprecated 旧日志可能仍用 phones */
    phones: { zh: '手机号', en: 'phones' },
    status: { zh: '状态', en: 'status' },
    items: { zh: '条目', en: 'items' },
    new: { zh: '新增', en: 'new' },
    skip: { zh: '跳过', en: 'skip' },
    saved: { zh: '存入', en: 'saved' },
    total: { zh: '总数', en: 'total' },
    msg: { zh: '消息', en: 'msg' },
    method: { zh: '方法', en: 'method' },
    url: { zh: '地址', en: 'url' },
    message: { zh: '原因', en: 'message' },
    errors: { zh: '错误数', en: 'errors' },
    elapsed: { zh: '耗时', en: 'elapsed' },
};

export interface SpiderLogger {
    readonly name: string;
    readonly stats: Readonly<CrawlStats>;
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
    /** 记录单页抓取结果，并累计 stats */
    page(ctx: CrawlContext, info?: PageLogInfo): void;
}

const STATS_REF = Symbol.for('crawlnd.spiderLogger.stats');

type SpiderWithStats = Spider & { [STATS_REF]?: CrawlStats };

/** 读取 attachSpiderLogger 累计的 stats（供 admin 回写 crawl_runs） */
export function getAttachedCrawlStats(spider: Spider): CrawlStats | null {
    const stats = (spider as SpiderWithStats)[STATS_REF];
    return stats ? { ...stats } : null;
}

/**
 * 给 Spider 挂载统一生命周期日志，并返回可在业务 afterResponse 中调用的 logger。
 */
export function attachSpiderLogger(spider: Spider, options: SpiderLoggerOptions = {}): SpiderLogger {
    const name = options.name ?? spider.getName();
    const minLevel = options.level ?? 'info';
    const locale = options.locale ?? 'en';
    const stats: CrawlStats = { pages: 0, items: 0, saved: 0, skipped: 0, errors: 0 };
    (spider as SpiderWithStats)[STATS_REF] = stats;
    const startedAt = Date.now();
    const getUnit = options.getUnit ?? options.getPage ?? defaultGetPage;
    const unitField = options.unitField ?? 'page';
    const isPageUnit = unitField === 'page';
    const rangeField =
        options.rangeField ?? (isPageUnit ? 'pageRange' : `${unitField}Summary`);
    const seedSummaryMode = options.seedSummaryMode ?? (isPageUnit ? 'range' : 'list');
    const seedListMax = options.seedListMax ?? 10;
    const eventLabels = { ...EVENT_I18N, ...options.eventLabels };
    const fieldLabels = { ...FIELD_I18N, ...options.fieldLabels };
    const persistEnabled = options.persist?.enabled === true;
    const consoleEnabled = options.persist?.console ?? true;
    const hasPersistTarget = Boolean(options.persist?.file || options.persist?.database);

    const remoteStats = resolveRemoteStats(options);
    let remoteChain: Promise<void> = Promise.resolve();

    const pushRemote = (delta: JobStatsDelta): void => {
        if (!remoteStats) {
            return;
        }
        remoteChain = remoteChain
            .then(() => remoteStats.incr(delta))
            .catch((err) => {
                console.error(`[${name}] remote stats incr failed`, err);
            });
    };

    const sinks: LogSink[] = persistEnabled && hasPersistTarget
        ? createPersistSinks({
            file: options.persist?.file,
            database: options.persist?.database,
        })
        : [];

    let writeChain: Promise<void> = Promise.resolve();

    const write = (
        level: LogLevel,
        message: string,
        fields?: Record<string, unknown>,
        event: string | null = null,
    ): void => {
        if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) {
            return;
        }

        if (consoleEnabled) {
            const parts = [`[${name}]`];
            if (options.timestamp) {
                parts.push(new Date().toISOString());
            }
            parts.push(message);
            const kv = formatFields(fields, locale, fieldLabels);
            if (kv) {
                parts.push(kv);
            }
            const line = parts.join(' ');
            if (level === 'error') {
                console.error(line);
            } else if (level === 'warn') {
                console.warn(line);
            } else {
                console.log(line);
            }
        }

        if (!persistEnabled || sinks.length === 0) {
            return;
        }

        const record: LogRecord = {
            ts: new Date().toISOString(),
            spider: name,
            level,
            event,
            message,
            runId: options.runId ?? null,
            ...(fields !== undefined ? { fields } : {}),
        };
        writeChain = writeChain
            .then(async () => {
                await Promise.all(sinks.map((sink) => sink.write(record)));
            })
            .catch((err) => {
                console.error(`[${name}] persist log failed`, err);
            });
    };

    const writeEvent = (level: LogLevel, event: EventKey, fields?: Record<string, unknown>): void => {
        write(level, labelEvent(event, locale, eventLabels), fields, event);
    };

    const logger: SpiderLogger = {
        name,
        get stats() {
            return stats;
        },
        debug: (message, fields) => write('debug', message, fields),
        info: (message, fields) => write('info', message, fields),
        warn: (message, fields) => write('warn', message, fields),
        error: (message, fields) => write('error', message, fields),
        page(ctx, info = {}) {
            stats.pages += 1;
            const items = info.items ?? 0;
            const saved = info.new ?? 0;
            const skipped = info.skip ?? Math.max(0, items - saved);
            stats.items += items;
            stats.saved += saved;
            stats.skipped += skipped;
            pushRemote({ pages: 1, items, saved, skipped });

            writeEvent('info', 'page', {
                [unitField]: getUnit(ctx.request) ?? '-',
                status: ctx.response?.status ?? '-',
                items,
                new: saved,
                skip: skipped,
                ...(info.total !== undefined ? { total: info.total } : {}),
                ...(info.msg !== undefined && info.msg !== '' ? { msg: info.msg } : {}),
                ...(info.extra ?? {}),
            });
        },
    };

    spider.on('open', () => {
        writeEvent('info', 'start', options.meta);
    });

    spider.on('seeds', (requests) => {
        const units = requests
            .map((r) => getUnit(r))
            .filter((v): v is string | number => v !== undefined && v !== null && v !== '');
        writeEvent('info', 'seeds', {
            count: requests.length,
            [rangeField]: formatSeedSummary(units, seedSummaryMode, seedListMax),
            ...(options.meta?.pageSize !== undefined ? { pageSize: options.meta.pageSize } : {}),
        });
    });

    if (options.logRequest) {
        spider.on('beforeRequest', '*', (ctx) => {
            writeEvent('debug', 'request', {
                [unitField]: getUnit(ctx.request) ?? '-',
                method: ctx.request.method ?? 'GET',
                url: ctx.request.url,
            });
        });
    }

    spider.on('error', '*', (err, ctx) => {
        stats.errors += 1;
        pushRemote({ errors: 1 });
        writeEvent('error', 'error', {
            [unitField]: getUnit(ctx.request) ?? '-',
            message: err instanceof Error ? err.message : String(err),
        });
    });

    spider.on('close', async () => {
        const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
        const fields = {
            pages: stats.pages,
            items: stats.items,
            saved: stats.saved,
            skip: stats.skipped,
            errors: stats.errors,
            elapsed: `${sec}s`,
        };
        if (stats.errors > 0) {
            writeEvent('error', 'failed', fields);
        } else {
            writeEvent('info', 'done', fields);
        }
        await remoteChain;
        await writeChain;
        await Promise.all(sinks.map((sink) => sink.close()));
        if (options.onClose) {
            await options.onClose();
        }
    });

    return logger;
}

function resolveRemoteStats(options: SpiderLoggerOptions): JobStatsRemote | null {
    if (options.remoteStats === false) {
        return null;
    }
    if (options.remoteStats) {
        return options.remoteStats;
    }
    if (options.frontierType === 'redis' && options.runId != null) {
        return createAutoRedisJobStatsRemote(options.runId);
    }
    return null;
}

/** 从 json / data / query / formData 中推断页码 */
export function defaultGetPage(request: CrawlRequest | CrawlQueuedRequest): string | number | undefined {
    const bags: Array<Record<string, unknown> | undefined> = [
        request.json as Record<string, unknown> | undefined,
        request.data,
        request.query,
        request.formData,
    ];
    for (const bag of bags) {
        if (!bag) {
            continue;
        }
        for (const key of PAGE_KEYS) {
            const value = bag[key];
            if (value !== undefined && value !== null && value !== '') {
                return value as string | number;
            }
        }
    }
    return undefined;
}

/** 种子汇总文案：页码用闭区间；离散标识用列表或首尾摘要 */
export function formatSeedSummary(
    units: Array<string | number>,
    mode: 'range' | 'list',
    listMax = 10,
): string {
    if (!units.length) {
        return '-';
    }
    if (mode === 'range') {
        return `[${units[0]}..${units[units.length - 1]}]`;
    }
    if (units.length <= listMax) {
        return units.join(', ');
    }
    return `${units[0]} … ${units[units.length - 1]}（共 ${units.length} 个）`;
}

function labelEvent(
    event: EventKey,
    locale: LogLocale,
    labels: Record<EventKey, { zh: string; en: string }> = EVENT_I18N,
): string {
    const item = labels[event] ?? EVENT_I18N[event];
    if (locale === 'zh') {
        return item.zh;
    }
    if (locale === 'en') {
        return item.en;
    }
    return `${item.zh}/${item.en}`;
}

function labelField(
    key: string,
    locale: LogLocale,
    labels: Record<string, { zh: string; en: string }> = FIELD_I18N,
): string {
    const item = labels[key];
    if (!item) {
        return key;
    }
    if (locale === 'zh') {
        return item.zh;
    }
    if (locale === 'en') {
        return item.en;
    }
    return `${item.zh}/${item.en}`;
}

function formatFields(
    fields: Record<string, unknown> | undefined,
    locale: LogLocale,
    labels: Record<string, { zh: string; en: string }> = FIELD_I18N,
): string {
    if (!fields) {
        return '';
    }
    return Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${labelField(k, locale, labels)}=${stringifyField(v)}`)
        .join(' ');
}

function stringifyField(value: unknown): string {
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'string') {
        return value.includes(' ') ? JSON.stringify(value) : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
