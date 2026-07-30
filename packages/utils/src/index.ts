/**
 * @crawlnd/utils 对外导出
 */
export {
    createPageSeeds,
    resolvePageNumbers,
    parsePageSeedOptions,
} from './page-seeds.js';
export type { PageSeedOptions } from './page-seeds.js';

export {
    attachSpiderLogger,
    getAttachedCrawlStats,
    defaultGetPage,
    formatSeedSummary,
} from './spider-logger.js';
export type {
    CrawlStats,
    LogLevel,
    LogLocale,
    PageLogInfo,
    LogPersistOptions,
    SpiderLogEventKey,
    SpiderLoggerOptions,
    SpiderLogger,
} from './spider-logger.js';

export {
    createPersistSinks,
} from './log-persist.js';
export type {
    LogRecord,
    LogSink,
    FileLogSinkOptions,
    MysqlLogSinkOptions,
} from './log-persist.js';

export { createRedisItemDeduper } from './redis-item-deduper.js';
export type {
    RedisItemDeduper,
    RedisItemDeduperOptions,
} from './redis-item-deduper.js';

export {
    createRedisJobStatsRemote,
    createAutoRedisJobStatsRemote,
    getRedisJobStats,
    readAggregatedJobStats,
    clearRedisJobStats,
    clearAggregatedJobStats,
    configureJobStatsRedis,
} from './redis-job-stats.js';
export type { JobStatsDelta, JobStatsRemote } from './redis-job-stats.js';
