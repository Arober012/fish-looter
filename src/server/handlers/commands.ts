import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { Server } from 'socket.io';
import { Catalog, CatalogChatCommand, ChatCommandEvent, CraftingMaterialId, EssenceId, EnchantmentInstance, InventoryItem, OverlayEvent, PlayerStatePublic, PoleSkinId, Rarity, StoreItem, ThemePalette, TradeListing, UpgradeDefinition } from '../../shared/types';
import { fetchTwitchUser } from '../twitch-helix';
import { resolveInDataDir } from '../data-dir';

let lastHelixSuccessAt: number | null = null;
let lastHelixError: string | null = null;

interface PlayerState extends PlayerStatePublic {
    isCasting: boolean;
    hasTug: boolean;
    scopedKey: string; // channel-scoped, lowercase username key
    activeBait?: { rarityBonus: number; valueBonus: number; uses: number; expiresAt?: number; minRarityIndex?: number; xpBonus?: number };
    activeCharm?: { expiresAt: number; rarityBonus: number; xpBonus: number };
    biomeKey: string;
    stabilizerCharges?: number;
    echoReelCharges?: number;
    chestUpgrade?: boolean;
    chestMinRarityIndex?: number;
    craftingBoostCharges?: number;
    enchantBoostCharges?: number;
}

interface RarityConfig {
    rarity: Rarity;
    weight: number;
    valueRange: [number, number];
    xp: number;
}

interface Biome {
    key: string;
    name: string;
    rarityConfigs: RarityConfig[];
    lootTable: Record<Rarity, string[]>;
    goldMultiplier: number;
    xpMultiplier: number;
    tier: number;
    imageUrl?: string;
}

const rarityOrder: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'relic'];

const materialDefaults: Record<CraftingMaterialId, number> = {
    'tide-shard': 0,
    'ember-fragment': 0,
    'abyssal-ink': 0,
    'frost-crystal': 0,
    'astral-fiber': 0,
    'cosmic-dust': 0,
};

const essenceDefaults: Record<EssenceId, number> = {
    'spark-essence': 0,
    'echo-essence': 0,
    'mythic-essence': 0,
};

type CraftingRecipe = {
    id: string;
    name: string;
    description?: string;
    costs: Partial<Record<CraftingMaterialId, number>>;
    grantsItem?: () => InventoryItem | null;
    grantsMaterials?: Partial<Record<CraftingMaterialId, number>>;
};

const craftingRecipes: CraftingRecipe[] = [
    {
        id: 'crafting-booster-kit',
        name: 'Crafting Booster Kit',
        costs: { 'tide-shard': 2, 'ember-fragment': 1 },
        description: 'Improves your next craft.',
        grantsItem: () => ({ id: randomUUID(), name: 'Crafting Booster Kit', rarity: 'epic', value: 0, description: 'Improves your next craft.', type: 'token' }),
    },
    {
        id: 'enchanters-spark',
        name: "Enchanter's Spark",
        costs: { 'ember-fragment': 2, 'abyssal-ink': 1, 'frost-crystal': 1 },
        description: 'Guarantees a minor enchant success.',
        grantsItem: () => ({ id: randomUUID(), name: "Enchanter's Spark", rarity: 'legendary', value: 0, description: 'Guarantees a minor enchant success.', type: 'token' }),
    },
    {
        id: 'tide-luck-charm',
        name: 'Tide Luck Charm',
        costs: { 'tide-shard': 3, 'astral-fiber': 1 },
        description: 'Boosts rarity for 3 minutes.',
        grantsItem: () => ({ id: randomUUID(), name: 'Luck Charm', rarity: 'rare', value: 0, description: 'Boost rarity for 3 minutes.', type: 'token' }),
    },
    {
        id: 'synthesize-cosmic-dust',
        name: 'Synthesize Cosmic Dust',
        costs: { 'astral-fiber': 6, 'frost-crystal': 5, 'abyssal-ink': 4 },
        description: 'Refine high-tier materials into 1 Cosmic Dust.',
        grantsMaterials: { 'cosmic-dust': 1 },
    },
];

function getCraftingRecipes(): CraftingRecipe[] {
    const catalog = getCatalogSnapshot();
    if (catalog.recipes && catalog.recipes.length) {
        return catalog.recipes.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            costs: r.costs as Partial<Record<CraftingMaterialId, number>>,
            grantsItem: r.grants
                ? () => ({
                      id: randomUUID(),
                      name: r.grants!.name,
                      rarity: r.grants!.rarity,
                      value: r.grants!.value ?? 0,
                      description: r.grants!.description,
                      type: r.grants!.type,
                  })
                : undefined,
            grantsMaterials: r.grantsMaterials as Partial<Record<CraftingMaterialId, number>> | undefined,
        }));
    }
    return craftingRecipes;
}

const dataDir = resolveInDataDir('saves');
export const saveDir = dataDir; // exposed for startup logging
function tradeStorePathForChannel(channel?: string) {
    const chan = (channel ?? process.env.TWITCH_CHANNEL ?? 'default').toLowerCase();
    return path.join(dataDir, `__trades__${chan}.json`);
}

const defaultStoreConfig = { rotationHours: 4, alwaysKeys: ['bag-upgrade', 'bait-basic'], slots: 6 } as const;
let storeRotation: { items: StoreItem[]; expiresAt: number } | null = null;
let storeRotationVersion: string | null = null;
const tradeBoard: Array<TradeListing & { sellerScopedKey: string }> = [];
let tradeLoadedChan: string | null = null;
const storeRefreshCooldownMs = 8 * 60 * 60 * 1000;
const lastStoreRefresh = new Map<string, number>();
const premiumStoreSlots = 1; // extra premium item(s) per rotation
const premiumRarityFloor: Rarity = 'epic';
const premiumPriceBonus = 0.35; // premium items cost more
const storeTierPriceStep = 0.15; // +15% per biome tier above tier 1
const storeLevelPriceStart = 20; // levels below this do not scale prices
const storeLevelPriceStep = 0.004; // +0.4% per level above the start
const storeLevelPriceCap = 0.6; // max +60% from levels
const storePrestigePriceStep = 0.08; // +8% per prestige
const storePriceMaxMultiplier = 3.25; // clamp overall scaling

const coveRarityConfigs: RarityConfig[] = [
    { rarity: 'common', weight: 52, valueRange: [5, 12], xp: 6 },
    { rarity: 'uncommon', weight: 26, valueRange: [12, 22], xp: 13 },
    { rarity: 'rare', weight: 12, valueRange: [24, 40], xp: 24 },
    { rarity: 'epic', weight: 6, valueRange: [42, 70], xp: 40 },
    { rarity: 'legendary', weight: 3, valueRange: [72, 110], xp: 60 },
    { rarity: 'mythic', weight: 1, valueRange: [120, 220], xp: 95 },
    { rarity: 'relic', weight: 0.2, valueRange: [240, 420], xp: 150 },
];

const coveLootTable: Record<Rarity, string[]> = {
    common: ['Minnow', 'Tin Can', 'Old Boot', 'Rusty Hook', 'Soggy Note', 'Pebbles', 'Common Chest', 'Wet Sock', 'Sand Dollar', 'Hay bale', 'Shiny Rock', 'Guppy', 'Tiny Crab', 'Turtle Shell'],
    uncommon: ['Sunfish', 'Carp', 'Seaweed Bundle', 'Uncommon Chest', 'Wooden Chest', 'Message Bottle', 'Lucky Token', 'Lobster Claw', 'Crab Leg', 'Copper Ring', 'Silver Fish Hook', 'Starfish', 'Clam Shell', 'Coral Fragment', 'Driftwood Piece', 'Fishing Bobber', 'Anchor Charm', 'Fishing Line Spool', 'Captain\'s Hat', 'Captain\'s Log'],
    rare: ['Salmon', 'Bass', 'Catfish', 'Pearl Oyster', 'Silver Locket', 'Old Map Fragment', 'Hammerhead Shark Tooth', 'Dolphin Fin', 'Dolphin', 'Tortoise', 'Sea Turtle', 'Peanut Brittle', 'Honeycomb', 'Hard Hat'],
    epic: ['Golden Trout', 'Swordfish', 'Ancient Coin', 'Opal Oyster', 'Treasure Map', 'Enchanted Compass', 'Mythic Chest', 'Pirate\'s Hat', 'Pirate\'s Cutlass', 'First Mate\'s Log', 'Navigator\'s Sextant', 'Silver Trout', 'Stingray', 'Manta Ray', 'Clown Fish', 'Blowfish', 'Jellyfish', 'Eeel', 'Coral Crown', 'Pearl Necklace', 'Captain\'s Spyglass', 'Ship in a Bottle'],
    legendary: ['Kraken Scale', 'Dragon Koi', 'Phoenix Feather', 'Gold Bar', 'Jeweled Crown', 'Legendary Chest', 'Ocean\'s Heart', 'Trident Fragment', 'Poseidon\'s Trident', 'Siren\'s Songbook', 'Mermaid\'s Comb', 'Coral Scepter', 'Triton\'s Shell', 'Sea Serpent Fang', 'Tuna', 'Marlin', 'Barracuda', 'Giant Squid'],
    mythic: ['Celestial Carp', 'Leviathan Tooth', 'Aurora Pearl', 'Starlit Relic', 'Forgotten Scepter', 'Crown of Tides', 'Neptune\'s Glory', 'Eternal Coral', 'Mythic Pearl', 'Starfish Crown', 'Ocean\'s Embrace', 'Galactic Shell', 'Cosmic Coral', 'Mythic Koi', 'Astral Fin', 'Mythic Trident', 'Mega Squid', 'Mega Shark', 'Megalodon', 'Great White Shark', 'Diamond Shark', 'Rainbow Koi', 'Mythic Leviathan', 'Mythic Dragon Koi', 'Mythic Phoenix Koi', 'Mythic Celestial Koi', 'Mythic Starlit Koi', 'Glowing Gem', 'Black Pearl', 'Kraken Tentacle', 'Poseidon\'s Crown', 'Kraken\'s Eye', 'Trident of the Seas', 'Neptune\'s Trident', 'The Kraken King'],
    relic: ['Prismatic Relic', 'Forgotten Anchor Stone', 'Eternal Wave Sigil'],
};

const specialLoot: Record<string, Partial<InventoryItem>> = {
    'Common Chest': { type: 'chest', description: 'Open for a common pull.' },
    'Uncommon Chest': { type: 'chest', description: 'Open for an uncommon pull.' },
    'Mythic Chest': { type: 'chest', description: 'Open for a mythic pull.' },
    'Legendary Chest': { type: 'chest', description: 'Open for a legendary pull.' },
    'Lucky Token': { type: 'token', description: 'Use to gain a short luck boost.' },
    'Wooden Chest': { type: 'chest', description: 'A weathered chest with modest loot.' },
    'Seared Chest': { type: 'chest', description: 'A chest singed by reef heat.' },
    'Ember Chest': { type: 'chest', description: 'Radiates warmth; holds rare reef treasure.' },
    'Trench Chest': { type: 'chest', description: 'Recovered from the deep trench.' },
    'Sealed Crate': { type: 'chest', description: 'Crate pressurized from abyssal depths.' },
    'Frosted Chest': { type: 'chest', description: 'A chest rimed with permafrost.' },
    'Glacial Cache': { type: 'chest', description: 'Ice-locked cache with crystalline loot.' },
    'Astral Chest': { type: 'chest', description: 'A chest infused with stellar light.' },
    'Starfall Crate': { type: 'chest', description: 'Crate fallen from the night sky.' },
    'Treasure Map': { type: 'map', description: 'Use to reveal a buried cache with higher-tier loot.' },
    'Enchanted Compass': { type: 'compass', description: 'Use to chart new waters and leave the starting cove.' },
};
// Custom loot added by players at prestige 4 via scrolls (in-memory per rarity)
const customLoot: Record<Rarity, string[]> = {
    common: [],
    uncommon: [],
    rare: [],
    epic: [],
    legendary: [],
    mythic: [],
    relic: [],
};

// Chat command config loaded from data/commands.json (optional) to enable/disable/alias without panel rebuilds
type ChatCommandsConfig = { disabled?: string[]; enabled?: string[]; aliases?: Record<string, string>; version?: string; updatedAt?: number };
const chatCommandsConfigPath = resolveInDataDir('commands.json');
let chatCommandsConfig: ChatCommandsConfig = loadChatCommandsConfig();

function loadChatCommandsConfig(): ChatCommandsConfig {
    try {
        const raw = require(chatCommandsConfigPath);
        if (raw && typeof raw === 'object') return raw as ChatCommandsConfig;
    } catch {
        // optional file
    }
    return {};
}

function recordHelixSuccess() {
    lastHelixSuccessAt = Date.now();
    lastHelixError = null;
}

function recordHelixFailure(err: unknown) {
    lastHelixError = err instanceof Error ? err.message : String(err);
}

export function getHelixDebug() {
    return {
        hasClientId: Boolean(process.env.TWITCH_CLIENT_ID),
        hasClientSecret: Boolean(process.env.TWITCH_CLIENT_SECRET),
        lastSuccessAt: lastHelixSuccessAt,
        lastError: lastHelixError,
    };
}

function addCustomLootName(rarity: Rarity, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false as const, reason: 'empty' as const };
    const safe = trimmed.slice(0, 48);
    const normalized = safe.toLowerCase();
    const existsAcrossPools = Object.values(customLoot).some((pool) => pool.some((entry) => entry.toLowerCase() === normalized));
    if (existsAcrossPools) {
        return { ok: false as const, reason: 'duplicate' as const };
    }
    const list = customLoot[rarity];
    if (list.length >= 64) list.shift();
    list.push(safe);
    return { ok: true as const };
}

const commandCatalog: CatalogChatCommand[] = [
    { name: 'fish', description: 'Start fishing and auto-cast if idle.' },
    { name: 'cast', description: 'Cast your line.' },
    { name: 'reel', description: 'Reel your line.' },
    { name: 'store', description: 'Open the store (panel-only)', panelOnly: true },
    { name: 'store-refresh', description: 'Refresh the store (panel-only)', panelOnly: true },
    { name: 'buy', description: 'Buy an item (panel-only)', panelOnly: true },
    { name: 'upgrades', description: 'Open upgrades (panel-only)', panelOnly: true },
    { name: 'sell', description: 'Sell items (panel-only)', panelOnly: true },
    { name: 'use', description: 'Use an item (panel-only)', panelOnly: true },
    { name: 'inventory', description: 'Show inventory (panel-only)', panelOnly: true },
    { name: 'save', description: 'Save progress.' },
    { name: 'equip', description: 'Equip a skin (panel-only)', panelOnly: true },
    { name: 'enchant', description: 'Apply essence to rod.' },
    { name: 'duplicate', description: 'Spend Cosmic Dust to duplicate items or materials.' },
    { name: 'level', description: 'Show your level.' },
    { name: 'theme', description: 'Change theme.' },
    { name: 'event', description: 'Start/stop global events (mod-only)', modOnly: true },
    { name: 'cooldown', description: 'Adjust per-user cooldown (mod-only)', modOnly: true },
    { name: 'gcooldown', description: 'Adjust global chat cooldown (mod-only)', modOnly: true },
    { name: 'reset-profile', description: 'Reset a player profile to defaults (mod-only, use sparingly)', modOnly: true },
    { name: 'panel', description: 'Get the panel link.' },
];

const knownCommands = new Set(commandCatalog.map((c) => c.name));

function resolveCommandName(raw: string): string {
    const normalized = raw.toLowerCase();
    const alias = chatCommandsConfig.aliases?.[normalized];
    return alias ? alias.toLowerCase() : normalized;
}

function isCommandEnabled(command: string): boolean {
    const disabled = chatCommandsConfig.disabled?.map((c) => c.toLowerCase()) ?? [];
    const enabled = chatCommandsConfig.enabled?.map((c) => c.toLowerCase()) ?? null;
    if (enabled && enabled.length > 0) return enabled.includes(command.toLowerCase());
    return !disabled.includes(command.toLowerCase());
}

