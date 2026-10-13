import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, SlidersHorizontal } from 'lucide-react';
import { useI18n } from '@/i18n';
import { qualityLabel, type QualityOption } from './quality';

export function InlineVideoSettings({speed,speeds,qualities,qualityIndex,loop,onSpeed,onQuality,onLoop}:{
  speed:number; speeds:readonly number[]; qualities:QualityOption[]; qualityIndex:number; loop:boolean;
  onSpeed:(value:number)=>void; onQuality:(index:number)=>void; onLoop:()=>void;
}) {
  const {t}=useI18n();
  const item='relative flex min-h-11 items-center rounded-lg px-3 ps-8 text-sm outline-none data-[highlighted]:bg-surface-3';
  return <Dropdown.Root>
    <Dropdown.Trigger asChild><button type="button" className="inline-flex min-h-11 min-w-11 items-center justify-center" aria-label={t('post.video.settings')} data-testid="video-inline-settings"><SlidersHorizontal className="size-5" /></button></Dropdown.Trigger>
    <Dropdown.Portal><Dropdown.Content align="end" side="top" sideOffset={8} collisionPadding={12} className="z-[250] min-w-44 max-h-[65dvh] overflow-y-auto overscroll-contain rounded-xl border border-edge bg-surface-2 p-1.5 text-ink shadow-xl">
      <Dropdown.Label className="px-3 py-2 text-xs text-ink-mute">{t('post.video.speed')}</Dropdown.Label>
      <Dropdown.RadioGroup value={String(speed)} onValueChange={value=>onSpeed(Number(value))}>
        {speeds.map(value=><Dropdown.RadioItem key={value} value={String(value)} className={item}>
          <Dropdown.ItemIndicator className="absolute start-2"><Check className="size-4" /></Dropdown.ItemIndicator>{value}×
        </Dropdown.RadioItem>)}
      </Dropdown.RadioGroup>
      {qualities.length > 1 && <>
        <Dropdown.Separator className="my-1 h-px bg-edge" />
        <Dropdown.Label className="px-3 py-2 text-xs text-ink-mute">{t('post.video.quality')}</Dropdown.Label>
        <Dropdown.RadioGroup value={String(qualityIndex)} onValueChange={value=>onQuality(Number(value))}>
          {qualities.map((quality,index)=>{
            const label=qualityLabel(quality,index);
            const name=label.kind==='text' ? label.text : label.kind==='bitrate' ? t('post.video.quality.bitrate',{kbps:label.kbps}) : t('post.video.quality.best');
            return <Dropdown.RadioItem key={quality.url} value={String(index)} className={item}><Dropdown.ItemIndicator className="absolute start-2"><Check className="size-4" /></Dropdown.ItemIndicator>{name}</Dropdown.RadioItem>;
          })}
        </Dropdown.RadioGroup>
      </>}
      <Dropdown.Separator className="my-1 h-px bg-edge" />
      <Dropdown.CheckboxItem checked={loop} onCheckedChange={onLoop} className={item}><Dropdown.ItemIndicator className="absolute start-2"><Check className="size-4" /></Dropdown.ItemIndicator>{t('post.video.loop')}</Dropdown.CheckboxItem>
    </Dropdown.Content></Dropdown.Portal>
  </Dropdown.Root>;
}
