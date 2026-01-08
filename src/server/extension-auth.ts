import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface ExtensionAuth {
    channelId: string;
    userId?: string;
    opaqueUserId: string;
    role: string;
    token: string;
}

declare module 'express-serve-static-core' {
    interface Request {
        twitchAuth?: ExtensionAuth;
    }
}

const bearerPrefix = 'bearer ';

export function verifyExtensionToken(req: Request, res: Response, next: NextFunction) {
    const secret = process.env.TWITCH_EXTENSION_SECRET;
    const authz = req.headers.authorization;

    // Dev bypass only when explicitly enabled AND no Authorization header was provided
    if ((!authz || !authz.toLowerCase().startsWith(bearerPrefix)) && process.env.PANEL_DEV_MODE === 'true') {
        const channelId = process.env.TWITCH_CHANNEL || 'devchannel';
        req.twitchAuth = {
            channelId,
            userId: 'devuser',
            opaqueUserId: 'dev-opaque',
            role: 'broadcaster',
            token: 'dev-bypass',
        };
        return next();
    }

    if (!secret) {
        return res.status(500).json({ error: 'Extension secret not configured' });
    }

    if (!authz || !authz.toLowerCase().startsWith(bearerPrefix)) {
        return res.status(401).json({ error: 'Missing Authorization bearer token' });
    }

    const token = authz.slice(bearerPrefix.length).trim();
    try {
        const decoded = jwt.verify(token, Buffer.from(secret, 'base64')) as any;
        const channelId = decoded.channel_id || decoded.channelId;
        const opaqueUserId = decoded.opaque_user_id || decoded.opaqueUserId;
        const userId = decoded.user_id || decoded.userId;
        const role = decoded.role || 'viewer';

        if (!channelId || !opaqueUserId) {
            return res.status(401).json({ error: 'Invalid extension token payload' });
        }

        req.twitchAuth = { channelId, opaqueUserId, userId, role, token };
        return next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}
