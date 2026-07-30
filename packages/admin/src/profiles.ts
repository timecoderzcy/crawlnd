import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { getPool } from './runtime.js';
import { getSpiderDefinition } from './registry.js';
import {
    envAppConfigDefaults,
    mergeAppConfig,
    normalizeAppConfig,
    normalizeCrawlOptions,
    normalizeSpiderConfig,
    type CrawlAppConfig,
    type CrawlRunOptions,
    type CrawlSpiderConfig,
} from './crawl-options.js';

export interface AppProfile {
    id: number;
    name: string;
    description: string;
    config: CrawlAppConfig;
    isDefault: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface SpiderProfile {
    id: number;
    spider: string;
    name: string;
    description: string;
    config: CrawlSpiderConfig;
    isDefault: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface CreateAppProfileInput {
    name: string;
    description?: string;
    config?: CrawlAppConfig;
    isDefault?: boolean;
}

export interface UpdateAppProfileInput {
    name?: string;
    description?: string;
    config?: CrawlAppConfig;
    isDefault?: boolean;
}

export interface CreateSpiderProfileInput {
    spider: string;
    name: string;
    description?: string;
    config?: CrawlSpiderConfig;
    isDefault?: boolean;
}

export interface UpdateSpiderProfileInput {
    name?: string;
    description?: string;
    config?: CrawlSpiderConfig;
    isDefault?: boolean;
}

export interface ResolvedRunProfiles {
    appProfileId: number | null;
    spiderProfileId: number | null;
    appConfig: CrawlAppConfig;
    spiderConfig: CrawlSpiderConfig;
    options: CrawlRunOptions;
}

interface AppProfileRow extends RowDataPacket {
    id: number;
    name: string;
    description: string | null;
    config: string | CrawlAppConfig;
    is_default: number;
    created_at: Date;
    updated_at: Date;
}

interface SpiderProfileRow extends RowDataPacket {
    id: number;
    spider: string;
    name: string;
    description: string | null;
    config: string | CrawlSpiderConfig;
    is_default: number;
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

function rowToApp(row: AppProfileRow): AppProfile {
    let config: CrawlAppConfig = {};
    try {
        config = normalizeAppConfig(parseJson(row.config, {}));
    } catch {
        config = {};
    }
    return {
        id: row.id,
        name: row.name,
        description: row.description ?? '',
        config,
        isDefault: Boolean(row.is_default),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}

function rowToSpider(row: SpiderProfileRow): SpiderProfile {
    let config: CrawlSpiderConfig = {};
    try {
        config = normalizeSpiderConfig(parseJson(row.config, {}));
    } catch {
        config = {};
    }
    return {
        id: row.id,
        spider: row.spider,
        name: row.name,
        description: row.description ?? '',
        config,
        isDefault: Boolean(row.is_default),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}

export async function ensureProfileTables(): Promise<void> {
    const pool = getPool();
    await pool.query(`
        CREATE TABLE IF NOT EXISTS crawl_app_profiles (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(128) NOT NULL,
          description VARCHAR(512) NOT NULL DEFAULT '',
          config JSON NOT NULL,
          is_default TINYINT(1) NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_name (name),
          KEY idx_default (is_default)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS crawl_spider_profiles (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          spider VARCHAR(64) NOT NULL,
          name VARCHAR(128) NOT NULL,
          description VARCHAR(512) NOT NULL DEFAULT '',
          config JSON NOT NULL,
          is_default TINYINT(1) NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_spider_name (spider, name),
          KEY idx_spider_default (spider, is_default)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

/** 无默认 App Profile 时插入一条来自 .env 的系统默认 */
export async function seedDefaultAppProfile(): Promise<void> {
    const existing = await getDefaultAppProfile();
    if (existing) {
        return;
    }
    await createAppProfile({
        name: '系统默认',
        description: '由 .env 生成的默认工程配置',
        config: envAppConfigDefaults(),
        isDefault: true,
    });
}

async function clearAppDefaults(exceptId?: number): Promise<void> {
    const pool = getPool();
    if (exceptId != null) {
        await pool.query(`UPDATE crawl_app_profiles SET is_default = 0 WHERE id <> ?`, [exceptId]);
    } else {
        await pool.query(`UPDATE crawl_app_profiles SET is_default = 0`);
    }
}

async function clearSpiderDefaults(spider: string, exceptId?: number): Promise<void> {
    const pool = getPool();
    if (exceptId != null) {
        await pool.query(
            `UPDATE crawl_spider_profiles SET is_default = 0 WHERE spider = ? AND id <> ?`,
            [spider, exceptId],
        );
    } else {
        await pool.query(`UPDATE crawl_spider_profiles SET is_default = 0 WHERE spider = ?`, [spider]);
    }
}

export async function listAppProfiles(): Promise<AppProfile[]> {
    const pool = getPool();
    const [rows] = await pool.query<AppProfileRow[]>(
        `SELECT * FROM crawl_app_profiles ORDER BY is_default DESC, id ASC`,
    );
    return rows.map(rowToApp);
}

export async function getAppProfile(id: number): Promise<AppProfile | null> {
    const pool = getPool();
    const [rows] = await pool.query<AppProfileRow[]>(
        `SELECT * FROM crawl_app_profiles WHERE id = ?`,
        [id],
    );
    return rows[0] ? rowToApp(rows[0]) : null;
}

export async function getDefaultAppProfile(): Promise<AppProfile | null> {
    const pool = getPool();
    const [rows] = await pool.query<AppProfileRow[]>(
        `SELECT * FROM crawl_app_profiles WHERE is_default = 1 ORDER BY id ASC LIMIT 1`,
    );
    return rows[0] ? rowToApp(rows[0]) : null;
}

export async function createAppProfile(input: CreateAppProfileInput): Promise<AppProfile> {
    const name = input.name?.trim();
    if (!name) {
        throw new Error('name 必填');
    }
    const config = normalizeAppConfig(input.config ?? envAppConfigDefaults());
    const isDefault = input.isDefault === true;
    const pool = getPool();
    if (isDefault) {
        await clearAppDefaults();
    }
    const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO crawl_app_profiles (name, description, config, is_default) VALUES (?, ?, ?, ?)`,
        [name, input.description?.trim() ?? '', JSON.stringify(config), isDefault ? 1 : 0],
    );
    const profile = await getAppProfile(result.insertId);
    if (!profile) {
        throw new Error('创建 App Profile 失败');
    }
    return profile;
}

export async function updateAppProfile(id: number, patch: UpdateAppProfileInput): Promise<AppProfile> {
    const current = await getAppProfile(id);
    if (!current) {
        throw new Error(`App Profile 不存在：${id}`);
    }
    const name = patch.name !== undefined ? patch.name.trim() : current.name;
    if (!name) {
        throw new Error('name 不能为空');
    }
    const description = patch.description !== undefined ? patch.description.trim() : current.description;
    const config = patch.config !== undefined ? normalizeAppConfig(patch.config) : current.config;
    const isDefault = patch.isDefault ?? current.isDefault;
    const pool = getPool();
    if (isDefault) {
        await clearAppDefaults(id);
    }
    await pool.query(
        `UPDATE crawl_app_profiles SET name = ?, description = ?, config = ?, is_default = ? WHERE id = ?`,
        [name, description, JSON.stringify(config), isDefault ? 1 : 0, id],
    );
    const updated = await getAppProfile(id);
    if (!updated) {
        throw new Error(`App Profile 不存在：${id}`);
    }
    return updated;
}

export async function deleteAppProfile(id: number): Promise<void> {
    const current = await getAppProfile(id);
    if (!current) {
        throw new Error(`App Profile 不存在：${id}`);
    }
    if (current.isDefault) {
        throw new Error('不能删除默认 App Profile，请先指定其它默认项');
    }
    const pool = getPool();
    await pool.query(`DELETE FROM crawl_app_profiles WHERE id = ?`, [id]);
}

export async function setDefaultAppProfile(id: number): Promise<AppProfile> {
    return updateAppProfile(id, { isDefault: true });
}

export async function listSpiderProfiles(spider?: string): Promise<SpiderProfile[]> {
    const pool = getPool();
    if (spider) {
        const [rows] = await pool.query<SpiderProfileRow[]>(
            `SELECT * FROM crawl_spider_profiles WHERE spider = ? ORDER BY is_default DESC, id ASC`,
            [spider],
        );
        return rows.map(rowToSpider);
    }
    const [rows] = await pool.query<SpiderProfileRow[]>(
        `SELECT * FROM crawl_spider_profiles ORDER BY spider ASC, is_default DESC, id ASC`,
    );
    return rows.map(rowToSpider);
}

export async function getSpiderProfile(id: number): Promise<SpiderProfile | null> {
    const pool = getPool();
    const [rows] = await pool.query<SpiderProfileRow[]>(
        `SELECT * FROM crawl_spider_profiles WHERE id = ?`,
        [id],
    );
    return rows[0] ? rowToSpider(rows[0]) : null;
}

export async function getDefaultSpiderProfile(spider: string): Promise<SpiderProfile | null> {
    const pool = getPool();
    const [rows] = await pool.query<SpiderProfileRow[]>(
        `SELECT * FROM crawl_spider_profiles WHERE spider = ? AND is_default = 1 ORDER BY id ASC LIMIT 1`,
        [spider],
    );
    return rows[0] ? rowToSpider(rows[0]) : null;
}

export async function createSpiderProfile(input: CreateSpiderProfileInput): Promise<SpiderProfile> {
    const spider = input.spider?.trim();
    const name = input.name?.trim();
    if (!spider || !name) {
        throw new Error('spider / name 必填');
    }
    if (!getSpiderDefinition(spider)) {
        throw new Error(`未知 Spider：${spider}`);
    }
    const config = normalizeSpiderConfig(input.config ?? {});
    const isDefault = input.isDefault === true;
    const pool = getPool();
    if (isDefault) {
        await clearSpiderDefaults(spider);
    }
    const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO crawl_spider_profiles (spider, name, description, config, is_default)
         VALUES (?, ?, ?, ?, ?)`,
        [spider, name, input.description?.trim() ?? '', JSON.stringify(config), isDefault ? 1 : 0],
    );
    const profile = await getSpiderProfile(result.insertId);
    if (!profile) {
        throw new Error('创建 Spider Profile 失败');
    }
    return profile;
}

export async function updateSpiderProfile(id: number, patch: UpdateSpiderProfileInput): Promise<SpiderProfile> {
    const current = await getSpiderProfile(id);
    if (!current) {
        throw new Error(`Spider Profile 不存在：${id}`);
    }
    const name = patch.name !== undefined ? patch.name.trim() : current.name;
    if (!name) {
        throw new Error('name 不能为空');
    }
    const description = patch.description !== undefined ? patch.description.trim() : current.description;
    const config = patch.config !== undefined ? normalizeSpiderConfig(patch.config) : current.config;
    const isDefault = patch.isDefault ?? current.isDefault;
    const pool = getPool();
    if (isDefault) {
        await clearSpiderDefaults(current.spider, id);
    }
    await pool.query(
        `UPDATE crawl_spider_profiles SET name = ?, description = ?, config = ?, is_default = ? WHERE id = ?`,
        [name, description, JSON.stringify(config), isDefault ? 1 : 0, id],
    );
    const updated = await getSpiderProfile(id);
    if (!updated) {
        throw new Error(`Spider Profile 不存在：${id}`);
    }
    return updated;
}

export async function deleteSpiderProfile(id: number): Promise<void> {
    const current = await getSpiderProfile(id);
    if (!current) {
        throw new Error(`Spider Profile 不存在：${id}`);
    }
    const pool = getPool();
    await pool.query(`DELETE FROM crawl_spider_profiles WHERE id = ?`, [id]);
}

export async function setDefaultSpiderProfile(id: number): Promise<SpiderProfile> {
    return updateSpiderProfile(id, { isDefault: true });
}

/**
 * 解析 Run/Schedule 使用的配置：
 * 指定 profile → 否则该层 default → 否则 .env / 空 Spider 配置；
 * 再用 options 浅覆盖 App。
 */
export async function resolveRunProfiles(input: {
    spider: string;
    appProfileId?: number | null;
    spiderProfileId?: number | null;
    options?: unknown;
    /** 已固化的 snapshot（Schedule 触发时优先） */
    appConfigSnapshot?: CrawlAppConfig | null;
    spiderConfigSnapshot?: CrawlSpiderConfig | null;
}): Promise<ResolvedRunProfiles> {
    const options = normalizeCrawlOptions(input.options);

    let appProfileId: number | null = null;
    let appConfig: CrawlAppConfig;

    if (input.appConfigSnapshot) {
        appConfig = normalizeAppConfig(input.appConfigSnapshot);
        appProfileId = input.appProfileId ?? null;
    } else if (input.appProfileId != null) {
        const profile = await getAppProfile(input.appProfileId);
        if (!profile) {
            throw new Error(`App Profile 不存在：${input.appProfileId}`);
        }
        appProfileId = profile.id;
        appConfig = profile.config;
    } else {
        const def = await getDefaultAppProfile();
        if (def) {
            appProfileId = def.id;
            appConfig = def.config;
        } else {
            appConfig = envAppConfigDefaults();
        }
    }

    appConfig = mergeAppConfig(appConfig, options);

    let spiderProfileId: number | null = null;
    let spiderConfig: CrawlSpiderConfig = {};

    if (input.spiderConfigSnapshot) {
        spiderConfig = normalizeSpiderConfig(input.spiderConfigSnapshot);
        spiderProfileId = input.spiderProfileId ?? null;
    } else if (input.spiderProfileId != null) {
        const profile = await getSpiderProfile(input.spiderProfileId);
        if (!profile) {
            throw new Error(`Spider Profile 不存在：${input.spiderProfileId}`);
        }
        if (profile.spider !== input.spider) {
            throw new Error(`Spider Profile #${profile.id} 属于 ${profile.spider}，与任务 spider=${input.spider} 不匹配`);
        }
        spiderProfileId = profile.id;
        spiderConfig = profile.config;
    } else {
        const def = await getDefaultSpiderProfile(input.spider);
        if (def) {
            spiderProfileId = def.id;
            spiderConfig = def.config;
        }
    }

    return {
        appProfileId,
        spiderProfileId,
        appConfig,
        spiderConfig,
        options,
    };
}
