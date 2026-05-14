/**
 * 极简 robots.txt：按行解析 User-agent 分组与 Allow/Disallow，用于 obeyRobotsTxt
 */

export type RobotsRuleLine = { kind: 'allow' | 'disallow'; path: string };

export type RobotsAgentGroup = {
    /** 小写，含 * 表示通配 */
    agents: string[];
    rules: RobotsRuleLine[];
};

export type ParsedRobots = {
    groups: RobotsAgentGroup[];
};

/** 无规则时视为全站允许 */
export function emptyRobotsAllowAll(): ParsedRobots {
    return { groups: [] };
}

/**
 * 拉取 origin/robots.txt 并解析；404 视为无限制；其它非 2xx 抛错
 */
export async function fetchRobotsTxt(origin: string, headers: Record<string, string>): Promise<ParsedRobots> {
    const url = `${origin.replace(/\/$/, '')}/robots.txt`;
    const res = await fetch(url, {
        method: 'GET',
        headers: { ...headers },
    });
    if (res.status === 404) {
        return emptyRobotsAllowAll();
    }
    if (!res.ok) {
        throw new Error(`获取 robots.txt 失败 HTTP ${res.status}：${url}`);
    }
    const text = await res.text();
    return parseRobotsTxt(text);
}

/**
 * 解析 robots.txt 正文为分组结构（忽略 Sitemap 等）
 */
export function parseRobotsTxt(raw: string): ParsedRobots {
    const groups: RobotsAgentGroup[] = [];
    let agents: string[] = [];
    let rules: RobotsRuleLine[] = [];

    const flushGroup = () => {
        if (agents.length > 0 || rules.length > 0) {
            groups.push({ agents: agents.length > 0 ? agents : ['*'], rules: [...rules] });
        }
        agents = [];
        rules = [];
    };

    for (const line of raw.split(/\r?\n/)) {
        const cut = line.split('#')[0]?.trim() ?? '';
        if (cut === '') {
            continue;
        }
        const colon = cut.indexOf(':');
        if (colon < 0) {
            continue;
        }
        const key = cut.slice(0, colon).trim().toLowerCase();
        const val = cut.slice(colon + 1).trim();
        if (key === 'user-agent') {
            if (rules.length > 0) {
                flushGroup();
            }
            agents.push(val.toLowerCase());
        } else if (key === 'disallow' || key === 'allow') {
            const pathNorm = normalizeRobotsPath(val);
            if (pathNorm !== null) {
                rules.push({ kind: key === 'allow' ? 'allow' : 'disallow', path: pathNorm });
            }
        }
    }
    flushGroup();
    return { groups };
}

/**
 * 空串 Disallow 表示该组不禁止（允许）；非法则跳过
 */
function normalizeRobotsPath(val: string): string | null {
    if (val === '') {
        return null;
    }
    let p = val.split(/\s+/)[0] ?? '';
    if (p === '') {
        return null;
    }
    if (!p.startsWith('/')) {
        p = `/${p}`;
    }
    return p;
}

/**
 * 根据请求 UA 与 pathname 判断是否允许（合并所有命中的 User-agent 组；同一路径长度优先）
 */
export function isUrlAllowedByRobots(parsed: ParsedRobots, userAgent: string, pathname: string): boolean {
    if (parsed.groups.length === 0) {
        return true;
    }
    const uaLc = userAgent.toLowerCase();
    const merged: RobotsRuleLine[] = [];
    for (const g of parsed.groups) {
        const hit = g.agents.some((a) => a === '*' || uaLc.includes(a));
        if (hit) {
            merged.push(...g.rules);
        }
    }
    if (merged.length === 0) {
        return true;
    }
    const path = pathname || '/';
    type Hit = { len: number; kind: 'allow' | 'disallow' };
    const hits: Hit[] = [];
    for (const r of merged) {
        if (robotsPathMatches(path, r.path)) {
            hits.push({ len: r.path.length, kind: r.kind });
        }
    }
    if (hits.length === 0) {
        return true;
    }
    hits.sort((a, b) => b.len - a.len);
    return hits[0].kind === 'allow';
}

function robotsPathMatches(pathname: string, pattern: string): boolean {
    if (pattern === '/') {
        return true;
    }
    if (!pathname.startsWith(pattern)) {
        return false;
    }
    if (pathname.length === pattern.length) {
        return true;
    }
    if (pattern.endsWith('/')) {
        return true;
    }
    return pathname.charAt(pattern.length) === '/';
}

/** 从请求头里取 User-Agent，缺省为 crawlnd */
export function pickUserAgent(headers: Record<string, string> | undefined): string {
    if (!headers) {
        return 'crawlnd';
    }
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === 'user-agent' && v.trim() !== '') {
            return v;
        }
    }
    return 'crawlnd';
}
