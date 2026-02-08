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

function normalizeLogin(login: string | undefined): string {
    return (login || '').replace(/^#/, '').toLowerCase();
}

function sanitizeRecord(rec: ChannelRecord): ChannelRecord {
    const login = normalizeLogin(rec.login);
    const channelId = rec.channelId || login;
    return { ...rec, login, channelId };
}

async function readStore(): Promise<ChannelRecord[]> {
    try {
        const raw = await fs.readFile(storePath, 'utf8');
        const parsed = JSON.parse(raw) as ChannelRecord[];
        return parsed.map(sanitizeRecord);
    } catch (err: any) {
        if (err?.code === 'ENOENT') return [];
        throw err;
    }
}

async function writeStore(records: ChannelRecord[]) {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    const sanitized = records.map(sanitizeRecord);
    await fs.writeFile(storePath, JSON.stringify(sanitized, null, 2), 'utf8');
}

export async function upsertChannel(rec: ChannelRecord): Promise<void> {
    const records = await readStore();
    const normalized = sanitizeRecord(rec);
    const existing = records.find((r) => r.channelId === normalized.channelId || normalizeLogin(r.login) === normalized.login);
    const now = Date.now();
    const next: ChannelRecord = { ...normalized, updatedAt: now };
    if (existing) {
        Object.assign(existing, next);
    } else {
        records.push(next);
    }
    await writeStore(records);
}

export async function getChannelByLogin(login: string): Promise<ChannelRecord | null> {
    const records = await readStore();
    const target = normalizeLogin(login);
    return records.find((r) => r.login === target) ?? null;
}

export async function getChannelById(channelId: string): Promise<ChannelRecord | null> {
    const records = await readStore();
    return records.find((r) => r.channelId === channelId) ?? null;
}

export async function listChannels(): Promise<ChannelRecord[]> {
    return readStore();
}

export async function cleanupChannels(): Promise<{ before: number; after: number; removed: string[] }> {
    const records = await readStore();
    const before = records.length;

    const isPlaceholderLogin = (login: string) => {
        const v = login.toLowerCase().trim();
        if (!v) return true;
        if (v === 'default') return true;
        if (v === 'your_bot_username') return true;
        if (v === 'your_twitch_channel') return true;
        if (v.includes('your_')) return true;
        if (v.includes('example')) return true;
        return false;
    };

    const byLogin = new Map<string, ChannelRecord>();
    const removed: string[] = [];

    for (const rec of records) {
        const login = (rec.login ?? '').toLowerCase().trim();
        const hasAuth = Boolean(rec.botAccessToken || rec.botRefreshToken);

        // Drop placeholders and useless entries.
        if (isPlaceholderLogin(login) || !hasAuth) {
            removed.push(rec.login);
            continue;
        }

        const existing = byLogin.get(login);
        if (!existing) {
            byLogin.set(login, rec);
            continue;
        }

        // Prefer records with access tokens, then refresh tokens, then most recent.
        const score = (r: ChannelRecord) => (r.botAccessToken ? 2 : r.botRefreshToken ? 1 : 0);
        const a = score(existing);
        const b = score(rec);
        if (b > a || (b === a && (rec.updatedAt ?? 0) > (existing.updatedAt ?? 0))) {
            removed.push(existing.login);
            byLogin.set(login, rec);
        } else {
            removed.push(rec.login);
        }
    }

    const cleaned = Array.from(byLogin.values());
    await writeStore(cleaned);

    return { before, after: cleaned.length, removed };
}
