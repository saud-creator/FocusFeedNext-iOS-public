import { useRef, useState } from 'react';
import { Gauge, ArrowUp, ArrowDown, Download, Upload } from 'lucide-react';
import { useAppStore, commitPortablePreferences } from '@/stores/useAppStore';
import { useI18n } from '@/i18n';
import { usePlatform } from '@/lib/platform';
import { useEffectivePolicy } from '@/lib/runtime';
import { mobileTabIds, type MobileTabId } from '@/lib/navigation';
import { api, isTauri } from '@/lib/api';
import { exportPreferenceBundle, parsePreferenceBundle } from '@/lib/preferenceBundle';
import { SettingsSection, SettingRow } from './SettingsSection';
import { Select, Switch } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
const labels: Record<MobileTabId,string> = { following:'nav.followingFeed',focus:'nav.focus',bookmarks:'nav.bookmarks',accounts:'nav.peopleYouFollow',originals:'nav.originals',groups:'nav.groups',search:'localSearch.title' };

export function PerformanceSection() {
  const { t } = useI18n();
  const { isIphone } = usePlatform();
  const prefs = useAppStore(s => s.prefs);
  const draft = useAppStore(s => s.draft);
  const setDraft = useAppStore(s => s.setDraft);
  const current = draft ?? prefs;
  const policy = useEffectivePolicy(isIphone);
  const file = useRef<HTMLInputElement>(null);
  const [message,setMessage] = useState('');
  const move = (index: number,direction: number) => {
    const tabs = [...current.mobileTabs]; const target = index+direction;
    if (target < 0 || target >= tabs.length) return;
    [tabs[index],tabs[target]] = [tabs[target],tabs[index]]; setDraft('mobileTabs',tabs);
  };
  const exportFile = async () => {
    setMessage('');
    const bundle = exportPreferenceBundle(prefs);
    if (isIphone && isTauri()) { await api.sharePreferences(bundle.preferences); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)],{ type:'application/json' }));
    const a = document.createElement('a'); a.href=url; a.download='FocusFeedNext-preferences.json'; a.click(); window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const importFile = async (selected?: File) => {
    if (!selected) return;
    try {
      if (selected.size > 32768) throw new Error();
      const bundle = parsePreferenceBundle(await selected.text(),prefs);
      // Native validation and transaction happen before either UI layer changes.
      await commitPortablePreferences(bundle.preferences);
      setMessage(t('performance.imported'));
    } catch { setMessage(t('performance.importFailed')); }
    if (file.current) file.current.value='';
  };
  return <SettingsSection title={t('performance.title')} description={t('performance.description')} icon={<Gauge className="size-4" />} keys={['performanceMode','readingSize','haptics','autoplay','mobileTabs']}>
    <div className="py-3 text-sm text-ink-dim" role="status">{t('performance.effective')}: {t(`performance.${policy.mode}`)} · {t(`performance.reason.${policy.reason}`)}</div>
    <SettingRow label={t('performance.mode')} control={<Select value={current.performanceMode} onChange={e => setDraft('performanceMode',e.target.value as typeof current.performanceMode)}>{['balanced','fast','ultra','battery'].map(mode => <option key={mode} value={mode}>{t(`performance.${mode}`)}</option>)}</Select>} />
    {current.performanceMode === 'ultra' && <p className="py-2 text-xs text-ink-mute">{t('performance.ultra.description')}</p>}
    <SettingRow label={t('performance.readingSize')} control={<Select value={current.readingSize} onChange={e => setDraft('readingSize',Number(e.target.value))}>{[80,90,100,110,120,140,160].map(size => <option key={size} value={size}>{size}%</option>)}</Select>} />
    <SettingRow label={t('performance.autoplay')} control={<Select value={current.autoplay} onChange={e => setDraft('autoplay',e.target.value as typeof current.autoplay)}>{['off','wifi','any'].map(value => <option key={value} value={value}>{t(`performance.autoplay.${value}`)}</option>)}</Select>} />
    <SettingRow label={t('performance.haptics')} control={<Switch checked={current.haptics} onCheckedChange={value => setDraft('haptics',value)} />} />
    {isIphone && <div className="py-4 space-y-2"><p className="mb-3 text-sm font-medium">{t('performance.navigation')}</p>{current.mobileTabs.map((tab,index) => <div key={index} className="flex items-center gap-2"><Select aria-label={`${t('performance.tab')} ${index+1}`} value={tab} onChange={e => { const tabs=[...current.mobileTabs]; const next=e.target.value as MobileTabId; const previous=tabs.indexOf(next); if (previous>=0) tabs[previous]=tab; tabs[index]=next; setDraft('mobileTabs',tabs); }}>{mobileTabIds.map(id => <option key={id} value={id}>{t(labels[id])}</option>)}</Select><Button variant="ghost" size="sm" disabled={index===0} aria-label={t('performance.moveUp')} onClick={() => move(index,-1)}><ArrowUp className="size-4" /></Button><Button variant="ghost" size="sm" disabled={index===3} aria-label={t('performance.moveDown')} onClick={() => move(index,1)}><ArrowDown className="size-4" /></Button></div>)}</div>}
    <div className="flex flex-wrap gap-2 py-4"><Button variant="secondary" size="sm" onClick={() => void exportFile().catch(() => setMessage(t('performance.importFailed')))}><Download className="size-4" />{t('performance.export')}</Button><Button variant="secondary" size="sm" onClick={() => file.current?.click()}><Upload className="size-4" />{t('performance.import')}</Button><input ref={file} type="file" accept="application/json,.json" className="hidden" aria-label={t('performance.import')} onChange={event => void importFile(event.target.files?.[0])} />{message && <p role="status" className="w-full text-sm text-ink-dim">{message}</p>}</div>
  </SettingsSection>;
}
