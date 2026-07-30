import { getAdminEnv } from './runtime.js';
import { createRun, hasActiveRunForSchedule } from './runs.js';
import {
    claimScheduleFire,
    computeNextRunAt,
    listDueSchedules,
    markScheduleFired,
    type CrawlSchedule,
} from './schedules.js';

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

async function fireOne(schedule: CrawlSchedule, now: Date): Promise<void> {
    const nextRunAt = computeNextRunAt(schedule.cron, schedule.timezone, now);
    const claimed = await claimScheduleFire(schedule, nextRunAt);
    if (!claimed) {
        return;
    }

    // 第一期仅 skip：上一次还在跑则跳过本拍
    if (schedule.overlapPolicy === 'skip') {
        const busy = await hasActiveRunForSchedule(schedule.id);
        if (busy) {
            await markScheduleFired(schedule.id, null, 'skipped: previous run still active');
            console.log(`[scheduler] schedule #${schedule.id} skipped (overlap)`);
            return;
        }
    }

    try {
        const run = await createRun({
            spider: schedule.spider,
            params: schedule.params,
            options: schedule.options,
            appProfileId: schedule.appProfileId,
            spiderProfileId: schedule.spiderProfileId,
            appConfigSnapshot: schedule.appConfig,
            spiderConfigSnapshot: schedule.spiderConfig,
            triggerType: 'schedule',
            scheduleId: schedule.id,
        });
        await markScheduleFired(schedule.id, run.id, null);
        console.log(`[scheduler] schedule #${schedule.id} → run #${run.id}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await markScheduleFired(schedule.id, null, message);
        console.error(`[scheduler] schedule #${schedule.id} failed: ${message}`);
    }
}

async function tick(): Promise<void> {
    if (ticking) {
        return;
    }
    ticking = true;
    try {
        const now = new Date();
        const due = await listDueSchedules(now);
        for (const schedule of due) {
            await fireOne(schedule, now);
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] tick error: ${message}`);
    } finally {
        ticking = false;
    }
}

/** 启动进程内调度器（单实例约定） */
export function startScheduler(): void {
    if (timer) {
        return;
    }
    const intervalMs = getAdminEnv().admin.schedulerIntervalMs;
    console.log(`[scheduler] started (interval=${intervalMs}ms, single-instance)`);
    void tick();
    timer = setInterval(() => {
        void tick();
    }, intervalMs);
    // 不阻止进程退出
    if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref();
    }
}

export function stopScheduler(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
        console.log('[scheduler] stopped');
    }
}
