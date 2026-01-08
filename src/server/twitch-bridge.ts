import { ChatUserstate, Client } from 'tmi.js';
import { Server } from 'socket.io';
import { ChatCommandEvent } from '../shared/types';
import { ChannelRecord } from './channel-store';

type ConnectedClient = {
    channel: string;
    client: Client;
};

export class ChatBridge {
    private io: Server;
    private onChatCommand: (io: Server, payload: ChatCommandEvent) => void;
    private clients: Map<string, ConnectedClient> = new Map(); // channel -> client

    constructor(io: Server, onChatCommand: (io: Server, payload: ChatCommandEvent) => void) {
        this.io = io;
        this.onChatCommand = onChatCommand;
    }

    async addChannel(record: ChannelRecord) {
        const chan = record.login.toLowerCase();
        if (!record.botAccessToken) {
            console.warn(`[twitch] Missing bot token for ${chan}; skipping chat join`);
            return;
        }
        if (this.clients.has(chan)) return; // already connected

        const username = record.login;
        const oauth = record.botAccessToken.startsWith('oauth:') ? record.botAccessToken : `oauth:${record.botAccessToken}`;

        const client = new Client({
            options: { debug: false },
            identity: { username, password: oauth },
            channels: [chan],
        });

        client.on('connected', (addr: string, port: number) => {
            console.log(`[twitch] Connected to #${chan} via ${addr}:${port}`);
        });

        client.on('disconnected', (reason: string) => {
            console.warn(`[twitch] Disconnected from #${chan}: ${reason}`);
            this.clients.delete(chan);
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

            this.onChatCommand(this.io, payload);
        });

        try {
            await client.connect();
            this.clients.set(chan, { channel: chan, client });
        } catch (err) {
            console.error(`[twitch] Connection failed for #${chan}`, err);
        }
    }
}