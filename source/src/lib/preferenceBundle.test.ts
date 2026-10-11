import { describe, expect, it } from 'vitest';
import { exportPreferenceBundle, parsePreferenceBundle } from './preferenceBundle';
import { defaultPreferences } from '@/stores/useAppStore';
describe('portable customization', () => {
  it('round trips appearance, navigation, reading and media without permissions or content', () => {
    const bundle=exportPreferenceBundle({...defaultPreferences,advancedAccountActions:true});
    const keys=bundle.preferences.map(([key])=>key);
    expect(keys).toContain('navigation.tabs');expect(keys).toContain('reading.size');
    expect(keys.some(key=>/auth|cookie|actions|startup|window|updates|list/.test(key))).toBe(false);
    expect(parsePreferenceBundle(JSON.stringify(bundle),defaultPreferences)).toEqual(bundle);
  });
  it.each([
    {version:2,preferences:[]}, {version:1,preferences:[['auth_token','secret']]},
    {version:1,preferences:[['theme','dark'],['theme','light']]},
    {version:1,preferences:[['theme',true]]}, {version:1,preferences:[],cookies:[]},
  ])('rejects malformed or nonportable bundles', bundle => expect(()=>parsePreferenceBundle(JSON.stringify(bundle),defaultPreferences)).toThrow());
});
