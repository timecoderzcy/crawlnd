import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getAdminEnv } from './runtime.js';
import { closePool } from './runtime.js';
import {
    createAuthMiddleware,
    isAuthEnabled,
    loginWithPassword,
} from './auth.js';
import { listSpiderDefinitions, type SpiderRunParams } from './registry.js';
import {
    createRun,
    ensureAdminTables,
    getRun,
    listLogs,
    listRunLogs,
    listRuns,
    stopRun,
    type CrawlRunOptions,
} from './runs.js';
import { createFrontier } from './frontier-factory.js';
import {
    clearAggregatedJobStats,
    readAggregatedJobStats,
} from '@crawlnd/utils';
import {
    createAppProfile,
    createSpiderProfile,
    deleteAppProfile,
    deleteSpiderProfile,
    ensureProfileTables,
    getDefaultAppProfile,
    getDefaultSpiderProfile,
    listAppProfiles,
    listSpiderProfiles,
    getAppProfile,
    getSpiderProfile,
    seedDefaultAppProfile,
    setDefaultAppProfile,
    setDefaultSpiderProfile,
    updateAppProfile,
    updateSpiderProfile,
    type CreateAppProfileInput,
    type CreateSpiderProfileInput,
    type UpdateAppProfileInput,
    type UpdateSpiderProfileInput,
} from './profiles.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { startJobSupervisor, stopJobSupervisor } from './job-supervisor.js';
import { quitSharedRedis } from './frontier-factory.js';
import { getPlatformOverview } from './stats.js';
import {
    createSchedule,
    deleteSchedule,
    ensureScheduleTables,
    getScheduleDetail,
    listSchedules,
    setScheduleEnabled,
    triggerSchedule,
    updateSchedule,
    type CreateScheduleInput,
    type OverlapPolicy,
    type UpdateScheduleInput,
} from './schedules.js';

export interface StartAdminServerOptions {
    /** 启动前钩子：通常用于 registerSpiders */
    beforeListen?: () => void | Promise<void>;
    host?: string;
    port?: number;
    /** 是否启动定时调度器，默认 true */
    enableScheduler?: boolean;
}

type AppVariables = {
    authSub: string;
};