const baseBiomes: Record<string, Biome> = {
    cove: {
        key: 'cove',
        name: 'Midnight Cove',
        rarityConfigs: coveRarityConfigs,
        lootTable: coveLootTable,
        goldMultiplier: 1,
        xpMultiplier: 1,
        tier: 1,
        imageUrl: '/biomes/midnight_cove.png',
    },
    'ember-reef': {
        key: 'ember-reef',
        name: 'Ember Reef',
        rarityConfigs: [
            { rarity: 'common', weight: 42, valueRange: [12, 26], xp: 10 },
            { rarity: 'uncommon', weight: 24, valueRange: [22, 40], xp: 18 },
            { rarity: 'rare', weight: 15, valueRange: [42, 80], xp: 32 },
            { rarity: 'epic', weight: 9, valueRange: [70, 120], xp: 55 },
            { rarity: 'legendary', weight: 6, valueRange: [110, 180], xp: 85 },
            { rarity: 'mythic', weight: 4, valueRange: [160, 280], xp: 130 },
            { rarity: 'relic', weight: 0.35, valueRange: [320, 520], xp: 200 },
        ],
        lootTable: {
            common: ['Glass Minnow', 'Coral Chip', 'Charred Driftwood', 'Cinder Shrimp', 'Glowing Kelp', 'Coal Pebble'],
            uncommon: ['Fire Guppy', 'Amber Clam', 'Heatfin', 'Brass Key', 'Seared Chest', 'Sun Coin'],
            rare: ['Blazefin Tuna', 'Molten Lobster', 'Gilded Anchor', 'Smoldering Relic'],
            epic: ['Phoenix Snapper', 'Lava Eel', 'Cinder Crown', 'Enchanted Compass', 'Ember Chest'],
            legendary: ['Ifrit Ray', 'Solar Dragonet', 'Molten Obelisk', 'Inferno Pearl'],
            mythic: ['Ashen Leviathan', 'Star Ember', 'Crown of Cinders'],
            relic: ['Emberheart Core', 'Cinder Relic'],
        },
        goldMultiplier: 1.2,
        xpMultiplier: 1.15,
        tier: 2,
        imageUrl: '/biomes/ember_reef.png',
    },
    'abyssal-gulf': {
        key: 'abyssal-gulf',
        name: 'Abyssal Gulf',
        rarityConfigs: [
            { rarity: 'common', weight: 36, valueRange: [14, 30], xp: 12 },
            { rarity: 'uncommon', weight: 24, valueRange: [28, 48], xp: 20 },
            { rarity: 'rare', weight: 16, valueRange: [55, 95], xp: 38 },
            { rarity: 'epic', weight: 12, valueRange: [90, 150], xp: 70 },
            { rarity: 'legendary', weight: 8, valueRange: [150, 240], xp: 110 },
            { rarity: 'mythic', weight: 4, valueRange: [220, 360], xp: 165 },
            { rarity: 'relic', weight: 0.4, valueRange: [360, 600], xp: 240 },
        ],
        lootTable: {
            common: ['Stone Minnow', 'Deep Silt', 'Shadow Shrimp', 'Cracked Lantern', 'Waterlogged Tome'],
            uncommon: ['Duskwater Carp', 'Abyssal Scale', 'Pressure Pearl', 'Forgotten Key', 'Sealed Crate'],
            rare: ['Ghostfin Tuna', 'Twilight Ray', 'Obsidian Anchor', 'Sunken Relic'],
            epic: ['Abyssal Angler', 'Midnight Eel', 'Moonlit Chalice', 'Enchanted Compass', 'Trench Chest'],
            legendary: ['Leviathan Fang', 'Cursed Crown', 'Tidal Scepter', 'Gloomheart Pearl'],
            mythic: ['Eternal Whale', 'Starless Eye', 'Crown of Depths'],
            relic: ['Voidstone Relic', 'Abyssal Crown'],
        },
        goldMultiplier: 1.35,
        xpMultiplier: 1.3,
        tier: 3,
        imageUrl: '/biomes/abyssal_gulf.png',
    },
    'crystal-fjord': {
        key: 'crystal-fjord',
        name: 'Crystal Fjord',
        rarityConfigs: [
            { rarity: 'common', weight: 34, valueRange: [18, 38], xp: 18 },
            { rarity: 'uncommon', weight: 22, valueRange: [35, 60], xp: 30 },
            { rarity: 'rare', weight: 16, valueRange: [70, 125], xp: 55 },
            { rarity: 'epic', weight: 12, valueRange: [120, 200], xp: 90 },
            { rarity: 'legendary', weight: 10, valueRange: [190, 300], xp: 135 },
            { rarity: 'mythic', weight: 6, valueRange: [280, 450], xp: 200 },
            { rarity: 'relic', weight: 0.45, valueRange: [420, 720], xp: 300 },
        ],
        lootTable: {
            common: ['Ice Minnow', 'Frost Kelp', 'Glassy Pebble', 'Frosted Chest', 'Snowmelt Snail'],
            uncommon: ['Glacier Smelt', 'Aurora Shrimp', 'Frozen Locket', 'Cracked Obelisk', 'Frosted Chest'],
            rare: ['Opal Cod', 'Shiver Ray', 'Prismatic Pearl', 'Glacial Cache'],
            epic: ['Aurora Salmon', 'Crystal Pike', 'Refraction Lens', 'Enchanted Compass', 'Aurora Prism'],
            legendary: ['Frostwyrm Scale', 'Northern Crown', 'Heart of Ice', 'Aurora Antler'],
            mythic: ['Starshard Leviathan', 'Eternal Glacier', 'Celestine Orb'],
            relic: ['Glacial Relic', 'Prismheart'],
        },
        goldMultiplier: 1.55,
        xpMultiplier: 1.5,
        tier: 4,
        imageUrl: '/biomes/crystal_fjord.png',
    },
    'astral-lagoon': {
        key: 'astral-lagoon',
        name: 'Astral Lagoon',
        rarityConfigs: [
            { rarity: 'common', weight: 30, valueRange: [24, 48], xp: 24 },
            { rarity: 'uncommon', weight: 22, valueRange: [45, 80], xp: 40 },
            { rarity: 'rare', weight: 16, valueRange: [90, 150], xp: 70 },
            { rarity: 'epic', weight: 14, valueRange: [160, 260], xp: 120 },
            { rarity: 'legendary', weight: 10, valueRange: [250, 380], xp: 180 },
            { rarity: 'mythic', weight: 8, valueRange: [360, 520], xp: 260 },
            { rarity: 'relic', weight: 0.5, valueRange: [520, 860], xp: 360 },
        ],
        lootTable: {
            common: ['Starlit Minnow', 'Moon Jelly', 'Dusty Shell', 'Gleaming Pebble'],
            uncommon: ['Comet Shrimp', 'Nebula Carp', 'Glimmer Pearl', 'Starfall Crate'],
            rare: ['Meteoric Ray', 'Void Lobster', 'Radiant Crown', 'Starfall Crate'],
            epic: ['Celestial Marlin', 'Black Hole Eel', 'Nova Relic', 'Astral Chest'],
            legendary: ['Cosmic Leviathan Scale', 'Sunforged Scepter', 'Crown of Stars', 'Lumenheart'],
            mythic: ['Eclipse Whale', 'Singularity Core', 'Heart of the Cosmos'],
            relic: ['Eternal Star Map', 'Cosmic Relic'],
        },
        goldMultiplier: 2.1,
        xpMultiplier: 1.9,
        tier: 5,
        imageUrl: '/biomes/astral_lagoon.png',
    },
};

const chestRarityByName: Record<string, Rarity> = {
    'common chest': 'common',
    'uncommon chest': 'uncommon',
    'mythic chest': 'mythic',
    'legendary chest': 'legendary',
    'wooden chest': 'uncommon',
    'seared chest': 'uncommon',
    'sealed crate': 'uncommon',
    'ember chest': 'epic',
    'trench chest': 'epic',
    'frosted chest': 'uncommon',
    'glacial cache': 'rare',
    'astral chest': 'epic',
    'starfall crate': 'rare',
};

const fallbackThemes: Record<string, ThemePalette> = {
    default: {
        name: 'Midnight Cove',
        background: '#0b1524',
        backgroundAlt: '#0f1d30',
        panel: 'rgba(19,33,53,0.9)',
        panelBorder: 'rgba(120,166,255,0.25)',
        accent: '#7ad7ff',
        accentSoft: 'rgba(120,166,255,0.12)',
        text: '#e8f0ff',
        muted: '#9fb3c8',
    },
    tropical: {
        name: 'Tropical Bay',
        background: '#0a1f1c',
        backgroundAlt: '#0f2b24',
        panel: 'rgba(14,34,32,0.9)',
        panelBorder: 'rgba(82,255,198,0.25)',
        accent: '#52ffc6',
        accentSoft: 'rgba(82,255,198,0.12)',
        text: '#e5fff6',
        muted: '#9ad1c2',
    },
    sunset: {
        name: 'Harbor Sunset',
        background: '#1a0f24',
        backgroundAlt: '#261433',
        panel: 'rgba(36,18,48,0.9)',
        panelBorder: 'rgba(255,179,94,0.25)',
        accent: '#ffb35e',
        accentSoft: 'rgba(255,179,94,0.14)',
        text: '#ffeedd',
        muted: '#d8b4a0',
    },
    glacier: {
        name: 'Glacier Dawn',
        background: '#0b1a26',
        backgroundAlt: '#102233',
        panel: 'rgba(18,34,52,0.9)',
        panelBorder: 'rgba(146,208,255,0.28)',
        accent: '#92d0ff',
        accentSoft: 'rgba(146,208,255,0.14)',
        text: '#e5f3ff',
        muted: '#9fb6c9',
    },
};

function themeMap(): Record<string, ThemePalette> {
    const catalog = getCatalogSnapshot();
    const uiThemes = catalog.ui?.themes;
    if (uiThemes && uiThemes.length) {
        const map: Record<string, ThemePalette> = { ...fallbackThemes };
        for (const t of uiThemes) {
            const key = (t as any).id || (t as any).key || t.name?.toLowerCase().replace(/\s+/g, '-') || 'custom';
            map[key] = t;
        }
        return map;
    }
    return fallbackThemes;
}

const startBiomeKey = 'cove';

type BiomeCache = { versionKey: string; byId: Record<string, Biome>; byTier: Biome[]; startKey: string; maxTier: number };
let biomeCache: BiomeCache | null = null;

function biomeVersionKey(catalog: Catalog) {
    return `${catalog.version}-${catalog.updatedAt}`;
}

function normalizeBiome(input: Catalog['biomes'][number] | Biome): Biome {
    const key = (input as any).key ?? (input as any).id ?? startBiomeKey;
    return {
        key,
        name: input.name,
        rarityConfigs: input.rarityConfigs as Biome['rarityConfigs'],
        lootTable: input.lootTable as Biome['lootTable'],
        goldMultiplier: input.goldMultiplier ?? 1,
        xpMultiplier: input.xpMultiplier ?? 1,
        tier: input.tier ?? 1,
        imageUrl: (input as any).imageUrl,
    };
}

function getBiomeData(): BiomeCache {
    const catalog = getCatalogSnapshot();
    const versionKey = biomeVersionKey(catalog);
    if (biomeCache && biomeCache.versionKey === versionKey) return biomeCache;

    const source = (catalog.biomes && catalog.biomes.length ? catalog.biomes : Object.values(baseBiomes)).map(normalizeBiome);
    const byId: Record<string, Biome> = {};
    for (const biome of source) {
        byId[biome.key] = biome;
    }
    const byTier = Object.values(byId).sort((a, b) => a.tier - b.tier);
    const startKey = byTier[0]?.key ?? startBiomeKey;
    const maxTier = byTier.length ? byTier[byTier.length - 1].tier : 1;

    biomeCache = { versionKey, byId, byTier, startKey, maxTier };
    return biomeCache;
}

function nextBiome(current: Biome): Biome | undefined {
    const { byTier } = getBiomeData();
    return byTier.find((b) => b.tier === current.tier + 1);
}

function prevBiome(current: Biome): Biome | undefined {
    const { byTier } = getBiomeData();
    return byTier.find((b) => b.tier === current.tier - 1);
}

function getBiome(state: PlayerState): Biome {
    const { byId, startKey } = getBiomeData();
    return byId[state.biomeKey] ?? byId[startKey] ?? Object.values(byId)[0];
}

const storeItems: StoreItem[] = [
    { key: 'bait-basic', name: 'Bag of Bait', cost: 20, rarity: 'common', value: 12, description: 'Adds a guaranteed common catch when used.', type: 'bait' },
    { key: 'bait-shiny', name: 'Shiny Lure', cost: 90, rarity: 'rare', value: 38, description: 'Slightly boosts rare+ odds for your next cast.', type: 'bait' },
    { key: 'bait-mystic', name: 'Mystic Bobber', cost: 160, rarity: 'epic', value: 65, description: 'Greatly boosts epic+ odds for your next cast.', type: 'bait' },
    { key: 'bait-aurora', name: 'Aurora Float', cost: 280, rarity: 'mythic', value: 120, description: 'Massively increases mythic odds for one cast.', type: 'bait' },
    { key: 'bag-upgrade', name: 'Inventory Expansion', cost: 120, rarity: 'rare', value: 0, description: 'Increase inventory space by +5 (max 30).', type: 'item' },
    { key: 'hook-stabilizer', name: 'Hook Stabilizer', cost: 35, rarity: 'common', value: 0, description: 'Forgives one early reel on your next cast.', type: 'token' },
    { key: 'tide-token', name: 'Tide Token', cost: 70, rarity: 'uncommon', value: 0, description: 'Next catch is guaranteed uncommon+.', type: 'token' },
    { key: 'gleam-polish', name: 'Gleam Polish', cost: 110, rarity: 'rare', value: 0, description: 'Next catch value +40%.', type: 'token' },
    { key: 'scholars-note', name: "Scholar's Note", cost: 80, rarity: 'uncommon', value: 0, description: 'Next catch XP +50%.', type: 'token' },
    { key: 'echo-reel', name: 'Echo Reel', cost: 140, rarity: 'rare', value: 0, description: 'Bonus catch after next successful reel (one tier lower).', type: 'token' },
    { key: 'luck-charm', name: 'Luck Charm', cost: 110, rarity: 'rare', value: 0, description: 'Boost rarity weights for 3 minutes.', type: 'token' },
    { key: 'traders-mark', name: "Trader's Mark", cost: 85, rarity: 'uncommon', value: 0, description: 'Boost item value by 15% for 5 minutes.', type: 'token' },
    { key: 'waypoint-charter', name: 'Waypoint Charter', cost: 170, rarity: 'rare', value: 0, description: 'Sail down one biome tier.', type: 'token' },
    { key: 'survey-beacon', name: 'Survey Beacon', cost: 230, rarity: 'epic', value: 0, description: 'Greatly improves next catch odds and value.', type: 'token' },
    { key: 'chest-key', name: 'Chest Key', cost: 120, rarity: 'rare', value: 0, description: 'Next chest opens one rarity tier higher.', type: 'token' },
    { key: 'prospectors-lens', name: "Prospector's Lens", cost: 210, rarity: 'epic', value: 0, description: 'Next chest guarantees epic+ loot.', type: 'token' },
    { key: 'crafting-booster', name: 'Crafting Booster Kit', cost: 280, rarity: 'epic', value: 0, description: 'Improves your next craft (requires crafting unlocked).', type: 'token' },
    { key: 'enchanters-spark', name: "Enchanter's Spark", cost: 340, rarity: 'legendary', value: 0, description: 'Guarantees a minor enchant success (requires enchantments unlocked).', type: 'token' },
    // Prestige 4+ custom loot scrolls (unlockable after fourth prestige)
    { key: 'scroll-common', name: 'Scroll of Looting (Common)', cost: 1200, rarity: 'common', value: 0, description: 'Prestige 4+: add a common custom loot item.', type: 'scroll' },
    { key: 'scroll-rare', name: 'Scroll of Looting (Rare)', cost: 2400, rarity: 'rare', value: 0, description: 'Prestige 4+: add a rare custom loot item.', type: 'scroll' },
    { key: 'scroll-epic', name: 'Scroll of Looting (Epic/Mythic)', cost: 4800, rarity: 'epic', value: 0, description: 'Prestige 4+: add an epic or mythic custom loot item.', type: 'scroll' },
    { key: 'scroll-legendary', name: 'Scroll of Looting (Legendary)', cost: 8200, rarity: 'legendary', value: 0, description: 'Prestige 4+: add a legendary custom loot item.', type: 'scroll' },
];

const baseUpgrades: UpgradeDefinition[] = [
    { key: 'rod', name: 'Reinforced Rod', cost: 60, maxLevel: 1, stat: 'value', description: '+20% item value for 3 minutes (max 3 per 12h).' },
    { key: 'lure', name: 'Lucky Lure', cost: 80, maxLevel: 5, stat: 'rarity', description: 'Better bite quality: +6% higher rarity odds per level.' },
    { key: 'journal', name: 'Fishing Journal', cost: 50, maxLevel: 1, stat: 'xp', description: '+15% XP for 5 minutes (max 3 per 12h).' },
];

function getUpgrades(state?: PlayerState): UpgradeDefinition[] {
    const catalog = getCatalogSnapshot();
    const fromCatalog = catalog.upgrades && catalog.upgrades.length ? catalog.upgrades : baseUpgrades;
    const list = [...fromCatalog];
    const prestigeCount = state?.prestigeCount ?? 0;
    if (state && state.level >= 60 && prestigeCount < 4) {
        const tier = prestigeCount + 1;
        const reward = tier === 1
            ? 'unlock crafting'
            : tier === 2
                ? 'unlock trading'
                : tier === 3
                    ? 'unlock enchantments'
                    : 'unlock custom loot scrolls';
        const cost = tier === 1 ? 75000 : tier === 2 ? 100000 : tier === 3 ? 150000 : 220000;
        list.push({
            key: 'prestige',
            name: `Prestige Token ${tier}/4`,
            cost,
            maxLevel: 1,
            stat: 'prestige',
            description: `Reset to level 1 and ${reward}.`,
        });
    }
    const dedup = new Map<string, UpgradeDefinition>();
    for (const up of list) {
        if (!up?.key) continue;
        if (!dedup.has(up.key)) dedup.set(up.key, up);
    }
    return Array.from(dedup.values());
}

const basePoleSkins: Record<PoleSkinId, { id: PoleSkinId; name: string; levelReq: number; cost: number; description: string; rarity: Rarity }> = {
    classic: { id: 'classic', name: 'Classic Oak', levelReq: 1, cost: 0, description: 'Reliable wood finish.', rarity: 'common' },
    carbon: { id: 'carbon', name: 'Carbon Pro', levelReq: 5, cost: 120, description: 'Light, matte carbon fiber.', rarity: 'rare' },
    neon: { id: 'neon', name: 'Neon Flux', levelReq: 8, cost: 180, description: 'Glowing accents for night runs.', rarity: 'epic' },
    aurora: { id: 'aurora', name: 'Aurora Drift', levelReq: 12, cost: 260, description: 'Iridescent shimmer in motion.', rarity: 'legendary' },
};

const poleSkinImages: Record<PoleSkinId, string> = {
    classic: '/skins/wooden_rod.png',
    carbon: '/skins/carbon_rod.png',
    neon: '/skins/neon_rod.png',
    aurora: '/skins/aura_rod.png',
};

