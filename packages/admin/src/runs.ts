import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { Crawlnd } from 'crawlnd';
import { getAdminEnv } from './runtime.js';
import { getPool } from './runtime.js';
import { getAttachedCrawlStats, type CrawlStats } from '@crawlnd/utils';
import {
    normalizeAppConfig,
    normalizeCrawlOptions,
    normalizeSpiderConfig,
    type CrawlAppConfig,
    type CrawlRunOptions,
    type CrawlSpiderConfig,
} from './crawl-options.js';
import { createFrontier, resolveFrontierType, type FrontierType } from './frontier-factory.js';
import { resolveRunProfiles } from './profiles.js';
import {
    createSpiderFromRegistry,
    getSpiderDefinition,
    type SpiderRunParams,
} from './registry.js';

export type { CrawlRunOptions, CrawlAppConfig, CrawlSpiderConfig } from './crawl-options.js';
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type RunTriggerType = 'manual' | 'schedule';
export type { FrontierType };

export interface CrawlRunStats {
    pages: number;
    items: number;
    saved: number;
    skipped: number;
    errors: number;
}

export interface CrawlRun {
    id: number;
    spider: string;
    params: SpiderRunParams;
    options: CrawlRunOptions;
    appProfileId: number | null;
    spiderProfileId: number | null;
    appConfig: CrawlAppConfig;
    spiderConfig: CrawlSpiderConfig;
    frontierType: FrontierType;
    cancelRequested: boolean;
    status: RunStatus;
    triggerType: RunTriggerType;
    scheduleId: number | null;
    stats: CrawlRunStats | null;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
}

export interface CreateRunInput {
    spider: string;
    params: SpiderRunParams;
    options?: CrawlRunOptions;
    appProfileId?: number | null;
    spiderProfileId?: number | null;
    /** Schedule 触发时可直接传入已固化配置 */
    appConfigSnapshot?: CrawlAppConfig | null;
    spiderConfigSnapshot?: CrawlSpiderConfig | null;
    triggerType?: RunTriggerType;
    scheduleId?: number | null;
    /** 覆盖环境默认 frontier */
    frontier?: FrontierType | null;
}

export interface ListRunsOptions {
    limit?: number;
    scheduleId?: number;
}

interface CrawlRunRow extends RowDataPacket {
    id: number;
    spider: string;
    params: string | SpiderRunParams;
    options: string | CrawlRunOptions | null;
    app_profile_id: number | null;
    spider_profile_id: number | null;
    app_config: string | CrawlAppConfig | null;
    spider_config: string | CrawlSpiderConfig | null;
    frontier_type: string | null;
    cancel_requested: number | boolean | null;
    status: RunStatus;
    trigger_type: RunTriggerType | null;
    schedule_id: number | null;
    stats: string | CrawlRunStats | null;
    error: string | null;
    started_at: Date | null;
    finished_at: Date | null;
    created_at: Date;
}

/** 内存中正在跑的任务（仅 memory / inline 执行） */
const active = new Map<number, { cancel: boolean; promise: Promise<void> }>();

function parseJson<T>(value: unknown, fallback: T): T {
    if (value === null || value === undefined) {
        return fallback;
    }
    if (typeof value === 'object') {
        return value as T;
    }
    if (typeof value === 'string') {
        try {
            return JSON.parse(value) as T;
        } catch {
            return fallback;
        }
    }
    return fallback;
}

function safeNormalize<T>(fn: (raw: unknown) => T, raw: unknown, fallback: T): T {
    try {
        return fn(raw);
    } catch {
        return fallback;
    }
}

function rowToRun(row: CrawlRunRow): CrawlRun {
    return {
        id: row.id,
        spider: row.spider,
        params: parseJson<SpiderRunParams>(row.params, {}),
        options: safeNormalize(normalizeCrawlOptions, parseJson(row.options, {}), {}),
        appProfileId: row.app_profile_id ?? null,
        spiderProfileId: row.spider_profile_id ?? null,
        appConfig: safeNormalize(normalizeAppConfig, parseJson(row.app_config, {}), {}),
        spiderConfig: safeNormalize(normalizeSpiderConfig, parseJson(row.spider_config, {}), {}),
        frontierType: resolveFrontierType(row.frontier_type),
        cancelRequested: Boolean(row.cancel_requested),
        status: row.status,
        triggerType: row.trigger_type ?? 'manual',
        scheduleId: row.schedule_id ?? null,
        stats: parseJson<CrawlRunStats | null>(row.stats, null),
        error: row.error,
        startedAt: row.started_at ? row.started_at.toISOString() : null,
        finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
        createdAt: row.created_at.toISOString(),
    };
}

