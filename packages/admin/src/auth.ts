import { createMiddleware } from 'hono/factory';
import { sign, verify } from 'hono/jwt';
import { timingSafeEqual } from 'node:crypto';
import { getAdminEnv } from './runtime.js';

export interface LoginResult {
    token: string;
    expiresAt: string;
    tokenType: 'Bearer';
}

function safeEqualString(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) {
        // 仍做一次等长比较，降低时序差异
        timingSafeEqual(left, left);
        return false;
    }
    return timingSafeEqual(left, right);
}

export function isAuthEnabled(): boolean {
    return Boolean(getAdminEnv().admin.password);
}

/** 校验密码并签发 JWT */
export async function loginWithPassword(password: string): Promise<LoginResult> {
    if (!isAuthEnabled()) {
        throw new Error('未配置 ADMIN_PASSWORD，鉴权未启用');
    }
    if (!password || !safeEqualString(password, getAdminEnv().admin.password)) {
        throw new Error('密码错误');
    }

    const now = Math.floor(Date.now() / 1000);
    const exp = now + getAdminEnv().admin.tokenTtlSeconds;
    const token = await sign(
        {
            sub: 'admin',
            iat: now,
            exp,
        },
        getAdminEnv().admin.jwtSecret,
        'HS256',
    );

    return {
        token,
        tokenType: 'Bearer',
        expiresAt: new Date(exp * 1000).toISOString(),
    };
}

export async function verifyAccessToken(token: string): Promise<{ sub: string }> {
    const payload = await verify(token, getAdminEnv().admin.jwtSecret, 'HS256');
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!sub) {
        throw new Error('无效 token');
    }
    return { sub };
}

/**
 * 保护 /api/*：未配置密码时放行；已配置则除白名单外需 Bearer token。
 */
export function createAuthMiddleware(publicPaths: string[]) {
    const publicSet = new Set(publicPaths);
    return createMiddleware(async (c, next) => {
        if (!isAuthEnabled()) {
            await next();
            return;
        }

        const path = new URL(c.req.url).pathname;
        if (publicSet.has(path)) {
            await next();
            return;
        }

        const header = c.req.header('Authorization') ?? '';
        const match = /^Bearer\s+(.+)$/i.exec(header);
        if (!match?.[1]) {
            return c.json({ error: '未登录或缺少 Authorization: Bearer <token>' }, 401);
        }

        try {
            const payload = await verifyAccessToken(match[1].trim());
            c.set('authSub', payload.sub);
            await next();
        } catch {
            return c.json({ error: '登录已失效，请重新登录' }, 401);
        }
    });
}