function getPoleSkinMap(catalog?: Catalog): Record<PoleSkinId, { id: PoleSkinId; name: string; levelReq: number; cost: number; description: string; rarity: Rarity; imageUrl?: string }> {
    const source = catalog && catalog.skins && catalog.skins.length ? catalog.skins : Object.values(basePoleSkins);
    const map: Record<PoleSkinId, { id: PoleSkinId; name: string; levelReq: number; cost: number; description: string; rarity: Rarity; imageUrl?: string }> = {
        classic: { ...basePoleSkins.classic },
        carbon: { ...basePoleSkins.carbon },
        neon: { ...basePoleSkins.neon },
        aurora: { ...basePoleSkins.aurora },
    } as any;
    for (const skin of source as any[]) {
        const id = skin.id as PoleSkinId;
        map[id] = {
            id,
            name: skin.name,
            levelReq: skin.levelReq ?? 1,
            cost: skin.cost ?? 0,
            description: skin.description ?? '',
            rarity: (skin.rarity ?? 'common') as Rarity,
            imageUrl: skin.imageUrl ?? poleSkinImages[id] ?? `/skins/${id}.png`,
        };
    }
    return map;
}

function skinStoreItems(catalog?: Catalog): StoreItem[] {
    const skins = getPoleSkinMap(catalog);
    return Object.values(skins)
        .filter((skin) => skin.id !== 'classic')
        .map((skin) => ({
        key: `skin-${skin.id}`,
        name: `${skin.name} Skin`,
        cost: skin.cost,
        rarity: skin.rarity,
        value: 0,
        description: `${skin.description} (req. lvl ${skin.levelReq})`,
        type: 'skin',
        minLevel: skin.levelReq,
        imageUrl: skin.imageUrl,
    }));
}

const baseCatalogVersion = process.env.CATALOG_VERSION ?? '1.0.0';
const baseCatalogTimestamp = Date.now();
const catalogOverridesPath = resolveInDataDir('catalog.json');

function loadCatalogOverrides(): Partial<Catalog> | null {
    try {
        const raw = require(catalogOverridesPath);
        if (raw && typeof raw === 'object') return raw as Partial<Catalog>;
    } catch {
        // optional file
    }
    return null;
}

function getStoreConfig(catalog: Catalog) {
    const cfg: Partial<NonNullable<Catalog['storeConfig']>> = catalog.storeConfig ?? {};
    const rotationHours = Number.isFinite(cfg.rotationHours) ? Math.max(1 / 6, Number(cfg.rotationHours)) : defaultStoreConfig.rotationHours;
    const rotationMs = rotationHours * 60 * 60 * 1000;
    const alwaysKeys = Array.isArray(cfg.alwaysKeys) && cfg.alwaysKeys.length ? cfg.alwaysKeys : [...defaultStoreConfig.alwaysKeys];
    const slots = Number.isFinite(cfg.slots) ? Math.max(1, Number(cfg.slots)) : defaultStoreConfig.slots;
    return { rotationHours, rotationMs, alwaysKeys, slots };
}

function storeVersionKey(catalog: Catalog, cfg: ReturnType<typeof getStoreConfig>) {
    return `${catalog.version}-${catalog.updatedAt}-rot:${cfg.rotationMs}-slots:${cfg.slots}-always:${cfg.alwaysKeys.join(',')}-premium:${premiumStoreSlots}-${premiumRarityFloor}`;
}

function labelFromId(id: string) {
    return id
        .split('-')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function runtimeStorePool(catalog: Catalog): StoreItem[] {
    const basePool = catalog.items && catalog.items.length ? catalog.items : storeItems;
    const skinPool = catalog.items && catalog.items.length ? [] : skinStoreItems(catalog);
    const merged = [...basePool, ...skinPool];
    const dedup = new Map<string, StoreItem>();
    for (const item of merged) {
        if (!item?.key) continue;
        if (!dedup.has(item.key)) dedup.set(item.key, item);
    }
    return Array.from(dedup.values());
}

function buildBaseCatalog(): Catalog {
    const materials = Object.keys(materialDefaults).map((id) => ({
        id,
        name: labelFromId(id),
    }));

    const essences = Object.keys(essenceDefaults).map((id) => ({
        id,
        name: labelFromId(id),
    }));

    const recipes = craftingRecipes.map((r) => {
        const sample = r.grantsItem ? r.grantsItem() : null;
        const grants = sample
            ? { name: sample.name, rarity: sample.rarity, type: sample.type, value: sample.value, description: sample.description }
            : r.grantsMaterials
                ? undefined
                : { name: r.name, rarity: 'common' as Rarity };
        return { id: r.id, name: r.name, description: r.description ?? grants?.description, costs: r.costs, grants, grantsMaterials: r.grantsMaterials };
    });

    const skins = Object.values(basePoleSkins).map((skin) => ({
        id: skin.id,
        name: skin.name,
        cost: skin.cost,
        levelReq: skin.levelReq,
        rarity: skin.rarity,
        description: skin.description,
        imageUrl: poleSkinImages[skin.id] ?? `/skins/${skin.id}.png`,
    }));

    const biomesCatalog = Object.values(baseBiomes).map((b) => ({
        id: b.key,
        name: b.name,
        tier: b.tier,
        rarityConfigs: b.rarityConfigs,
        lootTable: b.lootTable,
        goldMultiplier: b.goldMultiplier,
        xpMultiplier: b.xpMultiplier,
        imageUrl: b.imageUrl,
    }));

    const chatCommands = commandCatalog.map((c) => ({ ...c, enabled: isCommandEnabled(c.name) }));

    return {
        version: baseCatalogVersion,
        updatedAt: baseCatalogTimestamp,
        materials,
        essences,
        recipes,
        items: allStoreItems(),
        upgrades: [...baseUpgrades],
        skins,
        biomes: biomesCatalog,
        chatCommands,
        storeConfig: { rotationHours: defaultStoreConfig.rotationHours, alwaysKeys: [...defaultStoreConfig.alwaysKeys], slots: defaultStoreConfig.slots },
    };
}

export function getCatalogSnapshot(): Catalog {
    const base = buildBaseCatalog();
    const overrides = loadCatalogOverrides();
    if (!overrides) return base;
    return {
        ...base,
        ...overrides,
        version: overrides.version ?? base.version,
        updatedAt: overrides.updatedAt ?? base.updatedAt,
        materials: overrides.materials ?? base.materials,
        essences: overrides.essences ?? base.essences,
        recipes: overrides.recipes ?? base.recipes,
        items: overrides.items ?? base.items,
        upgrades: overrides.upgrades ?? base.upgrades,
        skins: overrides.skins ?? base.skins,
        biomes: overrides.biomes ?? base.biomes,
        chatCommands: overrides.chatCommands ?? base.chatCommands,
        storeConfig: overrides.storeConfig ?? base.storeConfig,
        ui: overrides.ui ?? base.ui,
    };
}

export function getCatalogDebug() {
    const catalog = getCatalogSnapshot();
    const cfg = getStoreConfig(catalog);
    return {
        version: catalog.version,
        updatedAt: catalog.updatedAt,
        storeConfig: { rotationHours: cfg.rotationHours, alwaysKeys: cfg.alwaysKeys, slots: cfg.slots },
        rotation: storeRotation
            ? { expiresAt: storeRotation.expiresAt, itemCount: storeRotation.items.length, version: storeRotationVersion }
            : null,
    };
}

function allStoreItems(): StoreItem[] {
    // Base pool used for the built-in catalog; runtime pulls from catalog via runtimeStorePool
    return [...storeItems, ...skinStoreItems()];
}

function pickStoreItems(catalog: Catalog, cfg: ReturnType<typeof getStoreConfig>): StoreItem[] {
    const base = runtimeStorePool(catalog);
    const always = base.filter((i) => cfg.alwaysKeys.includes(i.key));
    const pool = base.filter((i) => !cfg.alwaysKeys.includes(i.key));

    const selection: StoreItem[] = [...always];
    const chosenKeys = new Set(selection.map((i) => i.key));
    const targetCount = Math.min(cfg.slots, base.length);
    while (selection.length < targetCount && pool.length) {
        const idx = Math.floor(Math.random() * pool.length);
        const [picked] = pool.splice(idx, 1);
        selection.push(picked);
        chosenKeys.add(picked.key);
    }

    // Add premium slot(s) with higher-rarity picks
    const premiumFloorIdx = Math.max(0, rarityOrder.indexOf(premiumRarityFloor));
    const premiumPool = base.filter((i) => rarityOrder.indexOf(i.rarity) >= premiumFloorIdx && !chosenKeys.has(i.key));
    for (let i = 0; i < premiumStoreSlots && premiumPool.length; i += 1) {
        const idx = Math.floor(Math.random() * premiumPool.length);
        const [picked] = premiumPool.splice(idx, 1);
        selection.push({ ...picked, premium: true });
        chosenKeys.add(picked.key);
    }

    return selection;
}

function storePriceMultiplier(state?: PlayerState): number {
    if (!state) return 1;
    const biome = getBiome(state);
    const tierBonus = Math.max(0, biome.tier - 1) * storeTierPriceStep;
    const levelBonus = Math.min(storeLevelPriceCap, Math.max(0, state.level - storeLevelPriceStart) * storeLevelPriceStep);
    const prestigeBonus = (state.prestigeCount ?? 0) * storePrestigePriceStep;
    const multiplier = 1 + tierBonus + levelBonus + prestigeBonus;
    return Math.min(storePriceMaxMultiplier, multiplier);
}

function priceStoreItem(item: StoreItem, state?: PlayerState): number {
    const premiumBoost = item.premium ? 1 + premiumPriceBonus : 1;
    const scaled = Math.round((item.cost ?? 0) * storePriceMultiplier(state) * premiumBoost);
    return Math.max(1, scaled);
}

function priceStoreItemsForState(items: StoreItem[], state?: PlayerState): StoreItem[] {
    return items.map((item) => ({ ...item, cost: priceStoreItem(item, state) }));
}

function currentStoreItems(): StoreItem[] {
    const catalog = getCatalogSnapshot();
    const cfg = getStoreConfig(catalog);
    const versionKey = storeVersionKey(catalog, cfg);
    const now = Date.now();
    if (storeRotation && storeRotationVersion === versionKey && now < storeRotation.expiresAt) {
        return storeRotation.items;
    }

    const selection = pickStoreItems(catalog, cfg);
    storeRotation = { items: selection, expiresAt: now + cfg.rotationMs };
    storeRotationVersion = versionKey;
    return selection;
}

function isStoreItemUnlocked(state: PlayerState | undefined, item: StoreItem): boolean {
    if (!state) return true;
    if (item.type === 'scroll' && (state.prestigeCount ?? 0) < 4) return false;
    if (item.type === 'skin' && item.minLevel && state.level < item.minLevel) return false;
    return true;
}

const players = new Map<string, PlayerState>();
const tugTimers = new Map<string, NodeJS.Timeout>();
const decayTimers = new Map<string, NodeJS.Timeout>();
const baitTimers = new Map<string, NodeJS.Timeout>();
const charmTimers = new Map<string, NodeJS.Timeout>();
const tugMinDelayMs = 2000;
const tugMaxDelayMs = 6000;
const tugResponseWindowMs = 10000; // time to react after tug fires (covers stream delay)
const tugFailSafeBufferMs = 2000; // prevents getting stuck if tug timer misfires

type TimedBuff = { amount: number; timer: NodeJS.Timeout; endsAt: number; label?: string };
const xpBuffTimers = new Map<string, TimedBuff[]>();
const valueBuffTimers = new Map<string, TimedBuff[]>();
let themeSent = false;
const lastCommandAt = new Map<string, number>();
const lastGlobalCommandAt = new Map<string, number>();
const DEFAULT_USER_COOLDOWN_MS = 35 * 1000;
const DEFAULT_GLOBAL_COOLDOWN_MS = 0; // disabled by default
let userCommandCooldownMs = DEFAULT_USER_COOLDOWN_MS;
let globalCommandCooldownMs = DEFAULT_GLOBAL_COOLDOWN_MS;
const interactionTimeoutMs = 25 * 1000;
const maxInteractionRefreshes = 2; // number of extensions beyond the initial 25s (total 75s)
const maxEventDurationMs = 10 * 60 * 1000;
const defaultEventDurationMs = 5 * 60 * 1000;
const maxDoubleStacks = 3;
let interactionLock: { scopedKey: string; username: string; mode: 'store' | 'inventory'; timer?: NodeJS.Timeout; expiresAt: number; refreshesUsed: number } | null = null;

type GlobalEvent = { id: string; kind: 'xp' | 'gold' | 'double' | 'luck'; endsAt: number; amount: number; targetRarity?: Rarity };
let activeEvents: GlobalEvent[] = [];
const eventTimers = new Map<string, NodeJS.Timeout>();

const baseGoldPerCatch = 6;
const inventoryCapBase = 15;
const inventoryCapMax = 30;
const inventoryCapStep = 5;

function ensurePublic(state: PlayerState): PlayerStatePublic {
    const { username, displayName, twitchLogin, gold, level, xp, xpNeeded, poleLevel, lureLevel, luck, inventory, poleSkinId, ownedPoleSkins, inventoryCap, biomeKey, activeBuffs, upgradeCharges, craftingUnlocked, tradingUnlocked, enchantmentsUnlocked, prestigeCount, materials, essences, enchantments, tradeListings } = state;
    return {
        username,
        displayName,
        twitchLogin,
        gold,
        level,
        xp,
        xpNeeded,
        poleLevel,
        lureLevel,
        luck,
        inventory,
        poleSkinId,
        ownedPoleSkins,
        inventoryCap,
        biome: biomeKey,
        activeBuffs,
        upgradeCharges,
        craftingUnlocked,
        tradingUnlocked,
        enchantmentsUnlocked,
        prestigeCount,
        materials,
        essences,
        enchantments,
        tradeListings,
    };
}

function ids(username: string, channel?: string) {
    const safeUser = username.trim().toLowerCase() || 'anon';
    const safeChannel = (channel ?? process.env.TWITCH_CHANNEL ?? 'default').trim().toLowerCase() || 'default';
    const scopedKey = `${safeChannel}__${safeUser}`;
    return { safeUser, safeChannel, scopedKey };
}

function baseState(username: string, scopedKey: string): PlayerState {
    const startKey = getBiomeData().startKey;
    return {
        username,
        displayName: username,
        twitchLogin: undefined,
        gold: 25,
        level: 1,
        xp: 0,
        xpNeeded: 100,
        poleLevel: 1,
        lureLevel: 0,
        luck: 0,
        poleSkinId: 'classic',
        ownedPoleSkins: ['classic'],
        inventory: [],
        inventoryCap: inventoryCapBase,
        isCasting: false,
        hasTug: false,
        biome: startKey,
        biomeKey: startKey,
        activeBuffs: {},
        upgradeCharges: {},
            craftingUnlocked: false,
            tradingUnlocked: false,
            enchantmentsUnlocked: false,
            prestigeCount: 0,
        materials: { ...materialDefaults },
        essences: { ...essenceDefaults },
        enchantments: [],
        tradeListings: [],
        stabilizerCharges: 0,
        echoReelCharges: 0,
        chestUpgrade: false,
        chestMinRarityIndex: undefined,
        craftingBoostCharges: 0,
        enchantBoostCharges: 0,
        scopedKey,
    };
}

async function ensureDataDir() {
    await fs.mkdir(dataDir, { recursive: true });
}

async function loadTradeBoard(channel?: string) {
    const targetChan = (channel ?? process.env.TWITCH_CHANNEL ?? 'default').toLowerCase();
        if (tradeLoadedChan === targetChan) return; // Prevent loading the same channel multiple times
    tradeLoadedChan = targetChan;
    await ensureDataDir();
        const tradeStorePath = tradeStorePathForChannel(targetChan); // Get the path for the trade store
    try {
        const raw = await fs.readFile(tradeStorePath, 'utf-8');
        const parsed = JSON.parse(raw) as Array<TradeListing & { sellerScopedKey?: string }>;
        tradeBoard.length = 0;
        tradeBoard.push(...parsed.map((l) => ({ ...l, sellerScopedKey: l.sellerScopedKey ?? ids(l.seller, l.channel).scopedKey })));
        pruneTradeBoard();
    } catch {
        tradeBoard.length = 0;
    }
}

async function persistTradeBoard(channel?: string) {
    await ensureDataDir();
    const tradeStorePath = tradeStorePathForChannel(channel);
    const payload = tradeBoard.map((l) => ({ ...l }));
    await fs.writeFile(tradeStorePath, JSON.stringify(payload, null, 2));
}

function savePath(scopedKey: string) {
    const safe = scopedKey.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    return path.join(dataDir, `${safe}.json`);
}

async function loadPlayer(username: string, channel?: string): Promise<PlayerState> {
    const { scopedKey } = ids(username, channel);
    const existing = players.get(scopedKey);
    if (existing) return existing;

    await ensureDataDir();
    try {
        const buf = await fs.readFile(savePath(scopedKey), 'utf-8');
        const parsed = JSON.parse(buf) as PlayerStatePublic;
        const hydrated: PlayerState = {
            ...baseState(username, scopedKey),
            ...parsed,
            username,
            isCasting: false,
            hasTug: false,
            scopedKey,
        };
        if (!hydrated.inventoryCap) hydrated.inventoryCap = inventoryCapBase;
        hydrated.inventoryCap = Math.min(inventoryCapMax, Math.max(inventoryCapBase, hydrated.inventoryCap));
        if (!hydrated.poleSkinId) hydrated.poleSkinId = 'classic';
        if (!hydrated.ownedPoleSkins) hydrated.ownedPoleSkins = ['classic'];
        if (!hydrated.ownedPoleSkins.includes('classic')) hydrated.ownedPoleSkins.unshift('classic');
        const startKey = getBiomeData().startKey;
        hydrated.biome = hydrated.biome || startKey;
        hydrated.biomeKey = (hydrated as any).biomeKey || hydrated.biome || startKey;
        if (!hydrated.activeBuffs) hydrated.activeBuffs = {} as any;
        if (!hydrated.upgradeCharges) hydrated.upgradeCharges = {} as any;
            if (hydrated.craftingUnlocked === undefined) hydrated.craftingUnlocked = false;
            if (hydrated.tradingUnlocked === undefined) hydrated.tradingUnlocked = false;
            if (hydrated.enchantmentsUnlocked === undefined) hydrated.enchantmentsUnlocked = false;
            if (hydrated.prestigeCount === undefined) hydrated.prestigeCount = 0;
        if (!hydrated.materials) hydrated.materials = { ...materialDefaults };
        for (const key of Object.keys(materialDefaults) as CraftingMaterialId[]) {
            if (hydrated.materials[key] === undefined) hydrated.materials[key] = 0;
        }
        if (!hydrated.essences) hydrated.essences = { ...essenceDefaults };
        for (const key of Object.keys(essenceDefaults) as EssenceId[]) {
            if (hydrated.essences[key] === undefined) hydrated.essences[key] = 0;
        }
        if (!Array.isArray(hydrated.enchantments)) hydrated.enchantments = [] as EnchantmentInstance[];
        if (!Array.isArray(hydrated.tradeListings)) hydrated.tradeListings = [] as TradeListing[];
        if (hydrated.stabilizerCharges === undefined) hydrated.stabilizerCharges = 0;
        if (hydrated.echoReelCharges === undefined) hydrated.echoReelCharges = 0;
        if (hydrated.chestUpgrade === undefined) hydrated.chestUpgrade = false;
        if (hydrated.chestMinRarityIndex === undefined) hydrated.chestMinRarityIndex = undefined;
        if (hydrated.craftingBoostCharges === undefined) hydrated.craftingBoostCharges = 0;
        if (hydrated.enchantBoostCharges === undefined) hydrated.enchantBoostCharges = 0;
        players.set(scopedKey, hydrated);
        return hydrated;
    } catch {
        const created = baseState(username, scopedKey);
        players.set(scopedKey, created);
        return created;
    }
}

function pruneTradeBoard() {
    const now = Date.now();
    for (const entry of tradeBoard) {
        if (entry.status === 'active' && entry.expiresAt <= now) {
            entry.status = 'expired';
        }
    }
    // drop expired/inactive entries beyond a window to limit growth
    if (tradeBoard.length > 256) {
        const activeOrRecent = tradeBoard.filter((l) => l.status === 'active' || l.expiresAt > now - 6 * 60 * 60 * 1000);
        tradeBoard.length = 0;
        tradeBoard.push(...activeOrRecent);
    }
}

// Expose a safe snapshot for API callers (no secrets/stateful flags)
export async function getPublicState(username: string, channel?: string): Promise<PlayerStatePublic> {
    const state = await loadPlayer(username, channel);
    return ensurePublic(state);
}

// Panel snapshot: includes current store rotation and upgrade options
export async function getPanelData(username: string, channel?: string): Promise<{
    state: PlayerStatePublic;
    store: StoreItem[];
    upgrades: UpgradeDefinition[];
    tradeBoard: TradeListing[];
    storeExpiresAt: number;
    storeRefreshRemainingMs: number;
}> {
    const state = await loadPlayer(username, channel);
    // Resolve a friendly Twitch display name (cached) using the numeric user_id from the extension token
    try {
        const userInfo = await fetchTwitchUser(username);
        if (userInfo) {
            const nextDisplay = userInfo.displayName || state.displayName || state.username;
            const nextLogin = userInfo.login || state.twitchLogin;
            if (nextDisplay !== state.displayName || nextLogin !== state.twitchLogin) {
                state.displayName = nextDisplay;
                state.twitchLogin = nextLogin;
                await savePlayer(state); // persist for reuse without extra Helix calls
            }
            recordHelixSuccess();
        }
    } catch (err) {
        recordHelixFailure(err);
        // Helix failures should not block the panel; fallback to stored username
    }
    await loadTradeBoard();
    const catalog = getCatalogSnapshot();
    const storeConfig = getStoreConfig(catalog);
    const publicState = ensurePublic(state);
    const baseStore = currentStoreItems();
    const rotation = storeRotation ?? { items: baseStore, expiresAt: Date.now() + storeConfig.rotationMs };
    if (!storeRotation) {
        storeRotation = rotation;
        storeRotationVersion = storeVersionKey(catalog, storeConfig);
    }
    const store = priceStoreItemsForState(rotation.items, state);
    const last = lastStoreRefresh.get(state.scopedKey) ?? 0;
    const remaining = Math.max(0, storeRefreshCooldownMs - (Date.now() - last));
    const upgrades = getUpgrades(state);
    pruneTradeBoard();
    const board = tradeBoard
        .filter((l) => l.status === 'active')
        .map((l) => {
            const { sellerScopedKey, ...rest } = l;
            return rest;
        });
    return { state: publicState, store, upgrades, tradeBoard: board, storeExpiresAt: rotation.expiresAt, storeRefreshRemainingMs: remaining };
}

async function savePlayer(state: PlayerState) {
    await ensureDataDir();
    await fs.writeFile(savePath(state.scopedKey), JSON.stringify(ensurePublic(state), null, 2));
}

const enableActivityLogs = process.env.ENABLE_ACTIVITY_LOGS !== 'false';

function emit(io: Server, event: OverlayEvent) {
    io.emit('overlay-event', event);
}

function pushLog(io: Server, line: string) {
    if (!enableActivityLogs) return; // optional quiet mode for noisy environments
    emit(io, { type: 'log', line });
}

function emitStoreLocked(io: Server, reason: string, remainingMs?: number, refreshesLeft?: number, user?: string) {
    const cfg = getStoreConfig(getCatalogSnapshot());
    emit(io, { type: 'store', items: [], upgrades: [], expiresAt: Date.now() + cfg.rotationMs, locked: { reason, remainingMs, refreshesLeft }, user });
}

function emitInventoryLocked(io: Server, state: PlayerState, reason: string) {
    const refreshesLeft = interactionLock && interactionLock.scopedKey === state.scopedKey ? Math.max(0, maxInteractionRefreshes - interactionLock.refreshesUsed) : undefined;
    const remainingMs = interactionLock && interactionLock.scopedKey === state.scopedKey ? Math.max(0, interactionLock.expiresAt - Date.now()) : undefined;
    emit(io, { type: 'inventory', state: ensurePublic(state), locked: { reason, remainingMs, refreshesLeft } });
}

function randomInt(min: number, max: number) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatDuration(ms: number) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hours > 0) return `${hours}h ${mins}m`;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function broadcastEvents(io: Server) {
    const events = [...activeEvents].sort((a, b) => a.endsAt - b.endsAt);
    emit(io, {
        type: 'events',
        events: events.map((e) => ({ id: e.id, kind: e.kind, amount: e.amount, endsAt: e.endsAt })),
    });
}

