/*
 * The four tabs of Masters → Items & Products. A main category says which
 * one it is under, everything filed beneath it goes with it, and the item
 * types each takes keep a finished good out of Fabric and a button out of
 * Finished Goods. Expense heads are items too, under their own category and
 * on their own screen, so they belong to no tab here.
 */

export type ItemGroup = 'RAW_MATERIALS' | 'SEMI_FINISHED' | 'FINISHED_GOODS' | 'FIXED_ASSETS' | 'EXPENSES'

/** The four tabs, in the order they are shown. Fixed assets — machines, computers, furniture — are kept and moved, never used up. */
export const ITEM_GROUP_TABS = ['RAW_MATERIALS', 'SEMI_FINISHED', 'FINISHED_GOODS', 'FIXED_ASSETS'] as const

export const ITEM_GROUP_LABEL: Record<ItemGroup, string> = {
  RAW_MATERIALS: 'Raw Materials',
  SEMI_FINISHED: 'Semi-Finished Goods',
  FINISHED_GOODS: 'Finished Goods',
  FIXED_ASSETS: 'Fixed Assets',
  EXPENSES: 'Expenses',
}

/** The item types a group takes; Expenses takes any, as its heads always have. */
export const ITEM_GROUP_TYPES: Record<ItemGroup, readonly string[] | null> = {
  RAW_MATERIALS: ['RAW_MATERIAL', 'TRIM', 'PACKING_MATERIAL', 'CONSUMABLE'],
  SEMI_FINISHED: ['SEMI_FINISHED'],
  FINISHED_GOODS: ['FINISHED_GOOD'],
  FIXED_ASSETS: ['FIXED_ASSET'],
  EXPENSES: null,
}

/** Whether an item of this type can be filed under a category of this group. */
export function typeFitsGroup(type: string, group: ItemGroup): boolean {
  const types = ITEM_GROUP_TYPES[group]
  return !types || types.includes(type)
}

/** The group an item type normally belongs to, for a category not yet chosen. */
export function groupOfType(type: string): ItemGroup {
  if (type === 'FINISHED_GOOD') return 'FINISHED_GOODS'
  if (type === 'SEMI_FINISHED') return 'SEMI_FINISHED'
  if (type === 'FIXED_ASSET') return 'FIXED_ASSETS'
  return 'RAW_MATERIALS'
}
