import { describe, expect, it } from 'vitest';
import { defaultRuntime, effectivePolicy } from './runtime';
import { defaultPreferences } from '@/stores/useAppStore';
describe('effective iPhone policy', () => {
  it('bounds Ultra work and applies device restrictions without changing the saved mode',()=>{
    const ultra={...defaultPreferences,performanceMode:'ultra' as const,videoQuality:'best' as const};
    expect(effectivePolicy(ultra,defaultRuntime,true)).toMatchObject({mode:'ultra',imageMargin:900,screensAhead:3,videoQuality:'best'});
    expect(effectivePolicy(ultra,{...defaultRuntime,lowPower:true},true)).toMatchObject({mode:'battery',speculative:false,autoplay:false,videoQuality:'best'});
    expect(ultra.performanceMode).toBe('ultra');
  });
  const prefs = { ...defaultPreferences, videoQuality: 'auto' as const, autoplay: 'wifi' as const };
  it('selects the documented balanced Wi-Fi defaults', () => {
    expect(effectivePolicy(prefs,defaultRuntime,true)).toMatchObject({mode:'balanced',imageMargin:350,screensAhead:2,videoQuality:'720',autoplay:true,cleanup:true});
  });
  it.each(['lowPower','constrained','reduceMotion'] as const)('disables autoplay for %s without editing preferences', key => {
    const policy = effectivePolicy(prefs,{...defaultRuntime,[key]:true},true);
    expect(policy.autoplay).toBe(false); expect(prefs.autoplay).toBe('wifi');
    if (key !== 'reduceMotion') expect(policy.speculative).toBe(false);
  });
  it('uses actual connection and thermal restrictions', () => {
    expect(effectivePolicy(prefs,{...defaultRuntime,wifi:false,expensive:true},true)).toMatchObject({videoQuality:'480',autoplay:false});
    expect(effectivePolicy(prefs,{...defaultRuntime,thermal:'serious'},true)).toMatchObject({mode:'battery',videoQuality:'360',autoplay:false,speculative:false});
    expect(effectivePolicy({...prefs,performanceMode:'fast'},defaultRuntime,true)).toMatchObject({imageMargin:700,screensAhead:3});
    expect(effectivePolicy({...prefs,performanceMode:'battery'},defaultRuntime,true)).toMatchObject({imageMargin:200,screensAhead:1,autoplay:false});
  });
  it('suspends foreground work and preserves manual quality', () => {
    expect(effectivePolicy({...prefs,videoQuality:'1080'},{...defaultRuntime,foreground:false},true)).toMatchObject({videoQuality:'1080',foreground:false,speculative:false,autoplay:false});
  });
});