function clearGlobalEvent(io: Server | undefined, id?: string, reason?: string) {
    const idsToClear = id ? [id] : activeEvents.map((e) => e.id);
    for (const key of idsToClear) {
        const timer = eventTimers.get(key);
        if (timer) {
            clearTimeout(timer);
            eventTimers.delete(key);
        }
        const idx = activeEvents.findIndex((e) => e.id === key);
        if (idx >= 0) {
            const ended = activeEvents[idx];
            activeEvents.splice(idx, 1);
            if (io && reason) {
                emit(io, { type: 'status', text: `Event ended (${ended.kind}${reason ? `: ${reason}` : ''}).` });
            }
        }
    }
    if (io) broadcastEvents(io);
}

function startGlobalEvent(io: Server, kind: GlobalEvent['kind'], durationMs: number, amount: number, targetRarity?: Rarity) {
    const endsAt = Date.now() + durationMs;
    const id = randomUUID();
    const evt: GlobalEvent = { id, kind, endsAt, amount, targetRarity };
    activeEvents.push(evt);
    const timer = setTimeout(() => clearGlobalEvent(io, id, 'duration reached'), durationMs);
    eventTimers.set(id, timer);
    const bonusStacks = Math.max(1, Math.round(amount));
    const label = kind === 'xp'
        ? `XP +${Math.round(amount * 100)}%`
        : kind === 'gold'
            ? `Gold +${Math.round(amount * 100)}%`
            : kind === 'luck'
                ? `Luck +${Math.round(amount * 100)}%${targetRarity ? ` (${targetRarity} only)` : ''}`
                : `Double catch x${bonusStacks + 1}`;
    emit(io, { type: 'status', text: `Event started: ${label} for ${formatDuration(durationMs)}.` });
    broadcastEvents(io);
}

function currentEvents(io?: Server): GlobalEvent[] {
    const now = Date.now();
    const expired = activeEvents.filter((e) => now >= e.endsAt);
    if (expired.length) {
        for (const e of expired) clearGlobalEvent(io, e.id, 'expired');
    }
    return activeEvents;
}

function getEventEffects(io?: Server) {
    const events = currentEvents(io);
    let xpBonus = 0;
    let goldBonus = 0;
    let luckGlobalBonus = 0; // applies to all rarities
    let luckTargetedBonus = 0; // applies only to a specific rarity bucket
    let luckTargetIdx: number | undefined;
    let doubleStacks = 0;
    for (const evt of events) {
        if (evt.kind === 'xp') xpBonus += Math.max(0, evt.amount);
        if (evt.kind === 'gold') goldBonus += Math.max(0, evt.amount);
        if (evt.kind === 'luck') {
            if (evt.targetRarity) {
                luckTargetedBonus += Math.max(0, evt.amount);
                const idx = rarityOrder.indexOf(evt.targetRarity as Rarity);
                if (idx >= 0) {
                    luckTargetIdx = luckTargetIdx === undefined ? idx : Math.min(luckTargetIdx, idx);
                }
            } else {
                luckGlobalBonus += Math.max(0, evt.amount);
            }
        }
        if (evt.kind === 'double') doubleStacks += Math.max(0, Math.round(evt.amount || 1));
    }
    return { events, xpBonus, goldBonus, luckGlobalBonus, luckTargetedBonus, luckTargetIdx, doubleStacks } as const;
}

function rollRarity(state: PlayerState, biome: Biome, eventLuck?: { globalAmount?: number; targetedAmount?: number; targetIdx?: number }): RarityConfig {
    // Boost higher rarities with level and lure upgrades
    const baitBonus = state.activeBait?.rarityBonus ?? 0;
    const charmBonus = state.activeCharm?.rarityBonus ?? 0;
    const baseBonus = (state.level - 1) * 0.04 + state.lureLevel * 0.06 + state.luck * 0.01 + baitBonus + charmBonus;
    const globalEventBonus = Math.max(0, eventLuck?.globalAmount ?? 0);
    const targetedEventBonus = Math.max(0, eventLuck?.targetedAmount ?? 0);
    const targetIdx = eventLuck?.targetIdx;
    const configs = biome.rarityConfigs;
    const weights = configs.map((cfg, idx) => {
        const pooledBonus = baseBonus + globalEventBonus + (targetIdx !== undefined && idx === targetIdx ? targetedEventBonus : 0);
        const rarityBoost = 1 + Math.min(2, pooledBonus) * (idx / (configs.length - 1));
        return { cfg, weight: cfg.weight * rarityBoost };
    });
    const total = weights.reduce((sum, w) => sum + w.weight, 0);
    let roll = Math.random() * total;
    for (const w of weights) {
        roll -= w.weight;
        if (roll <= 0) {
            const picked = w.cfg;
            const minIdx = state.activeBait?.minRarityIndex;
            if (minIdx !== undefined) {
                const pickedIdx = rarityOrder.indexOf(picked.rarity);
                if (pickedIdx < minIdx) {
                    const upgraded = configs.find((c) => rarityOrder.indexOf(c.rarity) === minIdx);
                    return upgraded ?? picked;
                }
            }
            return picked;
        }
    }
    return weights[0].cfg;
}

function makeItem(rarity: RarityConfig, valueMultiplier: number, biome: Biome): InventoryItem {
    const names = biome.lootTable[rarity.rarity];
    const extras = customLoot[rarity.rarity] ?? [];
    const combined = [...names, ...extras];
    const { maxTier } = getBiomeData();
    const filtered = biome.tier === maxTier ? combined.filter((n) => n !== 'Enchanted Compass') : combined;
    const pool = filtered.length > 0 ? filtered : names;
    const name = pool[randomInt(0, pool.length - 1)];
    const [min, max] = rarity.valueRange;
    const value = Math.round(randomInt(min, max) * valueMultiplier);
    const special = specialLoot[name] ?? {};
    return {
        id: randomUUID(),
        name,
        rarity: rarity.rarity,
        value,
        ...special,
    };
}

function applyCatchRewards(state: PlayerState, item: InventoryItem, rarity: RarityConfig, biome: Biome, eventEffects?: { xpBonus: number; goldBonus: number }) {
    const valueBuff = state.activeBuffs?.value?.amount ?? 0;
    const valueMultiplier = 1 + (state.poleLevel - 1) * 0.1 + (state.activeBait?.valueBonus ?? 0) + valueBuff;
    const xpBuff = state.activeBuffs?.xp?.amount ?? 0;
    const xpBoost = 1 + state.poleLevel * 0.05 + state.lureLevel * 0.05 + state.luck * 0.1 + (state.activeCharm?.xpBonus ?? 0) + (state.activeBait?.xpBonus ?? 0) + xpBuff;
    const goldMultiplier = 1 + (eventEffects?.goldBonus ?? 0);
    const xpMultiplier = 1 + (eventEffects?.xpBonus ?? 0);
    const goldEarned = Math.round((baseGoldPerCatch + item.value * valueMultiplier) * biome.goldMultiplier * goldMultiplier);
    const xpGained = Math.round(rarity.xp * xpBoost * biome.xpMultiplier * xpMultiplier);

    state.gold += goldEarned;
    state.xp += xpGained;
    const stored = state.inventory.length < state.inventoryCap;
    if (stored) {
        state.inventory.push(item);
    }

    const levelUps: number[] = [];
    while (state.xp >= state.xpNeeded) {
        state.xp -= state.xpNeeded;
        state.level += 1;
        state.xpNeeded = Math.round(100 + state.level * 30);
        levelUps.push(state.level);
    }

    return { goldEarned, xpGained, levelUps, stored };
}

function maybeAwardCosmicDust(state: PlayerState, biome: Biome): number {
    if (biome.tier < 5) return 0;
    const roll = Math.random();
    const chance = 0.15;
    if (roll > chance) return 0;
    const amount = 1 + (Math.random() < 0.35 ? 1 : 0);
    state.materials = state.materials ?? { ...materialDefaults };
    state.materials['cosmic-dust'] = (state.materials['cosmic-dust'] ?? 0) + amount;
    return amount;
}

function clearTug(scopedKey: string) {
    const timer = tugTimers.get(scopedKey);
    if (timer) {
        clearTimeout(timer);
        tugTimers.delete(scopedKey);
    }
}

function clearDecay(scopedKey: string) {
    const timer = decayTimers.get(scopedKey);
    if (timer) {
        clearTimeout(timer);
        decayTimers.delete(scopedKey);
    }
}

function clearBait(scopedKey: string) {
    const timer = baitTimers.get(scopedKey);
    if (timer) {
        clearTimeout(timer);
        baitTimers.delete(scopedKey);
    }
}

function clearCharm(io: Server | null, state: PlayerState) {
    const timer = charmTimers.get(state.scopedKey);
    if (timer) {
        clearTimeout(timer);
        charmTimers.delete(state.scopedKey);
    }
    state.activeCharm = undefined;
    if (io) emitBuffs(io, state);
}

function emitBuffs(io: Server, state: PlayerState) {
    emit(io, { type: 'buffs', user: state.username, buffs: { xp: state.activeBuffs?.xp, value: state.activeBuffs?.value, charm: state.activeCharm ? { rarityBonus: state.activeCharm.rarityBonus, xpBonus: state.activeCharm.xpBonus, expiresAt: state.activeCharm.expiresAt } : undefined } });
}

function recomputeBuff(state: PlayerState, kind: 'xp' | 'value', map: Map<string, TimedBuff[]>, io?: Server) {
    const now = Date.now();
    const entries = (map.get(state.scopedKey) ?? []).filter((e) => e.endsAt > now);
    map.set(state.scopedKey, entries);
    const total = entries.reduce((sum, e) => sum + e.amount, 0);
    const buffs = state.activeBuffs ?? (state.activeBuffs = {} as any);
    if (total > 0) {
        const maxEnds = Math.max(...entries.map((e) => e.endsAt));
        buffs[kind] = { amount: total, expiresAt: maxEnds } as any;
    } else {
        if ((buffs as any)[kind]) {
            delete (buffs as any)[kind];
        }
    }
    if (io) emitBuffs(io, state);
    return total;
}

function addTimedBuff(state: PlayerState, kind: 'xp' | 'value', amount: number, durationMs: number, map: Map<string, TimedBuff[]>, io: Server, expireText: string) {
    const endsAt = Date.now() + durationMs;
    const timer = setTimeout(() => {
        const list = (map.get(state.scopedKey) ?? []).filter((e) => e.timer !== timer);
        map.set(state.scopedKey, list);
        recomputeBuff(state, kind, map, io);
        if (expireText) {
            emit(io, { type: 'status', text: expireText });
        }
    }, durationMs);
    const list = map.get(state.scopedKey) ?? [];
    list.push({ amount, timer, endsAt, label: expireText });
    map.set(state.scopedKey, list);
    recomputeBuff(state, kind, map, io);
}

function clearInteractionLock(io: Server | null, applyCooldown: boolean, reason?: string) {
    if (!interactionLock) return;
    if (interactionLock.timer) {
        clearTimeout(interactionLock.timer);
    }
    if (applyCooldown) {
        lastCommandAt.set(interactionLock.scopedKey, Date.now());
    }
    if (io && reason) {
        emit(io, { type: 'status', text: reason });
    }
    interactionLock = null;
}

function armInteractionTimeout(io: Server) {
    if (!interactionLock) return;
    if (interactionLock.timer) clearTimeout(interactionLock.timer);
    const remaining = interactionLock.expiresAt - Date.now();
    if (remaining <= 0) {
        const { username, mode } = interactionLock;
        clearInteractionLock(io, true, `${username}'s ${mode} closed after inactivity.`);
        return;
    }
    interactionLock.timer = setTimeout(() => {
        if (!interactionLock) return;
        const { username, mode } = interactionLock;
        clearInteractionLock(io, true, `${username}'s ${mode} closed after inactivity.`);
    }, remaining);
}

