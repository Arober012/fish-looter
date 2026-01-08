import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { createServer as createSecureServer } from 'https';
import { createHash } from 'crypto';
import { Server } from 'socket.io';
import { initializeTwitchBridge } from './twitch-bridge';
import { getPublicState, processChatCommand, getPanelData, processPanelCommand, panelCraft, panelEnchant, panelTradeList, panelTradeBuy, panelTradeCancel, panelStoreRefresh, getCatalogSnapshot, getCatalogDebug, getHelixDebug, saveDir } from './handlers/commands';
import { fetchTwitchUser } from './twitch-helix';
import { ChatCommandEvent, EssenceId } from '../shared/types';
import { verifyExtensionToken, ExtensionAuth } from './extension-auth';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

const effectiveChannel = process.env.TWITCH_CHANNEL ? process.env.TWITCH_CHANNEL.toLowerCase() : 'default';
console.log(`[startup] twitch_channel=${effectiveChannel} save_dir=${saveDir}`);

const app = express();

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

const io = new Server(server, { cors: { origin: '*' } });

// Default to a non-conflicting port; override with PORT env when needed
const PORT = Number(process.env.PORT) || 3100;
const overlayPath = path.resolve(__dirname, '../../dist/overlay');
const panelPath = path.resolve(__dirname, '../../dist/panel');
const panelHtmlPath = path.join(panelPath, 'panel.html');

async function resolveExtensionUsername(auth: ExtensionAuth): Promise<string> {
    if (auth.userId) {
        try {
            const user = await fetchTwitchUser(auth.userId);
            if (user?.displayName) return user.displayName;
            if (user?.login) return user.login;
        } catch {
            // best effort; fall through
        }
        return auth.userId;
    }
    if (auth.opaqueUserId) {
        return auth.opaqueUserId.replace(/^U_?/i, '').replace(/^A_?/i, '');
    }
    return 'anon';
}

async function resolveExtensionChannel(auth: ExtensionAuth): Promise<string> {
    if (auth.channelId) {
        try {
            const user = await fetchTwitchUser(auth.channelId);
            if (user?.login) return user.login.toLowerCase();
        } catch {
            // best effort
        }
        return auth.channelId.toLowerCase();
    }
    const envChannel = process.env.TWITCH_CHANNEL;
    return envChannel ? envChannel.toLowerCase() : 'default';
}

