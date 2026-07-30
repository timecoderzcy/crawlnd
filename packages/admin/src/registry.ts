import type { Spider } from 'crawlnd';
import { UI_WIDGET, type ParamSchema } from './param-schema.js';
import type { CrawlSpiderConfig } from './crawl-options.js';

export type { ParamSchema, ParamFieldSchema, ParamFieldUiExt, UiWidget } from './param-schema.js';
export {
    UI_WIDGET,
    withUi,
    stringLinesField,
    objectTableField,
    customFormSchema,
} from './param-schema.js';

/** 任务参数：由各 Spider 自己解释，管理插件不绑定具体字段 */
export type SpiderRunParams = Record<string, unknown>;

/** 创建 Spider 时的运行时上下文（不进 params / 不进表单） */
export interface SpiderCreateContext {
    /** 管理台任务 ID；站点 logger 落库时写入 crawl_logs.run_id */
    runId?: number;
    /** Spider Profile 快照 */
    spiderConfig?: CrawlSpiderConfig;
    /** 本 Run frontier；redis 时 logger 启用远程 stats */
    frontierType?: 'memory' | 'redis';
}

export interface SpiderDefinition {
    name: string;
    label: string;
    description: string;
    /**
     * 任务参数 schema（JSON Schema 子集 + x-ui-*）。
     * 前端必须按此动态渲染；不要假设所有 Spider 都有 pagination。
     */
    paramSchema: ParamSchema;
    /**
     * 可选：与 paramSchema['x-ui-form'] 同义的快捷字段。
     * 列表 API 会合并进公开的 paramSchema['x-ui-form']。
     */
    uiForm?: string;
    create: (params: SpiderRunParams, ctx?: SpiderCreateContext) => Spider;
}

export type SpiderDefinitionPublic = Omit<SpiderDefinition, 'create' | 'uiForm'> & {
    paramSchema: ParamSchema;
};

const byName = new Map<string, SpiderDefinition>();

/**
 * 向管理插件注册一个 Spider（站点侧 / 装配入口调用）。
 * 同名重复注册会覆盖。
 */
export function registerSpider(def: SpiderDefinition): void {
    const name = def.name.trim();
    if (!name) {
        throw new Error('SpiderDefinition.name 不能为空');
    }
    byName.set(name, { ...def, name });
}

/** 批量注册 */
export function registerSpiders(defs: readonly SpiderDefinition[]): void {
    for (const def of defs) {
        registerSpider(def);
    }
}

/** 清空注册表（测试用） */
export function clearSpiderRegistry(): void {
    byName.clear();
}

function toPublic(def: SpiderDefinition): SpiderDefinitionPublic {
    const { create: _c, uiForm, paramSchema, ...rest } = def;
    const schema: ParamSchema = {
        ...paramSchema,
        properties: { ...paramSchema.properties },
    };
    if (uiForm && !schema['x-ui-form']) {
        schema['x-ui-form'] = uiForm;
    }
    return { ...rest, paramSchema: schema };
}

export function listSpiderDefinitions(): SpiderDefinitionPublic[] {
    return [...byName.values()].map(toPublic);
}

export function getSpiderDefinition(name: string): SpiderDefinition | undefined {
    return byName.get(name);
}

export function createSpiderFromRegistry(
    name: string,
    params: SpiderRunParams,
    ctx?: SpiderCreateContext,
): Spider {
    const def = byName.get(name);
    if (!def) {
        throw new Error(`未知 Spider：${name}。请先 registerSpider / registerSpiders。`);
    }
    return def.create(params, ctx);
}

/** 常用 keyword + 分页模式表单 schema（仅分页类站点复用；非分页站勿引用） */
export const commonPageSeedProperties: ParamSchema['properties'] = {
    keyword: {
        type: 'string',
        title: '关键词',
        minLength: 1,
        'x-ui-widget': UI_WIDGET.text,
        'x-ui-order': 10,
    },
    pageSize: {
        type: 'integer',
        title: '每页条数',
        default: 20,
        minimum: 1,
        'x-ui-widget': UI_WIDGET.number,
        'x-ui-order': 20,
    },
    pagination: {
        type: 'object',
        title: '分页',
        description: '按 mode 选择 single / range；前 N 页用 range 且 from=1',
        required: ['mode'],
        'x-ui-widget': UI_WIDGET.paginationMode,
        'x-ui-order': 30,
        properties: {
            mode: {
                type: 'string',
                title: '分页模式',
                enum: ['single', 'range'],
                description: 'single=单页；range=从from到to（前N页：from=1, to=N）',
                'x-ui-widget': UI_WIDGET.radio,
            },
            pageNO: { type: 'integer', title: '页码（single）', minimum: 1, 'x-ui-widget': UI_WIDGET.number },
            from: { type: 'integer', title: '起始页（range）', minimum: 1, 'x-ui-widget': UI_WIDGET.number },
            to: { type: 'integer', title: '结束页（range）', minimum: 1, 'x-ui-widget': UI_WIDGET.number },
            pageSize: { type: 'integer', title: '每页条数（可覆盖外层）', minimum: 1, 'x-ui-widget': UI_WIDGET.number },
        },
        oneOf: [
            {
                title: '单页',
                required: ['mode', 'pageNO'],
                properties: {
                    mode: { const: 'single' },
                    pageNO: { type: 'integer', minimum: 1 },
                    pageSize: { type: 'integer', minimum: 1 },
                },
            },
            {
                title: '页码区间',
                required: ['mode', 'from', 'to'],
                properties: {
                    mode: { const: 'range' },
                    from: { type: 'integer', minimum: 1 },
                    to: { type: 'integer', minimum: 1 },
                    pageSize: { type: 'integer', minimum: 1 },
                },
            },
        ],
    },
};
