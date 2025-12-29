export const ITEM_TYPES = {
  SALVAGED_SCRAP: 1,
} as const;

export type ItemType = (typeof ITEM_TYPES)[keyof typeof ITEM_TYPES];

export const ITEM_DEFS: Record<number, { name: string; volume_m3: number }> = {
  [ITEM_TYPES.SALVAGED_SCRAP]: { name: "Salvaged Scrap", volume_m3: 10 },
};

export function getItemDef(itemType: number): { name: string; volume_m3: number } {
  return ITEM_DEFS[itemType] ?? { name: `Item ${itemType}`, volume_m3: 0 };
}
