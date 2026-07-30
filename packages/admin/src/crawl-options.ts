import { getAdminEnv } from './runtime.js';

/** 单次覆盖（浅覆盖 App 配置中的对应字段） */
export interface CrawlRunOptions {
    concurrentRequests?: number;
    delay?: number;
    obeyRobotsTxt?: boolean;
    concurrentSpiders?: number;
}

/** App / 工程级配置（CrawlndOptions 可暴露子集） */
export interface CrawlAppConfig {
    concurrentRequests?: number;
    concurrentSpiders?: number;
    delay?: number;
    obeyRobotsTxt?: boolean;
    defaultHeaders?: Record<string, string>;
    validDomains?: string[];
}

/** Spider 运行时配置（不含业务 params） */
export interface CrawlSpiderConfig {
    defaultHeaders?: Record<string, string>;
    validDomains?: string[];
}

const MAX_CONCURRENT = 32;
const MAX_SPIDERS = 8;
const MAX_DELAY_MS = 60_000;

function asRecord(raw: unknown, label: string): Record<string, unknown> {
    if (raw == null) {
        return {};
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`${label} 须为对象`);
    }
    return raw as Record<string, unknown>;
}

function parsePositiveInt(value: unknown, field: string, min: number, max: number): number {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(`${field} 须为 ${min}..${max} 的整数`);
    }
    return n;
}

function parseHeaders(value: unknown, field: string): Record<string, string> | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${field} 须为对象`);
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof k !== 'string' || !k.trim()) {
            throw new Error(`${field} 含非法键`);
        }
        if (v === undefined || v === null) {
            continue;
        }
        out[k] = String(v);
    }
    return out;
}

function parseDomainList(value: unknown, field: string): string[] | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw new Error(`${field} 须为字符串数组`);
    }
    return value.map((item, i) => {
        if (typeof item !== 'string' || !item.trim()) {
            throw new Error(`${field}[${i}] 须为非空字符串`);
        }
        return item.trim();
    });
}

/** 规范化并校验 options；非法抛错 */
export function normalizeCrawlOptions(raw: unknown): CrawlRunOptions {
    const input = asRecord(raw, 'options');
    const out: CrawlRunOptions = {};

    if (input.concurrentRequests !== undefined && input.concurrentRequests !== null) {
        out.concurrentRequests = parsePositiveInt(input.concurrentRequests, 'options.concurrentRequests', 1, MAX_CONCURRENT);
    }
    if (input.concurrentSpiders !== undefined && input.concurrentSpiders !== null) {
        out.concurrentSpiders = parsePositiveInt(input.concurrentSpiders, 'options.concurrentSpiders', 1, MAX_SPIDERS);
    }
    if (input.delay !== undefined && input.delay !== null) {
        out.delay = parsePositiveInt(input.delay, 'options.delay', 0, MAX_DELAY_MS);
    }
    if (input.obeyRobotsTxt !== undefined && input.obeyRobotsTxt !== null) {
        if (typeof input.obeyRobotsTxt !== 'boolean') {
            throw new Error('options.obeyRobotsTxt 须为 boolean');
        }
        out.obeyRobotsTxt = input.obeyRobotsTxt;
    }

    return out;
}

export function normalizeAppConfig(raw: unknown): CrawlAppConfig {
    const input = asRecord(raw, 'appConfig');
    const out: CrawlAppConfig = {};

    if (input.concurrentRequests !== undefined && input.concurrentRequests !== null) {
        out.concurrentRequests = parsePositiveInt(input.concurrentRequests, 'concurrentRequests', 1, MAX_CONCURRENT);
    }
    if (input.concurrentSpiders !== undefined && input.concurrentSpiders !== null) {
        out.concurrentSpiders = parsePositiveInt(input.concurrentSpiders, 'concurrentSpiders', 1, MAX_SPIDERS);
    }
    if (input.delay !== undefined && input.delay !== null) {
        out.delay = parsePositiveInt(input.delay, 'delay', 0, MAX_DELAY_MS);
    }
    if (input.obeyRobotsTxt !== undefined && input.obeyRobotsTxt !== null) {
        if (typeof input.obeyRobotsTxt !== 'boolean') {
            throw new Error('obeyRobotsTxt 须为 boolean');
        }
        out.obeyRobotsTxt = input.obeyRobotsTxt;
    }
    const headers = parseHeaders(input.defaultHeaders, 'defaultHeaders');
    if (headers) {
        out.defaultHeaders = headers;
    }
    const domains = parseDomainList(input.validDomains, 'validDomains');
    if (domains) {
        out.validDomains = domains;
    }
    return out;
}

export function normalizeSpiderConfig(raw: unknown): CrawlSpiderConfig {
    const input = asRecord(raw, 'spiderConfig');
    const out: CrawlSpiderConfig = {};
    const headers = parseHeaders(input.defaultHeaders, 'defaultHeaders');
    if (headers) {
        out.defaultHeaders = headers;
    }
    const domains = parseDomainList(input.validDomains, 'validDomains');
    if (domains) {
        out.validDomains = domains;
    }
    return out;
}

/** 从 .env 生成底座 App 配置 */
export function envAppConfigDefaults(): CrawlAppConfig {
    return {
        concurrentRequests: getAdminEnv().crawl.concurrentRequests,
        concurrentSpiders: getAdminEnv().crawl.concurrentSpiders,
        delay: 0,
        obeyRobotsTxt: getAdminEnv().crawl.obeyRobotsTxt,
    };
}

/** profile 配置 + 单次 options 浅覆盖 */
export function mergeAppConfig(
    base: CrawlAppConfig,
    override?: CrawlRunOptions | CrawlAppConfig | null,
): CrawlAppConfig {
    if (!override) {
        return { ...base, defaultHeaders: base.defaultHeaders ? { ...base.defaultHeaders } : undefined,
            validDomains: base.validDomains ? [...base.validDomains] : undefined };
    }
    return {
        concurrentRequests: override.concurrentRequests ?? base.concurrentRequests,
        concurrentSpiders: override.concurrentSpiders ?? base.concurrentSpiders,
        delay: override.delay ?? base.delay,
        obeyRobotsTxt: override.obeyRobotsTxt ?? base.obeyRobotsTxt,
        defaultHeaders: ('defaultHeaders' in override && override.defaultHeaders)
            ? { ...override.defaultHeaders }
            : (base.defaultHeaders ? { ...base.defaultHeaders } : undefined),
        validDomains: ('validDomains' in override && override.validDomains)
            ? [...override.validDomains]
            : (base.validDomains ? [...base.validDomains] : undefined),
    };
}

export function resolveConcurrentRequests(options: CrawlRunOptions | null | undefined, fallback: number): number {
    return options?.concurrentRequests ?? fallback;
}
