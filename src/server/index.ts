import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { createServer as createSecureServer } from 'https';
import { createHash } from 'crypto';
import { Server } from 'socket.io';
import { ChatBridge } from './twitch-bridge';
import { getPublicState, processChatCommand, getPanelData, processPanelCommand, panelCraft, panelEnchant, panelTradeList, panelTradeBuy, panelTradeCancel, panelStoreRefresh, getCatalogSnapshot, getCatalogDebug, getHelixDebug, saveDir } from './handlers/commands';
import { ChatCommandEvent, EssenceId } from '../shared/types';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { signSession, setSessionCookie, clearSessionCookie, requireSession, verifySessionToken } from './auth-session';
import { upsertChannel, getChannelById, getChannelByLogin, listChannels } from './channel-store';
import { getDataDir } from './data-dir';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

const effectiveChannel = process.env.TWITCH_CHANNEL ? process.env.TWITCH_CHANNEL.toLowerCase() : 'default';
console.log(`[startup] twitch_channel=${effectiveChannel} data_dir=${getDataDir()} save_dir=${saveDir}`);

const app = express();
app.use(cookieParser());

// HTTPS support: set CERT_PATH and KEY_PATH to PEM files; otherwise falls back to HTTP.
let server: import('http').Server | import('https').Server;
const certPath = process.env.CERT_PATH;
const keyPath = process.env.KEY_PATH;

if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    server = createSecureServer({
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
    }, app);
    console.log(`[server] Using HTTPS with cert ${certPath}`);
} else {
    server = createServer(app);
    console.warn('[server] CERT_PATH/KEY_PATH not set or files missing; using HTTP (Twitch panel requires HTTPS)');
}

const allowedOrigins = [
    'https://8n9kgk8pvew44q35z8l471ys2hr3dy.ext-twitch.tv',
    'https://fish.custom-overlays.com',
    'https://www.fish.custom-overlays.com',
    'https://custom-overlays.com',
    'https://www.custom-overlays.com',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
];

const io = new Server(server, { cors: { origin: allowedOrigins, credentials: true } });

// Default to a non-conflicting port; override with PORT env when needed
const PORT = Number(process.env.PORT) || 3100;
const overlayPath = path.resolve(__dirname, '../../dist/overlay');
const panelPath = path.resolve(__dirname, '../../dist/panel');
const panelHtmlPath = path.join(panelPath, 'panel.html');
const chatBridge = new ChatBridge(io, processChatCommand);

app.use(express.json());
// CORS: allow Twitch extension origin (and dev); include Authorization for preflight
app.use((req: Request, res: Response, next) => {
    const origin = req.headers.origin as string | undefined;
    if (origin && allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Serve built overlay and panel assets
app.use(express.static(panelPath));
app.use(express.static(overlayPath));

function requiredEnv(name: string): string {
    const val = process.env[name];
    if (!val) throw new Error(`${name} is required`);
    return val;
}

const oauthStateCookie = 'oauth_state';

app.get('/api/auth/login', (req: Request, res: Response) => {
    try {
        const clientId = requiredEnv('TWITCH_CLIENT_ID');
        const redirectUri = `${requiredEnv('PUBLIC_HOST')}/api/auth/callback`;
        const state = crypto.randomBytes(16).toString('hex');
        res.cookie(oauthStateCookie, state, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 10 * 60 * 1000, path: '/' });
        const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: 'chat:read chat:edit',
            state,
        });
        res.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
    } catch (err: any) {
        res.status(500).send(err?.message || 'Auth not configured');
    }
});

