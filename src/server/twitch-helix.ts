import dotenv from 'dotenv';

dotenv.config();

type HelixUser = { id: string; login: string; display_name: string };

// Use the global fetch (Node 18+) without pulling in DOM typings
const fetchFn: (url: string, init?: any) => Promise<any> = (globalThis as any).fetch;

const userCache = new Map<string, { displayName?: string; login?: string; expiresAt: number }>();
let appToken: { token: string; expiresAt: number } | null = null;
const tokenSkewMs = 60 * 1000; // refresh 60s early

async function getAppToken(): Promise<string | null> {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;

    const now = Date.now();
    if (appToken && appToken.expiresAt > now + tokenSkewMs) {
        return appToken.token;
    }

    const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
    });

    if (!fetchFn) return null;

    const resp = await fetchFn(`https://id.twitch.tv/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
    });

    if (!resp.ok) return null;
    const data = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token || !data.expires_in) return null;

    appToken = {
        token: data.access_token,
        expiresAt: now + data.expires_in * 1000,
    };
    return appToken.token;
}

export async function fetchTwitchUser(userId: string): Promise<{ displayName?: string; login?: string } | null> {
    if (!userId) return null;
    const now = Date.now();
    const cached = userCache.get(userId);
    if (cached && cached.expiresAt > now) return { displayName: cached.displayName, login: cached.login };

    const token = await getAppToken();
    const clientId = process.env.TWITCH_CLIENT_ID;
    if (!token || !clientId || !fetchFn) return null;

    const resp = await fetchFn(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(userId)}`, {
        headers: {
            'Client-ID': clientId,
            Authorization: `Bearer ${token}`,
        },
    });

    if (!resp.ok) return null;
    const data = (await resp.json()) as { data?: HelixUser[] };
    const user = data?.data?.[0];
    if (!user) return null;

    const result = { displayName: user.display_name || user.login, login: user.login };
    userCache.set(userId, { ...result, expiresAt: now + 10 * 60 * 1000 });
    return result;
}
