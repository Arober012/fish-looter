import React, { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { Catalog, InventoryItem, OverlayEvent, PoleSkinId, Rarity, ThemePalette } from '../shared/types';

const socketUrl = import.meta.env.VITE_SOCKET_URL ?? window.location.origin;

type LineState = 'idle' | 'casting' | 'casted' | 'tug' | 'reeling' | 'caught' | 'miss';
type LinePose = { bx: number; by: number; sag: number; tension: number };
type TipAnchor = { x: number; y: number };

type CatchSummary = {
  success: boolean;
  item?: InventoryItem;
  goldEarned?: number;
  xpGained?: number;
  rarity?: Rarity;
};

const rarityColors: Record<Rarity, string> = {
  common: '#9fb3c8',
  uncommon: '#6bd38c',
  rare: '#5db3ff',
  epic: '#c084fc',
  legendary: '#f6c344',
  mythic: '#ff8dd1',
  relic: '#ffdf7f',
};

const poleStyles: Record<string, { grip: string; rod: string; tip: string; line: string; bobber: string; thickness: number }> = {
  classic: { grip: '#8b6b3e', rod: '#caa474', tip: '#ac814a', line: '#d7e3ff', bobber: '#7ad7ff', thickness: 2.4 },
  carbon: { grip: '#1f1f23', rod: '#2c2f36', tip: '#4a4f5a', line: '#8ad8ff', bobber: '#6bd38c', thickness: 2.6 },
  neon: { grip: '#222038', rod: '#2f2c55', tip: '#ff5cf3', line: '#ff8dd1', bobber: '#5db3ff', thickness: 2.4 },
  aurora: { grip: '#1b2438', rod: '#304c74', tip: '#8ae0ff', line: '#c084fc', bobber: '#f6c344', thickness: 2.4 },
};

// Fixed per-skin tip anchors in the 320x200 viewBox
const tipAnchors: Record<string, TipAnchor> = {
  classic: { x: 190, y: 25 },
  carbon: { x: 197, y: 19 },
  neon: { x: 194, y: 23 },
  aurora: { x: 197, y: 19 },
};

const skinImageSrc: Record<string, string> = {
  classic: '/skins/wooden_rod.png',
  carbon: '/skins/carbon_rod.png',
  neon: '/skins/neon_rod.png',
  aurora: '/skins/aura_rod.png',
};

const biomeImages: Record<string, string> = {
  'cove': '/biomes/midnight_cove.png',
  'ember-reef': '/biomes/ember_reef.png',
  'abyssal-gulf': '/biomes/abyssal_gulf.png',
  'crystal-fjord': '/biomes/crystal_fjord.png',
  'astral-lagoon': '/biomes/astral_lagoon.png',
};

function LineScene({ state, lastCatch, skin, tip, skinImage }: { state: LineState; lastCatch?: CatchSummary; skin: PoleSkinId; tip: TipAnchor; skinImage?: string }) {
  const palette = poleStyles[skin] ?? poleStyles.classic;
  const lineColor = state === 'tug' ? palette.bobber : palette.line;
  const lineWidth = palette.thickness;
  const hasSkinArt = Boolean(skinImage);

  const tipX = tip.x;
  const tipY = tip.y;

  // Key poses for each phase; relative to the tip. Sag controls how much the line bows; tension is 0-1 (loose to tight).
  // Poses: no user !tug command — tug is a server event indicating a bite. Casted keeps bobber in water until reel.
  const poseFor = (s: LineState): LinePose => {
    switch (s) {
      case 'casting':
        return { bx: tipX + 60, by: tipY + 80, sag: 40, tension: 0.2 };
      case 'casted':
        return { bx: tipX + 70, by: tipY + 135, sag: 30, tension: 0.65 };
      case 'tug':
        // Lock to the probed absolute point (no relative offset) so the bobber sits exactly where measured
        return { bx: 259, by: 132, sag: 0, tension: 1 };
      case 'reeling':
        return { bx: tipX + 12, by: tipY + 10, sag: 4, tension: 0.98 };
      case 'caught':
        return { bx: tipX + 10, by: tipY + 10, sag: 6, tension: 0.94 };
      case 'miss':
        return { bx: tipX + 10, by: tipY + 10, sag: 4, tension: 0.98 };
      case 'idle':
      default:
        return { bx: tipX + 2, by: tipY + 2, sag: 2, tension: 1 };
    }
  };

  const buildCurve = (pose: LinePose, jigglePhase: number) => {
    // Add a subtle jiggle in idle/tug states
    const jiggle = state === 'idle' ? Math.sin(jigglePhase) * 1.0 : state === 'casted' ? Math.sin(jigglePhase) * 0.4 : 0;
    const bx = pose.bx + jiggle * 0.6;
    const by = pose.by + jiggle;
    const dx = bx - tipX;
    const dy = by - tipY;
    const len = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / len;
    const ny = dx / len;
    const sag = pose.sag * (1 - pose.tension);
    const c1x = tipX + dx * 0.35 + nx * sag;
    const c1y = tipY + dy * 0.35 + ny * sag;
    const c2x = tipX + dx * 0.7 + nx * sag * 0.6;
    const c2y = tipY + dy * 0.7 + ny * sag * 0.6;
    return {
      bx,
      by,
      c1x,
      c1y,
      c2x,
      c2y,
      tension: pose.tension,
    } as const;
  };

  const [curve, setCurve] = useState(() => buildCurve(poseFor('idle'), 0));
  const poseRef = React.useRef<LinePose>(poseFor('idle'));
  const rafRef = React.useRef<number | null>(null);
  const jiggleRef = React.useRef<number>(0);

  useEffect(() => {
    poseRef.current = poseRef.current;
  }, []);

  useEffect(() => {
    const target = poseFor(state);
    const duration = state === 'casting' ? 520 : state === 'reeling' ? 420 : state === 'tug' ? 320 : state === 'casted' ? 360 : 360;
    const start = performance.now();
    const from = poseRef.current;

    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const k = t * t * (3 - 2 * t); // smoothstep
      const lerp = (a: number, b: number) => a + (b - a) * k;
      const blended: LinePose = {
        bx: lerp(from.bx, target.bx),
        by: lerp(from.by, target.by),
        sag: lerp(from.sag, target.sag),
        tension: lerp(from.tension, target.tension),
      };
      poseRef.current = blended;
      jiggleRef.current += 0.08; // idle/tug wobble phase
      setCurve(buildCurve(blended, jiggleRef.current));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      }
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [state, tipX, tipY]);

  const bobberX = curve.bx;
  const bobberY = curve.by;
  const tension = curve.tension >= 0.7 ? 'tight' : 'loose';
  const rarityStroke = lastCatch?.rarity ? rarityColors[lastCatch.rarity] : lineColor;
  const splash = state === 'caught' ? 1 : 0;
  const miss = state === 'miss' ? 1 : 0;

  return (
    <svg
      className="scene"
      viewBox="0 0 320 200"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Fishing scene"
    >
      <defs>
        <linearGradient id="water" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#1b3a5b" stopOpacity="0.32" />
          <stop offset="70%" stopColor="#0f243b" stopOpacity="0.32" />
        </linearGradient>
        <linearGradient id="sky" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#13233b" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#0b1726" stopOpacity="0.32" />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width="320" height="120" fill="url(#sky)" />
      <rect x="0" y="120" width="320" height="80" fill="url(#water)" />

      {/* shoreline */}
      <path d="M0 118 C80 110 130 115 200 112 C260 108 320 118 320 118 L320 200 L0 200 Z" fill="#1c2b3d" opacity="0.35" />

      {/* pole (hide base art when a skin image is present) */}
      {!hasSkinArt && (
        <>
          <path d="M45 30 L55 12" stroke={palette.grip} strokeWidth="6" strokeLinecap="round" />
          <path d="M55 12 L70 16" stroke={palette.tip} strokeWidth="4" strokeLinecap="round" />
          <path d="M70 16 L120 28" stroke={palette.rod} strokeWidth="3" strokeLinecap="round" />
        </>
      )}

      {/* skin art near the grip */}
      {hasSkinArt ? (
        <image href={skinImage} x="-5" y="-10" width="220" height="120" preserveAspectRatio="xMidYMid meet" opacity="0.95" />
      ) : null}

      {/* line */}
      <path
        className={`line-path ${tension}`}
        d={`M${tipX} ${tipY} C${curve.c1x} ${curve.c1y} ${curve.c2x} ${curve.c2y} ${bobberX} ${bobberY}`}
        stroke={rarityStroke}
        strokeWidth={lineWidth}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={state === 'casting' ? '120 14' : '6 0'}
        strokeDashoffset={state === 'reeling' ? 60 : 0}
      />
      <circle className={`bobber ${state}`} cx={bobberX} cy={bobberY} r="6" fill={lineColor} stroke={palette.tip} strokeWidth="1.5" />

      {/* splash / ripple */}
      {splash ? <circle cx={bobberX} cy={Math.min(130, bobberY + 6)} r="14" fill="none" stroke="#7be0ff" strokeWidth="2" /> : null}
      {miss ? <path d={`M${bobberX - 12} ${bobberY + 6} L${bobberX + 12} ${bobberY + 2}`} stroke="#ff9aa2" strokeWidth="3" strokeLinecap="round" /> : null}

      {/* stars */}
      <g fill="#8ad8ff" opacity="0.6">
        <circle cx="40" cy="32" r="1.5" />
        <circle cx="90" cy="18" r="1.5" />
        <circle cx="180" cy="12" r="1.5" />
        <circle cx="260" cy="26" r="1.5" />
        <circle cx="300" cy="40" r="1.5" />
      </g>
    </svg>
  );
}

export default function App() {
  const [status, setStatus] = useState('Connecting...');
  const [statusDetail, setStatusDetail] = useState('Waiting for cast/reel...');
  const [lineState, setLineState] = useState<LineState>('idle');
  const [lastCatch, setLastCatch] = useState<CatchSummary | undefined>();
  const [activeUser, setActiveUser] = useState<string>('');
  const [skin, setSkin] = useState<PoleSkinId>('classic');
  const [theme, setTheme] = useState<ThemePalette | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [skinImagesMap, setSkinImagesMap] = useState<Record<string, string>>(skinImageSrc);
  const [biomeImagesMap, setBiomeImagesMap] = useState<Record<string, string>>(biomeImages);
  const [buffOwner, setBuffOwner] = useState<string>('');
  const [buffs, setBuffs] = useState<Partial<{ xp: { amount: number; expiresAt: number }; value: { amount: number; expiresAt: number }; charm: { rarityBonus?: number; xpBonus?: number; expiresAt: number } }>>({});
  const [buffTimers, setBuffTimers] = useState<{ xp?: string; value?: string; charm?: string }>({});
  const [events, setEvents] = useState<Array<{ id: string; kind: 'xp' | 'gold' | 'double' | 'luck'; amount: number; endsAt: number; targetRarity?: string }>>([]);
  const [eventTimers, setEventTimers] = useState<Record<string, string>>({});
  const [boostIconSet, setBoostIconSet] = useState<{ xp: string; gold: string; double: string; luck: string }>({ xp: '⭐', gold: '💰', double: '🎣', luck: '🍀' });
  const [biomeKey, setBiomeKey] = useState<string>('cove');
  const [biomeImage, setBiomeImage] = useState<string | undefined>(biomeImages['cove']);

  const resolvedTip = (skinId: PoleSkinId): TipAnchor => tipAnchors[skinId] ?? tipAnchors.classic;

  useEffect(() => {
    const loadCatalog = async () => {
      try {
        const res = await fetch('/api/catalog');
        if (!res.ok) return;
        const data = (await res.json()) as Catalog;
        setCatalog(data);
        if (data.biomes?.length) {
          setBiomeImagesMap((prev) => {
            const next = { ...prev } as Record<string, string>;
            data.biomes.forEach((b) => {
              if (b.imageUrl) next[b.id] = b.imageUrl;
            });
            return next;
          });
        }
        if (data.skins?.length) {
          setSkinImagesMap((prev) => {
            const next = { ...prev } as Record<string, string>;
            data.skins.forEach((s) => {
              if (s.imageUrl) next[s.id] = s.imageUrl;
            });
            return next;
          });
        }
        if (data.ui?.boostIcons) {
          setBoostIconSet((prev) => ({
            xp: data.ui?.boostIcons?.xp ?? prev.xp,
            gold: data.ui?.boostIcons?.gold ?? prev.gold,
            double: data.ui?.boostIcons?.double ?? prev.double,
            luck: data.ui?.boostIcons?.luck ?? prev.luck,
          }));
        }
        if (data.ui?.theme) {
          setTheme(data.ui.theme);
        }
      } catch (err) {
        console.warn('catalog load failed', err);
      }
    };
    loadCatalog();
  }, []);

  useEffect(() => {
    const socket = io(socketUrl, { transports: ['websocket'] });

    socket.on('connect', () => setStatus('Connected. Waiting for !cast / !reel...'));

    socket.on('overlay-event', (evt: OverlayEvent) => {
      switch (evt.type) {
        case 'status':
          setStatus(evt.text);
          setStatusDetail(evt.text);
          break;
        case 'cast': {
          setStatus(`${evt.user} cast their line`);
          setActiveUser(evt.user);
          setLineState('casting');
          const delay = Math.max(320, Math.min(1100, evt.etaMs ?? 700));
          setTimeout(() => setLineState('casted'), delay);
          break;
        }
        case 'tug':
          setStatus(`${evt.user}'s line is tugging!`);
          setStatusDetail('Hit !reel in chat to pull it in.');
          setActiveUser(evt.user);
          setLineState('tug');
          break;
        case 'catch': {
          setLineState('reeling');
          setActiveUser(evt.user);
          setTimeout(() => {
            if (evt.success) {
              setLineState('caught');
              setLastCatch({ success: true, item: evt.item, goldEarned: evt.goldEarned, xpGained: evt.xpGained, rarity: evt.rarity });
              setStatus(`${evt.user} caught ${evt.item?.name ?? 'something'}!`);
              const bonus: string[] = [];
              if (evt.goldEarned !== undefined) bonus.push(`+${evt.goldEarned}g`);
              if (evt.xpGained !== undefined) bonus.push(`+${evt.xpGained}xp`);
              setStatusDetail(bonus.length ? bonus.join(' / ') : 'Added to inventory (see panel)');
              setTimeout(() => setLineState('idle'), 900);
            } else {
              setLastCatch({ success: false });
              setStatus(`${evt.user} reeled in too soon.`);
              setStatusDetail('Missed the catch — wait for the tug.');
              setTimeout(() => setLineState('idle'), 450);
            }
          }, 200);
          break;
        }
        case 'level': {
          setStatus(`Level ${evt.level}`);
          setStatusDetail(`XP ${evt.xp}/${evt.xpNeeded}`);
          break;
        }
        case 'theme':
          setTheme(evt.theme);
          break;
        case 'skin':
          setSkin(evt.skinId);
          break;
        case 'buffs': {
          setBuffOwner(evt.user);
          setBuffs(evt.buffs ?? {});
          break;
        }
        case 'events': {
          setEvents((evt.events ?? []).slice().sort((a, b) => a.endsAt - b.endsAt));
          break;
        }
        // Store/inventory updates are now handled exclusively in the extension panel
        case 'store':
        case 'inventory':
          setStatusDetail('Store / inventory updated in extension panel.');
          if (evt.state?.biome) {
            setBiomeKey(evt.state.biome);
          }
          break;
      }
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const format = (expires?: number) => {
        if (!expires || expires <= now) return undefined;
        const remaining = Math.max(0, expires - now);
        const totalSec = Math.ceil(remaining / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
      };
      setBuffTimers({
        xp: format(buffs.xp?.expiresAt),
        value: format(buffs.value?.expiresAt),
        charm: format(buffs.charm?.expiresAt),
      });
    };
    const id = window.setInterval(tick, 1000);
    tick();
    return () => window.clearInterval(id);
  }, [buffs]);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const next: Record<string, string> = {};
      events.forEach((evt) => {
        if (!evt.endsAt || evt.endsAt <= now) return;
        const remaining = Math.max(0, evt.endsAt - now);
        const totalSec = Math.ceil(remaining / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        next[evt.id] = `${m}:${s.toString().padStart(2, '0')}`;
      });
      setEventTimers(next);
    };
    const id = window.setInterval(tick, 1000);
    tick();
    return () => window.clearInterval(id);
  }, [events]);

  useEffect(() => {
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
  }, [theme]);

  useEffect(() => {
    setBiomeImage(biomeImagesMap[biomeKey]);
  }, [biomeKey, biomeImagesMap]);

  const eventLabel = (evt: { kind: 'xp' | 'gold' | 'double' | 'luck'; amount: number; targetRarity?: string }) => {
    if (evt.kind === 'xp') return `Global XP +${Math.round(evt.amount * 100)}%`;
    if (evt.kind === 'gold') return `Global Gold +${Math.round(evt.amount * 100)}%`;
    if (evt.kind === 'luck') return `Luck +${Math.round(evt.amount * 100)}%${evt.targetRarity ? ` (${evt.targetRarity} only)` : ''}`;
    const stacks = Math.max(1, Math.round(evt.amount));
    return `Double Catch x${stacks + 1}`;
  };

  const activeBoostIcons = () => {
    const icons: string[] = [];
    if (events.some((e) => e.kind === 'xp')) icons.push(boostIconSet.xp);
    if (events.some((e) => e.kind === 'gold')) icons.push(boostIconSet.gold);
    if (events.some((e) => e.kind === 'double')) icons.push(boostIconSet.double);
    if (events.some((e) => e.kind === 'luck')) icons.push(boostIconSet.luck);
    return icons;
  };

  const charmLabel = (() => {
    const parts: string[] = [];
    if (buffs.charm?.rarityBonus) parts.push(`+${Math.round((buffs.charm.rarityBonus ?? 0) * 100)}% rarity`);
    if (buffs.charm?.xpBonus) parts.push(`+${Math.round((buffs.charm.xpBonus ?? 0) * 100)}% XP`);
    return parts.length ? parts.join(' / ') : 'Charm';
  })();

  return (
    <div className="page">
      <div className="hud">
        <div className="panel fishing-panel">
          <div className="panel-header">Fish Looter</div>
          <div className="scene-shell" style={biomeImage ? { backgroundImage: `url(${biomeImage})` } : undefined} aria-label={`Biome: ${biomeKey}`}>
            <div className="scene-overlay" />
            <LineScene state={lineState} lastCatch={lastCatch} skin={skin} skinImage={skinImagesMap[skin]} tip={resolvedTip(skin)} />
          </div>
          <div className="fishing-body">
            <div className="status-line" style={{ color: activeUser ? '#7ad7ff' : undefined }}>{status}</div>
            <div className="status-sub">
              <span>{statusDetail}</span>
              {activeBoostIcons().length ? (
                <span className="boost-icons" title="Active global boosts">{activeBoostIcons().join(' ')}</span>
              ) : null}
            </div>
            {events.length ? (
              <div className="event-row">
                {events.map((evt) => (
                  <div key={evt.id} className={`event-chip kind-${evt.kind}`} title="Global event">
                    <span className="event-label">{eventLabel(evt)}</span>
                    <span className="event-timer">{eventTimers[evt.id] ?? '0:00'}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="buff-row">
              {buffs.xp && buffTimers.xp ? (
                <div className="buff-chip" title={`${buffOwner || 'Player'} XP buff`}>
                  <span className="buff-label">XP +{Math.round(buffs.xp.amount * 100)}%</span>
                  <span className="buff-timer">{buffTimers.xp}</span>
                </div>
              ) : null}
              {buffs.value && buffTimers.value ? (
                <div className="buff-chip" title={`${buffOwner || 'Player'} value buff`}>
                  <span className="buff-label">Value +{Math.round(buffs.value.amount * 100)}%</span>
                  <span className="buff-timer">{buffTimers.value}</span>
                </div>
              ) : null}
              {buffs.charm && buffTimers.charm ? (
                <div className="buff-chip" title={`${buffOwner || 'Player'} charm buff`}>
                  <span className="buff-label">{charmLabel}</span>
                  <span className="buff-timer">{buffTimers.charm}</span>
                </div>
              ) : null}
            </div>
            {lastCatch?.success && lastCatch.item ? (
              <div className="catch-card" style={{ borderColor: rarityColors[lastCatch.item.rarity] }}>
                <div className="catch-name">{lastCatch.item.name}</div>
                <div className="catch-meta">{lastCatch.item.rarity} • {lastCatch.item.value}g</div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
