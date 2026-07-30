import { createHash } from 'node:crypto';
import type { CrawlQueuedRequest, CrawlRequest, JsonValue } from './context.js';

function sortStringRecord(r: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of Object.keys(r).sort()) {
        out[k] = r[k]!;
    }
    return out;
}

function canonicalize(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((x) => canonicalize(x));
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
        out[k] = canonicalize(obj[k]);
    }
    return out;
}

/**
 * 参与指纹的字段：url、method、query、params、data、json、formData、入队 state（不含 headers/cookies/proxy/tag）
 */
function identityPayload(req: CrawlRequest | CrawlQueuedRequest): unknown {
    const state =
        'state' in req && req.state !== undefined && Object.keys(req.state).length > 0
            ? canonicalize(req.state)
            : undefined;

    const core: Record<string, unknown> = {
        url: req.url,
        method: req.method ?? 'GET',
    };
    if (req.query !== undefined && Object.keys(req.query).length > 0) {
        core.query = sortStringRecord(req.query);
    }
    if (req.params !== undefined && Object.keys(req.params).length > 0) {
        core.params = sortStringRecord(req.params);
    }
    if (req.data !== undefined && Object.keys(req.data).length > 0) {
        core.data = sortStringRecord(req.data);
    }
    if (req.formData !== undefined && Object.keys(req.formData).length > 0) {
        core.formData = sortStringRecord(req.formData);
    }
    if (req.json !== undefined) {
        core.json = canonicalize(req.json) as JsonValue;
    }
    if (state !== undefined) {
        core.state = state;
    }
    return core;
}

/**
 * 由 url 与请求参数生成稳定 SHA-256 十六进制指纹；与 request.tag 无关（tag 仅决定走哪条 dedupe 规则）
 */
export function computeRequestFingerprintHash(req: CrawlRequest | CrawlQueuedRequest): string {
    const json = JSON.stringify(identityPayload(req));
    return createHash('sha256').update(json, 'utf8').digest('hex');
}