async function ensureColumn(
    table: string,
    column: string,
    alterSql: string,
): Promise<void> {
    const pool = getPool();
    const [cols] = await pool.query<RowDataPacket[]>(
        `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column],
    );
    if (cols.length === 0) {
        await pool.query(alterSql);
    }
}

export async function ensureAdminTables(): Promise<void> {
    const pool = getPool();
    await pool.query(`
        CREATE TABLE IF NOT EXISTS crawl_runs (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          spider VARCHAR(64) NOT NULL,
          params JSON NOT NULL,
          status VARCHAR(16) NOT NULL,
          trigger_type VARCHAR(16) NOT NULL DEFAULT 'manual',
          schedule_id BIGINT UNSIGNED NULL,
          stats JSON NULL,
          error TEXT NULL,
          started_at DATETIME(3) NULL,
          finished_at DATETIME(3) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_status_created (status, created_at),
          KEY idx_spider_created (spider, created_at),
          KEY idx_schedule_id (schedule_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await ensureColumn(
        'crawl_runs',
        'trigger_type',
        `ALTER TABLE crawl_runs ADD COLUMN trigger_type VARCHAR(16) NOT NULL DEFAULT 'manual' AFTER status`,
    );
    await ensureColumn(
        'crawl_runs',
        'schedule_id',
        `ALTER TABLE crawl_runs ADD COLUMN schedule_id BIGINT UNSIGNED NULL AFTER trigger_type, ADD KEY idx_schedule_id (schedule_id)`,
    );
    await ensureColumn(
        'crawl_runs',
        'options',
        `ALTER TABLE crawl_runs ADD COLUMN options JSON NULL AFTER params`,
    );
    await ensureColumn(
        'crawl_runs',
        'app_profile_id',
        `ALTER TABLE crawl_runs ADD COLUMN app_profile_id BIGINT UNSIGNED NULL AFTER options`,
    );
    await ensureColumn(
        'crawl_runs',
        'spider_profile_id',
        `ALTER TABLE crawl_runs ADD COLUMN spider_profile_id BIGINT UNSIGNED NULL AFTER app_profile_id`,
    );
    await ensureColumn(
        'crawl_runs',
        'app_config',
        `ALTER TABLE crawl_runs ADD COLUMN app_config JSON NULL AFTER spider_profile_id`,
    );
    await ensureColumn(
        'crawl_runs',
        'spider_config',
        `ALTER TABLE crawl_runs ADD COLUMN spider_config JSON NULL AFTER app_config`,
    );
    await ensureColumn(
        'crawl_runs',
        'frontier_type',
        `ALTER TABLE crawl_runs ADD COLUMN frontier_type VARCHAR(16) NOT NULL DEFAULT 'memory' AFTER spider_config`,
    );
    await ensureColumn(
        'crawl_runs',
        'cancel_requested',
        `ALTER TABLE crawl_runs ADD COLUMN cancel_requested TINYINT(1) NOT NULL DEFAULT 0 AFTER frontier_type`,
    );

    // crawl_logs.run_id：已有库兼容升级
    await ensureColumn(
        'crawl_logs',
        'run_id',
        `ALTER TABLE crawl_logs ADD COLUMN run_id BIGINT UNSIGNED NULL, ADD KEY idx_run_id (run_id)`,
    );
}

export async function createRun(input: CreateRunInput): Promise<CrawlRun> {
    const { spider, params } = input;
    const triggerType = input.triggerType ?? 'manual';
    const scheduleId = input.scheduleId ?? null;
    const frontierType = resolveFrontierType(input.frontier);

    if (!getSpiderDefinition(spider)) {
        throw new Error(`未知 Spider：${spider}。请先在装配入口 registerSpider。`);
    }
    if (triggerType === 'schedule' && scheduleId == null) {
        throw new Error('定时触发必须提供 scheduleId');
    }

    const resolved = await resolveRunProfiles({
        spider,
        appProfileId: input.appProfileId,
        spiderProfileId: input.spiderProfileId,
        options: input.options,
        appConfigSnapshot: input.appConfigSnapshot,
        spiderConfigSnapshot: input.spiderConfigSnapshot,
    });

    const pool = getPool();
    const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO crawl_runs
          (spider, params, options, app_profile_id, spider_profile_id, app_config, spider_config, frontier_type, status, trigger_type, schedule_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
            spider,
            JSON.stringify(params),
            JSON.stringify(resolved.options),
            resolved.appProfileId,
            resolved.spiderProfileId,
            JSON.stringify(resolved.appConfig),
            JSON.stringify(resolved.spiderConfig),
            frontierType,
            triggerType,
            scheduleId,
        ],
    );
    const id = result.insertId;
    const run = await getRun(id);
    if (!run) {
        throw new Error('创建任务失败');
    }

    if (frontierType === 'redis') {
        void seedRedisRun(id, spider, params, resolved.appConfig, resolved.spiderConfig).catch((err) => {
            console.error(`[runs] seed redis run #${id} failed:`, err);
        });
        return run;
    }

    const handle = { cancel: false, promise: Promise.resolve() };
    handle.promise = executeRunInline(id, spider, params, resolved.appConfig, resolved.spiderConfig, handle).catch(
        () => undefined,
    );
    active.set(id, handle);
    void handle.promise.finally(() => {
        active.delete(id);
    });

    return run;
}

/** redis：只入种子，由 Worker 拉取；空种子则直接成功 */
async function seedRedisRun(
    id: number,
    spiderName: string,
    params: SpiderRunParams,
    appConfig: CrawlAppConfig,
    spiderConfig: CrawlSpiderConfig,
): Promise<void> {
    const pool = getPool();

    try {
        const frontier = createFrontier('redis');
        const spider = createSpiderFromRegistry(spiderName, params, {
            runId: id,
            spiderConfig,
            frontierType: 'redis',
        });
        const delay = Math.max(0, appConfig.delay ?? 0);
        const concurrentRequests =
            delay > 0 ? 1 : (appConfig.concurrentRequests ?? getAdminEnv().crawl.concurrentRequests);
        const app = new Crawlnd({
            name: `run-${id}`,
            jobId: String(id),
            frontier,
            obeyRobotsTxt: appConfig.obeyRobotsTxt ?? getAdminEnv().crawl.obeyRobotsTxt,
            concurrentRequests,
            concurrentSpiders: appConfig.concurrentSpiders ?? 1,
            delay: delay > 0 ? delay : undefined,
            defaultHeaders: appConfig.defaultHeaders,
            validDomains: appConfig.validDomains,
        });
        app.useSpider(spider);
        const { seeded } = await app.seedJob(spider, String(id));
        await app.emitSpiderClose(spider);

        if (seeded === 0) {
            await pool.query(
                `UPDATE crawl_runs SET status = 'running', started_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
                [id],
            );
            await finishRun(id, 'succeeded', getAttachedCrawlStats(spider), null);
            await frontier.close(String(id)).catch(() => undefined);
            return;
        }

        // 先入队再标 running，避免 Supervisor 在空队列窗口误判完成
        await pool.query(
            `UPDATE crawl_runs SET status = 'running', started_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
            [id],
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await pool.query(
            `UPDATE crawl_runs SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)) WHERE id = ?`,
            [id],
        );
        await finishRun(id, 'failed', null, message);
    }
}

async function executeRunInline(
    id: number,
    spiderName: string,
    params: SpiderRunParams,
    appConfig: CrawlAppConfig,
    spiderConfig: CrawlSpiderConfig,
    handle: { cancel: boolean },
): Promise<void> {
    const pool = getPool();
    await pool.query(
        `UPDATE crawl_runs SET status = 'running', started_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
        [id],
    );

    try {
        if (handle.cancel) {
            await finishRun(id, 'cancelled', null, null);
            return;
        }

        const spider = createSpiderFromRegistry(spiderName, params, {
            runId: id,
            spiderConfig,
            frontierType: 'memory',
        });
        const delay = Math.max(0, appConfig.delay ?? 0);
        const concurrentRequests =
            delay > 0
                ? 1
                : (appConfig.concurrentRequests ?? getAdminEnv().crawl.concurrentRequests);
        const app = new Crawlnd({
            name: `run-${id}`,
            jobId: String(id),
            frontier: createFrontier('memory'),
            obeyRobotsTxt: appConfig.obeyRobotsTxt ?? getAdminEnv().crawl.obeyRobotsTxt,
            concurrentRequests,
            concurrentSpiders: appConfig.concurrentSpiders ?? 1,
            delay: delay > 0 ? delay : undefined,
            defaultHeaders: appConfig.defaultHeaders,
            validDomains: appConfig.validDomains,
        });
        app.useSpider(spider);

        await app.crawl(spiderName);
        const stats = getAttachedCrawlStats(spider);

        if (handle.cancel) {
            await finishRun(id, 'cancelled', stats, null);
            return;
        }

        const outcome = resolveRunOutcome(stats);
        await finishRun(id, outcome.status, stats, outcome.error);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await finishRun(id, handle.cancel ? 'cancelled' : 'failed', null, message);
    }
}

/** 根据 logger stats 判定任务终态（进程跑完 ≠ 业务成功） */
export function resolveRunOutcome(stats: CrawlStats | null): {
    status: Extract<RunStatus, 'succeeded' | 'failed'>;
    error: string | null;
} {
    if (!stats) {
        return { status: 'succeeded', error: null };
    }
    if (stats.errors > 0) {
        return {
            status: 'failed',
            error: `业务失败：errors=${stats.errors}, saved=${stats.saved}, skipped=${stats.skipped}, items=${stats.items}`,
        };
    }
    return { status: 'succeeded', error: null };
}

async function finishRun(
    id: number,
    status: RunStatus,
    stats: CrawlRunStats | null,
    error: string | null,
): Promise<void> {
    const pool = getPool();
    await pool.query(
        `UPDATE crawl_runs
         SET status = ?, stats = ?, error = ?, finished_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status IN ('pending', 'running')`,
        [status, stats ? JSON.stringify(stats) : null, error, id],
    );
}

/** Supervisor 写终态（仅 running → 终态） */
export async function finishRunFromSupervisor(
    id: number,
    status: RunStatus,
    stats: CrawlRunStats | null,
    error: string | null,
): Promise<void> {
    await finishRun(id, status, stats, error);
}

/** 正在跑的 redis frontier 任务（供 Supervisor / Worker） */
export async function listRunningRedisRuns(limit = 100): Promise<CrawlRun[]> {
    const pool = getPool();
    const [rows] = await pool.query<CrawlRunRow[]>(
        `SELECT * FROM crawl_runs
         WHERE status = 'running' AND frontier_type = 'redis'
         ORDER BY id ASC
         LIMIT ?`,
        [limit],
    );
    return rows.map(rowToRun);
}

export async function getRun(id: number): Promise<CrawlRun | null> {
    const pool = getPool();
    const [rows] = await pool.query<CrawlRunRow[]>(`SELECT * FROM crawl_runs WHERE id = ?`, [id]);
    const row = rows[0];
    return row ? rowToRun(row) : null;
}

export async function listRuns(options: ListRunsOptions | number = 50): Promise<CrawlRun[]> {
    const opts: ListRunsOptions = typeof options === 'number' ? { limit: options } : options;
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const pool = getPool();

    if (opts.scheduleId != null) {
        const [rows] = await pool.query<CrawlRunRow[]>(
            `SELECT * FROM crawl_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT ?`,
            [opts.scheduleId, limit],
        );
        return rows.map(rowToRun);
    }

    const [rows] = await pool.query<CrawlRunRow[]>(
        `SELECT * FROM crawl_runs ORDER BY id DESC LIMIT ?`,
        [limit],
    );
    return rows.map(rowToRun);
}

/** 该计划是否仍有 pending/running 的 Run（overlap skip 用） */
export async function hasActiveRunForSchedule(scheduleId: number): Promise<boolean> {
    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT id FROM crawl_runs
         WHERE schedule_id = ? AND status IN ('pending', 'running')
         LIMIT 1`,
        [scheduleId],
    );
    return rows.length > 0;
}

export async function stopRun(id: number): Promise<CrawlRun> {
    const run = await getRun(id);
    if (!run) {
        throw new Error(`任务不存在：${id}`);
    }
    if (run.status !== 'pending' && run.status !== 'running') {
        return run;
    }
    const handle = active.get(id);
    if (handle) {
        handle.cancel = true;
    }
    const pool = getPool();
    await pool.query(
        `UPDATE crawl_runs
         SET cancel_requested = 1,
             status = IF(frontier_type = 'redis', status, 'cancelled'),
             finished_at = IF(frontier_type = 'redis', finished_at, COALESCE(finished_at, CURRENT_TIMESTAMP(3)))
         WHERE id = ? AND status IN ('pending', 'running')`,
        [id],
    );

    if (run.frontierType === 'redis') {
        try {
            const frontier = createFrontier('redis');
            await frontier.setCancelled(String(id), true);
        } catch (err) {
            console.error(`[runs] cancel frontier #${id} failed:`, err);
        }
        // 终态由 Supervisor 在看到 cancel 后落库
    }

    const updated = await getRun(id);
    if (!updated) {
        throw new Error(`任务不存在：${id}`);
    }
    return updated;
}

/**
 * Worker：对指定 run 执行 runFetchLoop（须已 seed 且 frontier=redis）。
 */
export async function executeWorkerFetchLoop(run: CrawlRun): Promise<void> {
    if (run.frontierType !== 'redis' || run.status !== 'running') {
        return;
    }
    const frontier = createFrontier('redis');
    const delay = Math.max(0, run.appConfig.delay ?? 0);
    const concurrentRequests =
        delay > 0 ? 1 : (run.appConfig.concurrentRequests ?? getAdminEnv().crawl.concurrentRequests);
    const spider = createSpiderFromRegistry(run.spider, run.params, {
        runId: run.id,
        spiderConfig: run.spiderConfig,
        frontierType: 'redis',
    });
    const app = new Crawlnd({
        name: `worker-${getAdminEnv().worker.id}-run-${run.id}`,
        jobId: String(run.id),
        frontier,
        obeyRobotsTxt: run.appConfig.obeyRobotsTxt ?? getAdminEnv().crawl.obeyRobotsTxt,
        concurrentRequests,
        concurrentSpiders: 1,
        delay: delay > 0 ? delay : undefined,
        defaultHeaders: run.appConfig.defaultHeaders,
        validDomains: run.appConfig.validDomains,
    });
    app.useSpider(spider);
    await app.runFetchLoop(spider, String(run.id), { emitLifecycle: true });
}

export async function listRunLogs(runId: number, limit = 200): Promise<unknown[]> {
    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT id, ts, spider, level, event, message, fields, run_id AS runId
         FROM crawl_logs WHERE run_id = ? ORDER BY id ASC LIMIT ?`,
        [runId, Math.min(Math.max(limit, 1), 1000)],
    );
    return rows;
}

export interface ListLogsOptions {
    limit?: number;
    /** 小于该 id（用于向前翻页，取更旧日志） */
    beforeId?: number;
    spider?: string;
    level?: string;
    event?: string;
    runId?: number;
}

/** 全局日志查询（默认按 id 倒序，最新在前） */
export async function listLogs(options: ListLogsOptions = {}): Promise<unknown[]> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const pool = getPool();
    const where: string[] = [];
    const args: unknown[] = [];

    if (options.beforeId != null && Number.isFinite(options.beforeId)) {
        where.push('id < ?');
        args.push(options.beforeId);
    }
    if (options.spider) {
        where.push('spider = ?');
        args.push(options.spider);
    }
    if (options.level) {
        where.push('level = ?');
        args.push(options.level);
    }
    if (options.event) {
        where.push('event = ?');
        args.push(options.event);
    }
    if (options.runId != null && Number.isFinite(options.runId)) {
        where.push('run_id = ?');
        args.push(options.runId);
    }

    const sql = `
        SELECT id, ts, spider, level, event, message, fields, run_id AS runId
        FROM crawl_logs
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY id DESC
        LIMIT ?
    `;
    args.push(limit);
    const [rows] = await pool.query<RowDataPacket[]>(sql, args);
    return rows;
}

