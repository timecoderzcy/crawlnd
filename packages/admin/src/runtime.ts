import type { Pool } from 'mysql2/promise';

/**
 * Admin 插件运行时依赖（由 configureAdmin 注入）。
 * 框架不直接读应用 .env / 创建连接池。
 */
export interface AdminMysqlConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
}

export interface AdminRedisConfig {
    host: string;
    port: number;
}

export interface AdminHttpConfig {
    host: string;
    port: number;
    schedulerIntervalMs: number;
    password: string;
    jwtSecret: string;
    tokenTtlSeconds: number;
}

export interface AdminCrawlConfig {
    concurrentRequests: number;
    concurrentSpiders: number;
    obeyRobotsTxt: boolean;
    frontier: 'memory' | 'redis';
    frontierLeaseMs: number;
    jobStableWindowMs: number;
    supervisorIntervalMs: number;
}

export interface AdminWorkerConfig {
    maxJobs: number;
    pollIntervalMs: number;
    id: string;
}

export interface AdminEnv {
    mysql: AdminMysqlConfig;
    redis: AdminRedisConfig;
    admin: AdminHttpConfig;
    crawl: AdminCrawlConfig;
    worker: AdminWorkerConfig;
}

export interface AdminRuntime {
    env: AdminEnv;
    getPool: () => Pool;
    closePool: () => Promise<void>;
}

let runtime: AdminRuntime | null = null;

/** 在 startAdmin / worker 启动前调用一次 */
export function configureAdmin(next: AdminRuntime): void {
    runtime = next;
}

export function getAdminRuntime(): AdminRuntime {
    if (!runtime) {
        throw new Error('Admin 未配置：请先调用 configureAdmin({ env, getPool, closePool })');
    }
    return runtime;
}

export function getAdminEnv(): AdminEnv {
    return getAdminRuntime().env;
}

export function getPool(): Pool {
    return getAdminRuntime().getPool();
}

export async function closePool(): Promise<void> {
    await getAdminRuntime().closePool();
}
