import type { DupeFilter } from './types.js';

/**
 * 进程内 Set 去重；按 scopeId 隔离。
 */
export class MemoryDupeFilter implements DupeFilter {
    private readonly seenByScope = new Map<string, Set<string>>();

    private setFor(scopeId: string): Set<string> {
        let set = this.seenByScope.get(scopeId);
        if (!set) {
            set = new Set();
            this.seenByScope.set(scopeId, set);
        }
        return set;
    }

    async isSeen(scopeId: string, fingerprint: string): Promise<boolean> {
        return this.setFor(scopeId).has(fingerprint);
    }

    async markSeen(scopeId: string, fingerprint: string): Promise<void> {
        this.setFor(scopeId).add(fingerprint);
    }

    /** 测试 / 收尾用 */
    clear(scopeId?: string): void {
        if (scopeId === undefined) {
            this.seenByScope.clear();
            return;
        }
        this.seenByScope.delete(scopeId);
    }
}
