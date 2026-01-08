import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import { PlayerStatePublic, StoreItem, TradeListing, UpgradeDefinition, PoleSkinId, Catalog, ThemePalette, OverlayEvent } from '../shared/types';
import './styles/panel.css';

declare global {
  interface Window {
    Twitch?: any;
  }
}

const apiBase = ((import.meta as any)?.env?.VITE_API_BASE || '').replace(/\/$/, '');
const socketUrl = ((import.meta as any)?.env?.VITE_SOCKET_URL || apiBase || window.location.origin).replace(/\/$/, '');

function apiUrl(path: string) {
  const safePath = path.startsWith('/') ? path : `/${path}`;
  return `${apiBase}${safePath}`;
}

async function fetchState(devMode?: boolean) {
  const res = await fetch(apiUrl('/api/state'), {
    credentials: 'include',
  });
  if (res.status === 401) throw new Error('Not authenticated');
  if (!res.ok) throw new Error('Failed to load state');
  return res.json() as Promise<{ state: PlayerStatePublic; store: StoreItem[]; upgrades: UpgradeDefinition[]; tradeBoard: TradeListing[]; storeExpiresAt: number; storeRefreshRemainingMs: number; catalogVersion?: string }>;
}

async function panelPost(path: string, body: Record<string, any> = {}) {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error('Not authenticated');
  if (!res.ok) {
    // Try to surface a clean error message instead of raw JSON
    let msg = 'Request failed';
    try {
      const data = await res.json();
      msg = data?.error || data?.message || msg;
    } catch {
      const text = await res.text();
      msg = text || msg;
    }
    throw new Error(msg);
  }
}

const fallbackCraftingRecipes = [
  { id: 'crafting-booster-kit', name: 'Crafting Booster Kit', costs: { 'tide-shard': 2, 'ember-fragment': 1 }, desc: 'Improves your next craft outcome.' },
  { id: 'enchanters-spark', name: "Enchanter's Spark", costs: { 'ember-fragment': 2, 'abyssal-ink': 1, 'frost-crystal': 1 }, desc: 'Guarantees minor enchant success.' },
  { id: 'tide-luck-charm', name: 'Tide Luck Charm', costs: { 'tide-shard': 3, 'astral-fiber': 1 }, desc: 'Boosts rarity for 3 minutes.' },
  { id: 'synthesize-cosmic-dust', name: 'Synthesize Cosmic Dust', costs: { 'astral-fiber': 6, 'frost-crystal': 5, 'abyssal-ink': 4 }, desc: 'Refine high-tier mats into 1 Cosmic Dust.' },
];

const fallbackEssences: Array<{ id: string; label: string }> = [
  { id: 'spark-essence', label: 'Spark Essence (+5% rarity)' },
  { id: 'echo-essence', label: 'Echo Essence (+8% rarity)' },
  { id: 'mythic-essence', label: 'Mythic Essence (+12% rarity)' },
];

const palettePresets = [
  {
    id: 'deep-blue',
    label: 'Deep Blue',
    colors: {
      bg: '#0b1524',
      surface: '#0f1d30',
      surface2: '#111c2f',
      border: 'rgba(120, 166, 255, 0.25)',
      text: '#e8f0ff',
      muted: '#9fb3c8',
    },
  },
  {
    id: 'slate',
    label: 'Slate',
    colors: {
      bg: '#0c0f14',
      surface: '#12171f',
      surface2: '#171d26',
      border: 'rgba(140, 160, 185, 0.35)',
      text: '#e6edf3',
      muted: '#9aa7b8',
    },
  },
  {
    id: 'teal-drift',
    label: 'Teal Drift',
    colors: {
      bg: '#071a1f',
      surface: '#0b2229',
      surface2: '#0e2a32',
      border: 'rgba(93, 190, 194, 0.35)',
      text: '#e5fbff',
      muted: '#8fb5b9',
    },
  },
  {
    id: 'warm-dusk',
    label: 'Warm Dusk',
    colors: {
      bg: '#130f0f',
      surface: '#1a1414',
      surface2: '#211818',
      border: 'rgba(255, 194, 153, 0.3)',
      text: '#f7ede2',
      muted: '#d6c3b5',
    },
  },
];