app.get('/api/auth/callback', async (req: Request, res: Response) => {
    try {
        const code = req.query.code as string | undefined;
        const state = req.query.state as string | undefined;
        const expectedState = req.cookies?.[oauthStateCookie] as string | undefined;
        if (!code || !state || !expectedState || state !== expectedState) {
            return res.status(400).send('Invalid state or code');
        }
        res.clearCookie(oauthStateCookie, { path: '/' });

        const clientId = requiredEnv('TWITCH_CLIENT_ID');
        const clientSecret = requiredEnv('TWITCH_CLIENT_SECRET');
        const redirectUri = `${requiredEnv('PUBLIC_HOST')}/api/auth/callback`;

        const tokenResp = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri,
            }).toString(),
        });
        if (!tokenResp.ok) {
            const txt = await tokenResp.text();
            return res.status(400).send(`Token exchange failed: ${txt}`);
        }
        const tokenJson = (await tokenResp.json()) as { access_token: string; refresh_token?: string; scope?: string[] };
        const accessToken = tokenJson.access_token;
        const refreshToken = tokenJson.refresh_token;
        const scopes = tokenJson.scope ?? [];

        const userResp = await fetch('https://api.twitch.tv/helix/users', {
            headers: {
                'Client-ID': clientId,
                Authorization: `Bearer ${accessToken}`,
            },
        });
        if (!userResp.ok) {
            const txt = await userResp.text();
            return res.status(400).send(`User fetch failed: ${txt}`);
        }
        const userJson = (await userResp.json()) as { data?: Array<{ id: string; login: string; display_name: string }> };
        const user = userJson.data?.[0];
        if (!user) return res.status(400).send('User not found');

        const record = {
            channelId: user.id,
            login: user.login,
            displayName: user.display_name,
            botAccessToken: accessToken,
            botRefreshToken: refreshToken,
            scopes,
            updatedAt: Date.now(),
        };
        await upsertChannel(record);
        await chatBridge.addChannel(record);

        const sessionToken = signSession({ channelId: user.id, login: user.login, displayName: user.display_name });
        setSessionCookie(res, sessionToken);
        res.redirect(`${requiredEnv('PUBLIC_HOST')}/panel`);
    } catch (err: any) {
        res.status(500).send(err?.message || 'Auth failed');
    }
});

app.get('/api/auth/me', (req: Request, res: Response) => {
    const token = req.cookies?.['session'] as string | undefined;
    const session = verifySessionToken(token);
    if (!session) return res.status(401).json({ ok: false });
    return res.json({ ok: true, session });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
    clearSessionCookie(res);
    res.sendStatus(204);
});

// Optional: accept commands from HTTP clients
app.post('/api/commands', (req: Request, res: Response) => {
    const payload = req.body as ChatCommandEvent;
    processChatCommand(io, payload);
    res.sendStatus(204);
});

