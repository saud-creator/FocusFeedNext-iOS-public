export const mobileTabIds = ['following', 'focus', 'bookmarks', 'accounts', 'originals', 'groups', 'search'] as const;
export type MobileTabId = typeof mobileTabIds[number];
export const defaultMobileTabs: MobileTabId[] = ['following', 'focus', 'bookmarks', 'accounts'];
export function validMobileTabs(value: unknown): value is MobileTabId[] {
  return Array.isArray(value) && value.length === 4 && new Set(value).size === 4 &&
    value.every(id => (mobileTabIds as readonly unknown[]).includes(id));
}
