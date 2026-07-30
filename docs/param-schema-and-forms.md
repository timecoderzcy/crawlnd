# 任务参数表单约定（前端必读）

> 目标：新建 Run / Schedule 时，**不同 Spider 可以有完全不同的表单**（分页抓取、批量填表、批量登录、下载 URL 列表等），而不是写死「关键词 + 分页」。  
> 后端契约入口：`GET /api/spiders` → 每项的 `paramSchema`。  
> 相关类型与工具：`src/admin/param-schema.ts`、`commonPageSeedProperties`（**仅分页类站点**复用）。

---

## 1. 硬性要求（前端必须遵守）

1. **禁止**假设每个 Spider 都有 `keyword` / `pagination` / `pageSize`。  
2. 新建任务页只能根据**当前选中 Spider** 的 `paramSchema` 渲染；换 Spider 必须换表单。  
3. `params` 提交体必须是 schema 描述的结构；不要把 App/Spider Profile、并发等塞进 `params`（那些走 `appProfileId` / `options`）。  
4. 若 `paramSchema['x-ui-form']` 有值：加载对应**自定义表单组件**，不要再走通用字段映射（自定义组件内部仍应产出符合 properties 的 `params`）。  
5. 未识别的 `x-ui-widget`：按下方「type 默认映射」回退，并 `console.warn`，不要整页白屏。

---

## 2. `paramSchema` 形状

```ts
interface ParamSchema {
  type: 'object'
  required?: string[]
  properties: Record<string, ParamFieldSchema>
  /** 整表自定义表单 id，优先于通用 SchemaForm */
  'x-ui-form'?: string
  'x-ui-description'?: string
}

interface ParamFieldSchema {
  type?: string
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  const?: unknown
  minimum?: number
  maximum?: number
  minLength?: number
  items?: ParamFieldSchema | { type: string; properties?: ... }
  properties?: Record<string, ParamFieldSchema>
  required?: string[]
  oneOf?: unknown[]
  format?: string          // 如 uri、email
  // —— UI 扩展 ——
  'x-ui-widget'?: string
  'x-ui-order'?: number    // 越小越靠前
  'x-ui-hidden'?: boolean
  'x-ui-placeholder'?: string
  'x-ui-props'?: Record<string, unknown>
}
```

渲染顺序：按 `x-ui-order` 升序；无 order 的字段排在后面（可再按 key 字母序）。

---

## 3. 约定控件（`x-ui-widget`）

| widget | 适用 | 前端建议 | 提交值 |
|--------|------|----------|--------|
| `text` | string | `a-input` | string |
| `textarea` | 长文本 string | `a-textarea` | string |
| `textarea-lines` | `type: array` + `items: string` | 多行文本，**按行 split** 成数组 | `string[]` |
| `number` | integer/number | `a-input-number` | number |
| `select` | 有 `enum` | `a-select` | enum 项 |
| `radio` | 短 enum | `a-radio-group` | enum 项 |
| `switch` | boolean | `a-switch` | boolean |
| `password` | 敏感 string | `a-input-password` | string（注意勿打日志） |
| `json-editor` | object/array | JSON 编辑器 | object/array |
| `key-value` | `Record<string,string>` | 键值编辑器 | object |
| `editable-table` | `type: array` + `items.type=object` | 可增删行表格，列=items.properties | object[] |
| `file-to-json` | 任意 | 上传文件，解析后写入该字段 | 解析结果 |
| `pagination-mode` | 分页 object（见下） | 专用分页控件 | `{ mode, pageNO? , from?, to? }` |

### type 默认映射（无 `x-ui-widget` 时）

| schema | 默认控件 |
|--------|----------|
| `string` + `enum` | `select` |
| `string` + `format: uri` 且无 widget | `textarea`（单条也可用 text） |
| `string` | `text` |
| `integer` / `number` | `number` |
| `boolean` | `switch` |
| `array` + items string | `textarea-lines` |
| `array` + items object | `editable-table` |
| `object` + 明确的 pagination 结构且带 `x-ui-widget: pagination-mode` | 用分页控件 |
| 其它 `object` | `json-editor` 或递归嵌套 `a-form` |

---

## 4. 分页专用控件（仅当 schema 声明时）

仅当字段带 `'x-ui-widget': 'pagination-mode'`（后端 `commonPageSeedProperties.pagination` 已标注）时使用。

行为：

- 绑定值为 object  
- UI：`mode` = `single` | `range`（radio）  
- `single` → 显示 `pageNO`  
- `range` → 显示 `from` / `to`（前 N 页：`from=1, to=N`）  
- **不要**对没有该 widget 的 Spider 显示分页区  