// Catalog endpoint so the panel can render data-driven content without rebuilds
app.get('/api/catalog', (_req: Request, res: Response) => {
    const catalog = getCatalogSnapshot();
    const etag = createHash('sha256').update(`${catalog.version}-${catalog.updatedAt}`).digest('hex');
    if (_req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(catalog);
});

// Lightweight health/debug endpoints for quick verification in dev/tunnel
app.get('/api/health', (_req: Request, res: Response) => {
    const catalog = getCatalogSnapshot();
    res.json({ ok: true, catalogVersion: catalog.version, catalogUpdatedAt: catalog.updatedAt, helix: getHelixDebug() });
});

app.get('/api/debug/catalog', (_req: Request, res: Response) => {
    res.json(getCatalogDebug());
});

app.get('/api/debug/helix', (_req: Request, res: Response) => {
    res.json(getHelixDebug());
});

app.get('/api/debug/storage', async (_req: Request, res: Response) => {
    const dataDir = getDataDir();
    const channelsPath = path.join(dataDir, 'channels.json');
    let channelsFile: { exists: boolean; size?: number; mtimeMs?: number } = { exists: false };
    try {
        const stat = fs.statSync(channelsPath);
        channelsFile = { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
        // missing is expected until first auth
    }

    let channelCount = 0;
    try {
        const records = await listChannels();
        channelCount = records.length;
    } catch {
        // ignore
    }

    res.json({ dataDir, channelsPath, channelsFile, channelCount, saveDir });
});

app.get('/api/debug/twitch', async (_req: Request, res: Response) => {
    let storedChannels: string[] = [];
    try {
        const records = await listChannels();
        storedChannels = records.map((r) => r.login);
    } catch {
        // ignore
    }
    res.json({ connected: chatBridge.getStatus(), storedChannels });
});

// Extension-friendly state fetch (requires Twitch Extension bearer token)
app.get('/api/state', requireSession, async (req: Request, res: Response) => {
    const auth = req.session;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const username = auth.displayName || auth.login;
    const channelKey = auth.login.toLowerCase();
    const catalog = getCatalogSnapshot();
    const { state, store, upgrades, tradeBoard, storeExpiresAt, storeRefreshRemainingMs } = await getPanelData(username, channelKey);
    res.json({ state, store, upgrades, tradeBoard, storeExpiresAt, storeRefreshRemainingMs, catalogVersion: catalog.version });
});

// Extension-friendly command endpoint (uses verified Twitch identity)
app.post('/api/command', requireSession, async (req: Request, res: Response) => {
    const auth = req.session;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { command, args } = req.body || {};
    if (!command || typeof command !== 'string') {
        return res.status(400).json({ error: 'command is required' });
    }
    const username = auth.displayName || auth.login;
    const channelKey = auth.login.toLowerCase();
    const safeArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];
    const isBroadcaster = true;
    const isMod = true;

    const payload: ChatCommandEvent = {
        username,
        command: command.toLowerCase(),
        args: safeArgs,
        isMod,
        isBroadcaster,
        channel: channelKey,
    };

    await processChatCommand(io, payload);
    res.sendStatus(204);
});

// Panel-first endpoints to reduce chat command reliance; reuse core handlers with elevated rights
app.post('/api/panel/buy', requireSession, async (req: Request, res: Response) => {
    const auth = req.session;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { itemKey, quantity } = req.body || {};
    if (!itemKey || typeof itemKey !== 'string') return res.status(400).json({ error: 'itemKey is required' });
    const qtyArg = quantity && Number.isFinite(quantity) ? String(quantity) : undefined;
    const args = qtyArg ? [itemKey, qtyArg] : [itemKey];
    const username = auth.displayName || auth.login;
    const channelKey = auth.login.toLowerCase();
    await processPanelCommand(io, { username, command: 'buy', args, channel: channelKey });
    res.sendStatus(204);
});

app.post('/api/panel/sell', requireSession, async (req: Request, res: Response) => {
    const auth = req.session;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { sellAll, name } = req.body || {};
    const args = sellAll ? ['all'] : name && typeof name === 'string' ? [name] : [];
    const username = auth.displayName || auth.login;
    const channelKey = auth.login.toLowerCase();
    await processPanelCommand(io, { username, command: 'sell', args, channel: channelKey });
    res.sendStatus(204);
});

app.post('/api/panel/use', requireSession, async (req: Request, res: Response) => {
    const auth = req.session;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { name } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    const args = name.split(' ').filter(Boolean);
    const username = auth.displayName || auth.login;
    const channelKey = auth.login.toLowerCase();
    await processPanelCommand(io, { username, command: 'use', args, channel: channelKey });
    res.sendStatus(204);
});

app.post('/api/panel/store/refresh', requireSession, async (req: Request, res: Response) => {
    const auth = req.session;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const username = auth.displayName || auth.login;
    const channelKey = auth.login.toLowerCase();
    const result = await panelStoreRefresh(io, username, channelKey);
    if (!result.ok) {
        return res.status(429).json({ error: result.error || 'Store refresh on cooldown.' });
    }
    res.sendStatus(204);
});

app.post('/api/panel/equip', requireSession, async (req: Request, res: Response) => {
    const auth = req.session;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { skin } = req.body || {};
    if (!skin || typeof skin !== 'string') return res.status(400).json({ error: 'skin is required' });
    const args = skin.split(' ').filter(Boolean);
    const username = auth.displayName || auth.login;
    const channelKey = auth.login.toLowerCase();
    await processPanelCommand(io, { username, command: 'equip', args, channel: channelKey });
    res.sendStatus(204);
});

app.post('/api/panel/upgrades/buy', requireSession, async (req: Request, res: Response) => {
    const auth = req.session;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { upgradeKey } = req.body || {};
    if (!upgradeKey || typeof upgradeKey !== 'string') return res.status(400).json({ error: 'upgradeKey is required' });
    const username = auth.displayName || auth.login;
    const channelKey = auth.login.toLowerCase();
    await processPanelCommand(io, { username, command: 'buy', args: [upgradeKey], channel: channelKey });
    res.sendStatus(204);
});

// Future craft/enchant/trade panel routes can call dedicated handlers; stubbed for now
app.post('/api/panel/craft', requireSession, async (req: Request, res: Response) => {
    const auth = req.session;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { recipeId } = req.body || {};
    if (!recipeId || typeof recipeId !== 'string') return res.status(400).json({ error: 'recipeId is required' });
    const username = auth.displayName || auth.login;
    const channelKey = auth.login.toLowerCase();
    await panelCraft(io, username, channelKey, recipeId);
    res.sendStatus(204);
});

app.post('/api/panel/enchant', requireSession, async (req: Request, res: Response) => {
    const auth = req.session;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { essence, targetKind } = req.body || {};

    const essenceMap: Record<string, EssenceId> = {
        spark: 'spark-essence',
        'spark-essence': 'spark-essence',
        echo: 'echo-essence',
        'echo-essence': 'echo-essence',
        mythic: 'mythic-essence',
        'mythic-essence': 'mythic-essence',
    };

    const essenceId = typeof essence === 'string' ? essenceMap[essence.toLowerCase()] : undefined;
    if (!essenceId) return res.status(400).json({ error: 'essence must be spark|echo|mythic' });

    const target: { kind: 'rod' } = { kind: targetKind === 'rod' ? 'rod' : 'rod' };
    const username = auth.displayName || auth.login;
    const channelKey = auth.login.toLowerCase();
    await panelEnchant(io, username, channelKey, target, essenceId);
    res.sendStatus(204);
});

app.post('/api/panel/trade/list', requireSession, async (req: Request, res: Response) => {
    const auth = req.session;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { itemId, price } = req.body || {};
    if (!itemId || typeof itemId !== 'string') return res.status(400).json({ error: 'itemId is required' });
    if (!Number.isFinite(price)) return res.status(400).json({ error: 'price is required' });
    const username = auth.displayName || auth.login;
    const channelKey = auth.login.toLowerCase();
    await panelTradeList(io, username, channelKey, itemId, Number(price));
    res.sendStatus(204);
});

app.post('/api/panel/trade/buy', requireSession, async (req: Request, res: Response) => {
    const auth = req.session;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { listingId } = req.body || {};
    if (!listingId || typeof listingId !== 'string') return res.status(400).json({ error: 'listingId is required' });
    const username = auth.displayName || auth.login;
    const channelKey = auth.login.toLowerCase();
    await panelTradeBuy(io, username, channelKey, listingId);
    res.sendStatus(204);
});

app.post('/api/panel/trade/cancel', requireSession, async (req: Request, res: Response) => {
    const auth = req.session;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { listingId } = req.body || {};
    if (!listingId || typeof listingId !== 'string') return res.status(400).json({ error: 'listingId is required' });
    const username = auth.displayName || auth.login;
    const channelKey = auth.login.toLowerCase();
    await panelTradeCancel(io, username, channelKey, listingId);
    res.sendStatus(204);
});

// Initialize Twitch bridge to listen to chat and forward to command processor
listChannels()
    .then((records) => {
        if (!records.length) {
            console.warn('[twitch] No saved channels found (data/channels.json empty or missing). Chat commands will not work until you log in via /api/auth/login to store tokens.');
            if (effectiveChannel && effectiveChannel !== 'default') {
                console.warn(`[twitch] Falling back to anonymous chat connection for #${effectiveChannel} (read-only). Set TWITCH_CHANNEL and redeploy if needed.`);
                chatBridge.addChannel({ channelId: effectiveChannel, login: effectiveChannel, updatedAt: Date.now() });
            }
        }
        records.forEach((rec) => chatBridge.addChannel(rec));
    })
    .catch((err) => console.warn('[twitch] Failed to load channels for chat bridge', err));

// Serve panel bundle explicitly so it is not caught by the overlay SPA fallback
app.get(['/panel', '/panel.html'], (_req: Request, res: Response) => {
    if (fs.existsSync(panelHtmlPath)) {
        return res.sendFile(panelHtmlPath);
    }
    res.status(404).send('Panel build missing');
});

// SPA fallback for overlay (built entry is overlay.html, not index.html)
app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.join(overlayPath, 'overlay.html'));
});

server.listen(PORT, () => {
    const proto = certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath) ? 'https' : 'http';
    console.log(`Server is running on ${proto}://localhost:${PORT}`);
});