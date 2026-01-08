import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const SESSION_COOKIE = 'session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionPayload = {
    channelId: string;
    login: string;
    displayName?: string;
};

function getSecret(): string {
    const secret = process.env.APP_JWT_SECRET;
    if (!secret) throw new Error('APP_JWT_SECRET is not set');
    return secret;
}

export function signSession(payload: SessionPayload): string {
    return jwt.sign(payload, getSecret(), { expiresIn: SESSION_TTL_MS / 1000 });
}

export function verifySessionToken(token?: string): SessionPayload | null {
    if (!token) return null;
    try {
        return jwt.verify(token, getSecret()) as SessionPayload;
    } catch {
        return null;
    }
}

export function setSessionCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: SESSION_TTL_MS,
        path: '/',
    });
}

export function clearSessionCookie(res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
}

declare module 'express-serve-static-core' {
    interface Request {
        session?: SessionPayload;
    }
}

export function requireSession(req: Request, res: Response, next: NextFunction) {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    const session = verifySessionToken(token);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    req.session = session;
    next();
}
