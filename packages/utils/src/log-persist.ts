import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Pool } from 'mysql2/promise';

export interface LogRecord {
    ts: string;
    spider: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    /** 内置事件名；自定义 info/debug 等可为 null */
    event: string | null;
    message: string;
    fields?: Record<string, unknown>;
    /** 管理台任务 ID，便于按 run 过滤日志 */
    runId?: number | null;
}

export interface LogSink {
    write(record: LogRecord): Promise<void>;
    close(): Promise<void>;
}

export interface FileLogSinkOptions {
    path: string;
    /** 目前仅支持 jsonl */
    format?: 'jsonl';
}

export interface MysqlLogSinkOptions {
    pool: Pool;
    /** 默认 crawl_logs */
    table?: string;
}

/**
 * 本地 JSONL 追加写入；串行队列保证并发 logger 时行序稳定。
 */
export function createFileLogSink(options: FileLogSinkOptions): LogSink {
    const filePath = resolve(options.path);
    let chain: Promise<void> = Promise.resolve();
    let dirReady: Promise<void> | undefined;

    const ensureDir = (): Promise<void> => {
        if (!dirReady) {
            dirReady = mkdir(dirname(filePath), { recursive: true }).then(() => undefined);
        }
        return dirReady;
    };

    return {
        write(record) {
            chain = chain.then(async () => {
                await ensureDir();
                await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
            });
            return chain;
        },
        async close() {
            await chain;
        },
    };
}

/**
 * MySQL 落库；不负责 pool.end（由站点 onClose 管理）。
 */
export function createMysqlLogSink(options: MysqlLogSinkOptions): LogSink {
    const table = options.table ?? 'crawl_logs';
    // 仅允许简单标识符，防止表名注入
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
        throw new Error(`非法日志表名：${table}`);
    }

    let chain: Promise<void> = Promise.resolve();

    return {
        write(record) {
            chain = chain.then(async () => {
                await options.pool.query(
                    `INSERT INTO \`${table}\` (ts, spider, level, event, message, fields, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        new Date(record.ts),
                        record.spider,
                        record.level,
                        record.event,
                        record.message.slice(0, 255),
                        record.fields ? JSON.stringify(record.fields) : null,
                        record.runId ?? null,
                    ],
                );
            });
            return chain;
        },
        async close() {
            await chain;
        },
    };
}

export function createPersistSinks(options: {
    file?: FileLogSinkOptions;
    database?: MysqlLogSinkOptions;
}): LogSink[] {
    const sinks: LogSink[] = [];
    if (options.file) {
        sinks.push(createFileLogSink(options.file));
    }
    if (options.database) {
        sinks.push(createMysqlLogSink(options.database));
    }
    return sinks;
}