function beginInteraction(io: Server, state: PlayerState, mode: 'store' | 'inventory', announce: boolean) {
    const now = Date.now();
    if (interactionLock && interactionLock.scopedKey === state.scopedKey) {
        interactionLock.mode = mode;
        armInteractionTimeout(io);
        if (announce) {
            emit(io, { type: 'status', text: `${state.username}, ${mode} open - timer running (${interactionTimeoutMs / 1000}s per window, ${maxInteractionRefreshes} refreshes).` });
        }
        return;
    }
    interactionLock = {
        scopedKey: state.scopedKey,
        username: state.username,
        mode,
        expiresAt: now + interactionTimeoutMs,
        refreshesUsed: 0,
    };
    armInteractionTimeout(io);
    if (announce) {
        emit(io, { type: 'status', text: `${state.username}, ${mode} open - 25s to interact (up to ${maxInteractionRefreshes} refreshes).` });
    }
}

function refreshInteractionLock(io: Server, state: PlayerState) {
    if (!interactionLock || interactionLock.scopedKey !== state.scopedKey) return;
    if (interactionLock.refreshesUsed >= maxInteractionRefreshes) {
        return;
    }
    interactionLock.refreshesUsed += 1;
    interactionLock.expiresAt = Date.now() + interactionTimeoutMs;
    armInteractionTimeout(io);
}

async function handleFish(io: Server, state: PlayerState) {
    emit(io, {
        type: 'status',
        text: 'Commands: !fish (help), !cast, !reel, !save, !level, !theme <name>, !enchant <essence>, !duplicate <item|mat>',
    });
    pushLog(io, `${state.username} checked the fishing guide.`);
}

async function handleCast(io: Server, state: PlayerState) {
    if (state.isCasting) {
        emit(io, { type: 'status', text: `${state.username} already has a line in the water.` });
        return;
    }

    if (state.activeBait?.expiresAt && state.activeBait.expiresAt < Date.now()) {
        state.activeBait = undefined;
    }

    state.isCasting = true;
    state.hasTug = false;
    clearTug(state.scopedKey);
    clearDecay(state.scopedKey);

    // Refresh overlay rod art for the casting player so skins stay accurate after overlay reloads
    emit(io, { type: 'skin', user: state.username, skinId: state.poleSkinId });

    const scheduleDecay = (delayMs: number) => {
        clearDecay(state.scopedKey);
        const decay = setTimeout(() => {
            if (!state.isCasting) return;
            state.isCasting = false;
            state.hasTug = false;
            emit(io, { type: 'catch', user: state.username, success: false });
            emit(io, { type: 'status', text: `${state.username}'s line went slack.` });
            pushLog(io, `${state.username} let the line go slack (timed out).`);
            clearTug(state.scopedKey);
            if (state.activeBait) {
                state.activeBait.uses -= 1;
                if (state.activeBait.uses <= 0) state.activeBait = undefined;
            }
        }, delayMs);
        decayTimers.set(state.scopedKey, decay);
    };

    const eta = randomInt(tugMinDelayMs, tugMaxDelayMs);
    // Fail-safe: if tug never fires, still clear state after expected window plus buffer
    scheduleDecay(eta + tugResponseWindowMs + tugFailSafeBufferMs);

    const timer = setTimeout(() => {
        state.hasTug = true;
        emit(io, { type: 'tug', user: state.username });
        // Give players a generous window after seeing the tug to handle stream delay
        scheduleDecay(tugResponseWindowMs);
    }, eta);
    tugTimers.set(state.scopedKey, timer);

    emit(io, { type: 'cast', user: state.username, etaMs: eta });
    pushLog(io, `${state.username} casts their line.`);
}

async function handleReel(io: Server, state: PlayerState) {
    if (!state.isCasting) {
        emit(io, { type: 'status', text: `${state.username} needs to !cast first.` });
        return;
    }

    clearTug(state.scopedKey);
    clearDecay(state.scopedKey);

    if (!state.hasTug) {
        if (state.stabilizerCharges && state.stabilizerCharges > 0) {
            state.stabilizerCharges -= 1;
            state.hasTug = true; // forgive the early reel and treat as if a tug was present
        } else {
            state.isCasting = false;
            emit(io, { type: 'catch', user: state.username, success: false });
            pushLog(io, `${state.username} reeled in too early.`);
            if (state.activeBait) {
                state.activeBait.uses -= 1;
                if (state.activeBait.uses <= 0) state.activeBait = undefined;
            }
            return;
        }
    }

    state.hasTug = false;
    state.isCasting = false;

    const biome = getBiome(state);
    const eventEffects = getEventEffects(io);
    const rarity = rollRarity(state, biome, {
        globalAmount: eventEffects.luckGlobalBonus,
        targetedAmount: eventEffects.luckTargetedBonus,
        targetIdx: eventEffects.luckTargetIdx,
    });
    const item = makeItem(rarity, 1 + (state.level - 1) * 0.03, biome);
    const { goldEarned, xpGained, levelUps, stored } = applyCatchRewards(state, item, rarity, biome, eventEffects);

    const cosmicDustGained = maybeAwardCosmicDust(state, biome);

    const bonusCatchCount = Math.min(maxDoubleStacks, Math.max(0, Math.round(eventEffects.doubleStacks)));
    for (let i = 0; i < bonusCatchCount; i += 1) {
        const bonusItem = makeItem(rarity, 1 + (state.level - 1) * 0.03, biome);
        const { goldEarned: bonusGold, xpGained: bonusXp, levelUps: bonusLevels, stored: bonusStored } = applyCatchRewards(state, bonusItem, rarity, biome, eventEffects);
        emit(io, { type: 'status', text: `${state.username} scored a double catch bonus: ${bonusItem.rarity} ${bonusItem.name}!` });
        emit(io, { type: 'inventory', state: ensurePublic(state) });
        if (bonusLevels.length > 0) {
            emit(io, { type: 'level', level: state.level, xp: state.xp, xpNeeded: state.xpNeeded });
        }
        pushLog(io, `${state.username} double-event bonus ${bonusItem.rarity} ${bonusItem.name} (+${bonusGold}g, +${bonusXp}xp${bonusStored ? '' : ', auto-sold'})`);
    }

    // Persist progress after resolving the catch and any bonus drops
    await savePlayer(state);

    // Small chance to award a bonus scroll after prestige 4
    if ((state.prestigeCount ?? 0) >= 4 && Math.random() < 0.05) {
        const scrollDefs: Array<{ name: string; key: string; rarity: Rarity }> = [
            { key: 'scroll-common', name: 'Scroll of Looting (Common)', rarity: 'common' },
            { key: 'scroll-rare', name: 'Scroll of Looting (Rare)', rarity: 'rare' },
            { key: 'scroll-epic', name: 'Scroll of Looting (Epic/Mythic)', rarity: 'epic' },
            { key: 'scroll-legendary', name: 'Scroll of Looting (Legendary)', rarity: 'legendary' },
        ];
        const drop = scrollDefs[Math.floor(Math.random() * scrollDefs.length)];
        const bonus: InventoryItem = { id: randomUUID(), name: drop.name, rarity: drop.rarity, value: 0, description: 'Use to add custom loot', type: 'scroll' };
        let storedScroll = false;
        if (state.inventory.length < state.inventoryCap) {
            state.inventory.push(bonus);
            storedScroll = true;
        } else {
            state.gold += 50; // small consolation
        }
        emit(io, { type: 'status', text: `${state.username} found a ${bonus.name}! Use !use scroll <rarity> <item name>.` });
        pushLog(io, `${state.username} found ${bonus.name} (prestige 4 bonus).${storedScroll ? '' : ' Inventory full; converted to 50g.'}`);
    }

    if (state.echoReelCharges && state.echoReelCharges > 0) {
        state.echoReelCharges -= 1;
        const downgradedIdx = Math.max(0, rarityOrder.indexOf(rarity.rarity) - 1);
        const downgradedRarity = biome.rarityConfigs.find((r) => rarityOrder.indexOf(r.rarity) === downgradedIdx) ?? rarity;
        const bonusItem = makeItem(downgradedRarity, 1 + (state.level - 1) * 0.03, biome);
        const { goldEarned: bonusGold, xpGained: bonusXp, levelUps: bonusLevels, stored: bonusStored } = applyCatchRewards(state, bonusItem, downgradedRarity, biome, eventEffects);
        pushLog(io, `${state.username}'s Echo Reel triggered: bonus ${bonusItem.rarity} ${bonusItem.name} (+${bonusGold}g, +${bonusXp}xp${bonusStored ? '' : ', auto-sold'})`);
        emit(io, { type: 'status', text: `${state.username}'s Echo Reel landed a bonus ${bonusItem.rarity} ${bonusItem.name}!` });
        emit(io, { type: 'inventory', state: ensurePublic(state) });
        if (bonusLevels.length > 0) {
            emit(io, { type: 'level', level: state.level, xp: state.xp, xpNeeded: state.xpNeeded });
        }
    }

    if (state.activeBait) {
        state.activeBait.uses -= 1;
        if (state.activeBait.uses <= 0) state.activeBait = undefined;
    }

    emit(io, {
        type: 'catch',
        user: state.username,
        success: true,
        item,
        goldEarned,
        xpGained,
        rarity: rarity.rarity,
    });

    emit(io, { type: 'inventory', state: ensurePublic(state) });

    if (cosmicDustGained > 0) {
        emit(io, { type: 'status', text: `${state.username} distilled ${cosmicDustGained} Cosmic Dust from the astral waters.` });
    }

    if (levelUps.length > 0) {
        emit(io, { type: 'level', level: state.level, xp: state.xp, xpNeeded: state.xpNeeded });
    }

    if (!stored) {
        emit(io, { type: 'status', text: `${state.username}'s inventory is full; auto-sold ${item.name} for ${goldEarned}g.` });
        pushLog(io, `${state.username} auto-sold ${item.name} (inventory full, +${goldEarned}g, +${xpGained}xp).`);
    } else {
        pushLog(io, `${state.username} caught a ${item.rarity} ${item.name} (+${goldEarned}g, +${xpGained}xp).`);
    }
}

async function handleStore(io: Server, state?: PlayerState) {
    if (state) {
        const announce = !interactionLock || interactionLock.scopedKey !== state.scopedKey || interactionLock.mode !== 'store';
        beginInteraction(io, state, 'store', announce);
        const refreshesLeft = interactionLock ? Math.max(0, maxInteractionRefreshes - interactionLock.refreshesUsed) : maxInteractionRefreshes;
        const remainingMs = interactionLock ? Math.max(0, interactionLock.expiresAt - Date.now()) : interactionTimeoutMs;
        emit(io, { type: 'status', text: `${state.username}, store session active: ${formatDuration(remainingMs)} left, ${refreshesLeft} refresh${refreshesLeft === 1 ? '' : 'es'} remaining.` });
    }
    const cfg = getStoreConfig(getCatalogSnapshot());
    const rotation = storeRotation ?? { items: currentStoreItems(), expiresAt: Date.now() + cfg.rotationMs };
    const filtered = rotation.items.filter((i) => {
        if (!state) return true;
        if (i.key === 'bag-upgrade' && state.inventoryCap >= inventoryCapMax) return false;
        return isStoreItemUnlocked(state, i);
    });
    const priced = priceStoreItemsForState(filtered, state);
    emit(io, { type: 'store', items: priced, upgrades: getUpgrades(state), expiresAt: rotation.expiresAt, user: state?.username });
}

async function handleStoreRefresh(io: Server, state: PlayerState) {
    const catalog = getCatalogSnapshot();
    const cfg = getStoreConfig(catalog);
    const now = Date.now();
    const last = lastStoreRefresh.get(state.scopedKey) ?? 0;
    if (now - last < storeRefreshCooldownMs) {
        const remaining = storeRefreshCooldownMs - (now - last);
        emit(io, { type: 'status', text: `${state.username}: store refresh on cooldown (${formatDuration(remaining)} remaining).` });
        pushLog(io, `${state.username} attempted store refresh but is on cooldown (${formatDuration(remaining)} remaining).`);
        return;
    }

    lastStoreRefresh.set(state.scopedKey, now);
    const items = pickStoreItems(catalog, cfg);
    const expiresAt = storeRotation && storeRotation.expiresAt > now ? storeRotation.expiresAt : now + cfg.rotationMs;
    storeRotation = { items, expiresAt };
    storeRotationVersion = storeVersionKey(catalog, cfg);

    const filtered = items.filter((i) => {
        if (i.key === 'bag-upgrade' && state.inventoryCap >= inventoryCapMax) return false;
        return isStoreItemUnlocked(state, i);
    });

    const priced = priceStoreItemsForState(filtered, state);
    emit(io, { type: 'store', items: priced, upgrades: getUpgrades(state), expiresAt, user: state.username });
    const hoursLabel = cfg.rotationHours >= 1 ? `${cfg.rotationHours}h` : `${Math.round((cfg.rotationHours * 60))}m`;
    emit(io, { type: 'status', text: `${state.username} refreshed the store. Next auto refresh in ${hoursLabel}; personal cooldown 8h.` });
    pushLog(io, `${state.username} manually refreshed the store (next auto in ${hoursLabel}, personal cooldown 8h).`);
}

async function handleUpgrades(io: Server, state?: PlayerState) {
    if (state) {
        const announce = !interactionLock || interactionLock.scopedKey !== state.scopedKey || interactionLock.mode !== 'store';
        beginInteraction(io, state, 'store', announce);
        const refreshesLeft = interactionLock ? Math.max(0, maxInteractionRefreshes - interactionLock.refreshesUsed) : maxInteractionRefreshes;
        const remainingMs = interactionLock ? Math.max(0, interactionLock.expiresAt - Date.now()) : interactionTimeoutMs;
        emit(io, { type: 'status', text: `${state.username}, upgrades session active: ${formatDuration(remainingMs)} left, ${refreshesLeft} refresh${refreshesLeft === 1 ? '' : 'es'} remaining.` });
    }
    const cfg = getStoreConfig(getCatalogSnapshot());
    const rotation = storeRotation ?? { items: currentStoreItems(), expiresAt: Date.now() + cfg.rotationMs };
    const filtered = rotation.items.filter((i) => {
        if (!state) return true;
        if (i.key === 'bag-upgrade' && state.inventoryCap >= inventoryCapMax) return false;
        return isStoreItemUnlocked(state, i);
    });
    const priced = priceStoreItemsForState(filtered, state);
    emit(io, { type: 'store', items: priced, upgrades: getUpgrades(state), expiresAt: rotation.expiresAt, user: state?.username });
}

async function handleInventory(io: Server, state: PlayerState) {
    const announce = !interactionLock || interactionLock.scopedKey !== state.scopedKey || interactionLock.mode !== 'inventory';
    beginInteraction(io, state, 'inventory', announce);
    const refreshesLeft = interactionLock ? Math.max(0, maxInteractionRefreshes - interactionLock.refreshesUsed) : maxInteractionRefreshes;
    const remainingMs = interactionLock ? Math.max(0, interactionLock.expiresAt - Date.now()) : interactionTimeoutMs;
    emit(io, { type: 'status', text: `${state.username}, inventory session active: ${formatDuration(remainingMs)} left, ${refreshesLeft} refresh${refreshesLeft === 1 ? '' : 'es'} remaining.` });
    emit(io, { type: 'inventory', state: ensurePublic(state) });
}

