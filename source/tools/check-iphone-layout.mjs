import {chromium} from 'playwright';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

const base=process.argv[2] ?? 'http://127.0.0.1:5173';
const output=resolve(process.argv[3] ?? 'dist-ios/browser-checks');
await mkdir(output,{recursive:true});
const clips=await Promise.all(['portrait.mp4','small.mp4'].map(name=>readFile(new URL('./browser-fixtures/'+name,import.meta.url))));
const browser=await chromium.launch({headless:true});
const results=[];
try {
  for(const [width,height] of [[320,568],[390,844],[430,932]]) {
    const page=await browser.newPage({viewport:{width,height},isMobile:true,hasTouch:true});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route(/\/media\/[0-9a-f]+\/[0-9a-f]+$/,async route=>{
      const bytes=route.request().url().endsWith('3'.repeat(32)) ? clips[1] : clips[0];
      const range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
      const start=range ? Number(range[1]) : 0;
      const end=range?.[2] ? Math.min(Number(range[2]),bytes.length-1) : bytes.length-1;
      const headers={'content-type':'video/mp4','accept-ranges':'bytes','content-length':String(end-start+1),'cache-control':'no-store'};
      if(range) headers['content-range']=`bytes ${start}-${end}/${bytes.length}`;
      await route.fulfill({status:range ? 206 : 200,headers,body:bytes.subarray(start,end+1)});
    });
    await page.goto(base+'/tools/browser-fixtures/index.html?platform=ios');
    await page.locator('[data-testid="post-card"]').first().waitFor();
    const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,textSize:parseFloat(getComputedStyle(document.querySelector('.post-text')).fontSize),mediaWidth:document.querySelector('[data-testid="media-grid"]').getBoundingClientRect().width,cardWidth:document.querySelector('[data-testid="post-card"]').getBoundingClientRect().width}));
    assert.equal(geometry.scrollWidth,width,'Horizontal overflow');
    assert.equal(geometry.textSize,16,'Phone text sizing');
    assert(geometry.mediaWidth >= geometry.cardWidth-28,'Media is confined to the avatar column');
    await page.screenshot({path:resolve(output,`phone-${width}.png`)});
    const videoCard=page.locator('[data-testid="post-card"]').nth(1);
    await videoCard.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('video')?.readyState>=1);
    await videoCard.getByRole('button',{name:'Play',exact:true}).click();
    await page.waitForFunction(()=>{const video=document.querySelector('video');return video && !video.paused && video.currentTime>0.2;});
    await videoCard.getByTestId('video-inline-settings').click();
    const quality=page.getByRole('menuitemradio',{name:'284p',exact:true});
    await quality.evaluate(element=>element.scrollIntoView({block:'nearest'}));
    const target=await quality.boundingBox();
    assert(target && target.y>=0 && target.y+target.height<=height,'Quality choice is not reachable');
    await page.touchscreen.tap(target.x+target.width/2,target.y+target.height/2);
    await page.waitForFunction(()=>{const video=document.querySelector('video');return video?.videoHeight===284 && !video.paused;});
    await page.getByTestId('video-enter-fullscreen').click();
    await page.getByTestId('video-exit-fullscreen').waitFor();
    await page.screenshot({path:resolve(output,`fullscreen-${width}.png`)});
    const exit=await page.getByTestId('video-exit-fullscreen').boundingBox();
    assert(exit && exit.x>=0 && exit.y>=0 && exit.x+exit.width<=width && exit.y+exit.height<=height,'Exit is outside the viewport');
    await page.evaluate(()=>{document.querySelector('video').src='/missing-video.mp4';document.querySelector('video').load();});
    await page.waitForFunction(()=>Boolean(document.querySelector('video')?.error));
    await page.getByTestId('video-exit-fullscreen').click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="video-surface"]').dataset.fullscreen==='false');
    assert.equal(errors.length,0,errors.join('\n'));
    results.push({width,height,...geometry,mp4Playback:true,qualityChangeResumed:true,fullscreenErrorExit:true});
    await page.close();
  }
} finally {await browser.close();}
await writeFile(resolve(output,'results.json'),JSON.stringify(results,null,2)+'\n');
console.log(`Phone browser checks passed: ${results.length} viewport sizes, actual MP4 playback, quality change and fullscreen error exit.`);