---

## 5. 自定义整表（`x-ui-form`）

当交互远超通用控件（分步登录、验证码、选下载目录等）：

1. 后端在 `paramSchema` 上设 `'x-ui-form': 'custom:batch-login'`（或注册时 `uiForm`）  
2. 前端维护映射表：

```ts
const customForms: Record<string, Component> = {
  'custom:batch-login': BatchLoginForm,
  // ...
}
```

3. 有 `x-ui-form` 且能解析到组件 → 渲染该组件，`v-model` / `emit` 出完整 `params`  
4. 解析不到 → 降级通用 SchemaForm + 提示「未实现自定义表单 xxx」

自定义表单仍应尊重 `required` / 字段含义，提交给 `POST /api/runs` 的仍是 `{ spider, params, ... }`。

---

## 6. 任务类型与 schema 示例（给后端注册 / 前端联调）

### 6.1 分页搜索（现有分页站）

使用后端 `commonPageSeedProperties` 即可，含 `pagination-mode`。

### 6.2 批量 URL 下载

```json
{
  "type": "object",
  "required": ["urls"],
  "properties": {
    "urls": {
      "type": "array",
      "title": "资源地址",
      "items": { "type": "string", "minLength": 1 },
      "minItems": 1,
      "x-ui-widget": "textarea-lines",
      "x-ui-order": 10,
      "x-ui-placeholder": "每行一个 URL"
    },
    "saveDir": {
      "type": "string",
      "title": "保存目录（可选）",
      "x-ui-widget": "text",
      "x-ui-order": 20
    }
  }
}
```

### 6.3 批量账号（登录类）

```json
{
  "type": "object",
  "required": ["accounts"],
  "properties": {
    "accounts": {
      "type": "array",
      "title": "账号列表",
      "x-ui-widget": "editable-table",
      "x-ui-order": 10,
      "items": {
        "type": "object",
        "required": ["username", "password"],
        "properties": {
          "username": { "type": "string", "title": "用户名", "x-ui-widget": "text" },
          "password": { "type": "string", "title": "密码", "x-ui-widget": "password" }
        }
      }
    }
  }
}
```

也可用 `'x-ui-form': 'custom:batch-login'` 做更强交互。

### 6.4 批量填表（任意字段行）

```json
{
  "type": "object",
  "required": ["rows"],
  "properties": {
    "rows": {
      "type": "array",
      "title": "表单行",
      "x-ui-widget": "editable-table",
      "items": {
        "type": "object",
        "properties": {
          "fieldA": { "type": "string", "title": "字段 A" },
          "fieldB": { "type": "string", "title": "字段 B" }
        }
      }
    }
  }
}
```

或 `'x-ui-widget': 'file-to-json'` 上传 CSV/JSON 后写入 `rows`。

---

## 7. SchemaForm 组件职责清单

建议组件：`SchemaForm.vue`（Run / Schedule 共用）。

- [ ] 接收 `paramSchema` + `modelValue (params)`  
- [ ] 若存在 `x-ui-form` → 分发自定义表单  
- [ ] 否则遍历 `properties`（排序）渲染；跳过 `x-ui-hidden`  
- [ ] 实现上表全部约定 widget（至少实现 type 默认映射 + `pagination-mode` + `textarea-lines` + `editable-table`）  
- [ ] `required` → 校验规则；提交前校验失败不调 API  
- [ ] 换 Spider 时重置 `params` 为各字段 `default` 或 `{}`  
- [ ] 不要在组件内写死站点名或分页字段  

新建页布局建议：

```
[Spider 选择]
[App Profile] [Spider Profile] [可选 options.concurrentRequests]
─────────────
[SchemaForm ← 仅此处随 Spider 变化]
─────────────
[创建任务]
```

---

## 8. 后端注册侧（应用仓）注意

- 分页站：可展开 `commonPageSeedProperties`  
- **非分页站：不要**引用 `commonPageSeedProperties`  
- 可用 `stringLinesField` / `objectTableField` / `customFormSchema` / `withUi`（`src/admin/param-schema.ts`）拼 schema  
- `create(params)` 必须按自己的 schema 校验；错误信息经 `createRun` 以 400 返回即可  

---

## 9. 与其它文档的关系

| 文档 | 关系 |
|------|------|
| [`admin-api.md`](./admin-api.md) | HTTP 与类型；表单细节以本文为准 |
| [`admin-frontend-prep.md`](./admin-frontend-prep.md) | 页面与工程清单；表单映射指向本文 |
| [`capabilities-and-roadmap.md`](./capabilities-and-roadmap.md) | 框架能力全景 |
