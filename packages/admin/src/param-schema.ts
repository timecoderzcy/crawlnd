/**
 * Spider `paramSchema` 约定：JSON Schema 子集 + `x-ui-*` 扩展。
 * 前端须按 schema 动态渲染，禁止写死「每个站都有 pagination」。
 */

/** 前端已约定的控件名（可扩展；未知 widget 回退到 type 默认映射） */
export const UI_WIDGET = {
    text: 'text',
    textarea: 'textarea',
    /** 多行文本，按行拆成 string[] */
    textareaLines: 'textarea-lines',
    number: 'number',
    select: 'select',
    radio: 'radio',
    switch: 'switch',
    password: 'password',
    /** JSON 编辑器，值仍是 object/array */
    jsonEditor: 'json-editor',
    /** 字符串键值对编辑 */
    keyValue: 'key-value',
    /** 对象数组可编辑表格，列来自 items.properties */
    editableTable: 'editable-table',
    /** 上传文件，解析结果写入该字段（CSV/JSON 由前端约定） */
    fileToJson: 'file-to-json',
    /**
     * 分页模式专用：绑定 object，内部按 mode 显示 pageNO 或 from/to。
     * 仅当字段结构符合 commonPageSeedProperties.pagination 时使用。
     */
    paginationMode: 'pagination-mode',
} as const;

export type UiWidget = (typeof UI_WIDGET)[keyof typeof UI_WIDGET];

/** 单字段上的 UI 扩展（写入 JSON Schema 属性对象） */
export interface ParamFieldUiExt {
    /** 指定控件；缺省则按 type/enum/format 推断 */
    'x-ui-widget'?: UiWidget | string;
    /** 表单内排序，越小越靠前 */
    'x-ui-order'?: number;
    /** 为 true 时不渲染（仍可出现在默认值/提交体） */
    'x-ui-hidden'?: boolean;
    /** 占位提示 */
    'x-ui-placeholder'?: string;
    /** 控件额外 props，原样传给前端组件 */
    'x-ui-props'?: Record<string, unknown>;
}

export type ParamFieldSchema = Record<string, unknown> & ParamFieldUiExt;

/** 前端可直接用来渲染表单的 JSON Schema 子集 */
export interface ParamSchema {
    type: 'object';
    required?: string[];
    properties: Record<string, ParamFieldSchema>;
    /**
     * 整表级自定义表单：前端按此加载专用组件，不再用通用 SchemaForm。
     * 例：`custom:batch-login`、`BatchLoginForm`
     */
    'x-ui-form'?: string;
    /** 表单顶部说明 */
    'x-ui-description'?: string;
}

/** 给属性对象打上 UI 扩展（浅合并） */
export function withUi(
    field: Record<string, unknown>,
    ui: ParamFieldUiExt,
): ParamFieldSchema {
    return { ...field, ...ui };
}

/** 多行 URL / 文本列表（提交为 string[]） */
export function stringLinesField(options: {
    title: string;
    description?: string;
    minItems?: number;
    order?: number;
}): ParamFieldSchema {
    return withUi(
        {
            type: 'array',
            title: options.title,
            description: options.description ?? '每行一条；前端用 textarea-lines 编辑',
            items: { type: 'string', minLength: 1 },
            ...(options.minItems !== undefined ? { minItems: options.minItems } : {}),
        },
        {
            'x-ui-widget': UI_WIDGET.textareaLines,
            ...(options.order !== undefined ? { 'x-ui-order': options.order } : {}),
        },
    );
}

/** 对象数组表格 */
export function objectTableField(options: {
    title: string;
    description?: string;
    itemProperties: Record<string, ParamFieldSchema>;
    itemRequired?: string[];
    order?: number;
}): ParamFieldSchema {
    return withUi(
        {
            type: 'array',
            title: options.title,
            description: options.description,
            items: {
                type: 'object',
                required: options.itemRequired,
                properties: options.itemProperties,
            },
        },
        {
            'x-ui-widget': UI_WIDGET.editableTable,
            ...(options.order !== undefined ? { 'x-ui-order': options.order } : {}),
        },
    );
}

/** 整表使用自定义组件时的 schema 外壳 */
export function customFormSchema(formId: string, properties: ParamSchema['properties'] = {}, required?: string[]): ParamSchema {
    return {
        type: 'object',
        required,
        properties,
        'x-ui-form': formId,
    };
}
