import {describe,it,expect} from 'vitest';
import {externalUrl,trimUrlPunctuation} from './externalUrl';
describe('clickable web destinations',()=>{
  it('accepts web URLs and keeps balanced parentheses out of sentence punctuation',()=>{
    expect(externalUrl('https://example.com/story?q=1')).toBe('https://example.com/story?q=1');
    expect(trimUrlPunctuation('https://example.com/Story_(film)).')).toBe('https://example.com/Story_(film)');
    expect(trimUrlPunctuation('https://example.com/story،')).toBe('https://example.com/story');
  });
  it('rejects executable, credential-bearing and malformed destinations',()=>{
    for(const value of ['javascript:alert(1)','file:///tmp/a','https://user:pass@example.com','https://example.com\nignored','https://','data:text/html,a']) expect(externalUrl(value)).toBeNull();
  });
});
