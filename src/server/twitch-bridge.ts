import { ChatUserstate, Client } from 'tmi.js';
import { Server } from 'socket.io';
import { ChatCommandEvent } from '../shared/types';

export function initializeTwitchBridge(
    io: Server,
    onChatCommand: (io: Server, payload: ChatCommandEvent) => void
) {
    const channel = process.env.TWITCH_CHANNEL ?? '';
    const username = process.env.TWITCH_USERNAME ?? '';
    const oauth = process.env.TWITCH_OAUTH_TOKEN ?? '';

    // Skip connecting to Twitch chat if required config is missing to keep the server running.
    if (!channel || !username || !oauth) {
        console.warn('[twitch] Missing TWITCH_CHANNEL / TWITCH_USERNAME / TWITCH_OAUTH_TOKEN; skipping chat bridge');
        return;
    }

    const twitchClient = new Client({
        options: { debug: false },
        identity: {
            username,
            password: oauth,
        },
        channels: [channel],
    });

    twitchClient.on('connected', (addr: string, port: number) => {
        console.log(`[twitch] Connected to #${channel} via ${addr}:${port}`);
    });

    twitchClient.on('disconnected', (reason: string) => {
        console.warn(`[twitch] Disconnected: ${reason}`);
    });

    twitchClient.on('message', (_channel: string, tags: ChatUserstate, message: string, self: boolean) => {
        if (self) return;
        const raw = message.trim();
        if (!raw.startsWith('!')) return;

        const [cmd, ...args] = raw.slice(1).split(/\s+/);
        const chan = channel.toLowerCase();
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

        onChatCommand(io, payload);
    });

    twitchClient.connect().catch((err: unknown) => {
        console.error('Twitch connection failed', err);
    });
}