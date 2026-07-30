import { JSDOM } from 'jsdom';
import * as xpath from 'xpath';
import type { CrawlResponseBody } from './context.js';

/**
 * 启发式：以 (、//、./、../ 开头，或以 / 后接字母、_、@ 的视为 XPath（否则走 CSS querySelector）
 */
function isLikelyXPath(selector: string): boolean {
    const s = selector.trimStart();
    if (s.startsWith('(') || s.startsWith('//') || s.startsWith('./') || s.startsWith('../')) {
        return true;
    }
    if (s.startsWith('/') && s.length > 1 && s[1] !== '/') {
        return /^\/[a-zA-Z_@]/.test(s);
    }
    return false;
}

function stringifyXPathResult(value: xpath.SelectedValue): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    const nodeType = (value as { nodeType?: number }).nodeType;
    if (nodeType === 2) {
        return (value as Attr).value;
    }
    if (nodeType === 3 || nodeType === 4) {
        const d = (value as CharacterData).data?.trim();
        return d === '' || d === undefined ? null : d;
    }
    if (nodeType === 1) {
        const t = (value as Element).textContent?.trim();
        return t === '' || t === undefined ? null : t;
    }
    return null;
}

function bodyToUtf8String(body: CrawlResponseBody): string | null {
    if (typeof body === 'string') {
        return body;
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) {
        return body.toString('utf8');
    }
    if (body instanceof Uint8Array) {
        return Buffer.from(body).toString('utf8');
    }
    if (body instanceof ArrayBuffer) {
        return Buffer.from(body).toString('utf8');
    }
    return null;
}

function looksLikeMarkup(source: string, contentType: string): boolean {
    const ct = contentType.toLowerCase();
    if (ct.includes('html') || ct.includes('xml')) {
        return true;
    }
    return /^[\s\r\n]*</.test(source);
}

/**
 * jsdom 解析 HTML 时元素都在 XHTML 命名空间下，而 XPath 1.0 中无前缀的元素名只匹配「无命名空间」的节点，
 * 直接写 `//ul` 永远命中不到。这里把无前缀的元素名测试改写为 `*[local-name()='name']`，
 * 用户书写习惯保持不变（仅在 HTML 模式下调用，XML 文档不应改写）。
 *
 * 处理要点：
 * - 字符串字面量原样保留，不进入扫描
 * - 函数调用 `name(...)`、已带前缀 `ns:name`、通配符 `*` 不改写
 * - 属性测试 `@name` / `attribute::name`、`namespace::name` 不改写
 * - 轴名 `axis::` 自身保留，仅其后的元素节点测试参与改写
 */
