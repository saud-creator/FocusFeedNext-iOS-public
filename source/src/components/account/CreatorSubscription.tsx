import { useState } from 'react';
import { api } from '@/lib/api';
import { usePlatform } from '@/lib/platform';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';

export function CreatorSubscription({ username }: { username:string }) {
  const { isIphone } = usePlatform();
  const { t } = useI18n();
  const [failed,setFailed] = useState(false);
  if (!isIphone) return null;
  return <div className="space-y-2">
    <Button variant="secondary" size="sm" onClick={() => { setFailed(false); void api.openCreatorSubscription(username).catch(() => setFailed(true)); }}>{t('account.subscription.open')}</Button>
    <p className="text-xs text-ink-mute max-w-64">{t('account.subscription.description')}</p>
    {failed && <p role="alert" className="text-sm text-bad">{t('account.subscription.failed')}</p>}
  </div>;
}
