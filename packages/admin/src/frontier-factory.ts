import { Redis } from 'ioredis';
import {
    MemoryFrontier,
    RedisDupeFilter,
    RedisFrontier,
    computeRequestFingerprintHash,
    type CrawlQueuedRequest,
    type Frontier,
} from 'crawlnd';
import { getAdminEnv } from './runtime.js';

export type FrontierType = 'memory' | 'redis';

let sharedRedis: Redis | null = null;

export function getSharedRedis(): Redis {
    if (!sharedRedis) {
        sharedRedis = new Redis({
            host: getAdminEnv().redis.host,
            port: getAdminEnv().redis.port,
            maxRetriesPerRequest: null,
        });
    }
    return sharedRedis;
}

export async function quitSharedRedis(): Promise<void> {
    if (sharedRedis) {
        await sharedRedis.quit();
        sharedRedis = null;
    }
}

function fingerprint(req: CrawlQueuedRequest): string {
    return computeRequestFingerprintHash(req);
}

/**
 * 按类型构造 Frontier。
 * redis：带 Job 级 DupeFilter（入队去重）；memory：不做引擎级去重（仍走 Spider.dedupe）。
 */
export function createFrontier(type: FrontierType = getAdminEnv().crawl.frontier): Frontier {
    if (type === 'redis') {
        const redis = getSharedRedis();
        const dupeFilter = new RedisDupeFilter(redis);
        return new RedisFrontier(redis, {
            dupeFilter,
            fingerprint,
            defaultLeaseMs: getAdminEnv().crawl.frontierLeaseMs,
        });
    }
    return new MemoryFrontier();
}

export function resolveFrontierType(override?: string | null): FrontierType {
    if (override === 'redis' || override === 'memory') {
        return override;
    }
    return getAdminEnv().crawl.frontier;
}
