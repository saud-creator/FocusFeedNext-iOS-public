import {chromium,webkit} from 'playwright';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

const base=process.argv[2] ?? 'http://127.0.0.1:5173';
const output=resolve(process.argv[3] ?? 'dist-ios/browser-checks');
await mkdir(output,{recursive:true});
const clips=await Promise.all(['portrait.mp4','small.mp4'].map(name=>readFile(new URL('./browser-fixtures/'+name,import.meta.url))));
const results=[];
async function checkWindowedFeed(browser,engine,width,height) {
  const page=await browser.newPage({viewport:{width,height},isMobile:true,hasTouch:true});
  let releaseImage;
  const imageReady=new Promise(resolve=>{releaseImage=resolve;});
  await page.route('**/fixtures/changing-photo.svg',async route=>{
    await imageReady;
    await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="900"><rect width="320" height="900" fill="#38bdf8"/></svg>'});
  });
  try {
    await page.goto(base+'/tools/browser-fixtures/index.html?platform=ios&windowed');
    await page.getByTestId('feed-window-item').first().waitFor();
    await page.waitForFunction(()=>Boolean(document.querySelector('[data-testid="fixture-paint"]')?.getAttribute('data-ms')));
    const firstPaintMs=Number(await page.getByTestId('fixture-paint').getAttribute('data-ms'));
    assert(firstPaintMs<=250,`${engine} ${width}: first returned post painted in ${firstPaintMs.toFixed(1)} ms`);
    const assertRows=async phase=>{
      try {
        await page.waitForFunction(()=>{
          const rows=Array.from(document.querySelectorAll('[data-testid="feed-window-item"]')).sort((a,b)=>Number(a.dataset.index)-Number(b.dataset.index));
          return rows.length>1 && rows.every((row,index)=>index===0 || Number(row.dataset.index)!==Number(rows[index-1].dataset.index)+1 || row.getBoundingClientRect().top>=rows[index-1].getBoundingClientRect().bottom-1);
        },null,{timeout:4000});
      } catch(error) {
        const geometry=await page.getByTestId('feed-window-item').evaluateAll(rows=>rows.map(row=>({index:row.dataset.index,top:row.getBoundingClientRect().top,height:row.getBoundingClientRect().height})));
        await page.screenshot({path:resolve(output,`${engine}-overlap-${width}-${phase}.png`)});
        throw new Error(`${engine} ${width} ${phase}: overlapping measured cards ${JSON.stringify(geometry)}`,{cause:error});
      }
    };
    await assertRows('initial');
    releaseImage();
    await page.waitForFunction(()=>{const image=document.querySelector('img[alt="Delayed intrinsic image"]');return image?.complete && image.naturalHeight===900;});
    await assertRows('decoded');
    await page.locator('main').evaluate(element=>{element.scrollTop=1100;});
    await assertRows('scrolled');
    await page.setViewportSize({width:height,height:width});
    await assertRows('rotated');
    await page.setViewportSize({width,height});
    await page.locator('main').evaluate(element=>{element.scrollTop=0;});
    await assertRows('restored');
    await page.locator('main').evaluate(element=>{element.style.display='none';});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.locator('main').evaluate(element=>{element.style.display='';});
    await assertRows('shown');
    await page.screenshot({path:resolve(output,`${engine}-windowed-${width}.png`)});
    assert(await page.getByTestId('post-card').count()<40,'Windowed feed mounted the entire batch');
    return {firstPaintMs,windowedGeometry:true};
  } finally {releaseImage();await page.close();}
}
for(const [engine,browserType] of [['chromium',chromium],['webkit',webkit]]) {
const browser=await browserType.launch({headless:true});
try {
  for(const [width,height] of [[320,568],[390,844],[430,932],[844,390]]) {
    const windowed=await checkWindowedFeed(browser,engine,width,height);
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
    const geometry=await page.evaluate(()=>{
      const card=document.querySelector('[data-testid="post-card"]');const style=getComputedStyle(card);
      return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,textSize:parseFloat(getComputedStyle(document.querySelector('.post-text')).fontSize),mediaWidth:document.querySelector('[data-testid="media-grid"]').getBoundingClientRect().width,cardWidth:card.getBoundingClientRect().width,readingWidth:card.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)};
    });
    assert.equal(geometry.scrollWidth,width,'Horizontal overflow');
    assert.equal(geometry.textSize,16,'Phone text sizing');
    assert(Math.abs(geometry.mediaWidth-geometry.readingWidth)<=1,`Media does not use the reading width: ${JSON.stringify(geometry)}`);
    await page.screenshot({path:resolve(output,`${engine}-phone-${width}.png`)});
    // Model UIKit's measured occupied area. The scroll viewport must end above
    // it; padding alone leaves visible controls underneath the native bar.
    await page.evaluate(()=>document.documentElement.style.setProperty('--reader-bottom-inset','83px'));
    const readerBottom=await page.locator('main').evaluate(element=>element.getBoundingClientRect().bottom);
    assert(Math.abs(readerBottom-(height-83))<=1,'Reader viewport extends underneath native navigation');
    const videoCard=page.locator('[data-testid="post-card"]').nth(1);
    await videoCard.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>{const video=document.querySelector('video');return (video && (video.readyState>=1 || video.error)) || Array.from(document.querySelectorAll('button')).some(button=>button.textContent?.trim()==='Retry video');}).catch(async error=>{
      const mediaState=await page.evaluate(()=>{const video=document.querySelector('video');return {codec:document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'),readyState:video?.readyState,error:video?.error?.code,networkState:video?.networkState,sourcePresent:Boolean(video?.currentSrc),placeholder:Boolean(document.querySelector('[data-testid="video-surface-placeholder"]'))};});
      throw new Error(`${engine} ${width} video metadata: ${JSON.stringify(mediaState)}`,{cause:error});
    });
    const decode=await page.evaluate(()=>({ready:document.querySelector('video')?.readyState,error:document.querySelector('video')?.error?.code,failed:Array.from(document.querySelectorAll('button')).some(button=>button.textContent?.trim()==='Retry video')}));
    if(engine==='webkit' && process.platform==='win32' && (decode.error===4 || decode.failed)) {
      // A plain MP4 <video> also fails in this Windows WebKit build. Do not
      // label that playback as verified. macOS CI always requires playback.
      const plainError=await page.evaluate(source=>new Promise(resolve=>{
        const probe=document.createElement('video');probe.preload='metadata';probe.style.display='none';
        const finish=code=>{probe.remove();resolve(code);};
        probe.addEventListener('error',()=>finish(probe.error?.code),{once:true});
        probe.addEventListener('loadedmetadata',()=>finish(0),{once:true});
        document.body.appendChild(probe);probe.src=source;probe.load();
      }),base+'/media/'+('1'.repeat(32))+'/'+('2'.repeat(32)));
      assert.equal(plainError,4,'Windows limitation must reproduce outside the app');
      await videoCard.getByRole('button',{name:'Retry video'}).waitFor();
      results.push({engine,width,height,...geometry,...windowed,mp4Playback:false,hostLimitation:'Windows WebKit MP4 decoder unavailable',recoverableVideoError:true});
      await page.close();continue;
    }
    assert(decode.ready>=1,`${engine} ${width} cannot decode fixture MP4: ${JSON.stringify(decode)}`);
    const fullScreenControl=videoCard.getByTestId('video-enter-fullscreen');
    await fullScreenControl.scrollIntoViewIfNeeded();
    const inlineBounds=await fullScreenControl.boundingBox();
    assert(inlineBounds && inlineBounds.y>=0 && inlineBounds.y+inlineBounds.height<=height-83,'Fullscreen control remains below the reading viewport');
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
    await page.screenshot({path:resolve(output,`${engine}-fullscreen-${width}.png`)});
    const exit=await page.getByTestId('video-exit-fullscreen').boundingBox();
    assert(exit && exit.x>=0 && exit.y>=0 && exit.x+exit.width<=width && exit.y+exit.height<=height,'Exit is outside the viewport');
    await page.evaluate(()=>{document.querySelector('video').src='/missing-video.mp4';document.querySelector('video').load();});
    await page.waitForFunction(()=>Boolean(document.querySelector('video')?.error));
    await page.getByTestId('video-exit-fullscreen').click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="video-surface"]').dataset.fullscreen==='false');
    const failedCard=page.locator('[data-testid="post-card"]').nth(2);
    await failedCard.scrollIntoViewIfNeeded();
    await failedCard.getByRole('button',{name:'Retry image'}).waitFor();
    assert.equal(await failedCard.locator('img[alt="Failed fixture image"]').count(),0,'Broken image glyph remained in finished UI');
    assert.equal(errors.length,0,errors.join('\n'));
    results.push({engine,width,height,...geometry,...windowed,mp4Playback:true,qualityChangeResumed:true,fullscreenErrorExit:true});
    await page.close();
  }
} finally {await browser.close();}
}
await writeFile(resolve(output,'results.json'),JSON.stringify(results,null,2)+'\n');
console.log(`Phone browser checks: ${results.length} layout combinations; ${results.filter(r=>r.mp4Playback).length} verified MP4 playback/quality/fullscreen combinations; ${results.filter(r=>r.hostLimitation).length} explicitly unverified Windows WebKit playback combinations.`);
