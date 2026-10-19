import { describe, expect, it } from 'vitest';
import { feedWindow } from './feedWindow';

it('bounds Ultra rows at ten thousand posts and reverses the buffers',()=>{
  expect(feedWindow(500,505,10000,false,100,'ultra')).toEqual(Array.from({length:28},(_,i)=>494+i));
  expect(feedWindow(500,505,10000,true,100,'ultra')).toEqual(Array.from({length:28},(_,i)=>484+i));
});
describe('feed window', () => {
  it.each([1000,10000])('bounds mounted rows for %i mixed posts in every policy', count => {
    expect(feedWindow(500,505,count,false,0,'balanced')).toHaveLength(15);
    expect(feedWindow(500,505,count,false,20,'fast')).toHaveLength(22);
    expect(feedWindow(500,505,count,false,20,'battery')).toHaveLength(12);
    expect(feedWindow(500,505,count,true,0,'balanced')[0]).toBe(494);
    expect(feedWindow(500,505,count,true,20,'battery')[0]).toBe(496);
  });
  it('keeps every visible row after a large jump while bounding the runway', () => {
    const rows = feedWindow(700, 708, 10000, false, 30);
    expect(rows).toHaveLength(25);
    for (let i = 700; i <= 708; i++) expect(rows).toContain(i);
    expect(rows[0]).toBe(696); expect(rows.at(-1)).toBe(720);
  });
  it('changes the runway with direction and clamps both collection edges', () => {
    expect(feedWindow(10, 14, 100, true, 3)[0]).toBe(0);
    expect(feedWindow(98, 99, 100, false, 3).at(-1)).toBe(99);
    expect(feedWindow(0, 0, 0, false, 0)).toEqual([]);
  });
});