app.use(express.json());
// CORS: allow Twitch extension origin (and dev); include Authorization for preflight
app.use((req: Request, res: Response, next) => {
    const allowedOrigins = [
        'https://8n9kgk8pvew44q35z8l471ys2hr3dy.ext-twitch.tv',
        'https://fish.custom-overlays.com',
        'https://www.fish.custom-overlays.com',
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:5175',
    ];
    const origin = req.headers.origin as string | undefined;
    if (origin && allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Serve built overlay and panel assets
app.use(express.static(panelPath));
app.use(express.static(overlayPath));

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

// Extension-friendly state fetch (requires Twitch Extension bearer token)
app.get('/api/state', verifyExtensionToken, async (req: Request, res: Response) => {
    const auth = req.twitchAuth;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const username = await resolveExtensionUsername(auth);
    const channelKey = await resolveExtensionChannel(auth);
    const catalog = getCatalogSnapshot();
    const { state, store, upgrades, tradeBoard, storeExpiresAt, storeRefreshRemainingMs } = await getPanelData(username, channelKey);
    res.json({ state, store, upgrades, tradeBoard, storeExpiresAt, storeRefreshRemainingMs, catalogVersion: catalog.version });
});

// Extension-friendly command endpoint (uses verified Twitch identity)
app.post('/api/command', verifyExtensionToken, async (req: Request, res: Response) => {
    const auth = req.twitchAuth;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { command, args } = req.body || {};
    if (!command || typeof command !== 'string') {
        return res.status(400).json({ error: 'command is required' });
    }
    const username = await resolveExtensionUsername(auth);
    const channelKey = await resolveExtensionChannel(auth);
    const safeArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];
    const isBroadcaster = auth.role === 'broadcaster';
    const isMod = isBroadcaster || auth.role === 'moderator';

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
app.post('/api/panel/buy', verifyExtensionToken, async (req: Request, res: Response) => {
    const auth = req.twitchAuth;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { itemKey, quantity } = req.body || {};
    if (!itemKey || typeof itemKey !== 'string') return res.status(400).json({ error: 'itemKey is required' });
    const qtyArg = quantity && Number.isFinite(quantity) ? String(quantity) : undefined;
    const args = qtyArg ? [itemKey, qtyArg] : [itemKey];
    const username = await resolveExtensionUsername(auth);
    const channelKey = await resolveExtensionChannel(auth);
    await processPanelCommand(io, { username, command: 'buy', args, channel: channelKey });
    res.sendStatus(204);
});

app.post('/api/panel/sell', verifyExtensionToken, async (req: Request, res: Response) => {
    const auth = req.twitchAuth;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { sellAll, name } = req.body || {};
    const args = sellAll ? ['all'] : name && typeof name === 'string' ? [name] : [];
    const username = await resolveExtensionUsername(auth);
    const channelKey = await resolveExtensionChannel(auth);
    await processPanelCommand(io, { username, command: 'sell', args, channel: channelKey });
    res.sendStatus(204);
});

app.post('/api/panel/use', verifyExtensionToken, async (req: Request, res: Response) => {
    const auth = req.twitchAuth;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { name } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    const args = name.split(' ').filter(Boolean);
    const username = await resolveExtensionUsername(auth);
    const channelKey = await resolveExtensionChannel(auth);
    await processPanelCommand(io, { username, command: 'use', args, channel: channelKey });
    res.sendStatus(204);
});

app.post('/api/panel/store/refresh', verifyExtensionToken, async (req: Request, res: Response) => {
    const auth = req.twitchAuth;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const username = await resolveExtensionUsername(auth);
    const channelKey = await resolveExtensionChannel(auth);
    const result = await panelStoreRefresh(io, username, channelKey);
    if (!result.ok) {
        return res.status(429).json({ error: result.error || 'Store refresh on cooldown.' });
    }
    res.sendStatus(204);
});

app.post('/api/panel/equip', verifyExtensionToken, async (req: Request, res: Response) => {
    const auth = req.twitchAuth;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { skin } = req.body || {};
    if (!skin || typeof skin !== 'string') return res.status(400).json({ error: 'skin is required' });
    const args = skin.split(' ').filter(Boolean);
    const username = await resolveExtensionUsername(auth);
    const channelKey = await resolveExtensionChannel(auth);
    await processPanelCommand(io, { username, command: 'equip', args, channel: channelKey });
    res.sendStatus(204);
});

app.post('/api/panel/upgrades/buy', verifyExtensionToken, async (req: Request, res: Response) => {
    const auth = req.twitchAuth;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { upgradeKey } = req.body || {};
    if (!upgradeKey || typeof upgradeKey !== 'string') return res.status(400).json({ error: 'upgradeKey is required' });
    const username = await resolveExtensionUsername(auth);
    const channelKey = await resolveExtensionChannel(auth);
    await processPanelCommand(io, { username, command: 'buy', args: [upgradeKey], channel: channelKey });
    res.sendStatus(204);
});

// Future craft/enchant/trade panel routes can call dedicated handlers; stubbed for now
app.post('/api/panel/craft', verifyExtensionToken, async (req: Request, res: Response) => {
    const auth = req.twitchAuth;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { recipeId } = req.body || {};
    if (!recipeId || typeof recipeId !== 'string') return res.status(400).json({ error: 'recipeId is required' });
    const username = await resolveExtensionUsername(auth);
    const channelKey = await resolveExtensionChannel(auth);
    await panelCraft(io, username, channelKey, recipeId);
    res.sendStatus(204);
});

app.post('/api/panel/enchant', verifyExtensionToken, async (req: Request, res: Response) => {
    const auth = req.twitchAuth;
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
    const username = await resolveExtensionUsername(auth);
    const channelKey = await resolveExtensionChannel(auth);
    await panelEnchant(io, username, channelKey, target, essenceId);
    res.sendStatus(204);
});

app.post('/api/panel/trade/list', verifyExtensionToken, async (req: Request, res: Response) => {
    const auth = req.twitchAuth;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { itemId, price } = req.body || {};
    if (!itemId || typeof itemId !== 'string') return res.status(400).json({ error: 'itemId is required' });
    if (!Number.isFinite(price)) return res.status(400).json({ error: 'price is required' });
    const username = await resolveExtensionUsername(auth);
    const channelKey = await resolveExtensionChannel(auth);
    await panelTradeList(io, username, channelKey, itemId, Number(price));
    res.sendStatus(204);
});

app.post('/api/panel/trade/buy', verifyExtensionToken, async (req: Request, res: Response) => {
    const auth = req.twitchAuth;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { listingId } = req.body || {};
    if (!listingId || typeof listingId !== 'string') return res.status(400).json({ error: 'listingId is required' });
    const username = await resolveExtensionUsername(auth);
    const channelKey = await resolveExtensionChannel(auth);
    await panelTradeBuy(io, username, channelKey, listingId);
    res.sendStatus(204);
});

app.post('/api/panel/trade/cancel', verifyExtensionToken, async (req: Request, res: Response) => {
    const auth = req.twitchAuth;
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
    const { listingId } = req.body || {};
    if (!listingId || typeof listingId !== 'string') return res.status(400).json({ error: 'listingId is required' });
    const username = await resolveExtensionUsername(auth);
    const channelKey = await resolveExtensionChannel(auth);
    await panelTradeCancel(io, username, channelKey, listingId);
    res.sendStatus(204);
});

// Initialize Twitch bridge to listen to chat and forward to command processor
initializeTwitchBridge(io, processChatCommand);

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