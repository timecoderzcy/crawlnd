import { randomUUID } from 'node:crypto';
import type { CrawlQueuedRequest } from '../context.js';
import type {
    DupeFilter,
    Frontier,
    FrontierFetchOptions,
    FrontierItem,
    FrontierNackOptions,
} from './types.js';

type Waiter = {
    resolve: (item: FrontierItem | null) => void;
    timer: ReturnType<typeof setTimeout> | null;
};

type ScopeState = {
    pending: FrontierItem[];
    inflight: Map<string, FrontierItem>;
    cancelled: boolean;
    closed: boolean;
    waiters: Waiter[];
};

export interface MemoryFrontierOptions {
    /** 入队时可选去重；未配置则不做 frontier 级去重 */
    dupeFilter?: DupeFilter;
    /** 与 dupeFilter 同时提供时，push 前用其计算指纹 */
    fingerprint?: (req: CrawlQueuedRequest) => string;
}

/**
 * 进程内 Frontier：语义对齐原 PQueue 调度（动态 push + depth/inflight 双零结束）。
 */
export class MemoryFrontier implements Frontier {
    private readonly scopes = new Map<string, ScopeState>();
    private readonly dupeFilter: DupeFilter | undefined;
    private readonly fingerprint: ((req: CrawlQueuedRequest) => string) | undefined;

    constructor(options: MemoryFrontierOptions = {}) {
        this.dupeFilter = options.dupeFilter;
        this.fingerprint = options.fingerprint;
    }

    private ensure(scopeId: string): ScopeState {
        let s = this.scopes.get(scopeId);
        if (!s) {
            s = {
                pending: [],
                inflight: new Map(),
                cancelled: false,
                closed: false,
                waiters: [],
            };
            this.scopes.set(scopeId, s);
        }
        return s;
    }

    private wake(s: ScopeState): void {
        while (s.waiters.length > 0 && s.pending.length > 0) {
            const w = s.waiters.shift()!;
            if (w.timer) {
                clearTimeout(w.timer);
            }
            const item = s.pending.shift()!;
            s.inflight.set(item.id, item);
            w.resolve(item);
        }
    }

    private rejectWaiters(s: ScopeState): void {
        while (s.waiters.length > 0) {
            const w = s.waiters.shift()!;
            if (w.timer) {
                clearTimeout(w.timer);
            }
            w.resolve(null);
        }
    }

    async push(scopeId: string, requests: CrawlQueuedRequest[]): Promise<number> {
        const s = this.ensure(scopeId);
        if (s.cancelled || s.closed) {
            return 0;
        }
        let n = 0;
        for (const request of requests) {
            if (this.dupeFilter && this.fingerprint) {
                const fp = this.fingerprint(request);
                if (await this.dupeFilter.isSeen(scopeId, fp)) {
                    continue;
                }
                await this.dupeFilter.markSeen(scopeId, fp);
            }
            s.pending.push({
                id: randomUUID(),
                request,
                attempt: 0,
            });
            n += 1;
        }
        this.wake(s);
        return n;
    }

    async fetch(scopeId: string, opts: FrontierFetchOptions = {}): Promise<FrontierItem | null> {
        const s = this.ensure(scopeId);
        if (s.cancelled || s.closed) {
            return null;
        }
        if (s.pending.length > 0) {
            const item = s.pending.shift()!;
            s.inflight.set(item.id, item);
            return item;
        }

        const waitMs = opts.waitMs ?? 0;
        if (waitMs <= 0) {
            return null;
        }

        return new Promise<FrontierItem | null>((resolve) => {
            const waiter: Waiter = { resolve, timer: null };
            waiter.timer = setTimeout(() => {
                const idx = s.waiters.indexOf(waiter);
                if (idx >= 0) {
                    s.waiters.splice(idx, 1);
                }
                resolve(null);
            }, waitMs);
            s.waiters.push(waiter);
            // push 可能在注册 waiter 前已发生竞态：再试一次
            if (s.pending.length > 0) {
                this.wake(s);
            }
        });
    }

    async ack(scopeId: string, itemId: string): Promise<void> {
        const s = this.scopes.get(scopeId);
        if (!s) {
            return;
        }
        s.inflight.delete(itemId);
    }

    async nack(scopeId: string, itemId: string, opts: FrontierNackOptions = {}): Promise<void> {
        const s = this.scopes.get(scopeId);
        if (!s) {
            return;
        }
        const item = s.inflight.get(itemId);
        s.inflight.delete(itemId);
        if (!item) {
            return;
        }
        const requeue = opts.requeue !== false;
        if (!requeue || s.cancelled || s.closed) {
            return;
        }
        item.attempt += 1;
        s.pending.push(item);
        this.wake(s);
    }

    async depth(scopeId: string): Promise<number> {
        return this.scopes.get(scopeId)?.pending.length ?? 0;
    }

    async inflight(scopeId: string): Promise<number> {
        return this.scopes.get(scopeId)?.inflight.size ?? 0;
    }

    async setCancelled(scopeId: string, cancelled: boolean): Promise<void> {
        const s = this.ensure(scopeId);
        s.cancelled = cancelled;
        if (cancelled) {
            this.rejectWaiters(s);
        }
    }

    async isCancelled(scopeId: string): Promise<boolean> {
        return this.scopes.get(scopeId)?.cancelled ?? false;
    }

    async close(scopeId: string): Promise<void> {
        const s = this.scopes.get(scopeId);
        if (!s) {
            return;
        }
        s.closed = true;
        s.pending.length = 0;
        s.inflight.clear();
        this.rejectWaiters(s);
        this.scopes.delete(scopeId);
    }
}
