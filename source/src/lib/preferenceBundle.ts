import { preferenceEntries, type Preferences } from '@/stores/useAppStore';
export interface PreferenceBundle { version: 1; preferences: [string,string][] }
export function exportPreferenceBundle(prefs: Preferences): PreferenceBundle {
  return { version: 1, preferences: preferenceEntries(prefs).filter(([key]) => !/^(actions|startup|window|updates)\./.test(key)) };
}
export function parsePreferenceBundle(text: string, prefs: Preferences): PreferenceBundle {
  if (text.length > 32768) throw new Error('Invalid preference bundle.');
  const bundle = JSON.parse(text) as PreferenceBundle;
  const allowed = new Set(exportPreferenceBundle(prefs).preferences.map(([key]) => key));
  const seen = new Set<string>();
  if (!bundle || bundle.version !== 1 || Object.keys(bundle).some(key => !['version','preferences'].includes(key)) || !Array.isArray(bundle.preferences) || bundle.preferences.length > 80)
    throw new Error('Invalid preference bundle.');
  for (const entry of bundle.preferences) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string' || !allowed.has(entry[0]) || seen.has(entry[0])) throw new Error('Invalid preference bundle.');
    seen.add(entry[0]);
  }
  return bundle;
}
