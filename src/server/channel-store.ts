import fs from 'fs/promises';
import path from 'path';
import { resolveInDataDir } from './data-dir';

export type ChannelRecord = {
    channelId: string;
    login: string;
    displayName?: string;
    botAccessToken?: string;
    botRefreshToken?: string;
    scopes?: string[];
    updatedAt: number;
};

const storePath = resolveInDataDir('channels.json');

async function readStore(): Promise<ChannelRecord[]> {
    try {
        const raw = await fs.readFile(storePath, 'utf8');
        return JSON.parse(raw) as ChannelRecord[];
    } catch (err: any) {
        if (err?.code === 'ENOENT') return [];
        throw err;
    }
}

async function writeStore(records: ChannelRecord[]) {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(records, null, 2), 'utf8');
}

export async function upsertChannel(rec: ChannelRecord): Promise<void> {
    const records = await readStore();
    const existing = records.find((r) => r.channelId === rec.channelId || r.login.toLowerCase() === rec.login.toLowerCase());
    const now = Date.now();
    const next: ChannelRecord = { ...rec, updatedAt: now };
    if (existing) {
        Object.assign(existing, next);
    } else {
        records.push(next);
    }
    await writeStore(records);
}

export async function getChannelByLogin(login: string): Promise<ChannelRecord | null> {
    const records = await readStore();
    return records.find((r) => r.login.toLowerCase() === login.toLowerCase()) ?? null;
}

export async function getChannelById(channelId: string): Promise<ChannelRecord | null> {
    const records = await readStore();
    return records.find((r) => r.channelId === channelId) ?? null;
}

export async function listChannels(): Promise<ChannelRecord[]> {
    return readStore();
}
