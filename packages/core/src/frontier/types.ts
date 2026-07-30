import type { CrawlQueuedRequest } from '../context.js';

/**
 * 队列中的一帧请求（可跨进程序列化；Memory 实现也使用同一形状）。
 */
export interface FrontierItem {
    /** 租约 / ack 用的稳定 id */
    id: string;
    request: CrawlQueuedRequest;
    attempt: number;
}

export interface FrontierFetchOptions {
    /** 租约时长（毫秒）；超时未 ack 应由实现回收。Memory 实现主要用于接口对齐 */
    leaseMs?: number;
    /** 队列为空时最多等待多久；超时返回 null */
    waitMs?: number;
}

export interface FrontierNackOptions {
    /** 是否重新入队；默认 true */
    requeue?: boolean;
    /** 重新入队前延迟（毫秒）；Memory 可忽略或简单 sleep 由调用方处理 */
    delayMs?: number;
}

/**
 * 作用域级去重（通常 scopeId = jobId / runId）。
 * 与 Spider.dedupe 可并存：dedupe 偏站点/跨 Run 持久规则，DupeFilter 偏引擎/Job 级。
 */
export interface DupeFilter {
    /** 是否已见过该指纹（true = 应跳过） */
    isSeen(scopeId: string, fingerprint: string): Promise<boolean>;
    /** 标记已见 */
    markSeen(scopeId: string, fingerprint: string): Promise<void>;
}

/**
 * 可插拔请求 frontier：本机 Memory 或 Redis 等实现。
 * Core 只依赖本接口；分布式后端作为可选实现接入。
 */
export interface Frontier {
    /**
     * 入队；返回实际入队条数（若挂了 DupeFilter，已见指纹可能被跳过）。
     */
    push(scopeId: string, requests: CrawlQueuedRequest[]): Promise<number>;

    /**
     * 租约取出一条；队列空时按 waitMs 等待。
     * 返回 null 表示等待超时仍无任务（调用方结合 depth/inflight 判断是否结束）。
     */
    fetch(scopeId: string, opts?: FrontierFetchOptions): Promise<FrontierItem | null>;

    ack(scopeId: string, itemId: string): Promise<void>;

    nack(scopeId: string, itemId: string, opts?: FrontierNackOptions): Promise<void>;

    depth(scopeId: string): Promise<number>;

    inflight(scopeId: string): Promise<number>;

    setCancelled(scopeId: string, cancelled: boolean): Promise<void>;

    isCancelled(scopeId: string): Promise<boolean>;

    /** 清理该 scope 的内存/键；之后不应再 push/fetch */
    close(scopeId: string): Promise<void>;
}
