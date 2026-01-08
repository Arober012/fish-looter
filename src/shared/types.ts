// Shared types for chat-driven fishing overlay

// Added 'relic' as a post-mythic prestige-4+ rarity for custom loot
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic' | 'relic';

// Crafting and enchanting resource identifiers
export type CraftingMaterialId = 'tide-shard' | 'ember-fragment' | 'abyssal-ink' | 'frost-crystal' | 'astral-fiber' | 'cosmic-dust';
export type EssenceId = 'spark-essence' | 'echo-essence' | 'mythic-essence';

export interface InventoryItem {
    id: string;
    name: string;
    rarity: Rarity;
    value: number;
    description?: string;
    type?: StoreItem['type'];
}

// Stored enchantments; starts with rod targeting, later can attach to items/skins
export interface EnchantmentInstance {
    id: string;
    target: { kind: 'rod' | 'item' | 'skin'; refId?: string };
    name: string;
    level: number;
    bonuses?: { rarityBonus?: number; valueBonus?: number; xpBonus?: number; yieldBonus?: number };
    expiresAt?: number;
}

export interface PlayerStatePublic {
    username: string;
    displayName?: string;
    twitchLogin?: string;
    gold: number;
    level: number;
    xp: number;
    xpNeeded: number;
    poleLevel: number;
    lureLevel: number;
    luck: number;
    poleSkinId: PoleSkinId;
    ownedPoleSkins?: PoleSkinId[];
    inventory: InventoryItem[];
    inventoryCap: number;
    biome: string;
    activeBuffs?: {
        xp?: { amount: number; expiresAt: number };
        value?: { amount: number; expiresAt: number };
    };
    upgradeCharges?: Record<string, { count: number; resetAt: number }>;
    craftingUnlocked?: boolean;
    tradingUnlocked?: boolean;
    enchantmentsUnlocked?: boolean;
    prestigeCount?: number;
    materials?: Record<CraftingMaterialId, number>;
    essences?: Record<EssenceId, number>;
    enchantments?: EnchantmentInstance[];
    tradeListings?: TradeListing[];
}

// Catalog-driven content definitions (server-served to the panel)
export type CatalogVersion = string;

export interface CatalogMaterial {
    id: CraftingMaterialId | string;
    name: string;
    description?: string;
    iconUrl?: string;
}

export interface CatalogEssence {
    id: EssenceId | string;
    name: string;
    rarityBonus?: number;
    valueBonus?: number;
    description?: string;
    iconUrl?: string;
}

export interface CatalogRecipe {
    id: string;
    name: string;
    description?: string;
    costs: Partial<Record<CraftingMaterialId | string, number>>;
    grants?: { name: string; rarity: Rarity; type?: StoreItem['type']; value?: number; description?: string };
    grantsMaterials?: Partial<Record<CraftingMaterialId | string, number>>;
}

export interface CatalogSkin {
    id: PoleSkinId | string;
    name: string;
    levelReq: number;
    cost: number;
    rarity: Rarity;
    description?: string;
    imageUrl?: string;
}

export interface CatalogBiome {
    id: string;
    name: string;
    tier: number;
    rarityConfigs: Array<{ rarity: Rarity; weight: number; valueRange: [number, number]; xp: number }>;
    lootTable: Record<Rarity, string[]>;
    goldMultiplier: number;
    xpMultiplier: number;
    imageUrl?: string;
}

export interface CatalogBuff {
    id: string;
    name: string;
    amount?: number;
    durationMs?: number;
    kind: 'xp' | 'value' | 'rarity' | 'event';
    description?: string;
}

export interface CatalogChatCommand {
    name: string;
    description?: string;
    aliases?: string[];
    enabled?: boolean;
    panelOnly?: boolean;
    modOnly?: boolean;
}

export interface CatalogUiConfig {
    theme?: ThemePalette;
    themes?: Array<ThemePalette & { id?: string; key?: string }>;
    boostIcons?: { xp?: string; gold?: string; double?: string };
}

export interface Catalog {
    version: CatalogVersion;
    updatedAt: number;
    materials: CatalogMaterial[];
    essences: CatalogEssence[];
    recipes: CatalogRecipe[];
    items: StoreItem[];
    upgrades: UpgradeDefinition[];
    skins: CatalogSkin[];
    biomes: CatalogBiome[];
    buffs?: CatalogBuff[];
    chatCommands?: CatalogChatCommand[];
    storeConfig?: { rotationHours: number; alwaysKeys?: string[]; slots?: number };
    ui?: CatalogUiConfig;
}

// Allow new skins to flow from catalog without code changes
export type PoleSkinId = 'classic' | 'carbon' | 'neon' | 'aurora' | string;

export interface PoleSkin {
    id: PoleSkinId;
    name: string;
    levelReq: number;
    cost: number;
    description: string;
}

export interface StoreItem {
    key: string;
    name: string;
    cost: number;
    rarity: Rarity;
    value: number;
    description: string;
    type?: 'bait' | 'skin' | 'upgrade' | 'item' | 'chest' | 'token' | 'compass' | 'map' | 'scroll';
    minLevel?: number;
    imageUrl?: string;
}

export type TradeStatus = 'active' | 'sold' | 'cancelled' | 'expired';

export interface TradeListing {
    id: string;
    seller: string;
    channel?: string;
    item: InventoryItem;
    price: number;
    createdAt: number;
    expiresAt: number;
    status?: TradeStatus;
}

export interface UpgradeDefinition {
    key: string;
    name: string;
    cost: number;
    maxLevel: number;
    description: string;
    stat: 'luck' | 'value' | 'xp' | 'rarity' | 'prestige';
}

export interface ChatCommandEvent {
    username: string;
    command: string;
    args?: string[];
    isMod?: boolean;
    isBroadcaster?: boolean;
    channel?: string;
}

export type OverlayEvent =
    | { type: 'status'; text: string }
    | { type: 'log'; line: string }
    | { type: 'cast'; user: string; etaMs: number }
    | { type: 'tug'; user: string }
    | { type: 'catch'; user: string; success: boolean; item?: InventoryItem; goldEarned?: number; xpGained?: number; rarity?: Rarity }
    | { type: 'level'; level: number; xp: number; xpNeeded: number }
    | { type: 'store'; items: StoreItem[]; upgrades: UpgradeDefinition[]; expiresAt?: number; locked?: { reason: string; remainingMs?: number; refreshesLeft?: number } }
    | { type: 'inventory'; state: PlayerStatePublic; locked?: { reason: string; remainingMs?: number; refreshesLeft?: number } }
    | { type: 'sell'; gold: number; item?: InventoryItem; count?: number }
    | { type: 'save'; ok: boolean; message?: string }
    | { type: 'theme'; theme: ThemePalette }
    | { type: 'skin'; user: string; skinId: PoleSkinId }
    | { type: 'buffs'; user: string; buffs: Partial<{ xp: { amount: number; expiresAt: number }; value: { amount: number; expiresAt: number }; charm: { rarityBonus?: number; xpBonus?: number; expiresAt: number } }> }
    | { type: 'events'; events: Array<{ id: string; kind: 'xp' | 'gold' | 'double' | 'luck'; amount: number; endsAt: number; targetRarity?: Rarity }> };

export interface ThemePalette {
    name: string;
    background: string;
    backgroundAlt: string;
    panel: string;
    panelBorder: string;
    accent: string;
    accentSoft: string;
    text: string;
    muted: string;
}