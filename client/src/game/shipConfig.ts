// client/src/game/shipConfig.ts

export type ShipStats = {
  name: string;

  // Size (meters) used for camera min-distance + visuals consistency
  size_m: number;

  // Health
  maxArmor: number;
  maxHull: number;

  // Placeholder weapon stats (structure only for now)
  weapon: {
    name: string;
    cooldownMs: number;
    range_m: number;
    // damage is not wired to anything yet, but keep it here for future
    damage: {
      armor: number;
      hull: number;
    };
  };
};

export const DEFAULT_SHIP_STATS: ShipStats = {
  name: "Basic Frigate",
  size_m: 300,

  maxArmor: 120,
  maxHull: 90,

  weapon: {
    name: "Civilian Blaster (stub)",
    cooldownMs: 900,
    range_m: 25_000,
    damage: {
      armor: 8,
      hull: 6,
    },
  },
};
