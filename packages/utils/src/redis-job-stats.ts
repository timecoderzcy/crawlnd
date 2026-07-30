import type { Redis } from 'ioredis';
import { Redis as RedisClient } from 'ioredis';
import type { CrawlStats } from './spider-logger.js';

export type JobStatsDelta = Partial<CrawlStats>;

export interface JobStatsRemote {
    /** 累加增量（可只传变化字段） */
    incr(delta: JobStatsDelta): Promise<void>;
}

const DEFAULT_PREFIX = 'crawlnd:jobstats';

let autoRedis: Redis | null = null;
let redisFactory: (() => Redis) | null = null;

/** 应用可注入 Redis 工厂；未注入时用 REDIS_HOST / REDIS_PORT */
export function configureJobStatsRedis(factory: () => Redis): void {
    redisFactory = factory;
    autoRedis = null;
}

function getAutoRedis(): Redis {
    if (!autoRedis) {
        if (redisFactory) {
            autoRedis = redisFactory();
        } else {
            autoRedis = new RedisClient({
                host: process.env.REDIS_HOST || '127.0.0.1',
                port: Number(process.env.REDIS_PORT || 6379) || 6379,
                maxRetriesPerRequest: null,
            });
        }
    }
    return autoRedis;
}

function key(runId: number | string, prefix = DEFAULT_PREFIX): string {
    return `${prefix}:${runId}`;
}

/**
 * 将本进程 stats 增量写入 Redis Hash（HINCRBY），供多 Worker 聚合。
 */
export function createRedisJobStatsRemote(
    redis: Redis,
    runId: number | string,
    options: { keyPrefix?: string } = {},
): JobStatsRemote {
    const k = key(runId, options.keyPrefix ?? DEFAULT_PREFIX);
    return {
        async incr(delta) {
            const pipeline = redis.pipeline();
            let any = false;
            for (const field of ['pages', 'items', 'saved', 'skipped', 'errors'] as const) {
                const n = delta[field];
                if (typeof n === 'number' && n !== 0 && Number.isFinite(n)) {
                    pipeline.hincrby(k, field, Math.trunc(n));
                    any = true;
                }
            }
            if (any) {
                await pipeline.exec();
            }
        },
    };
}

/** 使用共享配置自动创建（logger 在 frontierType=redis 时调用） */
export function createAutoRedisJobStatsRemote(runId: number | string): JobStatsRemote {
    return createRedisJobStatsRemote(getAutoRedis(), runId);
}

/** 读取聚合后的 Job stats；无 key 时返回全 0 */
export async function getRedisJobStats(
    redis: Redis,
    runId: number | string,
    options: { keyPrefix?: string } = {},
): Promise<CrawlStats> {
    const raw = await redis.hgetall(key(runId, options.keyPrefix ?? DEFAULT_PREFIX));
    return {
        pages: Number(raw.pages ?? 0) || 0,
        items: Number(raw.items ?? 0) || 0,
        saved: Number(raw.saved ?? 0) || 0,
        skipped: Number(raw.skipped ?? 0) || 0,
        errors: Number(raw.errors ?? 0) || 0,
    };
}

export async function readAggregatedJobStats(runId: number | string): Promise<CrawlStats> {
    return getRedisJobStats(getAutoRedis(), runId);
}

export async function clearRedisJobStats(
    redis: Redis,
    runId: number | string,
    options: { keyPrefix?: string } = {},
): Promise<void> {
    await redis.del(key(runId, options.keyPrefix ?? DEFAULT_PREFIX));
}

export async function clearAggregatedJobStats(runId: number | string): Promise<void> {
    await clearRedisJobStats(getAutoRedis(), runId);
}
