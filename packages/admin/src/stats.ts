import type { RowDataPacket } from 'mysql2';
import { getPool } from './runtime.js';
import type { CrawlRunStats, RunStatus, RunTriggerType } from './runs.js';

export interface PlatformOverview {
    generatedAt: string;
    runs: {
        total: number;
        byStatus: Record<RunStatus, number>;
        byTrigger: Record<RunTriggerType, number>;
        /** succeeded / (succeeded + failed)；无终态成功失败时为 null */
        successRate: number | null;
        /** 近 24 小时创建的任务数 */
        last24h: number;
        /** 近 7 天创建的任务数 */
        last7d: number;
        /** 当前进行中 */
        active: number;
    };
    /** 所有已结束任务的 stats 累加（stats 为空的不计） */
    totals: CrawlRunStats;
    bySpider: Array<{
        spider: string;
        total: number;
        succeeded: number;
        failed: number;
        successRate: number | null;
    }>;
    schedules: {
        total: number;
        enabled: number;
    };
    logs: {
        total: number;
        errors: number;
    };
}

interface CountRow extends RowDataPacket {
    cnt: number | string;
    status?: string;
    trigger_type?: string;
    spider?: string;
    succeeded?: number | string;
    failed?: number | string;
}

function n(value: number | string | null | undefined): number {
    const x = Number(value ?? 0);
    return Number.isFinite(x) ? x : 0;
}

function rate(succeeded: number, failed: number): number | null {
    const denom = succeeded + failed;
    if (denom <= 0) {
        return null;
    }
    return Math.round((succeeded / denom) * 10000) / 10000;
}

const EMPTY_STATUS: Record<RunStatus, number> = {
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
};

const EMPTY_TRIGGER: Record<RunTriggerType, number> = {
    manual: 0,
    schedule: 0,
};

/** 全平台基础概览（仪表盘用） */
export async function getPlatformOverview(): Promise<PlatformOverview> {
    const pool = getPool();

    const [[totalRow]] = await pool.query<CountRow[]>(
        `SELECT COUNT(*) AS cnt FROM crawl_runs`,
    );
    const total = n(totalRow?.cnt);

    const [statusRows] = await pool.query<CountRow[]>(
        `SELECT status, COUNT(*) AS cnt FROM crawl_runs GROUP BY status`,
    );
    const byStatus = { ...EMPTY_STATUS };
    for (const row of statusRows) {
        const s = row.status as RunStatus;
        if (s in byStatus) {
            byStatus[s] = n(row.cnt);
        }
    }

    const [triggerRows] = await pool.query<CountRow[]>(
        `SELECT COALESCE(trigger_type, 'manual') AS trigger_type, COUNT(*) AS cnt
         FROM crawl_runs GROUP BY COALESCE(trigger_type, 'manual')`,
    );
    const byTrigger = { ...EMPTY_TRIGGER };
    for (const row of triggerRows) {
        const t = row.trigger_type as RunTriggerType;
        if (t in byTrigger) {
            byTrigger[t] = n(row.cnt);
        }
    }

    const [[h24]] = await pool.query<CountRow[]>(
        `SELECT COUNT(*) AS cnt FROM crawl_runs
         WHERE created_at >= (NOW() - INTERVAL 24 HOUR)`,
    );
    const [[d7]] = await pool.query<CountRow[]>(
        `SELECT COUNT(*) AS cnt FROM crawl_runs
         WHERE created_at >= (NOW() - INTERVAL 7 DAY)`,
    );

    const [spiderRows] = await pool.query<CountRow[]>(
        `SELECT spider,
                COUNT(*) AS cnt,
                SUM(status = 'succeeded') AS succeeded,
                SUM(status = 'failed') AS failed
         FROM crawl_runs
         GROUP BY spider
         ORDER BY cnt DESC`,
    );
    const bySpider = spiderRows.map((row) => {
        const succeeded = n(row.succeeded);
        const failed = n(row.failed);
        return {
            spider: row.spider ?? '',
            total: n(row.cnt),
            succeeded,
            failed,
            successRate: rate(succeeded, failed),
        };
    });

    // MySQL JSON 聚合：stats 为空的行跳过
    const [[agg]] = await pool.query<RowDataPacket[]>(
        `SELECT
           COALESCE(SUM(JSON_EXTRACT(stats, '$.pages')), 0) AS pages,
           COALESCE(SUM(JSON_EXTRACT(stats, '$.items')), 0) AS items,
           COALESCE(SUM(JSON_EXTRACT(stats, '$.saved')), 0) AS saved,
           COALESCE(SUM(JSON_EXTRACT(stats, '$.skipped')), 0) AS skipped,
           COALESCE(SUM(JSON_EXTRACT(stats, '$.errors')), 0) AS errors
         FROM crawl_runs
         WHERE stats IS NOT NULL`,
    );

    let schedulesTotal = 0;
    let schedulesEnabled = 0;
    try {
        const [[sTotal]] = await pool.query<CountRow[]>(
            `SELECT COUNT(*) AS cnt FROM crawl_schedules`,
        );
        const [[sEn]] = await pool.query<CountRow[]>(
            `SELECT COUNT(*) AS cnt FROM crawl_schedules WHERE enabled = 1`,
        );
        schedulesTotal = n(sTotal?.cnt);
        schedulesEnabled = n(sEn?.cnt);
    } catch {
        // 表尚未创建时忽略
    }

    let logsTotal = 0;
    let logsErrors = 0;
    try {
        const [[lTotal]] = await pool.query<CountRow[]>(
            `SELECT COUNT(*) AS cnt FROM crawl_logs`,
        );
        const [[lErr]] = await pool.query<CountRow[]>(
            `SELECT COUNT(*) AS cnt FROM crawl_logs WHERE level = 'error'`,
        );
        logsTotal = n(lTotal?.cnt);
        logsErrors = n(lErr?.cnt);
    } catch {
        // ignore
    }

    return {
        generatedAt: new Date().toISOString(),
        runs: {
            total,
            byStatus,
            byTrigger,
            successRate: rate(byStatus.succeeded, byStatus.failed),
            last24h: n(h24?.cnt),
            last7d: n(d7?.cnt),
            active: byStatus.pending + byStatus.running,
        },
        totals: {
            pages: n(agg?.pages),
            items: n(agg?.items),
            saved: n(agg?.saved),
            skipped: n(agg?.skipped),
            errors: n(agg?.errors),
        },
        bySpider,
        schedules: {
            total: schedulesTotal,
            enabled: schedulesEnabled,
        },
        logs: {
            total: logsTotal,
            errors: logsErrors,
        },
    };
}