async function handleBuy(io: Server, state: PlayerState, args: string[]) {
    if (!args.length) {
        emit(io, { type: 'status', text: 'Usage: !buy <item> [quantity]' });
        return;
    }

    refreshInteractionLock(io, state);

    const argCopy = [...args];
    let quantity = 1;
    const tail = argCopy[argCopy.length - 1];
    if (tail && /^\d+$/.test(tail)) {
        quantity = Math.max(1, parseInt(tail, 10));
        argCopy.pop();
    }

    if (argCopy.length === 0) {
        emit(io, { type: 'status', text: 'Usage: !buy <item> [quantity]' });
        return;
    }

    const query = argCopy.join(' ').toLowerCase();
    const availableUpgrades = getUpgrades(state);
    const upgrade = availableUpgrades.find((u) => u.key === query || u.name.toLowerCase() === query);
    if (upgrade) {
        if (quantity > 1) {
            emit(io, { type: 'status', text: 'Upgrades are bought one at a time.' });
            return;
        }

        const now = Date.now();
        const windowMs = 12 * 60 * 60 * 1000;
        const journalDuration = 5 * 60 * 1000;
        const rodDuration = 3 * 60 * 1000;
        const maxPerWindow = 3;

        const entry = state.upgradeCharges?.[upgrade.key] ?? { count: 0, resetAt: now + windowMs };
        if (entry.resetAt < now) {
            entry.count = 0;
            entry.resetAt = now + windowMs;
        }

        if (upgrade.key === 'journal' || upgrade.key === 'rod') {
            if (entry.count >= maxPerWindow) {
                const waitMs = entry.resetAt - now;
                const hrs = Math.max(1, Math.ceil(waitMs / (60 * 60 * 1000)));
                emit(io, { type: 'status', text: `${upgrade.name} limit reached. Try again in ~${hrs}h.` });
                return;
            }
            if (state.gold < upgrade.cost) {
                emit(io, { type: 'status', text: `Not enough gold for ${upgrade.name}.` });
                return;
            }
            state.gold -= upgrade.cost;
            entry.count += 1;
            entry.resetAt = Math.max(entry.resetAt, now + windowMs);
            state.upgradeCharges = { ...(state.upgradeCharges ?? {}), [upgrade.key]: entry };

            if (upgrade.key === 'journal') {
                addTimedBuff(state, 'xp', 0.15, journalDuration, xpBuffTimers, io, `${state.username}'s journal study ended.`);
                emit(io, { type: 'status', text: `${state.username} studied a Journal: +15% XP for 5m (uses ${entry.count}/${maxPerWindow}).` });
                pushLog(io, `${state.username} started a journal XP boost (5m, +15%).`);
            } else if (upgrade.key === 'rod') {
                addTimedBuff(state, 'value', 0.2, rodDuration, valueBuffTimers, io, `${state.username}'s rod reinforcement faded.`);
                emit(io, { type: 'status', text: `${state.username} reinforced their rod: +20% value for 3m (uses ${entry.count}/${maxPerWindow}).` });
                pushLog(io, `${state.username} started a rod value boost (3m, +20%).`);
            }

            emit(io, { type: 'inventory', state: ensurePublic(state) });
            return;
        } else if (upgrade.key === 'prestige') {
            const prestigeCount = state.prestigeCount ?? 0;
            if (prestigeCount >= 3) {
                emit(io, { type: 'status', text: 'Maximum prestige reached.' });
                return;
            }
            if (state.level < 60) {
                emit(io, { type: 'status', text: 'Prestige requires level 60.' });
                return;
            }
            if (state.gold < upgrade.cost) {
                emit(io, { type: 'status', text: `Not enough gold for ${upgrade.name}.` });
                return;
            }

            state.gold -= upgrade.cost;
            state.level = 1;
            state.xp = 0;
            state.xpNeeded = 100;
            state.prestigeCount = prestigeCount + 1;

            if (state.prestigeCount >= 1) state.craftingUnlocked = true;
            if (state.prestigeCount >= 2) state.tradingUnlocked = true;
            if (state.prestigeCount >= 3) state.enchantmentsUnlocked = true;

            const perk = state.prestigeCount === 1 ? 'Crafting unlocked' : state.prestigeCount === 2 ? 'Trading unlocked' : 'Enchantments unlocked';
            emit(io, { type: 'status', text: `${state.username} prestiged (${state.prestigeCount}/3)! ${perk}; level reset to 1.` });
            pushLog(io, `${state.username} prestiged (${state.prestigeCount}/3): ${perk.toLowerCase()}.`);
            emit(io, { type: 'level', level: state.level, xp: state.xp, xpNeeded: state.xpNeeded });
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            return;
        }

        // Default behavior for other upgrades (e.g., lure progression)
        const currentLevel = upgrade.stat === 'rarity' ? state.lureLevel : upgrade.stat === 'value' ? state.poleLevel : state.luck;
        if (currentLevel >= upgrade.maxLevel) {
            emit(io, { type: 'status', text: `${upgrade.name} is already maxed.` });
            return;
        }
        if (state.gold < upgrade.cost) {
            emit(io, { type: 'status', text: `Not enough gold for ${upgrade.name}.` });
            return;
        }
        state.gold -= upgrade.cost;
        if (upgrade.stat === 'rarity') state.lureLevel += 1;
        if (upgrade.stat === 'value') state.poleLevel += 1;
        if (upgrade.stat === 'xp') state.luck += 1;
        emit(io, { type: 'status', text: `${state.username} bought ${upgrade.name}.` });
        emit(io, { type: 'inventory', state: ensurePublic(state) });
        pushLog(io, `${state.username} upgraded ${upgrade.name}.`);
        return;
    }

    const catalog = getCatalogSnapshot();
    const skinMap = getPoleSkinMap(catalog);
    const item = currentStoreItems().find((i) => i.key === query || i.name.toLowerCase() === query);
    const skinKey = query.startsWith('skin-') ? query.replace('skin-', '') : item?.key.startsWith('skin-') ? item.key.replace('skin-', '') : undefined;
    const skinNameMatch = !skinKey && item?.type === 'skin' ? Object.values(skinMap).find((s) => item.name.toLowerCase().includes(s.name.toLowerCase()))?.id : undefined;
    const skinId = (skinKey as PoleSkinId | undefined) ?? skinNameMatch;
    const skin = skinId ? skinMap[skinId] : undefined;

    if (skin) {
        if (quantity > 1) {
            emit(io, { type: 'status', text: 'Skins can only be bought once.' });
            return;
        }
        if (state.ownedPoleSkins && state.ownedPoleSkins.includes(skin.id)) {
            emit(io, { type: 'status', text: `${skin.name} is already owned.` });
            return;
        }
        if (state.level < skin.levelReq) {
            emit(io, { type: 'status', text: `Level ${skin.levelReq} required for ${skin.name}.` });
            return;
        }
        const skinCost = priceStoreItem(item ?? {
            key: `skin-${skin.id}`,
            name: `${skin.name} Skin`,
            cost: skin.cost,
            rarity: skin.rarity,
            value: 0,
            description: skin.description,
            type: 'skin',
            minLevel: skin.levelReq,
        }, state);
        if (state.gold < skinCost) {
            emit(io, { type: 'status', text: `Not enough gold for ${skin.name}.` });
            return;
        }
        state.gold -= skinCost;
        state.poleSkinId = skin.id;
        state.ownedPoleSkins = Array.from(new Set([...(state.ownedPoleSkins ?? []), skin.id]));
        emit(io, { type: 'skin', user: state.username, skinId: skin.id });
        emit(io, { type: 'inventory', state: ensurePublic(state) });
        pushLog(io, `${state.username} unlocked ${skin.name} skin for ${skinCost}g.`);
        return;
    }

    if (!item) {
        emit(io, { type: 'status', text: `Item not available right now: ${query} (store rotates every 4h).` });
        return;
    }

    const unitCost = priceStoreItem(item, state);

    if (item.key === 'bag-upgrade') {
        const remaining = Math.max(0, Math.floor((inventoryCapMax - state.inventoryCap) / inventoryCapStep));
        if (remaining <= 0) {
            emit(io, { type: 'status', text: 'Inventory space is already at the max (30).' });
            return;
        }
        if (quantity > remaining) {
            emit(io, { type: 'status', text: `Only ${remaining} inventory expansion${remaining === 1 ? '' : 's'} left (max 30).` });
            return;
        }
        const totalCost = unitCost * quantity;
        if (state.gold < totalCost) {
            emit(io, { type: 'status', text: `Not enough gold for ${quantity}x ${item.name}.` });
            return;
        }
        state.gold -= totalCost;
        state.inventoryCap = Math.min(inventoryCapMax, state.inventoryCap + inventoryCapStep * quantity);
        emit(io, { type: 'status', text: `${state.username} expanded inventory to ${state.inventoryCap} slots.` });
        emit(io, { type: 'inventory', state: ensurePublic(state) });
        pushLog(io, `${state.username} bought ${quantity}x ${item.name} (+${inventoryCapStep * quantity} slots, now ${state.inventoryCap}).`);
        return;
    }

    if (item.minLevel && state.level < item.minLevel) {
        emit(io, { type: 'status', text: `Level ${item.minLevel} required for ${item.name}.` });
        return;
    }

    if (item.key === 'crafting-booster' && !state.craftingUnlocked) {
        emit(io, { type: 'status', text: 'Crafting Booster requires crafting to be unlocked first (prestige 1).' });
        return;
    }

    if (item.key === 'enchanters-spark' && !state.enchantmentsUnlocked) {
        emit(io, { type: 'status', text: "Enchanter's Spark requires enchantments to be unlocked first (prestige 3)." });
        return;
    }

    const space = state.inventoryCap - state.inventory.length;
    if (space < quantity) {
        emit(io, { type: 'status', text: `Not enough inventory space (room for ${space}, need ${quantity}).` });
        return;
    }

    const totalCost = unitCost * quantity;
    if (state.gold < totalCost) {
        emit(io, { type: 'status', text: `Not enough gold for ${quantity}x ${item.name}.` });
        return;
    }
    state.gold -= totalCost;
    for (let i = 0; i < quantity; i++) {
        state.inventory.push({
            id: randomUUID(),
            name: item.name,
            rarity: item.rarity,
            value: item.value,
            description: item.description,
            type: item.type,
        });
    }
    const qtyText = quantity > 1 ? `${quantity}x ` : '';
    emit(io, { type: 'status', text: `${state.username} bought ${qtyText}${item.name} for ${totalCost}g.` });
    emit(io, { type: 'inventory', state: ensurePublic(state) });
    pushLog(io, `${state.username} bought ${quantity}x ${item.name} for ${totalCost}g.`);
}

async function handleSell(io: Server, state: PlayerState, args: string[]) {
    refreshInteractionLock(io, state);

    if (state.inventory.length === 0) {
        emit(io, { type: 'status', text: `${state.username} has nothing to sell.` });
        return;
    }

    if (args[0]?.toLowerCase() === 'all') {
        const count = state.inventory.length;
        const total = state.inventory.reduce((sum, item) => sum + (item.value ?? 0), 0);
        state.gold += total;
        state.inventory = [];
        emit(io, { type: 'sell', gold: total, count });
        emit(io, { type: 'status', text: `${state.username} sold all (${count}) items for ${total}g.` });
        emit(io, { type: 'inventory', state: ensurePublic(state) });
        pushLog(io, `${state.username} sold all (${count}) items for ${total}g.`);
        return;
    }

    let sold: InventoryItem | undefined;
    if (args.length) {
        const query = args.join(' ').toLowerCase();
        const idx = state.inventory.findIndex((i) => i.name.toLowerCase() === query);
        if (idx >= 0) {
            sold = state.inventory.splice(idx, 1)[0];
        }
    }
    if (!sold) {
        sold = state.inventory.shift();
    }

    if (!sold) {
        emit(io, { type: 'status', text: 'No item sold.' });
        return;
    }

    state.gold += sold.value;
    emit(io, { type: 'sell', gold: sold.value, item: sold });
    emit(io, { type: 'status', text: `${state.username} sold ${sold.name} for ${sold.value}g.` });
    emit(io, { type: 'inventory', state: ensurePublic(state) });
    pushLog(io, `${state.username} sold ${sold.name} for ${sold.value}g.`);
}

async function handleSave(io: Server, state: PlayerState) {
    await savePlayer(state);
    emit(io, { type: 'save', ok: true, message: 'Progress saved.' });
    pushLog(io, `${state.username} saved their progress.`);
}

// Removed dev-only skin grant and swap helpers

async function handleEquip(io: Server, state: PlayerState, args: string[]) {
    if (!args.length) {
        emit(io, { type: 'status', text: 'Usage: !equip <rod/skin name>' });
        return;
    }
    const skinMap = getPoleSkinMap(getCatalogSnapshot());
    const query = args.join(' ').toLowerCase();
    const match = Object.values(skinMap).find((s) => s.id === query || s.name.toLowerCase() === query || query.includes(s.id) || query.includes(s.name.toLowerCase()));
    if (!match) {
        emit(io, { type: 'status', text: `Unknown rod/skin: ${query}` });
        return;
    }
    if (!state.ownedPoleSkins || !state.ownedPoleSkins.includes(match.id)) {
        emit(io, { type: 'status', text: `${match.name} is not owned yet.` });
        return;
    }
    if (state.poleSkinId === match.id) {
        emit(io, { type: 'status', text: `${match.name} is already equipped.` });
        return;
    }
    state.poleSkinId = match.id;
    await savePlayer(state); // persist equipped skin for future sessions/overlay reloads
    emit(io, { type: 'skin', user: state.username, skinId: match.id });
    emit(io, { type: 'inventory', state: ensurePublic(state) });
    pushLog(io, `${state.username} equipped ${match.name}.`);
}

async function handleEnchantChat(io: Server, state: PlayerState, args: string[]) {
    if (!state.enchantmentsUnlocked) {
        emit(io, { type: 'status', text: `${state.username}: enchantments unlock at Prestige 3.` });
        return;
    }
    const essenceMap: Record<string, EssenceId> = {
        spark: 'spark-essence', 'spark-essence': 'spark-essence',
        echo: 'echo-essence', 'echo-essence': 'echo-essence',
        mythic: 'mythic-essence', 'mythic-essence': 'mythic-essence',
    };
    const pick = args[0]?.toLowerCase();
    const essence = pick ? essenceMap[pick] : undefined;
    if (!essence) {
        emit(io, { type: 'status', text: 'Usage: !enchant <spark|echo|mythic>' });
        return;
    }
    await panelEnchant(io, state.username, state.biomeKey, { kind: 'rod' }, essence);
}

function grantXp(state: PlayerState, amount: number) {
    const levelUps: number[] = [];
    state.xp += amount;
    while (state.xp >= state.xpNeeded) {
        state.xp -= state.xpNeeded;
        state.level += 1;
        state.xpNeeded = Math.round(100 + state.level * 30);
        levelUps.push(state.level);
    }
    return levelUps;
}

async function handleDuplicate(io: Server, state: PlayerState, args: string[]) {
    if (args.length < 2) {
        emit(io, { type: 'status', text: 'Usage: !duplicate item <item name> | !duplicate material <id>' });
        return;
    }

    state.materials = state.materials ?? { ...materialDefaults };
    const dustAvailable = state.materials['cosmic-dust'] ?? 0;
    if (dustAvailable <= 0) {
        emit(io, { type: 'status', text: `${state.username}: Cosmic Dust required.` });
        return;
    }

    const mode = args[0].toLowerCase();

    if (mode === 'material' || mode === 'resource') {
        const target = args[1]?.toLowerCase() as CraftingMaterialId;
        const validMaterials = Object.keys(materialDefaults) as CraftingMaterialId[];
        if (!target || !validMaterials.includes(target)) {
            emit(io, { type: 'status', text: `${state.username}: unknown material.` });
            return;
        }
        const owned = state.materials[target] ?? 0;
        if (owned <= 0) {
            emit(io, { type: 'status', text: `${state.username}: need at least 1 ${target} to duplicate.` });
            return;
        }
        const cost = 1;
        if (dustAvailable < cost) {
            emit(io, { type: 'status', text: `${state.username}: not enough Cosmic Dust (need ${cost}).` });
            return;
        }
        state.materials['cosmic-dust'] = dustAvailable - cost;
        state.materials[target] = owned + 1;
        emit(io, { type: 'status', text: `${state.username} duplicated ${target} using Cosmic Dust.` });
        emit(io, { type: 'inventory', state: ensurePublic(state) });
        return;
    }

    if (mode === 'item') {
        if (state.inventory.length >= state.inventoryCap) {
            emit(io, { type: 'status', text: `${state.username}: bag is full; cannot duplicate.` });
            return;
        }
        const query = args.slice(1).join(' ').toLowerCase();
        const found = state.inventory.find((i) => i.name.toLowerCase() === query);
        if (!found) {
            emit(io, { type: 'status', text: `${state.username}: item not found.` });
            return;
        }
        const cost = 2;
        if (dustAvailable < cost) {
            emit(io, { type: 'status', text: `${state.username}: not enough Cosmic Dust (need ${cost}).` });
            return;
        }
        state.materials['cosmic-dust'] = dustAvailable - cost;
        const clone: InventoryItem = { ...found, id: randomUUID() };
        state.inventory.push(clone);
        emit(io, { type: 'status', text: `${state.username} duplicated ${found.name} using Cosmic Dust.` });
        emit(io, { type: 'inventory', state: ensurePublic(state) });
        return;
    }

    emit(io, { type: 'status', text: 'Usage: !duplicate item <item name> | !duplicate material <id>' });
}