const poleSkinNames: Record<PoleSkinId, string> = {
  classic: 'Classic Oak',
  carbon: 'Carbon Pro',
  neon: 'Neon Flux',
  aurora: 'Aurora Drift',
};

function applyTheme(theme?: ThemePalette) {
  if (!theme) return;
  const root = document.documentElement;
  root.style.setProperty('--bg', theme.background);
  root.style.setProperty('--bg-alt', theme.backgroundAlt);
  root.style.setProperty('--panel', theme.panel);
  root.style.setProperty('--panel-border', theme.panelBorder);
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--accent-soft', theme.accentSoft);
  root.style.setProperty('--text', theme.text);
  root.style.setProperty('--muted', theme.muted);
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace('#', '');
  const bigint = parseInt(normalized, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function applyPalette(colors?: { bg?: string; surface?: string; surface2?: string; border?: string; text?: string; muted?: string; bgAlt?: string }) {
  if (!colors) return;
  const root = document.documentElement;
  if (colors.bg) root.style.setProperty('--bg', colors.bg);
  if (colors.bgAlt) root.style.setProperty('--bg-alt', colors.bgAlt);
  if (colors.surface) root.style.setProperty('--surface', colors.surface);
  if (colors.surface2) root.style.setProperty('--surface-2', colors.surface2);
  if (colors.border) root.style.setProperty('--border', colors.border);
  if (colors.text) root.style.setProperty('--text', colors.text);
  if (colors.muted) root.style.setProperty('--muted', colors.muted);
}

function App() {
  const [session, setSession] = useState<{ login: string; displayName?: string } | null>(null);
  const [state, setState] = useState<PlayerStatePublic | null>(null);
  const [store, setStore] = useState<StoreItem[]>([]);
  const [upgrades, setUpgrades] = useState<UpgradeDefinition[]>([]);
  const [tradeBoard, setTradeBoard] = useState<TradeListing[]>([]);
  const [storeExpiresAt, setStoreExpiresAt] = useState<number | null>(null);
  const [storeRefreshRemaining, setStoreRefreshRemaining] = useState<number | null>(null);
  const [storeCooldownCapturedAt, setStoreCooldownCapturedAt] = useState<number>(Date.now());
  const [autoRefreshText, setAutoRefreshText] = useState<string>('—');
  const [manualRefreshText, setManualRefreshText] = useState<string>('Ready');
  const [status, setStatus] = useState<string>('Waiting for authorization...');
  const [loading, setLoading] = useState<boolean>(false);
  const [listItemId, setListItemId] = useState<string>('');
  const [listPrice, setListPrice] = useState<string>('100');
  const [sellItemId, setSellItemId] = useState<string>('');
  const [useItemName, setUseItemName] = useState<string>('');
  const [enchantEssence, setEnchantEssence] = useState<string>('spark-essence');
  const [equipSkinId, setEquipSkinId] = useState<PoleSkinId>('classic');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogVersion, setCatalogVersion] = useState<string | null>(null);
  const socketRef = useRef<ReturnType<typeof io> | null>(null);
  const [activeTab, setActiveTab] = useState<'play' | 'inventory' | 'store' | 'upgrades' | 'trade' | 'craft'>('play');
  const [accentColor, setAccentColor] = useState<string>('#7ad7ff');
  const [showLoginPreview, setShowLoginPreview] = useState<boolean>(false);
  const [selectedThemeId, setSelectedThemeId] = useState<string>('');
  const [selectedPaletteId, setSelectedPaletteId] = useState<string>('');

  const tabs: Array<{ key: typeof activeTab; label: string }> = [
    { key: 'play', label: 'Play' },
    { key: 'inventory', label: 'Inventory' },
    { key: 'store', label: 'Store' },
    { key: 'upgrades', label: 'Upgrades' },
    { key: 'trade', label: 'Trade' },
    { key: 'craft', label: 'Craft' },
  ];

  const handleAuthLost = (message?: string) => {
    setSession(null);
    setState(null);
    setStore([]);
    setUpgrades([]);
    setTradeBoard([]);
    setStatus(message || 'Login required');
  };

  const logout = async () => {
    try {
      await fetch(apiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include' });
    } catch {
      // ignore
    }
    handleAuthLost('Logged out');
  };

  const reauth = () => {
    window.location.href = apiUrl('/api/auth/login');
  };

  const panelDevFlag = (typeof process !== 'undefined' && (process as any).env?.VITE_PANEL_DEV) || (window as any).__PANEL_DEV__;
  const devMode = typeof window !== 'undefined' && (window.location.search.includes('dev=1') || panelDevFlag === 'true' || panelDevFlag === true);

  const xpPct = useMemo(() => {
    if (!state) return 0;
    return Math.min(100, Math.round((state.xp / state.xpNeeded) * 100));
  }, [state]);

  const availableThemes = useMemo(() => {
    const uiThemes = catalog?.ui?.themes ?? (catalog?.ui?.theme ? [catalog.ui.theme] : []);
    return uiThemes?.map((t, idx) => ({ id: t.name || `theme-${idx}`, label: t.name || `Theme ${idx + 1}`, value: t })) || [];
  }, [catalog]);

  const availablePalettes = useMemo(() => palettePresets, []);

  const applyAccent = (accent?: string) => {
    const root = document.documentElement;
    if (accent) {
      root.style.setProperty('--accent', accent);
      root.style.setProperty('--accent-soft', hexToRgba(accent, 0.18));
    }
  };

  const baseTheme = useMemo(() => {
    const chosen = availableThemes.find((t) => t.id === selectedThemeId)?.value;
    return (chosen || catalog?.ui?.theme || catalog?.ui?.themes?.[0]) as ThemePalette | undefined;
  }, [availableThemes, selectedThemeId, catalog]);

  useEffect(() => {
    if (!state) return;
    const current = state.poleSkinId;
    const owned = state.ownedPoleSkins && state.ownedPoleSkins.length ? state.ownedPoleSkins : [current];
    setEquipSkinId(owned.includes(current) ? current : owned[0]);
  }, [state]);

  useEffect(() => {
    const savedAccent = localStorage.getItem('panel-accent');
    if (savedAccent) {
      setAccentColor(savedAccent);
      applyAccent(savedAccent);
    } else {
      applyAccent(accentColor);
    }
    const savedPalette = localStorage.getItem('panel-palette-id');
    if (savedPalette) setSelectedPaletteId(savedPalette);
    const savedTheme = localStorage.getItem('panel-theme-id');
    if (savedTheme) setSelectedThemeId(savedTheme);
  }, []);

  useEffect(() => {
    if (baseTheme) applyTheme(baseTheme);
    applyAccent(accentColor);
    if (selectedPaletteId) {
      const pal = availablePalettes.find((p) => p.id === selectedPaletteId);
      if (pal) applyPalette(pal.colors);
    }
  }, [baseTheme, accentColor, selectedPaletteId, availablePalettes]);

  useEffect(() => {
    applyAccent(accentColor);
    localStorage.setItem('panel-accent', accentColor);
  }, [accentColor]);

  useEffect(() => {
    localStorage.setItem('panel-palette-id', selectedPaletteId || '');
  }, [selectedPaletteId]);

  const recipeList = useMemo(() => {
    if (catalog?.recipes?.length) {
      return catalog.recipes.map((r) => ({
        id: r.id,
        name: r.name,
        costs: r.costs ?? {},
        desc: r.description || r.grants?.description || 'Craft',
      }));
    }
    return fallbackCraftingRecipes;
  }, [catalog]);

  const essenceOptions = useMemo(() => {
    if (catalog?.essences?.length) {
      return catalog.essences.map((e) => ({ id: e.id, label: e.description ? `${e.name} (${e.description})` : e.name }));
    }
    return fallbackEssences;
  }, [catalog]);

  useEffect(() => {
    if (!enchantEssence && essenceOptions.length) {
      setEnchantEssence(essenceOptions[0].id);
    }
  }, [enchantEssence, essenceOptions]);

  const applyStatePayload = ({ state: st, store, upgrades, tradeBoard, storeExpiresAt, storeRefreshRemainingMs, catalogVersion }: { state: PlayerStatePublic; store: StoreItem[]; upgrades: UpgradeDefinition[]; tradeBoard: TradeListing[]; storeExpiresAt: number; storeRefreshRemainingMs: number; catalogVersion?: string }) => {
    setState(st);
    setStore(store || []);
    setUpgrades(upgrades || []);
    setTradeBoard(tradeBoard || []);
    setStoreExpiresAt(storeExpiresAt ?? null);
    setStoreRefreshRemaining(storeRefreshRemainingMs ?? null);
    setStoreCooldownCapturedAt(Date.now());
    if (catalogVersion) setCatalogVersion(catalogVersion);
  };

  const loadCatalog = async () => {
    try {
      const res = await fetch(apiUrl('/api/catalog'));
      if (!res.ok) throw new Error('Failed to load catalog');
      const data = (await res.json()) as Catalog;
      setCatalog(data);
      setCatalogVersion(data.version);
      const theme = data.ui?.theme ?? data.ui?.themes?.[0];
      applyTheme(theme);
    } catch (err) {
      console.warn('Catalog fetch failed', err);
    }
  };

  // Live socket sync: mirror overlay events into the panel so inventory/store stay instant
  useEffect(() => {
    // Twitch panel CSP blocks wss; force polling in production panel to keep live updates
    const transports = devMode ? ['websocket', 'polling'] : ['polling'];
    const socket = io(socketUrl, { transports, upgrade: devMode, withCredentials: true });
    socketRef.current = socket;

    socket.on('connect', () => {
      setStatus((prev) => (prev.startsWith('Waiting') ? 'Live sync connected' : prev));
    });

    socket.on('overlay-event', (evt: OverlayEvent) => {
      switch (evt.type) {
        case 'inventory':
          if (evt.state) {
            setState(evt.state);
            setStatus('Inventory updated');
          }
          break;
        case 'store':
          setStore(evt.items || []);
          setUpgrades(evt.upgrades || []);
          setStoreExpiresAt(evt.expiresAt ?? null);
          if (evt.locked?.remainingMs !== undefined) {
            setStoreRefreshRemaining(evt.locked.remainingMs);
            setStoreCooldownCapturedAt(Date.now());
          }
          setStatus(evt.locked ? evt.locked.reason : 'Store updated');
          break;
        case 'theme':
          applyTheme(evt.theme);
          break;
        case 'status':
          setStatus(evt.text);
          break;
        case 'skin':
          setState((prev) => (prev ? { ...prev, poleSkinId: evt.skinId } : prev));
          break;
        default:
          break;
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const ensureCatalog = async () => {
    if (catalog) return;
    await loadCatalog();
  };

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const meRes = await fetch(apiUrl('/api/auth/me'), { credentials: 'include' });
        if (meRes.ok) {
          const me = await meRes.json();
          setSession(me.session);
          setStatus('Authenticated, loading catalog...');
          await ensureCatalog();
          setStatus('Authenticated, loading state...');
          const payload = await fetchState(devMode);
          applyStatePayload(payload);
          const friendly = payload.state.displayName || payload.state.username;
          setStatus(`Welcome, ${friendly}`);
        } else {
          setStatus('Login required');
        }
      } catch (err: any) {
        setStatus(err?.message || 'Failed to load state');
      } finally {
        setLoading(false);
      }
    })();
  }, [devMode]);

  const refresh = async (msg?: string) => {
    if (!catalog) await ensureCatalog();
    try {
      const payload = await fetchState(devMode);
      applyStatePayload(payload);
      if (msg) setStatus(msg);
    } catch (err: any) {
      if ((err?.message || '').toLowerCase().includes('not authenticated')) {
        handleAuthLost('Session expired — please login again');
        return;
      }
      throw err;
    }
  };

  const doPanel = async (path: string, body: Record<string, any> = {}, msg?: string) => {
    if (!session && !devMode) return;
    setLoading(true);
    try {
      await panelPost(path, body);
      await refresh(msg);
    } catch (err: any) {
      if ((err?.message || '').toLowerCase().includes('not authenticated')) {
        handleAuthLost('Session expired — please login again');
      } else {
        setStatus(err?.message || 'Action failed');
      }
    } finally {
      setLoading(false);
    }
  };

  const doCastReel = async (command: 'cast' | 'reel') => {
    if (!session && !devMode) return;
    setLoading(true);
    try {
      await panelPost('/api/command', { command });
      await refresh(`Sent !${command}`);
    } catch (err: any) {
      if ((err?.message || '').toLowerCase().includes('not authenticated')) {
        handleAuthLost('Session expired — please login again');
      } else {
        setStatus(err?.message || 'Command failed');
      }
    } finally {
      setLoading(false);
    }
  };

  const usableItems = useMemo(() => {
    if (!state) return [] as PlayerStatePublic['inventory'];
    const usableTypes = new Set(['token', 'bait', 'chest', 'compass', 'map', 'scroll', 'upgrade']);
    return state.inventory.filter((i) => {
      if (i.type && usableTypes.has(i.type)) return true;
      // fallback: allow items with zero value but a description (likely consumables)
      if (!i.type && (i.description?.toLowerCase().includes('use') || i.value === 0)) return true;
      return false;
    });
  }, [state]);

  const ownedSkins = useMemo(() => {
    if (!state) return [] as PoleSkinId[];
    const unique = new Set<PoleSkinId>(state.ownedPoleSkins ?? []);
    unique.add(state.poleSkinId);
    return Array.from(unique);
  }, [state]);

  useEffect(() => {
    const formatMs = (ms: number | null) => {
      if (ms === null) return '—';
      if (ms <= 0) return 'Ready';
      const totalSec = Math.max(0, Math.floor(ms / 1000));
      const hours = Math.floor(totalSec / 3600);
      const mins = Math.floor((totalSec % 3600) / 60);
      const secs = totalSec % 60;
      if (hours > 0) return `${hours}h ${mins.toString().padStart(2, '0')}m`;
      return `${mins}m ${secs.toString().padStart(2, '0')}s`;
    };

    const interval = setInterval(() => {
      const now = Date.now();
      const autoMs = storeExpiresAt !== null ? storeExpiresAt - now : null;
      const manualMs = storeRefreshRemaining !== null ? storeRefreshRemaining - (now - storeCooldownCapturedAt) : 0;
      setAutoRefreshText(formatMs(autoMs));
      setManualRefreshText(formatMs(manualMs));
    }, 1000);

    return () => clearInterval(interval);
  }, [storeExpiresAt, storeRefreshRemaining, storeCooldownCapturedAt]);

  const skinLabel = (id: PoleSkinId) => {
    const found = catalog?.skins?.find((s) => s.id === id);
    return found?.name ?? poleSkinNames[id as PoleSkinId] ?? id;
  };

  const friendlyName = state ? (state.displayName || state.twitchLogin || state.username) : '';
  const loginSubtitle = state && state.twitchLogin && state.twitchLogin.toLowerCase() !== (friendlyName || '').toLowerCase()
    ? `@${state.twitchLogin}`
    : '';

  const renderLoginView = (isPreview?: boolean) => (
    <div className="login-screen">
      <div className="login-card">
        <div className="title">Fishing Panel</div>
        <div className="muted">Authorize with Twitch to enable chat commands and syncing.</div>
        <div className="button-row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => (window.location.href = apiUrl('/api/auth/login'))} disabled={loading}>
            Login with Twitch
          </button>
          <button className="ghost" onClick={() => window.open(apiUrl('/api/auth/login'), '_blank')} disabled={loading}>Open in new tab</button>
          {isPreview && (
            <button className="ghost" onClick={() => setShowLoginPreview(false)}>Close preview</button>
          )}
        </div>
      </div>
    </div>
  );

  const renderPlay = () => {
    if (!state) return null;
    return (
      <>
        <section className="card hero">
          <div className="hero-row">
            <div>
              <div className="title">{friendlyName}</div>
              {loginSubtitle && <div className="title-sub">{loginSubtitle}</div>}
              <div className="muted">Prestige {state.prestigeCount ?? 0}</div>
            </div>
            <div className="stat-chips">
              <span className="pill">Gold {state.gold}g</span>
              <span className="pill">Bag {state.inventory.length}/{state.inventoryCap}</span>
              <span className="pill">Pole {skinLabel(state.poleSkinId)}</span>
            </div>
          </div>
          <div className="progress">
            <div className="progress-label">Level {state.level} • XP {state.xp}/{state.xpNeeded}</div>
            <div className="progress-bar"><span style={{ width: `${xpPct}%` }} /></div>
          </div>
        </section>

        <section className="grid two">
          <div className="card">
            <div className="section-title">Unlocks</div>
            <div className="pill-row">
              <span className={`pill ${state.craftingUnlocked ? '' : 'pill-warn'}`}>Crafting {state.craftingUnlocked ? 'On' : 'Locked'}</span>
              <span className={`pill ${state.tradingUnlocked ? '' : 'pill-warn'}`}>Trading {state.tradingUnlocked ? 'On' : 'Locked'}</span>
              <span className={`pill ${state.enchantmentsUnlocked ? '' : 'pill-warn'}`}>Enchant {state.enchantmentsUnlocked ? 'On' : 'Locked'}</span>
            </div>
            {state.activeBuffs && (
              <div className="muted small">
                {state.activeBuffs.xp && <>XP +{Math.round((state.activeBuffs.xp.amount ?? 0) * 100)}% </>}
                {state.activeBuffs.value && <>Value +{Math.round((state.activeBuffs.value.amount ?? 0) * 100)}%</>}
              </div>
            )}
          </div>

          <div className="card">
            <div className="section-title">Resources</div>
            <div className="pill-row wrap">
              {state.materials && Object.entries(state.materials).map(([k, v]) => (
                <span key={k} className="pill pill-soft">{k}: {v}</span>
              ))}
              {state.essences && Object.entries(state.essences).map(([k, v]) => (
                <span key={k} className="pill pill-soft">{k}: {v}</span>
              ))}
              {!state.materials && !state.essences && <span className="muted small">No resources yet</span>}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="section-title">Rods & skins</div>
          <div className="muted">Equipped: {skinLabel(state.poleSkinId)}</div>
          <div className="form-row" style={{ gap: '8px', marginTop: 8, flexWrap: 'wrap' }}>
            <select value={equipSkinId} onChange={(e) => setEquipSkinId(e.target.value as PoleSkinId)}>
              {ownedSkins.map((id) => (
                <option key={id} value={id}>{skinLabel(id)}</option>
              ))}
            </select>
            <button className="primary" disabled={loading || ownedSkins.length === 0} onClick={() => doPanel('/api/panel/equip', { skin: equipSkinId }, `Equipped ${skinLabel(equipSkinId)}`)}>Equip</button>
          </div>
          <div className="muted" style={{ marginTop: 6 }}>Owned: {ownedSkins.map(skinLabel).join(', ') || 'None'}</div>
        </section>
      </>
    );
  };

  const renderInventory = () => {
    if (!state) return null;
    return (
      <>
        <section className="card">
          <div className="section-title">Inventory actions</div>
          <div className="form-row wrap">
            <select value={sellItemId} onChange={(e) => setSellItemId(e.target.value)} disabled={loading}>
              <option value="">Select item to sell</option>
              {state.inventory.map((i) => (
                <option key={i.id} value={i.name}>{i.name} ({i.rarity})</option>
              ))}
            </select>
            <button className="ghost" disabled={loading || !sellItemId} onClick={() => doPanel('/api/panel/sell', { name: sellItemId }, `Sold ${sellItemId}`)}>Sell Item</button>
            <button className="ghost" disabled={loading || state.inventory.length === 0} onClick={() => doPanel('/api/panel/sell', { sellAll: true }, 'Sold all sellable items')}>Sell All</button>
          </div>
          <div className="form-row wrap">
            <select value={useItemName} onChange={(e) => setUseItemName(e.target.value)} disabled={loading}>
              <option value="">Select usable item</option>
              {usableItems.map((i) => (
                <option key={i.id} value={i.name}>{i.name} ({i.rarity})</option>
              ))}
            </select>
            <button className="primary" disabled={loading || !useItemName} onClick={() => doPanel('/api/panel/use', { name: useItemName }, `Used ${useItemName}`)}>Use Item</button>
            <div className="muted tiny">Tip: chat still supports !use &lt;item&gt; for interactive engagement.</div>
          </div>
        </section>

        <section className="card">
          <div className="section-title">Inventory</div>
          {state.inventory.length === 0 ? <div className="muted">Empty</div> : (
            <div className="grid three">
              {state.inventory.map((i) => (
                <div key={i.id} className="subcard">
                  <div className="item-title">{i.name}</div>
                  <div className="muted tiny">{i.rarity} • {i.value}g</div>
                  {i.description && <div className="muted tiny">{i.description}</div>}
                </div>
              ))}
            </div>
          )}
        </section>
      </>
    );
  };

  const renderStore = () => (
    <section className="card">
      <div className="section-title">Store</div>
      <div className="muted tiny">Auto refresh in {autoRefreshText} • Manual refresh {manualRefreshText}</div>
      {store.length === 0 ? <div className="muted">No store items available.</div> : (
        <div className="grid three">
          {store.map((item) => (
            <div key={item.key} className="subcard">
              <div className="item-title">{item.name}</div>
              <div className="muted tiny">{item.rarity} • {item.cost}g{item.minLevel ? ` • Req ${item.minLevel}` : ''}</div>
              {item.description && <div className="muted tiny">{item.description}</div>}
              <button className="primary" disabled={loading} onClick={() => doPanel('/api/panel/buy', { itemKey: item.key }, `Bought ${item.name}`)}>Buy</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );

  const renderUpgrades = () => (
    <section className="card">
      <div className="section-title">Upgrades</div>
      {upgrades.length === 0 ? <div className="muted">No upgrades available.</div> : (
        <div className="grid three">
          {upgrades.map((u) => (
            <div key={u.key} className="subcard">
              <div className="item-title">{u.name}</div>
              <div className="muted tiny">{u.stat} • Cost {u.cost}g • Max {u.maxLevel}</div>
              <div className="muted tiny">{u.description}</div>
              <button className="primary" disabled={loading} onClick={() => doPanel('/api/panel/upgrades/buy', { upgradeKey: u.key }, `Bought ${u.name}`)}>Buy</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );

  const renderTrade = () => {
    if (!state) return null;
    return (
      <section className="card">
        <div className="section-title">Trading board</div>
        <div className="form-row wrap">
          <select value={listItemId} onChange={(e) => setListItemId(e.target.value)} disabled={loading}>
            <option value="">Select item to list</option>
            {state.inventory.map((i) => (
              <option key={i.id} value={i.id}>{i.name} ({i.rarity})</option>
            ))}
          </select>
          <input className="input" value={listPrice} onChange={(e) => setListPrice(e.target.value)} disabled={loading} />
          <button className="primary" disabled={loading || !listItemId} onClick={() => doPanel('/api/panel/trade/list', { itemId: listItemId, price: Number(listPrice) }, 'Listed item')}>List Item</button>
          <button className="ghost" disabled={loading} onClick={() => refresh('Trade board refreshed')}>Refresh Board</button>
        </div>
        {tradeBoard.length === 0 ? <div className="muted">No active listings.</div> : (
          <div className="grid three">
            {tradeBoard.map((l) => {
              const isSeller = l.seller === state.username;
              return (
                <div key={l.id} className="subcard">
                  <div className="item-title">{l.item.name}</div>
                  <div className="muted tiny">{l.item.rarity} • {l.price}g • Seller: {l.seller}</div>
                  <div className="button-row">
                    {isSeller ? (
                      <button className="ghost" disabled={loading} onClick={() => doPanel('/api/panel/trade/cancel', { listingId: l.id }, 'Listing cancelled')}>Cancel</button>
                    ) : (
                      <button className="primary" disabled={loading} onClick={() => doPanel('/api/panel/trade/buy', { listingId: l.id }, 'Bought item')}>Buy</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    );
  };

  const renderCraft = () => (
    <section className="grid two">
      <div className="card">
        <div className="section-title">Crafting</div>
        <div className="muted small">Spend materials to craft boosts.</div>
        <div className="grid three">
          {recipeList.map((r) => (
            <div key={r.id} className="subcard">
              <div className="item-title">{r.name}</div>
              <div className="muted small">{r.desc}</div>
              <div className="muted tiny">Costs: {Object.entries(r.costs).map(([k, v]) => `${k} x${v}`).join(', ')}</div>
              <button className="primary" disabled={loading || !(state && state.craftingUnlocked)} onClick={() => doPanel('/api/panel/craft', { recipeId: r.id }, `Crafted ${r.name}`)}>Craft</button>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="section-title">Enchant (rod)</div>
        <div className="muted small">Use essences to add rarity/value bonuses.</div>
        <div className="form-row">
          <select value={enchantEssence} onChange={(e) => setEnchantEssence(e.target.value as any)} disabled={loading}>
            {essenceOptions.map((e) => (
              <option key={e.id} value={e.id}>{e.label}</option>
            ))}
          </select>
          <button className="primary" disabled={loading || !(state && state.enchantmentsUnlocked)} onClick={() => doPanel('/api/panel/enchant', { essence: enchantEssence, targetKind: 'rod' }, 'Enchanted rod')}>Enchant Rod</button>
        </div>
      </div>
    </section>
  );

  if (!session && !devMode) {
    return (
      <div className="panel-shell">
        {renderLoginView()}
      </div>
    );
  }

  return (
    <div className="panel-shell">
      <div className="sticky-top">
        <header className="panel-header">
          <div>
            <div className="eyebrow">Fishing Panel</div>
            <div className="status-text">{status}</div>
          </div>
          <div className="header-actions">
            {devMode && <span className="pill pill-dev">Dev mode</span>}
            {!devMode && session && (
              <>
                <button className="ghost" disabled={loading} onClick={reauth}>Re-auth</button>
                <button className="ghost" disabled={loading} onClick={logout}>Logout</button>
              </>
            )}
            <button className="ghost" disabled={loading} onClick={() => window.open(apiUrl('/api/auth/login'), '_blank')}>View auth</button>
            <button className="ghost" onClick={() => setShowLoginPreview(true)}>Preview login</button>
            <button className="ghost" disabled={loading} onClick={() => refresh('Synced')}>Refresh</button>
          </div>
        </header>

        <div className="theme-controls">
          {availableThemes.length > 0 && (
            <label className="theme-control">
              <span className="muted tiny">Theme</span>
              <select
                value={selectedThemeId}
                onChange={(e) => {
                  setSelectedThemeId(e.target.value);
                  localStorage.setItem('panel-theme-id', e.target.value);
                }}
              >
                <option value="">Catalog default</option>
                {availableThemes.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </label>
          )}
          <label className="theme-control">
            <span className="muted tiny">Panel palette</span>
            <select
              value={selectedPaletteId}
              onChange={(e) => setSelectedPaletteId(e.target.value)}
            >
              <option value="">Theme default</option>
              {availablePalettes.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          <label className="theme-control">
            <span className="muted tiny">Accent</span>
            <input type="color" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} />
          </label>
        </div>

        <div className="tab-strip">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={`tab ${activeTab === t.key ? 'active' : ''}`}
              onClick={() => setActiveTab(t.key)}
              disabled={loading}
            >
              {t.label}
            </button>
          ))}
        </div>

        <section className="card quick-card">
          <div className="section-title">Quick actions</div>
          <div className="button-row">
            <button className="primary" disabled={!state || loading} onClick={() => doCastReel('cast')}>Cast</button>
            <button className="primary" disabled={!state || loading} onClick={() => doCastReel('reel')}>Reel</button>
            <button className="ghost" disabled={!state || loading} onClick={() => doPanel('/api/panel/store/refresh', {}, 'Store refreshed')}>Refresh Store</button>
            <button className="ghost" disabled={!state || loading} onClick={() => refresh('Inventory synced')}>Sync Inventory</button>
          </div>
        </section>
      </div>

      {state && (
        <div className="layout">
          {activeTab === 'play' && renderPlay()}
          {activeTab === 'inventory' && renderInventory()}
          {activeTab === 'store' && renderStore()}
          {activeTab === 'upgrades' && renderUpgrades()}
          {activeTab === 'trade' && renderTrade()}
          {activeTab === 'craft' && renderCraft()}
        </div>
      )}

      {showLoginPreview && (
        <div className="login-overlay">
          {renderLoginView(true)}
        </div>
      )}
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
