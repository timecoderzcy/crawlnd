import type { RedisFrontier } from 'crawlnd';
import { RedisFrontier as RedisFrontierClass } from 'crawlnd';
import { getAdminEnv } from './runtime.js';
import {
    clearAggregatedJobStats,
    readAggregatedJobStats,
} from '@crawlnd/utils';
import { createFrontier } from './frontier-factory.js';
import {
    finishRunFromSupervisor,
    listRunningRedisRuns,
    resolveRunOutcome,
} from './runs.js';

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** scope 连续「空闲」起始时间 */
const idleSince = new Map<number, number>();

async function finalizeRedisRun(
    runId: number,
    status: 'succeeded' | 'failed' | 'cancelled',
    error: string | null,
): Promise<void> {
    let stats = null;
    try {
        stats = await readAggregatedJobStats(runId);
    } catch (err) {
        console.error(`[supervisor] read stats #${runId} failed:`, err);
    }

    if (status === 'cancelled') {
        await finishRunFromSupervisor(runId, 'cancelled', stats, error);
    } else {
        const outcome = resolveRunOutcome(stats);
        await finishRunFromSupervisor(
            runId,
            outcome.status,
            stats,
            outcome.error ?? error,
        );
    }

    await clearAggregatedJobStats(runId).catch(() => undefined);
}

/**
 * 扫描 redis frontier 的 running Run：回收过期租约，并在稳定空闲后写终态。
 */
async function tick(): Promise<void> {
    if (ticking) {
        return;
    }
    ticking = true;
    try {
        const runs = await listRunningRedisRuns();
        const frontier = createFrontier('redis');
        const redisFrontier =
            frontier instanceof RedisFrontierClass ? frontier : (frontier as RedisFrontier);
        const now = Date.now();
        const stableMs = getAdminEnv().crawl.jobStableWindowMs;

        for (const run of runs) {
            const jobId = String(run.id);
            try {
                await redisFrontier.reclaimExpired(jobId, now);

                if (run.cancelRequested) {
                    await frontier.setCancelled(jobId, true);
                    await finalizeRedisRun(run.id, 'cancelled', 'cancelled by stop');
                    idleSince.delete(run.id);
                    await frontier.close(jobId).catch(() => undefined);
                    continue;
                }

                const [depth, inflight] = await Promise.all([
                    frontier.depth(jobId),
                    frontier.inflight(jobId),
                ]);

                if (depth === 0 && inflight === 0) {
                    if (!idleSince.has(run.id)) {
                        idleSince.set(run.id, now);
                    }
                    const since = idleSince.get(run.id)!;
                    if (now - since >= stableMs) {
                        await finalizeRedisRun(run.id, 'succeeded', null);
                        idleSince.delete(run.id);
                        await frontier.close(jobId).catch(() => undefined);
                    }
                } else {
                    idleSince.delete(run.id);
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[supervisor] run #${run.id}: ${message}`);
            }
        }

        const active = new Set(runs.map((r) => r.id));
        for (const id of idleSince.keys()) {
            if (!active.has(id)) {
                idleSince.delete(id);
            }
        }
    } finally {
        ticking = false;
    }
}

export function startJobSupervisor(): void {
    if (timer) {
        return;
    }
    const intervalMs = getAdminEnv().crawl.supervisorIntervalMs;
    console.log(`[supervisor] started (interval=${intervalMs}ms)`);
    void tick();
    timer = setInterval(() => {
        void tick();
    }, intervalMs);
    if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref();
    }
}

export function stopJobSupervisor(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
        console.log('[supervisor] stopped');
    }
}