async function handleUse(io: Server, state: PlayerState, args: string[]) {
    refreshInteractionLock(io, state);

    if (!args.length) {
        emit(io, { type: 'status', text: 'Usage: !use <item> (or !use help)' });
        return;
    }

    if (state.inventory.length === 0) {
        emit(io, { type: 'status', text: `${state.username} has nothing to use.` });
        return;
    }

    const firstArg = args[0].toLowerCase();
    if (firstArg === 'help' || firstArg === 'list') {
        const usable = state.inventory.filter((i) => {
            const t = i.type ?? '';
            return t === 'bait' || t === 'upgrade' || t === 'chest' || t === 'token' || t === 'compass' || t === 'map' || t === 'scroll';
        }).map((i) => i.name);
        if (usable.length === 0) {
            emit(io, { type: 'status', text: 'No usable items right now. Catch or buy more items first.' });
        } else {
            const unique = Array.from(new Set(usable)).slice(0, 12);
            emit(io, { type: 'status', text: `Usable items: ${unique.join(', ')}` });
        }
        return;
    }

    // Scroll syntax: !use scroll <rarity> <custom item name>
    if (firstArg === 'scroll') {
        if ((state.prestigeCount ?? 0) < 4) {
            emit(io, { type: 'status', text: 'Custom loot scrolls require prestige 4.' });
            return;
        }
        if (args.length < 3) {
            emit(io, { type: 'status', text: 'Usage: !use scroll <rarity> <item name>' });
            return;
        }
        const rarityArg = args[1].toLowerCase();
        const validRarity: Record<string, Rarity> = {
            common: 'common',
            uncommon: 'uncommon',
            rare: 'rare',
            epic: 'epic',
            mythic: 'mythic',
            legendary: 'legendary',
            relic: 'relic',
        };
        const targetRarity = validRarity[rarityArg];
        if (!targetRarity) {
            emit(io, { type: 'status', text: 'Rarity must be common/uncommon/rare/epic/legendary/mythic/relic.' });
            return;
        }
        const customName = args.slice(2).join(' ');
        const scrollIdx = state.inventory.findIndex((i) => i.type === 'scroll' && i.rarity === targetRarity);
        if (scrollIdx < 0) {
            emit(io, { type: 'status', text: `No scroll for rarity ${targetRarity} available.` });
            return;
        }
        const result = addCustomLootName(targetRarity, customName);
        if (!result.ok) {
            const reason = result.reason === 'duplicate'
                ? `Item '${customName}' already exists in the custom loot pool.`
                : 'Item name is empty.';
            emit(io, { type: 'status', text: reason });
            return;
        }
        state.inventory.splice(scrollIdx, 1);
        emit(io, { type: 'status', text: `${state.username} inscribed '${customName}' into the ${targetRarity} loot pool.` });
        pushLog(io, `${state.username} added custom ${targetRarity} loot: ${customName}.`);
        emit(io, { type: 'inventory', state: ensurePublic(state) });
        return;
    }

    const query = args.join(' ').toLowerCase();
    const idx = state.inventory.findIndex((i) => i.name.toLowerCase() === query);
    if (idx < 0) {
        emit(io, { type: 'status', text: `Item not found: ${query}` });
        return;
    }

    const item = state.inventory[idx];
    const itemType = item.type ?? null;
    const biome = getBiome(state);

    if (itemType === 'bait') {
        state.inventory.splice(idx, 1);
        clearBait(state.scopedKey);
        state.activeBait = { rarityBonus: 0.3, valueBonus: 0.15, uses: 1, expiresAt: Date.now() + 30 * 60 * 1000 };
        emit(io, { type: 'status', text: `${state.username} used ${item.name}: boosted rarity/value on the next cast only.` });
        emit(io, { type: 'inventory', state: ensurePublic(state) });
        pushLog(io, `${state.username} used bait ${item.name} (next cast only).`);
        return;
    }

    if (itemType === 'compass') {
        state.inventory.splice(idx, 1);
        const current = getBiome(state);
        const next = nextBiome(current);
        if (!next) {
            emit(io, { type: 'status', text: `${state.username} is already in the highest waters; the compass fades.` });
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            pushLog(io, `${state.username} used an Enchanted Compass at the max biome (no effect).`);
            return;
        }
        state.biomeKey = next.key;
        state.biome = next.key;
        state.isCasting = false;
        state.hasTug = false;
        clearTug(state.scopedKey);
        clearDecay(state.scopedKey);
        emit(io, { type: 'status', text: `${state.username} used ${item.name} and sailed to ${next.name}. New waters unlocked.` });
        emit(io, { type: 'inventory', state: ensurePublic(state) });
        pushLog(io, `${state.username} charted a course to ${next.name} using an Enchanted Compass.`);
        return;
    }

    if (itemType === 'map') {
        state.inventory.splice(idx, 1);
        const biome = getBiome(state);
        const eventEffects = getEventEffects(io);
        // Force a rare+ find
        const rolled = rollRarity(state, biome, {
            globalAmount: eventEffects.luckGlobalBonus,
            targetedAmount: eventEffects.luckTargetedBonus,
            targetIdx: eventEffects.luckTargetIdx,
        });
        const rolledIdx = rarityOrder.indexOf(rolled.rarity);
        const minIdx = rarityOrder.indexOf('rare');
        const targetRarity = rolledIdx >= minIdx
            ? rolled
            : (biome.rarityConfigs.find((r) => rarityOrder.indexOf(r.rarity) >= minIdx) ?? rolled);
        const cacheItem = makeItem(targetRarity, 1 + (state.level - 1) * 0.05, biome);
        const stashBonusGold = Math.round((40 + state.level * 3) * biome.goldMultiplier);
        const stashBonusXp = Math.round(35 * biome.xpMultiplier);
        state.gold += stashBonusGold;
        const levelUps = grantXp(state, stashBonusXp);

        let stored = false;
        if (state.inventory.length < state.inventoryCap) {
            state.inventory.push(cacheItem);
            stored = true;
        } else {
            state.gold += cacheItem.value;
        }

        emit(io, {
            type: 'status',
            text: `${state.username} followed the Treasure Map and uncovered a ${cacheItem.rarity} ${cacheItem.name} (+${stashBonusGold}g, +${stashBonusXp}xp).`,
        });
        emit(io, { type: 'inventory', state: ensurePublic(state) });
        if (levelUps.length > 0) {
            emit(io, { type: 'level', level: state.level, xp: state.xp, xpNeeded: state.xpNeeded });
        }
        pushLog(io, `${state.username} used a Treasure Map and found ${cacheItem.rarity} ${cacheItem.name} (+${stashBonusGold}g, +${stashBonusXp}xp${stored ? '' : ', auto-sold (full bag)'}).`);
        return;
    }

    if (itemType === 'upgrade') {
        // Fallback for legacy upgrade items: treat as a small XP boost
        state.inventory.splice(idx, 1);
        const levelUps = grantXp(state, 20);
        emit(io, { type: 'status', text: `${state.username} used ${item.name}: gained 20xp.` });
        emit(io, { type: 'inventory', state: ensurePublic(state) });
        if (levelUps.length > 0) {
            emit(io, { type: 'level', level: state.level, xp: state.xp, xpNeeded: state.xpNeeded });
        }
        pushLog(io, `${state.username} used upgrade ${item.name} (+20xp).`);
        return;
    }

    if (itemType === 'chest') {
        state.inventory.splice(idx, 1);
        const rarityKey = chestRarityByName[item.name.toLowerCase()] ?? item.rarity;
        let target = biome.rarityConfigs.find((r) => r.rarity === rarityKey) ?? biome.rarityConfigs[0];

        if (state.chestMinRarityIndex !== undefined) {
            const minCfg = biome.rarityConfigs.find((r) => rarityOrder.indexOf(r.rarity) === state.chestMinRarityIndex);
            if (minCfg && rarityOrder.indexOf(target.rarity) < state.chestMinRarityIndex) {
                target = minCfg;
            }
            state.chestMinRarityIndex = undefined;
        }

        if (state.chestUpgrade) {
            const upgradedIdx = Math.min(rarityOrder.length - 1, rarityOrder.indexOf(target.rarity) + 1);
            const upgraded = biome.rarityConfigs.find((r) => rarityOrder.indexOf(r.rarity) === upgradedIdx);
            if (upgraded) target = upgraded;
            state.chestUpgrade = false;
        }

        const reward = makeItem(target, 1 + (state.level - 1) * 0.03, biome);
        if (state.inventory.length >= state.inventoryCap) {
            state.gold += reward.value;
            emit(io, { type: 'status', text: `${state.username} opened ${item.name} but inventory was full; auto-sold ${reward.name} for ${reward.value}g.` });
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            pushLog(io, `${state.username} opened ${item.name} (auto-sold ${reward.name} for ${reward.value}g, full inventory).`);
        } else {
            state.inventory.push(reward);
            emit(io, { type: 'status', text: `${state.username} opened ${item.name} and found a ${reward.rarity} ${reward.name}.` });
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            pushLog(io, `${state.username} opened ${item.name} -> ${reward.rarity} ${reward.name}.`);
        }
        return;
    }

    if (itemType === 'token') {
        const name = item.name.toLowerCase();
        state.inventory.splice(idx, 1);

        if (name === 'hook stabilizer') {
            state.stabilizerCharges = (state.stabilizerCharges ?? 0) + 1;
            emit(io, { type: 'status', text: `${state.username} readied a Hook Stabilizer: first early reel will be forgiven.` });
            pushLog(io, `${state.username} primed a Hook Stabilizer (1 early reel forgiveness).`);
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            return;
        }

        if (name === 'tide token') {
            state.activeBait = { rarityBonus: 0, valueBonus: 0, uses: 1, expiresAt: Date.now() + 30 * 60 * 1000, minRarityIndex: rarityOrder.indexOf('uncommon') } as any;
            emit(io, { type: 'status', text: `${state.username} used a Tide Token: next catch is guaranteed uncommon+.` });
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            pushLog(io, `${state.username} primed a Tide Token (min rarity uncommon).`);
            return;
        }

        if (name === 'gleam polish') {
            state.activeBait = { rarityBonus: 0, valueBonus: 0.4, uses: 1, expiresAt: Date.now() + 30 * 60 * 1000 } as any;
            emit(io, { type: 'status', text: `${state.username} applied Gleam Polish: +40% value on next catch.` });
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            pushLog(io, `${state.username} primed Gleam Polish (+40% value next catch).`);
            return;
        }

        if (name === "scholar's note") {
            state.activeBait = { rarityBonus: 0, valueBonus: 0, xpBonus: 0.5, uses: 1, expiresAt: Date.now() + 30 * 60 * 1000 } as any;
            emit(io, { type: 'status', text: `${state.username} studied a Scholar's Note: +50% XP on next catch.` });
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            pushLog(io, `${state.username} primed Scholar's Note (+50% XP next catch).`);
            return;
        }

        if (name === 'echo reel') {
            state.echoReelCharges = (state.echoReelCharges ?? 0) + 1;
            emit(io, { type: 'status', text: `${state.username} prepped an Echo Reel: next success triggers a bonus catch.` });
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            pushLog(io, `${state.username} primed an Echo Reel (bonus catch ready).`);
            return;
        }

        if (name === 'luck charm') {
            clearCharm(io, state);
            const durationMs = 3 * 60 * 1000;
            const expiresAt = Date.now() + durationMs;
            state.activeCharm = { expiresAt, rarityBonus: 0.08, xpBonus: 0.05 };
            const timer = setTimeout(() => {
                clearCharm(io, state);
                emit(io, { type: 'status', text: `${state.username}'s luck charm faded.` });
            }, durationMs);
            charmTimers.set(state.scopedKey, timer);
            emitBuffs(io, state);
            emit(io, { type: 'status', text: `${state.username} used a Luck Charm: better rarity for 3m.` });
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            pushLog(io, `${state.username} activated a Luck Charm (3m rarity boost).`);
            return;
        }

        if (name === "trader's mark") {
            addTimedBuff(state, 'value', 0.15, 5 * 60 * 1000, valueBuffTimers, io, `${state.username}'s Trader's Mark faded.`);
            emit(io, { type: 'status', text: `${state.username} used Trader's Mark: +15% value for 5m.` });
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            pushLog(io, `${state.username} activated Trader's Mark (+15% value, 5m).`);
            return;
        }

        if (name === 'waypoint charter') {
            const current = getBiome(state);
            const { byTier } = getBiomeData();
            const prev = byTier.find((b) => b.tier === current.tier - 1);
            if (!prev) {
                emit(io, { type: 'status', text: `${state.username} is already at the starting waters.` });
            } else {
                state.biomeKey = prev.key;
                state.biome = prev.key;
                state.isCasting = false;
                state.hasTug = false;
                clearTug(state.scopedKey);
                clearDecay(state.scopedKey);
                emit(io, { type: 'status', text: `${state.username} sailed to ${prev.name} using a Waypoint Charter.` });
                pushLog(io, `${state.username} sailed down to ${prev.name} (Waypoint Charter).`);
            }
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            return;
        }

        if (name === 'survey beacon') {
            state.activeBait = { rarityBonus: 0.5, valueBonus: 0.1, uses: 1, expiresAt: Date.now() + 30 * 60 * 1000 } as any;
            emit(io, { type: 'status', text: `${state.username} deployed a Survey Beacon: boosted odds and value on next catch.` });
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            pushLog(io, `${state.username} primed a Survey Beacon (next catch boosted).`);
            return;
        }

        if (name === 'chest key') {
            state.chestUpgrade = true;
            emit(io, { type: 'status', text: `${state.username} readied a Chest Key: next chest opens one tier higher.` });
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            pushLog(io, `${state.username} prepped a Chest Key (upgrade next chest).`);
            return;
        }

        if (name === "prospector's lens") {
            state.chestMinRarityIndex = rarityOrder.indexOf('epic');
            emit(io, { type: 'status', text: `${state.username} polished a Prospector's Lens: next chest is epic+.` });
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            pushLog(io, `${state.username} primed a Prospector's Lens (min epic chest).`);
            return;
        }

        if (name === 'crafting booster kit') {
            state.craftingBoostCharges = (state.craftingBoostCharges ?? 0) + 1;
            emit(io, { type: 'status', text: `${state.username} stored a Crafting Booster Kit. Applies to the next craft (once crafting is used).` });
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            pushLog(io, `${state.username} saved a Crafting Booster Kit.`);
            return;
        }

        if (name === "enchanter's spark") {
            state.enchantBoostCharges = (state.enchantBoostCharges ?? 0) + 1;
            emit(io, { type: 'status', text: `${state.username} bottled an Enchanter's Spark. Applies to the next enchant (once used).` });
            emit(io, { type: 'inventory', state: ensurePublic(state) });
            pushLog(io, `${state.username} saved an Enchanter's Spark.`);
            return;
        }

        // Default charm behavior (legacy tokens)
        clearCharm(io, state);
        const durationMs = 120000;
        const expiresAt = Date.now() + durationMs;
        state.activeCharm = { expiresAt, rarityBonus: 0.1, xpBonus: 0.1 };
        const timer = setTimeout(() => {
            clearCharm(io, state);
            emit(io, { type: 'status', text: `${state.username}'s luck boost faded.` });
        }, durationMs);
        charmTimers.set(state.scopedKey, timer);
        emitBuffs(io, state);
        emit(io, { type: 'status', text: `${state.username} used ${item.name}: luck/rarity boost for 2m.` });
        emit(io, { type: 'inventory', state: ensurePublic(state) });
        pushLog(io, `${state.username} used ${item.name} (2m luck boost).`);
        return;
    }

    emit(io, { type: 'status', text: `Can't use ${item.name}.` });
}

async function handleLevel(io: Server, state: PlayerState) {
    emit(io, { type: 'level', level: state.level, xp: state.xp, xpNeeded: state.xpNeeded });
    pushLog(io, `${state.username} is level ${state.level}.`);
}

async function handleTheme(io: Server, args: string[]) {
    const choice = args[0]?.toLowerCase();
    const chan = (process.env.TWITCH_CHANNEL ?? 'default').toLowerCase();
    if (!choice) {
        const themes = themeMap();
        emit(io, { type: 'theme', theme: themes[chan] ?? themes.default });
        emit(io, { type: 'status', text: `Theme is ${themes[chan]?.name ?? themes.default.name}.` });
        return;
    }

    const themes = themeMap();
    const theme = themes[choice];
    if (!theme) {
        emit(io, { type: 'status', text: `Unknown theme. Available: ${Object.keys(themes).join(', ')}` });
        return;
    }
    emit(io, { type: 'theme', theme });
    emit(io, { type: 'status', text: `Theme switched to ${theme.name}.` });
}

async function handleResetProfile(io: Server, state: PlayerState, args: string[], isMod: boolean | undefined, isBroadcaster: boolean | undefined) {
    const isPrivileged = Boolean(isMod || isBroadcaster);
    if (!isPrivileged) {
        emit(io, { type: 'status', text: `${state.username}: reset is mod-only.` });
        return;
    }

    const targetRaw = args[0]?.trim();
    const targetUser = targetRaw && targetRaw.length > 0 ? targetRaw : state.username;
    const chanFromState = state.scopedKey?.includes('__') ? state.scopedKey.split('__')[0] : null;
    const chan = (chanFromState ?? process.env.TWITCH_CHANNEL ?? 'default').toLowerCase();
    const { safeUser, scopedKey } = ids(targetUser, chan);

    // Clear timers/buffs for this player
    clearTug(scopedKey);
    clearDecay(scopedKey);
    clearBait(scopedKey);
    clearCharm(null, { ...baseState(safeUser, scopedKey) }); // pass dummy state for clearing only
    xpBuffTimers.delete(scopedKey);
    valueBuffTimers.delete(scopedKey);
    baitTimers.delete(scopedKey);
    charmTimers.delete(scopedKey);
    tugTimers.delete(scopedKey);
    decayTimers.delete(scopedKey);
    if (interactionLock?.scopedKey === scopedKey) {
        clearInteractionLock(null, false);
    }

    const fresh = baseState(safeUser, scopedKey);
    fresh.displayName = targetUser;
    players.set(scopedKey, fresh);
    await savePlayer(fresh);

    emit(io, { type: 'status', text: `${state.username} reset ${targetUser}'s profile to defaults.` });
    emit(io, { type: 'inventory', state: ensurePublic(fresh) });
    pushLog(io, `${state.username} reset ${targetUser}'s profile (mod action).`);
}

async function handleEventCommand(io: Server, state: PlayerState, args: string[], isMod: boolean | undefined, isBroadcaster: boolean | undefined) {
    const isPrivileged = Boolean(isMod || isBroadcaster);
    if (!isPrivileged) {
        emit(io, { type: 'status', text: `${state.username}: event control is mod-only.` });
        return;
    }
    const sub = args[0]?.toLowerCase();
    if (!sub || sub === 'help') {
        emit(io, { type: 'status', text: 'Usage: !event start <xp|gold|double|luck> [rarity] [minutes<=10] [amount] | !event stop [id]' });
        return;
    }
    if (sub === 'stop' || sub === 'end') {
        const targetId = args[1];
        clearGlobalEvent(io, targetId, 'stopped');
        emit(io, { type: 'status', text: targetId ? `Event stopped (${targetId}).` : 'Events stopped.' });
        return;
    }
    if (sub !== 'start') {
        emit(io, { type: 'status', text: 'Usage: !event start <xp|gold|double|luck> [rarity] [minutes<=10] [amount] | !event stop [id]' });
        return;
    }

    const kind = args[1]?.toLowerCase() as GlobalEvent['kind'] | undefined;
    if (!kind || !['xp', 'gold', 'double', 'luck'].includes(kind)) {
        emit(io, { type: 'status', text: 'Invalid event type. Use xp, gold, double, or luck.' });
        return;
    }

    let minutesArg: number | undefined;
    let amountArg: number | undefined;
    let targetRarity: Rarity | undefined;
    const rarityLookup: Record<string, Rarity> = Object.fromEntries(rarityOrder.map((r) => [r, r]));
    for (const tokenRaw of args.slice(2)) {
        const token = tokenRaw.toLowerCase();
        if (rarityLookup[token] && !targetRarity) {
            targetRarity = rarityLookup[token];
            continue;
        }
        const numeric = Number(token.replace(/[^0-9.]/g, ''));
        if (!Number.isFinite(numeric)) continue;
        if (kind === 'double' && token.startsWith('x')) {
            amountArg = numeric;
            continue;
        }
        if (token.includes('%')) {
            amountArg = numeric;
            continue;
        }
        if (minutesArg === undefined) {
            minutesArg = numeric;
            continue;
        }
        if (amountArg === undefined) amountArg = numeric;
    }

    const minutes = minutesArg ?? defaultEventDurationMs / 60000;
    const durationMs = Math.min(maxEventDurationMs, Math.max(60 * 1000, Math.round(minutes) * 60 * 1000));
    let amount: number;
    if (kind === 'double') {
        amount = Math.max(1, Math.min(maxDoubleStacks, Math.round(amountArg ?? 1)));
    } else if (kind === 'luck') {
        amount = Math.max(0.01, Math.min(1.5, (amountArg ?? 10) / 100));
    } else {
        // xp / gold
        amount = Math.max(0.1, Math.min(5, (amountArg ?? 50) / 100));
    }

    startGlobalEvent(io, kind, durationMs, amount, targetRarity);
}

