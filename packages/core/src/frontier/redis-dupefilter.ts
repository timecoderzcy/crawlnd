import type { Redis } from 'ioredis';
import type { DupeFilter } from './types.js';

export interface RedisDupeFilterOptions {
    /** key 前缀，默认 crawlnd:dupe */
    keyPrefix?: string;
}

/**
 * Redis SET 去重；按 scopeId 分 key。
 */
export class RedisDupeFilter implements DupeFilter {
    private readonly redis: Redis;
    private readonly keyPrefix: string;

    constructor(redis: Redis, options: RedisDupeFilterOptions = {}) {
        this.redis = redis;
        this.keyPrefix = options.keyPrefix ?? 'crawlnd:dupe';
    }

    private key(scopeId: string): string {
        return `${this.keyPrefix}:${scopeId}`;
    }

    async isSeen(scopeId: string, fingerprint: string): Promise<boolean> {
        const n = await this.redis.sismember(this.key(scopeId), fingerprint);
        return n === 1;
    }

    async markSeen(scopeId: string, fingerprint: string): Promise<void> {
        await this.redis.sadd(this.key(scopeId), fingerprint);
    }

    async clear(scopeId: string): Promise<void> {
        await this.redis.del(this.key(scopeId));
    }
}