/** 创建管理 API 应用（不含 listen，便于测试或挂到其它服务器） */
export function createAdminApp(): Hono<{ Variables: AppVariables }> {
    const app = new Hono<{ Variables: AppVariables }>();

    app.use('/api/*', cors({ origin: '*' }));
    app.use(
        '/api/*',
        createAuthMiddleware(['/api/health', '/api/auth/login', '/api/auth/status']),
    );

    app.get('/api/health', (c) => c.json({ ok: true }));

    app.get('/api/auth/status', (c) => {
        return c.json({
            authRequired: isAuthEnabled(),
        });
    });

    app.post('/api/auth/login', async (c) => {
        try {
            const body = await c.req.json<{ password?: string }>();
            const result = await loginWithPassword(body.password ?? '');
            return c.json(result);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const status = message.includes('密码错误') ? 401 : 400;
            return c.json({ error: message }, status);
        }
    });

    app.get('/api/auth/me', (c) => {
        return c.json({
            sub: c.get('authSub') ?? 'admin',
            authRequired: isAuthEnabled(),
        });
    });

    app.get('/api/stats/overview', async (c) => {
        const overview = await getPlatformOverview();
        return c.json(overview);
    });

    app.get('/api/spiders', async (c) => {
        const defaultApp = await getDefaultAppProfile();
        const items = await Promise.all(
            listSpiderDefinitions().map(async (s) => {
                const def = await getDefaultSpiderProfile(s.name);
                return {
                    ...s,
                    defaultSpiderProfileId: def?.id ?? null,
                };
            }),
        );
        return c.json({
            items,
            defaultAppProfileId: defaultApp?.id ?? null,
        });
    });

    app.get('/api/runs', async (c) => {
        const limit = Number(c.req.query('limit') ?? 50);
        const scheduleIdRaw = c.req.query('scheduleId');
        const scheduleId = scheduleIdRaw != null && scheduleIdRaw !== '' ? Number(scheduleIdRaw) : undefined;
        if (scheduleId !== undefined && !Number.isFinite(scheduleId)) {
            return c.json({ error: '无效 scheduleId' }, 400);
        }
        const items = await listRuns({ limit, scheduleId });
        return c.json({ items });
    });

    app.get('/api/runs/:id', async (c) => {
        const id = Number(c.req.param('id'));
        if (!Number.isFinite(id)) {
            return c.json({ error: '无效 id' }, 400);
        }
        const run = await getRun(id);
        if (!run) {
            return c.json({ error: '任务不存在' }, 404);
        }
        return c.json(run);
    });

    app.get('/api/runs/:id/frontier', async (c) => {
        const id = Number(c.req.param('id'));
        if (!Number.isFinite(id)) {
            return c.json({ error: '无效 id' }, 400);
        }
        const run = await getRun(id);
        if (!run) {
            return c.json({ error: '任务不存在' }, 404);
        }
        if (run.frontierType !== 'redis') {
            return c.json({
                runId: id,
                frontierType: run.frontierType,
                depth: null,
                inflight: null,
                cancelled: run.cancelRequested,
            });
        }
        try {
            const frontier = createFrontier('redis');
            const [depth, inflight, cancelled] = await Promise.all([
                frontier.depth(String(id)),
                frontier.inflight(String(id)),
                frontier.isCancelled(String(id)),
            ]);
            let stats = null;
            try {
                stats = await readAggregatedJobStats(id);
            } catch {
                /* ignore */
            }
            return c.json({
                runId: id,
                frontierType: 'redis',
                depth,
                inflight,
                cancelled,
                stats,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 500);
        }
    });

    app.post('/api/runs', async (c) => {
        try {
            const body = await c.req.json<{
                spider?: string;
                params?: SpiderRunParams;
                options?: CrawlRunOptions;
                appProfileId?: number | null;
                spiderProfileId?: number | null;
                frontier?: 'memory' | 'redis';
            }>();
            if (!body.spider) {
                return c.json({ error: 'spider 必填' }, 400);
            }
            const run = await createRun({
                spider: body.spider,
                params: body.params ?? {},
                options: body.options,
                appProfileId: body.appProfileId,
                spiderProfileId: body.spiderProfileId,
                frontier: body.frontier,
                triggerType: 'manual',
            });
            return c.json(run, 201);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    app.post('/api/runs/:id/stop', async (c) => {
        try {
            const id = Number(c.req.param('id'));
            if (!Number.isFinite(id)) {
                return c.json({ error: '无效 id' }, 400);
            }
            const run = await stopRun(id);
            return c.json(run);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    app.get('/api/runs/:id/logs', async (c) => {
        const id = Number(c.req.param('id'));
        if (!Number.isFinite(id)) {
            return c.json({ error: '无效 id' }, 400);
        }
        const run = await getRun(id);
        if (!run) {
            return c.json({ error: '任务不存在' }, 404);
        }
        const limit = Number(c.req.query('limit') ?? 200);
        const items = await listRunLogs(id, limit);
        return c.json({ items });
    });

    app.get('/api/logs', async (c) => {
        const limit = Number(c.req.query('limit') ?? 100);
        const beforeIdRaw = c.req.query('beforeId');
        const runIdRaw = c.req.query('runId');
        const beforeId = beforeIdRaw != null && beforeIdRaw !== '' ? Number(beforeIdRaw) : undefined;
        const runId = runIdRaw != null && runIdRaw !== '' ? Number(runIdRaw) : undefined;
        if (beforeId !== undefined && !Number.isFinite(beforeId)) {
            return c.json({ error: '无效 beforeId' }, 400);
        }
        if (runId !== undefined && !Number.isFinite(runId)) {
            return c.json({ error: '无效 runId' }, 400);
        }
        const items = await listLogs({
            limit,
            beforeId,
            spider: c.req.query('spider') || undefined,
            level: c.req.query('level') || undefined,
            event: c.req.query('event') || undefined,
            runId,
        });
        return c.json({ items });
    });

    // ── App / Spider Profiles ──

    app.get('/api/app-profiles', async (c) => {
        const items = await listAppProfiles();
        return c.json({ items });
    });

    app.post('/api/app-profiles', async (c) => {
        try {
            const body = await c.req.json<CreateAppProfileInput>();
            const profile = await createAppProfile(body);
            return c.json(profile, 201);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    app.get('/api/app-profiles/:id', async (c) => {
        const id = Number(c.req.param('id'));
        if (!Number.isFinite(id)) {
            return c.json({ error: '无效 id' }, 400);
        }
        const profile = await getAppProfile(id);
        if (!profile) {
            return c.json({ error: 'App Profile 不存在' }, 404);
        }
        return c.json(profile);
    });

    app.patch('/api/app-profiles/:id', async (c) => {
        try {
            const id = Number(c.req.param('id'));
            if (!Number.isFinite(id)) {
                return c.json({ error: '无效 id' }, 400);
            }
            const body = await c.req.json<UpdateAppProfileInput>();
            const profile = await updateAppProfile(id, body);
            return c.json(profile);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    app.delete('/api/app-profiles/:id', async (c) => {
        try {
            const id = Number(c.req.param('id'));
            if (!Number.isFinite(id)) {
                return c.json({ error: '无效 id' }, 400);
            }
            await deleteAppProfile(id);
            return c.json({ ok: true });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    app.post('/api/app-profiles/:id/set-default', async (c) => {
        try {
            const id = Number(c.req.param('id'));
            if (!Number.isFinite(id)) {
                return c.json({ error: '无效 id' }, 400);
            }
            const profile = await setDefaultAppProfile(id);
            return c.json(profile);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    app.get('/api/spider-profiles', async (c) => {
        const spider = c.req.query('spider') || undefined;
        const items = await listSpiderProfiles(spider);
        return c.json({ items });
    });

    app.post('/api/spider-profiles', async (c) => {
        try {
            const body = await c.req.json<CreateSpiderProfileInput>();
            const profile = await createSpiderProfile(body);
            return c.json(profile, 201);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    app.get('/api/spider-profiles/:id', async (c) => {
        const id = Number(c.req.param('id'));
        if (!Number.isFinite(id)) {
            return c.json({ error: '无效 id' }, 400);
        }
        const profile = await getSpiderProfile(id);
        if (!profile) {
            return c.json({ error: 'Spider Profile 不存在' }, 404);
        }
        return c.json(profile);
    });

    app.patch('/api/spider-profiles/:id', async (c) => {
        try {
            const id = Number(c.req.param('id'));
            if (!Number.isFinite(id)) {
                return c.json({ error: '无效 id' }, 400);
            }
            const body = await c.req.json<UpdateSpiderProfileInput>();
            const profile = await updateSpiderProfile(id, body);
            return c.json(profile);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    app.delete('/api/spider-profiles/:id', async (c) => {
        try {
            const id = Number(c.req.param('id'));
            if (!Number.isFinite(id)) {
                return c.json({ error: '无效 id' }, 400);
            }
            await deleteSpiderProfile(id);
            return c.json({ ok: true });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    app.post('/api/spider-profiles/:id/set-default', async (c) => {
        try {
            const id = Number(c.req.param('id'));
            if (!Number.isFinite(id)) {
                return c.json({ error: '无效 id' }, 400);
            }
            const profile = await setDefaultSpiderProfile(id);
            return c.json(profile);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    // ── Schedules ──

    app.get('/api/schedules', async (c) => {
        const items = await listSchedules();
        return c.json({ items });
    });

    app.post('/api/schedules', async (c) => {
        try {
            const body = await c.req.json<Partial<CreateScheduleInput>>();
            if (!body.name || !body.spider || !body.cron) {
                return c.json({ error: 'name / spider / cron 必填' }, 400);
            }
            const schedule = await createSchedule({
                name: body.name,
                spider: body.spider,
                params: body.params ?? {},
                cron: body.cron,
                timezone: body.timezone,
                enabled: body.enabled,
                overlapPolicy: body.overlapPolicy as OverlapPolicy | undefined,
                options: body.options,
                appProfileId: body.appProfileId,
                spiderProfileId: body.spiderProfileId,
            });
            return c.json(schedule, 201);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    app.get('/api/schedules/:id', async (c) => {
        const id = Number(c.req.param('id'));
        if (!Number.isFinite(id)) {
            return c.json({ error: '无效 id' }, 400);
        }
        const detail = await getScheduleDetail(id);
        if (!detail) {
            return c.json({ error: '计划不存在' }, 404);
        }
        return c.json(detail);
    });

    app.patch('/api/schedules/:id', async (c) => {
        try {
            const id = Number(c.req.param('id'));
            if (!Number.isFinite(id)) {
                return c.json({ error: '无效 id' }, 400);
            }
            const body = await c.req.json<UpdateScheduleInput>();
            const schedule = await updateSchedule(id, body);
            return c.json(schedule);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    app.delete('/api/schedules/:id', async (c) => {
        try {
            const id = Number(c.req.param('id'));
            if (!Number.isFinite(id)) {
                return c.json({ error: '无效 id' }, 400);
            }
            await deleteSchedule(id);
            return c.json({ ok: true });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    app.post('/api/schedules/:id/enable', async (c) => {
        try {
            const id = Number(c.req.param('id'));
            if (!Number.isFinite(id)) {
                return c.json({ error: '无效 id' }, 400);
            }
            const schedule = await setScheduleEnabled(id, true);
            return c.json(schedule);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    app.post('/api/schedules/:id/disable', async (c) => {
        try {
            const id = Number(c.req.param('id'));
            if (!Number.isFinite(id)) {
                return c.json({ error: '无效 id' }, 400);
            }
            const schedule = await setScheduleEnabled(id, false);
            return c.json(schedule);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    app.post('/api/schedules/:id/trigger', async (c) => {
        try {
            const id = Number(c.req.param('id'));
            if (!Number.isFinite(id)) {
                return c.json({ error: '无效 id' }, 400);
            }
            const run = await triggerSchedule(id);
            return c.json(run, 201);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return c.json({ error: message }, 400);
        }
    });

    return app;
}

/** 建表、执行 beforeListen、开始监听 */
export async function startAdminServer(options: StartAdminServerOptions = {}): Promise<void> {
    if (options.beforeListen) {
        await options.beforeListen();
    }
    await ensureAdminTables();
    await ensureScheduleTables();
    await ensureProfileTables();
    await seedDefaultAppProfile();
    const app = createAdminApp();
    const hostname = options.host ?? getAdminEnv().admin.host;
    const port = options.port ?? getAdminEnv().admin.port;
    console.log(`[admin] listening http://${hostname}:${port}`);
    if (isAuthEnabled()) {
        console.log('[admin] auth enabled (ADMIN_PASSWORD set); API requires Bearer token');
    } else {
        console.warn('[admin] auth DISABLED — set ADMIN_PASSWORD in .env to enable password gate');
    }
    serve({ fetch: app.fetch, hostname, port });

    if (options.enableScheduler !== false) {
        startScheduler();
    }
    startJobSupervisor();
}

export async function shutdownAdmin(): Promise<void> {
    stopScheduler();
    stopJobSupervisor();
    await quitSharedRedis().catch(() => undefined);
    await closePool();
}
