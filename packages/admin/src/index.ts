/**
 * Crawlnd Admin 插件（与核心单向依赖：admin → core / utils）。
 * 站点通过 registerSpider(s) 注入；不要在本目录 import 具体站点。
 * 启动前须 configureAdmin({ env, getPool, closePool }).
 */
export {
    configureAdmin,
    getAdminRuntime,
    getAdminEnv,
    getPool,
    closePool,
} from './runtime.js';
export type {
    AdminRuntime,
    AdminEnv,
    AdminMysqlConfig,
    AdminRedisConfig,
    AdminHttpConfig,
    AdminCrawlConfig,
    AdminWorkerConfig,
} from './runtime.js';
export {
    registerSpider,
    registerSpiders,
    clearSpiderRegistry,
    listSpiderDefinitions,
    getSpiderDefinition,
    createSpiderFromRegistry,
    commonPageSeedProperties,
    UI_WIDGET,
    withUi,
    stringLinesField,
    objectTableField,
    customFormSchema,
} from './registry.js';
export type {
    ParamSchema,
    ParamFieldSchema,
    ParamFieldUiExt,
    UiWidget,
    SpiderRunParams,
    SpiderCreateContext,
    SpiderDefinition,
    SpiderDefinitionPublic,
} from './registry.js';

export {
    createRun,
    getRun,
    listRuns,
    stopRun,
    listRunLogs,
    listLogs,
    hasActiveRunForSchedule,
    ensureAdminTables,
    listRunningRedisRuns,
    executeWorkerFetchLoop,
    finishRunFromSupervisor,
} from './runs.js';
export type {
    CrawlRun,
    CrawlRunStats,
    CrawlRunOptions,
    RunStatus,
    RunTriggerType,
    CreateRunInput,
    ListRunsOptions,
    ListLogsOptions,
    FrontierType,
} from './runs.js';

export { createFrontier, resolveFrontierType, getSharedRedis, quitSharedRedis } from './frontier-factory.js';
export { startJobSupervisor, stopJobSupervisor } from './job-supervisor.js';

export { normalizeCrawlOptions, normalizeAppConfig, normalizeSpiderConfig, resolveConcurrentRequests, envAppConfigDefaults, mergeAppConfig } from './crawl-options.js';
export type { CrawlAppConfig, CrawlSpiderConfig } from './crawl-options.js';

export {
    ensureProfileTables,
    seedDefaultAppProfile,
    listAppProfiles,
    getAppProfile,
    createAppProfile,
    updateAppProfile,
    deleteAppProfile,
    setDefaultAppProfile,
    listSpiderProfiles,
    getSpiderProfile,
    createSpiderProfile,
    updateSpiderProfile,
    deleteSpiderProfile,
    setDefaultSpiderProfile,
    resolveRunProfiles,
} from './profiles.js';
export type {
    AppProfile,
    SpiderProfile,
    CreateAppProfileInput,
    UpdateAppProfileInput,
    CreateSpiderProfileInput,
    UpdateSpiderProfileInput,
    ResolvedRunProfiles,
} from './profiles.js';

export {
    createSchedule,
    getSchedule,
    listSchedules,
    updateSchedule,
    deleteSchedule,
    setScheduleEnabled,
    triggerSchedule,
    getScheduleDetail,
    ensureScheduleTables,
    computeNextRunAt,
} from './schedules.js';
export type {
    CrawlSchedule,
    CreateScheduleInput,
    UpdateScheduleInput,
    OverlapPolicy,
} from './schedules.js';

export { startScheduler, stopScheduler } from './scheduler.js';

export { getPlatformOverview } from './stats.js';
export type { PlatformOverview } from './stats.js';

export {
    loginWithPassword,
    verifyAccessToken,
    isAuthEnabled,
    createAuthMiddleware,
} from './auth.js';
export type { LoginResult } from './auth.js';

export { createAdminApp, startAdminServer, shutdownAdmin } from './server.js';
export type { StartAdminServerOptions } from './server.js';
