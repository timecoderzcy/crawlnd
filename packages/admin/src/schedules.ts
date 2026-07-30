import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { Cron } from 'croner';
import { getPool } from './runtime.js';
import {
    normalizeAppConfig,
    normalizeCrawlOptions,
    normalizeSpiderConfig,
    type CrawlAppConfig,
    type CrawlRunOptions,
    type CrawlSpiderConfig,
} from './crawl-options.js';
import { resolveRunProfiles } from './profiles.js';
import { getSpiderDefinition, type SpiderRunParams } from './registry.js';
import { createRun, listRuns, type CrawlRun } from './runs.js';

export type OverlapPolicy = 'skip' | 'queue' | 'replace';

export interface CrawlSchedule {
    id: number;
    name: string;
    spider: string;
    params: SpiderRunParams;
    options: CrawlRunOptions;
    appProfileId: number | null;
    spiderProfileId: number | null;
    appConfig: CrawlAppConfig;
    spiderConfig: CrawlSpiderConfig;
    cron: string;
    timezone: string;
    enabled: boolean;
    overlapPolicy: OverlapPolicy;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastRunId: number | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface CreateScheduleInput {
    name: string;
    spider: string;
    params: SpiderRunParams;
    options?: CrawlRunOptions;
    appProfileId?: number | null;
    spiderProfileId?: number | null;
    cron: string;
    timezone?: string;
    enabled?: boolean;
    overlapPolicy?: OverlapPolicy;
}

export interface UpdateScheduleInput {
    name?: string;
    spider?: string;
    params?: SpiderRunParams;
    options?: CrawlRunOptions;
    appProfileId?: number | null;
    spiderProfileId?: number | null;
    cron?: string;
    timezone?: string;
    enabled?: boolean;
    overlapPolicy?: OverlapPolicy;
}

interface CrawlScheduleRow extends RowDataPacket {
    id: number;
    name: string;
    spider: string;
    params: string | SpiderRunParams;
    options: string | CrawlRunOptions | null;
    app_profile_id: number | null;
    spider_profile_id: number | null;
    app_config: string | CrawlAppConfig | null;
    spider_config: string | CrawlSpiderConfig | null;
    cron: string;
    timezone: string;
    enabled: number;
    overlap_policy: OverlapPolicy;
    next_run_at: Date | null;
    last_run_at: Date | null;
    last_run_id: number | null;
    last_error: string | null;
    created_at: Date;
    updated_at: Date;
}

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

function rowToSchedule(row: CrawlScheduleRow): CrawlSchedule {
    return {
        id: row.id,
        name: row.name,
        spider: row.spider,
        params: parseJson<SpiderRunParams>(row.params, {}),
        options: safeNormalize(normalizeCrawlOptions, parseJson(row.options, {}), {}),
        appProfileId: row.app_profile_id ?? null,
        spiderProfileId: row.spider_profile_id ?? null,
        appConfig: safeNormalize(normalizeAppConfig, parseJson(row.app_config, {}), {}),
        spiderConfig: safeNormalize(normalizeSpiderConfig, parseJson(row.spider_config, {}), {}),
        cron: row.cron,
        timezone: row.timezone,
        enabled: Boolean(row.enabled),
        overlapPolicy: row.overlap_policy,
        nextRunAt: row.next_run_at ? row.next_run_at.toISOString() : null,
        lastRunAt: row.last_run_at ? row.last_run_at.toISOString() : null,
        lastRunId: row.last_run_id,
        lastError: row.last_error,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}

/** 解析 cron 并计算下一次触发时间；非法表达式抛错 */
export function computeNextRunAt(cron: string, timezone: string, from: Date = new Date()): Date {
    let job: Cron;
    try {
        job = new Cron(cron, { timezone, paused: true });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`无效 cron 表达式：${cron}（${message}）`);
    }
    const next = job.nextRun(from);
    if (!next) {
        throw new Error(`cron 无法算出下次执行时间：${cron}`);
    }
    return next;
}

function assertSpider(spider: string): void {
    if (!getSpiderDefinition(spider)) {
        throw new Error(`未知 Spider：${spider}。请先在装配入口 registerSpider。`);
    }
}

function assertOverlapPolicy(policy: string): asserts policy is OverlapPolicy {
    if (policy !== 'skip' && policy !== 'queue' && policy !== 'replace') {
        throw new Error(`overlapPolicy 仅支持 skip | queue | replace，收到：${policy}`);
    }
    if (policy !== 'skip') {
        throw new Error(`第一期仅实现 overlapPolicy=skip，收到：${policy}`);
    }
}

export async function ensureScheduleTables(): Promise<void> {
    const pool = getPool();
    await pool.query(`
        CREATE TABLE IF NOT EXISTS crawl_schedules (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(128) NOT NULL,
          spider VARCHAR(64) NOT NULL,
          params JSON NOT NULL,
          options JSON NULL,
          app_profile_id BIGINT UNSIGNED NULL,
          spider_profile_id BIGINT UNSIGNED NULL,
          app_config JSON NULL,
          spider_config JSON NULL,
          cron VARCHAR(64) NOT NULL,
          timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          overlap_policy VARCHAR(16) NOT NULL DEFAULT 'skip',
          next_run_at DATETIME(3) NULL,
          last_run_at DATETIME(3) NULL,
          last_run_id BIGINT UNSIGNED NULL,
          last_error TEXT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          KEY idx_enabled_next (enabled, next_run_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    for (const [column, sql] of [
        ['options', `ALTER TABLE crawl_schedules ADD COLUMN options JSON NULL AFTER params`],
        ['app_profile_id', `ALTER TABLE crawl_schedules ADD COLUMN app_profile_id BIGINT UNSIGNED NULL AFTER options`],
        ['spider_profile_id', `ALTER TABLE crawl_schedules ADD COLUMN spider_profile_id BIGINT UNSIGNED NULL AFTER app_profile_id`],
        ['app_config', `ALTER TABLE crawl_schedules ADD COLUMN app_config JSON NULL AFTER spider_profile_id`],
        ['spider_config', `ALTER TABLE crawl_schedules ADD COLUMN spider_config JSON NULL AFTER app_config`],
    ] as const) {
        const [cols] = await pool.query<RowDataPacket[]>(
            `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'crawl_schedules' AND COLUMN_NAME = ?`,
            [column],
        );
        if (cols.length === 0) {
            await pool.query(sql);
        }
    }
}

export async function createSchedule(input: CreateScheduleInput): Promise<CrawlSchedule> {
    const name = input.name?.trim();
    if (!name) {
        throw new Error('name 必填');
    }
    assertSpider(input.spider);
    const resolved = await resolveRunProfiles({
        spider: input.spider,
        appProfileId: input.appProfileId,
        spiderProfileId: input.spiderProfileId,
        options: input.options,
    });
    const timezone = input.timezone?.trim() || 'Asia/Shanghai';
    const overlapPolicy = input.overlapPolicy ?? 'skip';
    assertOverlapPolicy(overlapPolicy);
    const enabled = input.enabled !== false;
    const nextRunAt = enabled ? computeNextRunAt(input.cron, timezone) : null;

    const pool = getPool();
    const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO crawl_schedules
          (name, spider, params, options, app_profile_id, spider_profile_id, app_config, spider_config,
           cron, timezone, enabled, overlap_policy, next_run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            name,
            input.spider,
            JSON.stringify(input.params ?? {}),
            JSON.stringify(resolved.options),
            resolved.appProfileId,
            resolved.spiderProfileId,
            JSON.stringify(resolved.appConfig),
            JSON.stringify(resolved.spiderConfig),
            input.cron.trim(),
            timezone,
            enabled ? 1 : 0,
            overlapPolicy,
            nextRunAt,
        ],
    );
    const schedule = await getSchedule(result.insertId);
    if (!schedule) {
        throw new Error('创建计划失败');
    }
    return schedule;
}

export async function getSchedule(id: number): Promise<CrawlSchedule | null> {
    const pool = getPool();
    const [rows] = await pool.query<CrawlScheduleRow[]>(
        `SELECT * FROM crawl_schedules WHERE id = ?`,
        [id],
    );
    const row = rows[0];
    return row ? rowToSchedule(row) : null;
}

export async function listSchedules(): Promise<CrawlSchedule[]> {
    const pool = getPool();
    const [rows] = await pool.query<CrawlScheduleRow[]>(
        `SELECT * FROM crawl_schedules ORDER BY id DESC`,
    );
    return rows.map(rowToSchedule);
}

export async function updateSchedule(id: number, patch: UpdateScheduleInput): Promise<CrawlSchedule> {
    const current = await getSchedule(id);
    if (!current) {
        throw new Error(`计划不存在：${id}`);
    }

    const name = patch.name !== undefined ? patch.name.trim() : current.name;
    if (!name) {
        throw new Error('name 不能为空');
    }
    const spider = patch.spider ?? current.spider;
    assertSpider(spider);
    const params = patch.params ?? current.params;
    const profilePatch =
        patch.options !== undefined ||
        patch.appProfileId !== undefined ||
        patch.spiderProfileId !== undefined ||
        patch.spider !== undefined;
    const resolved = profilePatch
        ? await resolveRunProfiles({
            spider,
            appProfileId: patch.appProfileId !== undefined ? patch.appProfileId : current.appProfileId,
            spiderProfileId:
                patch.spiderProfileId !== undefined ? patch.spiderProfileId : current.spiderProfileId,
            options: patch.options !== undefined ? patch.options : current.options,
        })
        : {
            appProfileId: current.appProfileId,
            spiderProfileId: current.spiderProfileId,
            appConfig: current.appConfig,
            spiderConfig: current.spiderConfig,
            options: current.options,
        };
    const cron = patch.cron !== undefined ? patch.cron.trim() : current.cron;
    const timezone = patch.timezone !== undefined ? patch.timezone.trim() || 'Asia/Shanghai' : current.timezone;
    const enabled = patch.enabled ?? current.enabled;
    const overlapPolicy = patch.overlapPolicy ?? current.overlapPolicy;
    assertOverlapPolicy(overlapPolicy);

    // cron / timezone / enabled 变化时重算 next；禁用则清空
    let nextRunAt: Date | null = null;
    if (enabled) {
        const cronChanged =
            patch.cron !== undefined ||
            patch.timezone !== undefined ||
            patch.enabled !== undefined;
        if (cronChanged || !current.nextRunAt) {
            nextRunAt = computeNextRunAt(cron, timezone);
        } else {
            nextRunAt = new Date(current.nextRunAt);
        }
    }

    const pool = getPool();
    await pool.query(
        `UPDATE crawl_schedules SET
           name = ?, spider = ?, params = ?, options = ?,
           app_profile_id = ?, spider_profile_id = ?, app_config = ?, spider_config = ?,
           cron = ?, timezone = ?, enabled = ?, overlap_policy = ?, next_run_at = ?
         WHERE id = ?`,
        [
            name,
            spider,
            JSON.stringify(params),
            JSON.stringify(resolved.options),
            resolved.appProfileId,
            resolved.spiderProfileId,
            JSON.stringify(resolved.appConfig),
            JSON.stringify(resolved.spiderConfig),
            cron,
            timezone,
            enabled ? 1 : 0,
            overlapPolicy,
            nextRunAt,
            id,
        ],
    );
    const updated = await getSchedule(id);
    if (!updated) {
        throw new Error(`计划不存在：${id}`);
    }
    return updated;
}

export async function deleteSchedule(id: number): Promise<void> {
    const pool = getPool();
    const [result] = await pool.query<ResultSetHeader>(
        `DELETE FROM crawl_schedules WHERE id = ?`,
        [id],
    );
    if (result.affectedRows === 0) {
        throw new Error(`计划不存在：${id}`);
    }
}

export async function setScheduleEnabled(id: number, enabled: boolean): Promise<CrawlSchedule> {
    return updateSchedule(id, { enabled });
}

/** 立即触发一次（仍走 createRun，计入该计划历史） */
export async function triggerSchedule(id: number): Promise<CrawlRun> {
    const schedule = await getSchedule(id);
    if (!schedule) {
        throw new Error(`计划不存在：${id}`);
    }
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
    const pool = getPool();
    await pool.query(
        `UPDATE crawl_schedules SET last_run_at = CURRENT_TIMESTAMP(3), last_run_id = ?, last_error = NULL WHERE id = ?`,
        [run.id, id],
    );
    return run;
}

export async function getScheduleDetail(
    id: number,
    recentRunLimit = 20,
): Promise<(CrawlSchedule & { recentRuns: CrawlRun[] }) | null> {
    const schedule = await getSchedule(id);
    if (!schedule) {
        return null;
    }
    const recentRuns = await listRuns({ scheduleId: id, limit: recentRunLimit });
    return { ...schedule, recentRuns };
}

/** 供调度器：取出已到期的计划 */
export async function listDueSchedules(now: Date = new Date()): Promise<CrawlSchedule[]> {
    const pool = getPool();
    const [rows] = await pool.query<CrawlScheduleRow[]>(
        `SELECT * FROM crawl_schedules
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC
         LIMIT 50`,
        [now],
    );
    return rows.map(rowToSchedule);
}

/**
 * 抢占一次触发：把 next_run_at 推进到下一拍。
 * WHERE next_run_at <= 读到的到期时间，避免双 tick 重复触发。
 */
export async function claimScheduleFire(
    schedule: CrawlSchedule,
    nextRunAt: Date,
): Promise<boolean> {
    if (!schedule.nextRunAt) {
        return false;
    }
    const pool = getPool();
    const dueAt = new Date(schedule.nextRunAt);
    const [result] = await pool.query<ResultSetHeader>(
        `UPDATE crawl_schedules
         SET next_run_at = ?
         WHERE id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
        [nextRunAt, schedule.id, dueAt],
    );
    return result.affectedRows > 0;
}

export async function markScheduleFired(
    id: number,
    runId: number | null,
    error: string | null,
): Promise<void> {
    const pool = getPool();
    await pool.query(
        `UPDATE crawl_schedules SET
           last_run_at = CURRENT_TIMESTAMP(3),
           last_run_id = COALESCE(?, last_run_id),
           last_error = ?
         WHERE id = ?`,
        [runId, error, id],
    );
}
