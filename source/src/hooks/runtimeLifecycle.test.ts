import { afterEach, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { makeSnapshot } from '@/test/factories';
import { resetStartupSequenceForTests, setMonitoringInterval, startStartupSequence } from './useStartupSequence';
vi.mock('@/lib/api',async original=>{const actual=await original<typeof import('@/lib/api')>();return {...actual,api:{...actual.api,checkSession:vi.fn()}};});
afterEach(()=>{resetStartupSequenceForTests();vi.useRealTimers();});
it('honors the configured interval, stops in native background and rearms once on resume',async()=>{
  vi.useFakeTimers();resetStartupSequenceForTests();
  vi.mocked(api.checkSession).mockResolvedValue(makeSnapshot({state:'connected',checkedAt:null,lastSuccessAt:null}));
  setMonitoringInterval(1);startStartupSequence();await vi.advanceTimersByTimeAsync(0);
  expect(api.checkSession).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(59000);expect(api.checkSession).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new CustomEvent('ffn-runtime',{detail:{foreground:false}}));
  await vi.advanceTimersByTimeAsync(300000);expect(api.checkSession).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new CustomEvent('ffn-runtime',{detail:{foreground:true}}));
  await vi.advanceTimersByTimeAsync(60000);expect(api.checkSession).toHaveBeenCalledTimes(2);
});
