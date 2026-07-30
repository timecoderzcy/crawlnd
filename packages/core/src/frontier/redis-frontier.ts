import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { CrawlQueuedRequest } from '../context.js';
import type {
    DupeFilter,
    Frontier,
    FrontierFetchOptions,
    FrontierItem,
    FrontierNackOptions,
} from './types.js';

export interface RedisFrontierOptions {
    /** key 前缀，默认 crawlnd:frontier */
    keyPrefix?: string;
    /** 入队去重；建议与 fingerprint 同时提供 */
    dupeFilter?: DupeFilter;
    fingerprint?: (req: CrawlQueuedRequest) => string;
    /** 默认租约（毫秒），fetch 未指定 leaseMs 时使用 */
    defaultLeaseMs?: number;
}

type InflightRecord = {
    id: string;
    request: CrawlQueuedRequest;
    attempt: number;
    leaseExpireAt: number;
    workerId?: string;
};

/**
 * Redis LIST + inflight HASH 的共享 Frontier。
 *
 * Keys（scopeId = jobId/runId）:
 * - `{prefix}:{scope}:q`        LIST  待抓 JSON(FrontierItem)
 * - `{prefix}:{scope}:inflight` HASH  itemId → InflightRecord JSON
 * - `{prefix}:{scope}:meta`     HASH  cancelled 等
 */
export class RedisFrontier implements Frontier {
    private readonly redis: Redis;
    private readonly keyPrefix: string;
    private readonly dupeFilter: DupeFilter | undefined;
    private readonly fingerprint: ((req: CrawlQueuedRequest) => string) | undefined;
    private readonly defaultLeaseMs: number;

    constructor(redis: Redis, options: RedisFrontierOptions = {}) {
        this.redis = redis;
        this.keyPrefix = options.keyPrefix ?? 'crawlnd:frontier';
        this.dupeFilter = options.dupeFilter;
        this.fingerprint = options.fingerprint;
        this.defaultLeaseMs = options.defaultLeaseMs ?? 60_000;
    }

    private qKey(scopeId: string): string {
        return `${this.keyPrefix}:${scopeId}:q`;
    }

    private inflightKey(scopeId: string): string {
        return `${this.keyPrefix}:${scopeId}:inflight`;
    }

    private metaKey(scopeId: string): string {
        return `${this.keyPrefix}:${scopeId}:meta`;
    }

    async push(scopeId: string, requests: CrawlQueuedRequest[]): Promise<number> {
        if (await this.isCancelled(scopeId)) {
            return 0;
        }
        const payloads: string[] = [];
        for (const request of requests) {
            if (this.dupeFilter && this.fingerprint) {
                const fp = this.fingerprint(request);
                if (await this.dupeFilter.isSeen(scopeId, fp)) {
                    continue;
                }
                await this.dupeFilter.markSeen(scopeId, fp);
            }
            const item: FrontierItem = {
                id: randomUUID(),
                request,
                attempt: 0,
            };
            payloads.push(JSON.stringify(item));
        }
        if (payloads.length === 0) {
            return 0;
        }
        await this.redis.rpush(this.qKey(scopeId), ...payloads);
        return payloads.length;
    }

    async fetch(scopeId: string, opts: FrontierFetchOptions = {}): Promise<FrontierItem | null> {
        if (await this.isCancelled(scopeId)) {
            return null;
        }

        const leaseMs = opts.leaseMs ?? this.defaultLeaseMs;
        const waitMs = opts.waitMs ?? 0;
        const waitSec = waitMs > 0 ? Math.max(1, Math.ceil(waitMs / 1000)) : 0;

        let raw: string | null = null;
        if (waitSec > 0) {
            const popped = await this.redis.blpop(this.qKey(scopeId), waitSec);
            raw = popped?.[1] ?? null;
        } else {
            raw = await this.redis.lpop(this.qKey(scopeId));
        }

        if (!raw) {
            return null;
        }

        let item: FrontierItem;
        try {
            item = JSON.parse(raw) as FrontierItem;
        } catch {
            return null;
        }

        const record: InflightRecord = {
            ...item,
            leaseExpireAt: Date.now() + leaseMs,
        };
        await this.redis.hset(this.inflightKey(scopeId), item.id, JSON.stringify(record));
        return item;
    }

    async ack(scopeId: string, itemId: string): Promise<void> {
        await this.redis.hdel(this.inflightKey(scopeId), itemId);
    }

    async nack(scopeId: string, itemId: string, opts: FrontierNackOptions = {}): Promise<void> {
        const raw = await this.redis.hget(this.inflightKey(scopeId), itemId);
        await this.redis.hdel(this.inflightKey(scopeId), itemId);
        if (!raw) {
            return;
        }
        const requeue = opts.requeue !== false;
        if (!requeue || (await this.isCancelled(scopeId))) {
            return;
        }
        let record: InflightRecord;
        try {
            record = JSON.parse(raw) as InflightRecord;
        } catch {
            return;
        }
        const item: FrontierItem = {
            id: record.id,
            request: record.request,
            attempt: record.attempt + 1,
        };
        if (opts.delayMs && opts.delayMs > 0) {
            await sleep(opts.delayMs);
        }
        await this.redis.rpush(this.qKey(scopeId), JSON.stringify(item));
    }

    async depth(scopeId: string): Promise<number> {
        return this.redis.llen(this.qKey(scopeId));
    }

    async inflight(scopeId: string): Promise<number> {
        return this.redis.hlen(this.inflightKey(scopeId));
    }

    async setCancelled(scopeId: string, cancelled: boolean): Promise<void> {
        await this.redis.hset(this.metaKey(scopeId), 'cancelled', cancelled ? '1' : '0');
    }

    async isCancelled(scopeId: string): Promise<boolean> {
        const v = await this.redis.hget(this.metaKey(scopeId), 'cancelled');
        return v === '1';
    }

    async close(scopeId: string): Promise<void> {
        await this.redis.del(
            this.qKey(scopeId),
            this.inflightKey(scopeId),
            this.metaKey(scopeId),
        );
    }

    /**
     * 将租约过期的 inflight 重新入队。由 Supervisor 周期性调用。
     * @returns 回收条数
     */
    async reclaimExpired(scopeId: string, now = Date.now()): Promise<number> {
        const all = await this.redis.hgetall(this.inflightKey(scopeId));
        let n = 0;
        for (const [id, raw] of Object.entries(all)) {
            let record: InflightRecord;
            try {
                record = JSON.parse(raw) as InflightRecord;
            } catch {
                await this.redis.hdel(this.inflightKey(scopeId), id);
                continue;
            }
            if (record.leaseExpireAt > now) {
                continue;
            }
            await this.redis.hdel(this.inflightKey(scopeId), id);
            const item: FrontierItem = {
                id: record.id,
                request: record.request,
                attempt: record.attempt + 1,
            };
            await this.redis.rpush(this.qKey(scopeId), JSON.stringify(item));
            n += 1;
        }
        return n;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