async function handleCooldownCommand(io: Server, state: PlayerState, args: string[], isMod: boolean | undefined, isBroadcaster: boolean | undefined) {
    const isPrivileged = Boolean(isMod || isBroadcaster);
    if (!isPrivileged) {
        emit(io, { type: 'status', text: `${state.username}: cooldown control is mod-only.` });
        return;
    }

    const raw = args[0]?.toLowerCase();
    if (!raw || raw === 'show' || raw === 'status') {
        emit(io, { type: 'status', text: `Per-user cooldown is ${Math.round(userCommandCooldownMs / 1000)}s (default ${Math.round(DEFAULT_USER_COOLDOWN_MS / 1000)}s).` });
        return;
    }

    if (raw === 'reset' || raw === 'default') {
        userCommandCooldownMs = DEFAULT_USER_COOLDOWN_MS;
        emit(io, { type: 'status', text: `${state.username} reset cooldown to ${Math.round(userCommandCooldownMs / 1000)}s.` });
        return;
    }

    const parsed = Number(raw.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(parsed)) {
        emit(io, { type: 'status', text: 'Usage: !cooldown <seconds 5-300> | !cooldown reset' });
        return;
    }

    const clampedSeconds = Math.max(5, Math.min(300, Math.round(parsed)));
    userCommandCooldownMs = clampedSeconds * 1000;
    emit(io, { type: 'status', text: `${state.username} set the per-user cooldown to ${clampedSeconds}s.` });
}

async function handleGlobalCooldownCommand(io: Server, state: PlayerState, args: string[], isMod: boolean | undefined, isBroadcaster: boolean | undefined) {
    const isPrivileged = Boolean(isMod || isBroadcaster);
    if (!isPrivileged) {
        emit(io, { type: 'status', text: `${state.username}: global cooldown control is mod-only.` });
        return;
    }

    if (args.length === 0) {
        const seconds = Math.round(globalCommandCooldownMs / 1000);
        const label = seconds > 0 ? `${seconds}s` : 'disabled';
        emit(io, { type: 'status', text: `Global chat cooldown is ${label} (set 5-45s with !gcooldown).` });
        return;
    }

    const raw = args.join(' ').toLowerCase();
    if (raw === 'reset' || raw === 'default') {
        globalCommandCooldownMs = DEFAULT_GLOBAL_COOLDOWN_MS;
        lastGlobalCommandAt.clear();
        emit(io, { type: 'status', text: `${state.username} reset the global chat cooldown (disabled).` });
        return;
    }

    const parsed = Number(raw.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(parsed)) {
        emit(io, { type: 'status', text: 'Usage: !gcooldown <seconds 5-45> | !gcooldown reset' });
        return;
    }

    const clampedSeconds = Math.max(5, Math.min(45, Math.round(parsed)));
    globalCommandCooldownMs = clampedSeconds * 1000;
    lastGlobalCommandAt.clear();
    emit(io, { type: 'status', text: `${state.username} set the global chat cooldown to ${clampedSeconds}s.` });
}

export async function processChatCommand(io: Server, payload: ChatCommandEvent & { fromPanel?: boolean }, sendChat?: (message: string) => Promise<void>) {
    const { username, args = [], isMod, isBroadcaster, channel, fromPanel } = payload;
    const rawCommand = (payload.command ?? '').toLowerCase();
    const command = resolveCommandName(rawCommand);
    if (!command || !knownCommands.has(command)) {
        return; // silently ignore commands we don't own to avoid cross-overlay noise
    }
    if (!isCommandEnabled(command)) {
        emit(io, { type: 'status', text: `${username}: command !${command} is currently disabled.` });
        return;
    }
    const disableGlobalCooldown = process.env.DISABLE_COOLDOWN === 'true' || process.env.NODE_ENV === 'development';
    const isPrivilegedCommand = command === 'event' || command === 'cooldown' || command === 'gcooldown' || command === 'reset-profile';
    const bypassCooldown = Boolean(disableGlobalCooldown || isPrivilegedCommand);
    const chan = (channel ?? process.env.TWITCH_CHANNEL ?? 'default').toLowerCase();
    if (!themeSent) {
        const themes = themeMap();
        emit(io, { type: 'theme', theme: themes[chan] ?? themes.default });
        themeSent = true;
    }
    const { scopedKey } = ids(username, chan);
    const now = Date.now();
    const isCast = command === 'cast';
    const isReel = command === 'reel';
    const isFishingCommand = isCast || isReel;
    const isSessionCommand = command === 'store' || command === 'upgrades' || command === 'inventory' || command === 'buy' || command === 'sell' || command === 'use';
    const isChatOrigin = !fromPanel;

    const lastGlobal = lastGlobalCommandAt.get(chan) ?? 0;
    const globalRemainingMs = disableGlobalCooldown ? 0 : globalCommandCooldownMs - (now - lastGlobal);
    if (isChatOrigin && globalCommandCooldownMs > 0 && !isMod && !isBroadcaster && globalRemainingMs > 0) {
        const reason = `Global cooldown active: ${formatDuration(globalRemainingMs)} remaining.`;
        emit(io, { type: 'status', text: `${username}: ${reason}` });
        pushLog(io, `${username} blocked by global cooldown (${formatDuration(globalRemainingMs)} remaining).`);
        return;
    }

    const last = lastCommandAt.get(scopedKey) ?? 0;
    const remainingMs = bypassCooldown ? 0 : userCommandCooldownMs - (now - last);

    if (interactionLock && interactionLock.scopedKey !== scopedKey) {
        const cdText = remainingMs > 0 ? ` Cooldown: ${formatDuration(remainingMs)} remaining.` : '';
        const reason = `${interactionLock.username} is using the ${interactionLock.mode}; please wait until they're done.`;
        emit(io, { type: 'status', text: `${reason}${cdText}` });
        if (command === 'store' || command === 'upgrades') {
            emitStoreLocked(io, reason, remainingMs > 0 ? remainingMs : undefined, maxInteractionRefreshes, username);
        }
        if (command === 'inventory') {
            emitInventoryLocked(io, await loadPlayer(username, chan), reason);
        }
        pushLog(io, `${username} blocked: ${reason}${cdText ? ` (${cdText.trim()})` : ''}`);
        return;
    }
    const inOwnSession = interactionLock?.scopedKey === scopedKey;
    const enforceCooldown = remainingMs > 0;

    if (enforceCooldown && remainingMs > 0) {
        const reason = `${username}, cooldown active: ${formatDuration(remainingMs)} remaining.`;
        emit(io, { type: 'status', text: reason });
        if (command === 'store' || command === 'upgrades') {
            emitStoreLocked(io, reason, remainingMs, maxInteractionRefreshes - (interactionLock?.refreshesUsed ?? 0), username);
        }
        if (command === 'inventory') {
            emitInventoryLocked(io, await loadPlayer(username, chan), reason);
        }
        pushLog(io, `${username} blocked: cooldown ${formatDuration(remainingMs)} remaining.`);
        return;
    }

    if (enforceCooldown && !isFishingCommand) {
        lastCommandAt.set(scopedKey, now);
    }

    if (isChatOrigin && globalCommandCooldownMs > 0 && !disableGlobalCooldown) {
        lastGlobalCommandAt.set(chan, now);
    }

    const state = await loadPlayer(username, chan);

    // Panel-only commands guard (opt-in). Default behavior allows chat control as documented.
    // Set PANEL_ONLY_COMMANDS=true to require panel for inventory/store/buy/sell/etc.
    const panelOnly = new Set(['store', 'store-refresh', 'buy', 'sell', 'use', 'inventory', 'upgrades', 'equip', 'trade']);
    if (!fromPanel && panelOnly.has(command)) {
        emit(io, { type: 'status', text: `${username}: this action is panel-only. Open the panel: https://custom-overlays.com/panel` });
        pushLog(io, `${username} blocked: panel-only command ${command}.`);
        return;
    }

    if (inOwnSession && !isSessionCommand) {
        clearInteractionLock(null, false);
    }

    switch (command) {
        case 'fish':
            await handleFish(io, state);
            break;
        case 'cast':
            await handleCast(io, state);
            break;
        case 'reel':
            await handleReel(io, state);
            lastCommandAt.set(scopedKey, Date.now());
            break;
        case 'store':
            await handleStore(io, state);
            break;
        case 'store-refresh':
            await handleStoreRefresh(io, state);
            break;
        case 'buy':
            await handleBuy(io, state, args);
            break;
        case 'upgrades':
            await handleUpgrades(io, state);
            break;
        case 'sell':
            await handleSell(io, state, args);
            break;
        case 'use':
            await handleUse(io, state, args);
            break;
        case 'inventory':
            await handleInventory(io, state);
            break;
        case 'save':
            await handleSave(io, state);
            break;
        case 'equip':
            await handleEquip(io, state, args);
            break;
        case 'enchant':
            await handleEnchantChat(io, state, args);
            break;
        case 'duplicate':
            await handleDuplicate(io, state, args);
            break;
        case 'level':
            await handleLevel(io, state);
            break;
        case 'theme':
            await handleTheme(io, args);
            break;
        case 'event':
            await handleEventCommand(io, state, args, isMod, isBroadcaster);
            break;
        case 'cooldown':
            await handleCooldownCommand(io, state, args, isMod, isBroadcaster);
            break;
        case 'gcooldown':
            await handleGlobalCooldownCommand(io, state, args, isMod, isBroadcaster);
            break;
        case 'reset-profile':
            await handleResetProfile(io, state, args, isMod, isBroadcaster);
            break;
        case 'panel':
            if (sendChat) {
                try {
                    await sendChat('Open the panel: https://custom-overlays.com/panel');
                } catch (err) {
                    emit(io, { type: 'status', text: `Could not post panel link to chat: ${err instanceof Error ? err.message : String(err)}` });
                }
            } else {
                emit(io, { type: 'status', text: `${state.username}: Panel link → https://custom-overlays.com/panel` });
            }
            break;
        default:
            emit(io, { type: 'status', text: `Unknown command: !${command}` });
    }
}

// Panel-issued commands reuse the same handler while marking origin as panel.
export async function processPanelCommand(io: Server, payload: ChatCommandEvent) {
    const elevated: ChatCommandEvent & { fromPanel?: boolean } = { ...payload, fromPanel: true };
    await processChatCommand(io, elevated);
}

export async function panelStoreRefresh(io: Server, username: string, channel?: string): Promise<{ ok: boolean; error?: string }> {
    const state = await loadPlayer(username, channel);
    const now = Date.now();
    const last = lastStoreRefresh.get(state.scopedKey) ?? 0;
    if (now - last < storeRefreshCooldownMs) {
        const remaining = storeRefreshCooldownMs - (now - last);
        const msg = `Store refresh on cooldown (${formatDuration(remaining)} remaining).`;
        emit(io, { type: 'status', text: `${state.username}: ${msg}` });
        return { ok: false, error: msg };
    }
    await handleStoreRefresh(io, state);
    return { ok: true };
}

// Panel helpers (bypass cooldowns, no chat syntax required)
export async function panelCraft(io: Server, username: string, channel: string | undefined, recipeId: string) {
    const state = await loadPlayer(username, channel);
    if (!state.craftingUnlocked) {
        emit(io, { type: 'status', text: `${state.username}: crafting is locked (prestige 1 required).` });
        return;
    }
    const recipe = getCraftingRecipes().find((r) => r.id === recipeId);
    if (!recipe) {
        emit(io, { type: 'status', text: `${state.username}: unknown recipe.` });
        return;
    }
    for (const [mat, cost] of Object.entries(recipe.costs)) {
        const key = mat as CraftingMaterialId;
        if ((state.materials?.[key] ?? 0) < (cost ?? 0)) {
            emit(io, { type: 'status', text: `${state.username}: not enough ${mat}.` });
            return;
        }
    }
    state.materials = state.materials ?? { ...materialDefaults };
    for (const [mat, cost] of Object.entries(recipe.costs)) {
        const key = mat as CraftingMaterialId;
        state.materials[key] = Math.max(0, (state.materials[key] ?? 0) - (cost ?? 0));
    }
    const item = recipe.grantsItem ? recipe.grantsItem() : null;
    const grantedMaterials = recipe.grantsMaterials ?? null;

    if (grantedMaterials) {
        state.materials = state.materials ?? { ...materialDefaults };
        for (const [mat, amt] of Object.entries(grantedMaterials)) {
            const key = mat as CraftingMaterialId;
            state.materials[key] = (state.materials[key] ?? 0) + (amt ?? 0);
        }
        emit(io, { type: 'status', text: `${state.username} crafted materials: ${Object.entries(grantedMaterials).map(([m, a]) => `${m} x${a}`).join(', ')}.` });
    }

    if (item) {
        if (state.inventory.length >= state.inventoryCap) {
            state.gold += item.value;
            emit(io, { type: 'status', text: `${state.username}: bag full; auto-sold crafted ${item.name} for ${item.value}g.` });
        } else {
            state.inventory.push(item);
            emit(io, { type: 'status', text: `${state.username} crafted ${item.name}.` });
        }
    }

    if (grantedMaterials || item) {
        emit(io, { type: 'inventory', state: ensurePublic(state) });
    }
}

export async function panelEnchant(io: Server, username: string, channel: string | undefined, target: { kind: 'rod' }, essence: EssenceId) {
    const state = await loadPlayer(username, channel);
    if (!state.enchantmentsUnlocked) {
        emit(io, { type: 'status', text: `${state.username}: enchantments are locked (prestige 3 required).` });
        return;
    }
    state.essences = state.essences ?? { ...essenceDefaults };
    const available = state.essences[essence] ?? 0;
    if (available <= 0) {
        emit(io, { type: 'status', text: `${state.username}: missing ${essence}.` });
        return;
    }
    state.essences[essence] = available - 1;
    const bonus = essence === 'mythic-essence' ? 0.12 : essence === 'echo-essence' ? 0.08 : 0.05;
    const inst: EnchantmentInstance = {
        id: randomUUID(),
        target,
        name: 'Empowered Rod',
        level: 1,
        bonuses: { rarityBonus: bonus, valueBonus: bonus / 2 },
    };
    state.enchantments = [...(state.enchantments ?? []), inst];
    emit(io, { type: 'status', text: `${state.username} enchanted their rod (+rarity/+value).` });
    emit(io, { type: 'inventory', state: ensurePublic(state) });
}

export async function panelTradeList(io: Server, username: string, channel: string | undefined, itemId: string, price: number) {
    await loadTradeBoard(channel);
    const state = await loadPlayer(username, channel);
    if (!state.tradingUnlocked) {
        emit(io, { type: 'status', text: `${state.username}: trading is locked (prestige 2 required).` });
        return;
    }
    const idx = state.inventory.findIndex((i) => i.id === itemId);
    if (idx < 0) {
        emit(io, { type: 'status', text: `${state.username}: item not found.` });
        return;
    }
    const item = state.inventory.splice(idx, 1)[0];
    const listing: TradeListing & { sellerScopedKey: string } = {
        id: randomUUID(),
        seller: state.username,
        channel: channel,
        item,
        price: Math.max(1, Math.floor(price)),
        createdAt: Date.now(),
        expiresAt: Date.now() + 12 * 60 * 60 * 1000,
        status: 'active',
        sellerScopedKey: state.scopedKey,
    };
    tradeBoard.push(listing);
    await persistTradeBoard(channel);
    state.tradeListings = [...(state.tradeListings ?? []), listing];
    emit(io, { type: 'status', text: `${state.username} listed ${item.name} for ${listing.price}g.` });
    emit(io, { type: 'inventory', state: ensurePublic(state) });
}

export async function panelTradeBuy(io: Server, username: string, channel: string | undefined, listingId: string) {
    await loadTradeBoard(channel);
    pruneTradeBoard();
    const buyer = await loadPlayer(username, channel);
    const entry = tradeBoard.find((l) => l.id === listingId && l.status === 'active' && l.expiresAt > Date.now());
    if (!entry) {
        emit(io, { type: 'status', text: `${buyer.username}: listing unavailable.` });
        return;
    }
    if (buyer.gold < entry.price) {
        emit(io, { type: 'status', text: `${buyer.username}: not enough gold.` });
        return;
    }
    if (buyer.inventory.length >= buyer.inventoryCap) {
        emit(io, { type: 'status', text: `${buyer.username}: inventory full.` });
        return;
    }
    const seller = await loadPlayer(entry.seller, entry.channel);
    buyer.gold -= entry.price;
    buyer.inventory.push(entry.item);
    seller.gold += entry.price;
    entry.status = 'sold';
    await persistTradeBoard(channel);
    emit(io, { type: 'status', text: `${buyer.username} bought ${entry.item.name} for ${entry.price}g.` });
    emit(io, { type: 'inventory', state: ensurePublic(buyer) });
}

export async function panelTradeCancel(io: Server, username: string, channel: string | undefined, listingId: string) {
    await loadTradeBoard(channel);
    pruneTradeBoard();
    const state = await loadPlayer(username, channel);
    const entry = tradeBoard.find((l) => l.id === listingId && l.status === 'active');
    if (!entry) {
        emit(io, { type: 'status', text: `${state.username}: listing not found.` });
        return;
    }
    if (entry.seller !== state.username) {
        emit(io, { type: 'status', text: `${state.username}: cannot cancel others' listings.` });
        return;
    }
    entry.status = 'cancelled';
    if (state.inventory.length < state.inventoryCap) {
        state.inventory.push(entry.item);
    } else {
        state.gold += entry.item.value;
    }
    await persistTradeBoard(channel);
    emit(io, { type: 'status', text: `${state.username} cancelled listing ${entry.item.name}.` });
    emit(io, { type: 'inventory', state: ensurePublic(state) });
}