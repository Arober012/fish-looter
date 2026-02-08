import { ChatUserstate, Client } from 'tmi.js';
import { Server } from 'socket.io';
import { ChatCommandEvent } from '../shared/types';
import { ChannelRecord, upsertChannel } from './channel-store';

type ConnectedClient = {
    channel: string;
    client: Client;
    authMode: 'oauth' | 'anonymous';
};

const normalizeChan = (login: string): string => login.replace(/^#/, '').toLowerCase();

export class ChatBridge {
    private io: Server;
    private onChatCommand: (io: Server, payload: ChatCommandEvent, sendChat?: (message: string) => Promise<void>) => void | Promise<void>;
    private clients: Map<string, ConnectedClient> = new Map(); // channel -> client
    private channelRecords: Map<string, ChannelRecord> = new Map();
    private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
    private connecting: Set<string> = new Set();

    constructor(io: Server, onChatCommand: (io: Server, payload: ChatCommandEvent, sendChat?: (message: string) => Promise<void>) => void | Promise<void>) {
        this.io = io;
        this.onChatCommand = onChatCommand;
    }

    private clearReconnectTimer(chan: string) {
        const timer = this.reconnectTimers.get(chan);
        if (timer) clearTimeout(timer);
        this.reconnectTimers.delete(chan);
    }

    private scheduleReconnect(record: ChannelRecord, reason: string, delayMs = 5000) {
        const chan = normalizeChan(record.login);
        if (this.reconnectTimers.has(chan)) return; // already scheduled
        console.warn(`[twitch] Reconnecting to #${chan} in ${delayMs}ms (${reason})`);
        const timer = setTimeout(async () => {
            this.reconnectTimers.delete(chan);
            this.clients.delete(chan);
            try {
                await this.addChannel(record);
            } catch (err) {
                console.warn(`[twitch] Reconnect failed for #${chan}: ${err instanceof Error ? err.message : String(err)}`);
                // backoff and retry once more
                this.scheduleReconnect(record, 'retry after failure', Math.min(delayMs * 2, 60000));
            }
        }, delayMs);
        this.reconnectTimers.set(chan, timer);
    }

    getStatus() {
        return Array.from(this.clients.values()).map((c) => ({ channel: c.channel, authMode: c.authMode }));
    }

    private async validateToken(accessToken: string): Promise<boolean> {
        try {
            const token = accessToken.startsWith('oauth:') ? accessToken.slice('oauth:'.length) : accessToken;
            const resp = await fetch('https://id.twitch.tv/oauth2/validate', {
                headers: {
                    Authorization: `OAuth ${token}`,
                },
            });
            return resp.ok;
        } catch {
            // If validate is unavailable, don't block connection attempts.
            return true;
        }
    }

    private async refreshUserToken(record: ChannelRecord): Promise<ChannelRecord | null> {
        const refreshToken = record.botRefreshToken;
        if (!refreshToken) return null;

        const clientId = process.env.TWITCH_CLIENT_ID;
        const clientSecret = process.env.TWITCH_CLIENT_SECRET;
        if (!clientId || !clientSecret) return null;

        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
        });

        const resp = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });

        if (!resp.ok) {
            const txt = await resp.text().catch(() => '');
            throw new Error(`refresh_token failed (${resp.status}): ${txt}`);
        }

        const json = (await resp.json()) as { access_token?: string; refresh_token?: string; scope?: string[] };
        if (!json.access_token) throw new Error('refresh_token response missing access_token');

        const next: ChannelRecord = {
            ...record,
            botAccessToken: json.access_token,
            botRefreshToken: json.refresh_token ?? record.botRefreshToken,
            scopes: json.scope ?? record.scopes,
            updatedAt: Date.now(),
        };

        await upsertChannel(next);
        return next;
    }

    async addChannel(record: ChannelRecord) {
        const chan = normalizeChan(record.login);
        this.channelRecords.set(chan, { ...record, login: chan });
        if (this.clients.has(chan) || this.connecting.has(chan)) return; // already connected or in-flight
        this.connecting.add(chan);

        let effectiveRecord = record;
        const hasAuth = Boolean(record.botAccessToken);
        if (hasAuth) {
            const tokenOk = await this.validateToken(record.botAccessToken!);
            if (!tokenOk) {
                try {
                    const refreshed = await this.refreshUserToken(record);
                    if (refreshed?.botAccessToken) {
                        effectiveRecord = refreshed;
                        console.log(`[twitch] Refreshed bot token for #${chan}`);
                    } else {
                        console.warn(`[twitch] Bot token invalid for #${chan} and no refresh available`);
                    }
                } catch (err) {
                    console.warn(`[twitch] Failed to refresh bot token for #${chan}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        } else {
            console.warn(`[twitch] No bot token for #${chan}; connecting anonymously (read-only)`);
        }

        const username = normalizeChan(effectiveRecord.login);
        const oauth = effectiveRecord.botAccessToken
            ? effectiveRecord.botAccessToken.startsWith('oauth:')
                ? effectiveRecord.botAccessToken
                : `oauth:${effectiveRecord.botAccessToken}`
            : undefined;

        const authMode: ConnectedClient['authMode'] = oauth ? 'oauth' : 'anonymous';

        const client = new Client({
            options: { debug: process.env.TMI_DEBUG === 'true' },
            connection: { reconnect: true, secure: true },
            ...(oauth ? { identity: { username, password: oauth } } : {}),
            channels: [chan],
        });

        client.on('connecting', (addr: string, port: number) => {
            console.log(`[twitch] Connecting to #${chan} via ${addr}:${port} as ${oauth ? username : 'anonymous'}`);
        });

        client.on('connected', (addr: string, port: number) => {
            console.log(`[twitch] Connected to #${chan} via ${addr}:${port}`);
            this.clearReconnectTimer(chan);
        });

        client.on('reconnect', () => {
            console.warn(`[twitch] Reconnecting to #${chan}...`);
        });

        client.on('notice', (_channel: string, msgid: string, message: string) => {
            // Auth failures and join issues often surface only as NOTICE events.
            console.warn(`[twitch] Notice for #${chan}: ${msgid} - ${message}`);
            const authProblem = message.toLowerCase().includes('authentication failed') || message.toLowerCase().includes('login authentication failed');
            if (authProblem) {
                this.clients.delete(chan);
                this.scheduleReconnect({ ...effectiveRecord, login: chan }, 'auth notice');
            }
        });

        client.on('disconnected', (reason: string) => {
            console.warn(`[twitch] Disconnected from #${chan}: ${reason}`);
            this.clients.delete(chan);
            this.scheduleReconnect({ ...effectiveRecord, login: chan }, reason || 'disconnected');
        });

        client.on('message', (_channel: string, tags: ChatUserstate, message: string, self: boolean) => {
            if (self) return;
            const raw = message.trim();
            if (!raw.startsWith('!')) return;

            const [cmd, ...args] = raw.slice(1).split(/\s+/);
            const isBroadcaster = Boolean(tags.badges?.broadcaster === '1' || (chan && tags.username?.toLowerCase() === chan));
            const isMod = Boolean(tags.mod) || isBroadcaster;
            const payload: ChatCommandEvent = {
                username: tags['display-name'] ?? tags.username ?? 'anon',
                command: cmd.toLowerCase(),
                args,
                isMod,
                isBroadcaster,
                channel: chan,
            };

            try {
                const sendChat = (text: string) => this.say(chan, text);
                const result = this.onChatCommand(this.io, payload, sendChat);
                if (result && typeof (result as any).catch === 'function') {
                    (result as Promise<void>).catch((err) => console.error('[twitch] Command handler rejected', err));
                }
            } catch (err) {
                console.error('[twitch] Command handler threw', err);
            }
        });

        try {
            await client.connect();
            this.clients.set(chan, { channel: chan, client, authMode });
        } catch (err) {
            console.error(`[twitch] Connection failed for #${chan}`, err);
            this.scheduleReconnect({ ...effectiveRecord, login: chan }, 'initial connect failed', 7500);
        } finally {
            this.connecting.delete(chan);
        }
    }

    async ensureConnected(record: ChannelRecord) {
        const chan = normalizeChan(record.login);
        const existing = this.clients.get(chan);
        if (!existing) {
            return this.addChannel(record);
        }
        const state = typeof (existing.client as any).readyState === 'function' ? (existing.client as any).readyState() : 'OPEN';
        if (state !== 'OPEN') {
            try {
                await existing.client.disconnect();
            } catch {
                // ignore
            }
            this.clients.delete(chan);
            return this.addChannel(record);
        }
    }

    async say(channel: string, message: string) {
        const key = normalizeChan(channel);
        const entry = this.clients.get(key);
        if (!entry) throw new Error(`Not connected to #${channel}`);
        if (entry.authMode !== 'oauth') throw new Error(`Bot is not authenticated to speak in #${channel}`);
        const target = channel.startsWith('#') ? channel : `#${channel}`;
        await entry.client.say(target, message);
    }
}