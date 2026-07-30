import type { Redis } from "ioredis";

export interface RedisItemDeduperOptions<T> {
    /** Redis SET 键，如 crawlnd:exampleSpider:items */
    setKey: string;
    /** 返回去重键；返回 null/undefined/'' 的条目会被跳过（既不入库也不标记） */
    keyOf: (item: T) => string | null | undefined;
}

export interface RedisItemDeduper<T> {
    /** 过滤出尚未在 Redis SET 中的条目 */
    filter: (items: T[]) => Promise<T[]>;
    /** 将条目标记为已处理 */
    mark: (items: T[]) => Promise<void>;
}

/**
 * 基于 Redis SET 的条目级去重：filter 查新，mark 写入。
 * 各站点只需提供 setKey 与 keyOf。
 */
export function createRedisItemDeduper<T>(
    redis: Redis,
    options: RedisItemDeduperOptions<T>,
): RedisItemDeduper<T> {
    const { setKey, keyOf } = options;

    return {
        async filter(items) {
            if (!items.length) {
                return [];
            }
            const keys = items.map(keyOf);
            const pipeline = redis.pipeline();
            for (const key of keys) {
                if (key) {
                    pipeline.sismember(setKey, key);
                }
            }
            const replies = await pipeline.exec();
            const fresh: T[] = [];
            let replyIdx = 0;
            for (let i = 0; i < items.length; i++) {
                const key = keys[i];
                if (!key) {
                    continue;
                }
                const [err, exists] = replies![replyIdx++] ?? [null, 0];
                if (err) {
                    throw err;
                }
                if (exists !== 1) {
                    fresh.push(items[i]!);
                }
            }
            return fresh;
        },

        async mark(items) {
            const keys = items
                .map(keyOf)
                .filter((k): k is string => typeof k === "string" && k !== "");
            if (!keys.length) {
                return;
            }
            await redis.sadd(setKey, ...keys);
        },
    };
}
