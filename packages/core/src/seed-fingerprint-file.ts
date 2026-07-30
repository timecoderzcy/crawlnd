import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 与指纹去重存储对接的最小回调形态 */
export interface FingerprintStoreHandlers {
    isDone: (fingerprintHash: string) => boolean | Promise<boolean>;
    markDone: (fingerprintHash: string) => void | Promise<void>;
}

/**
 * 将指纹（SHA-256 hex）持久化到本地 JSON 文件：`string[]`
 */
export class SeedFingerprintFileStore {
    private readonly filePath: string;
    private readonly hashes = new Set<string>();
    private loaded = false;
    private persistChain = Promise.resolve();
    private bound: FingerprintStoreHandlers | undefined;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    /** 从磁盘重新加载（每次 Spider 开跑前调用） */
    async reloadFromDisk(): Promise<void> {
        this.loaded = false;
        await this.ensureLoaded();
    }

    private async ensureLoaded(): Promise<void> {
        if (this.loaded) {
            return;
        }
        this.hashes.clear();
        try {
            const raw = await readFile(this.filePath, 'utf8');
            const trimmed = raw.trim();
            if (trimmed === '') {
                this.loaded = true;
                return;
            }
            const parsed = JSON.parse(trimmed) as unknown;
            if (!Array.isArray(parsed)) {
                throw new Error('指纹去重状态文件格式须为 JSON 数组');
            }
            for (const item of parsed) {
                if (typeof item === 'string' && item.length > 0) {
                    this.hashes.add(item);
                }
            }
        } catch (e: unknown) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                /* 首跑尚无文件 */
            } else {
                throw e;
            }
        }
        this.loaded = true;
    }

    asHandlers(): FingerprintStoreHandlers {
        if (this.bound === undefined) {
            this.bound = {
                isDone: (h) => this.isDoneImpl(h),
                markDone: (h) => this.markDoneImpl(h),
            };
        }
        return this.bound;
    }

    private async isDoneImpl(h: string): Promise<boolean> {
        await this.ensureLoaded();
        return this.hashes.has(h);
    }

    private async markDoneImpl(h: string): Promise<void> {
        await this.ensureLoaded();
        if (this.hashes.has(h)) {
            return;
        }
        this.hashes.add(h);
        this.persistChain = this.persistChain.then(() => this.flushToDisk());
        await this.persistChain;
    }

    private async flushToDisk(): Promise<void> {
        const dir = dirname(this.filePath);
        await mkdir(dir, { recursive: true });
        const list = [...this.hashes].sort();
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
        await rename(tmp, this.filePath);
    }
}