function rewriteXPathForHtml(expr: string): string {
    const isIdentStart = (c: string | undefined): boolean => c !== undefined && /[a-zA-Z_]/.test(c);
    const isIdent = (c: string | undefined): boolean => c !== undefined && /[a-zA-Z0-9_\-]/.test(c);
    const readIdent = (s: string, p: number): string => {
        let j = p;
        while (j < s.length && isIdent(s[j])) {
            j++;
        }
        return s.slice(p, j);
    };

    let out = '';
    let i = 0;
    let prevAxis: string | null = null;
    while (i < expr.length) {
        const c = expr[i]!;
        if (c === '"' || c === "'") {
            const q = c;
            const end = expr.indexOf(q, i + 1);
            if (end < 0) {
                out += expr.slice(i);
                break;
            }
            out += expr.slice(i, end + 1);
            i = end + 1;
            continue;
        }
        if (c === '@') {
            out += '@';
            i++;
            const next = expr[i];
            if (next === '*') {
                out += '*';
                i++;
            } else if (isIdentStart(next)) {
                const n1 = readIdent(expr, i);
                out += n1;
                i += n1.length;
                if (expr[i] === ':' && expr[i + 1] !== ':') {
                    out += ':';
                    i++;
                    if (expr[i] === '*') {
                        out += '*';
                        i++;
                    } else if (isIdentStart(expr[i])) {
                        const n2 = readIdent(expr, i);
                        out += n2;
                        i += n2.length;
                    }
                }
            }
            prevAxis = null;
            continue;
        }
        if (isIdentStart(c)) {
            const name = readIdent(expr, i);
            const after = expr[i + name.length];
            const after2 = expr[i + name.length + 1];
            if (after === '(') {
                out += name;
                i += name.length;
                continue;
            }
            if (after === ':' && after2 === ':') {
                out += name + '::';
                i += name.length + 2;
                prevAxis = name;
                continue;
            }
            if (after === ':' && after2 !== ':') {
                out += name + ':';
                i += name.length + 1;
                if (expr[i] === '*') {
                    out += '*';
                    i++;
                } else if (isIdentStart(expr[i])) {
                    const n2 = readIdent(expr, i);
                    out += n2;
                    i += n2.length;
                }
                prevAxis = null;
                continue;
            }
            if (prevAxis === 'attribute' || prevAxis === 'namespace') {
                out += name;
            } else {
                out += `*[local-name()='${name}']`;
            }
            i += name.length;
            prevAxis = null;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/**
 * 在给定作用域（Document 或 Element）内执行一次选择，命中后返回原始节点/标量
 * 复用原有 isLikelyXPath 的判定逻辑：XPath 走 xpath.select1，否则走 CSS querySelector
 * htmlMode 为 true 时对 XPath 做命名空间无关改写，避免 XHTML 命名空间导致 //tag 命中失败
 */
function selectOneInScope(
    scope: Document | Element,
    selector: string,
    htmlMode: boolean,
): xpath.SelectedValue | null {
    const sel = selector.trim();
    if (sel === '') {
        return null;
    }
    try {
        if (isLikelyXPath(sel)) {
            const expr = htmlMode ? rewriteXPathForHtml(sel) : sel;
            const v = xpath.select1(expr, scope as unknown as Node);
            return v === undefined ? null : (v as xpath.SelectedValue);
        }
        const el = scope.querySelector(sel);
        return el ?? null;
    } catch {
        return null;
    }
}

/**
 * 在给定作用域内执行一次「全部命中」选择，返回原始节点/标量数组（未命中返回空数组）
 * - XPath 走 xpath.select（返回数组）；CSS 走 querySelectorAll
 * - 与 selectOneInScope 共用 isLikelyXPath 与 HTML 模式 XPath 改写
 */
function selectAllInScope(
    scope: Document | Element,
    selector: string,
    htmlMode: boolean,
): xpath.SelectedValue[] {
    const sel = selector.trim();
    if (sel === '') {
        return [];
    }
    try {
        if (isLikelyXPath(sel)) {
            const expr = htmlMode ? rewriteXPathForHtml(sel) : sel;
            const result = xpath.select(expr, scope as unknown as Node);
            if (Array.isArray(result)) {
                return result as xpath.SelectedValue[];
            }
            return result === undefined || result === null ? [] : [result as xpath.SelectedValue];
        }
        const list = scope.querySelectorAll(sel);
        const out: xpath.SelectedValue[] = [];
        list.forEach((el) => {
            out.push(el as unknown as xpath.SelectedValue);
        });
        return out;
    } catch {
        return [];
    }
}

function isElementValue(value: unknown): value is Element {
    return (
        value !== null &&
        typeof value === 'object' &&
        (value as { nodeType?: number }).nodeType === 1
    );
}

/**
 * 链式选择结果包装：可继续 select 定位子元素，亦可读取文本、属性、innerHTML
 * - 仅当当前命中的是 Element 时，`select` 才能继续命中（属性/文本/标量节点会返回 null）
 */
export interface HtmlSelection {
    /** 在当前命中的元素范围内继续选择，未命中返回 null */
    select(selector: string): HtmlSelection | null;
    /** 在当前命中的元素范围内匹配全部子节点；当前非元素或未命中返回空数组 */
    selectAll(selector: string): HtmlSelection[];
    /** 当前节点的文本内容（trim 后），无内容返回 null */
    text(): string | null;
    /** 当前元素的属性值；当前若已是属性节点则忽略 name 直接返回其值 */
    attr(name: string): string | null;
    /** 当前元素的 innerHTML；非元素返回 null */
    html(): string | null;
}

function wrapSelection(
    value: xpath.SelectedValue | null,
    htmlMode: boolean,
): HtmlSelection | null {
    if (value === null || value === undefined) {
        return null;
    }
    return {
        select(selector: string): HtmlSelection | null {
            if (!isElementValue(value)) {
                return null;
            }
            const next = selectOneInScope(value, selector, htmlMode);
            return wrapSelection(next, htmlMode);
        },
        selectAll(selector: string): HtmlSelection[] {
            if (!isElementValue(value)) {
                return [];
            }
            const list = selectAllInScope(value, selector, htmlMode);
            const out: HtmlSelection[] = [];
            for (const item of list) {
                const w = wrapSelection(item, htmlMode);
                if (w !== null) {
                    out.push(w);
                }
            }
            return out;
        },
        text(): string | null {
            return stringifyXPathResult(value);
        },
        attr(name: string): string | null {
            if (
                typeof value === 'object' &&
                value !== null &&
                (value as { nodeType?: number }).nodeType === 2
            ) {
                return (value as Attr).value;
            }
            if (!isElementValue(value)) {
                return null;
            }
            const v = value.getAttribute(name);
            return v === null ? null : v;
        },
        html(): string | null {
            if (!isElementValue(value)) {
                return null;
            }
            return value.innerHTML;
        },
    };
}

/**
 * 内部：构造一对共享同一份惰性解析 Document 的选择器（select / selectAll）
 * - 仅当正文是可解析的 HTML/XML 文本时生效
 * - htmlMode 由 contentType 推断；HTML 模式下对 XPath 做命名空间无关改写
 */
function createResponseBodySelectors(
    body: CrawlResponseBody,
    contentTypeHeader?: string,
): {
    select: (selector: string) => HtmlSelection | null;
    selectAll: (selector: string) => HtmlSelection[];
} {
    let documentRef: Document | null | undefined;
    let htmlMode = false;

    const getDocument = (): Document | null => {
        if (documentRef !== undefined) {
            return documentRef;
        }
        const src = bodyToUtf8String(body);
        if (src === null) {
            documentRef = null;
            return null;
        }
        const ct = contentTypeHeader ?? '';
        if (!looksLikeMarkup(src, ct)) {
            documentRef = null;
            return null;
        }
        try {
            const asXml = ct.toLowerCase().includes('xml') && !ct.toLowerCase().includes('html');
            const dom = new JSDOM(src, { contentType: asXml ? 'text/xml' : 'text/html' });
            documentRef = dom.window.document;
            htmlMode = !asXml;
        } catch {
            documentRef = null;
        }
        return documentRef;
    };

    const select = (selector: string): HtmlSelection | null => {
        const doc = getDocument();
        if (!doc) {
            return null;
        }
        const v = selectOneInScope(doc, selector, htmlMode);
        return wrapSelection(v, htmlMode);
    };

    const selectAll = (selector: string): HtmlSelection[] => {
        const doc = getDocument();
        if (!doc) {
            return [];
        }
        const list = selectAllInScope(doc, selector, htmlMode);
        const out: HtmlSelection[] = [];
        for (const item of list) {
            const w = wrapSelection(item, htmlMode);
            if (w !== null) {
                out.push(w);
            }
        }
        return out;
    };

    return { select, selectAll };
}

/**
 * 基于当前响应体构造 `select`：仅当正文为可解析的 HTML/XML 文本时生效，否则恒返回 null
 * 返回 HtmlSelection 包装：支持 `.select(...)` 链式定位、`.text()` / `.attr(name)` / `.html()` 取值
 */
export function createResponseBodySelect(
    body: CrawlResponseBody,
    contentTypeHeader?: string,
): (selector: string) => HtmlSelection | null {
    return createResponseBodySelectors(body, contentTypeHeader).select;
}

/**
 * 基于当前响应体构造 `selectAll`：返回与 select 同一文档下命中的全部节点的 HtmlSelection 数组
 * 未命中或正文不可解析时返回空数组
 */
export function createResponseBodySelectAll(
    body: CrawlResponseBody,
    contentTypeHeader?: string,
): (selector: string) => HtmlSelection[] {
    return createResponseBodySelectors(body, contentTypeHeader).selectAll;
}

export { createResponseBodySelectors };
