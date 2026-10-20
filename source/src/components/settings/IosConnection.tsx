import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ClipboardCopy, LoaderCircle, LogOut, Share2, ShieldCheck, SlidersHorizontal, Sparkles } from 'lucide-react';
import { api, isTauri, toAppError, type SessionSnapshot } from '@/lib/api';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { resetFeedSessionState } from '@/hooks/useFeed';
import { acceptConnectedSession, acceptSessionSnapshot } from '@/hooks/useStartupSequence';
import { useAccountActionStore } from '@/components/account/accountActions';
import { useAppStore } from '@/stores/useAppStore';
import { Avatar } from '@/components/account/Avatar';

function useIosAccount() {
  const qc = useQueryClient();
  const owner=useRef({mounted:true,generation:0});
  const pending=useRef<Promise<SessionSnapshot>|null>(null);
  useEffect(()=>{const state=owner.current;state.mounted=true;return()=>{state.mounted=false;state.generation++;};},[]);
  const session = useQuery({ queryKey: ['sessionStatus'], queryFn: api.sessionStatus });
  const accept = (snapshot: SessionSnapshot) => {
    resetFeedSessionState();
    void qc.resetQueries({ predicate: q => q.queryKey[0] !== 'sessionStatus' });
    useAccountActionStore.getState().reset();
    if (snapshot.account) acceptConnectedSession(snapshot);
    else acceptSessionSnapshot(snapshot);
    qc.setQueryData(['sessionStatus'], snapshot);
  };
  const signIn = useMutation({ mutationFn: async () => {
    const generation=owner.current.generation;
    if(!pending.current) pending.current=api.signInIos().finally(()=>{pending.current=null;});
    return {snapshot:await pending.current,generation};
  }, retry: false, onMutate: () => setStage('login'), onSuccess: ({snapshot,generation}) => {
    if(owner.current.mounted && owner.current.generation===generation) accept(snapshot);
  } });
  const signOut = useMutation({ mutationFn: () => api.disconnect(), onSuccess: accept });
  const [stage,setStage] = useState('login');
  useEffect(() => {
    const update = (event: Event) => {
      const value = (event as CustomEvent<string>).detail;
      if (['login','cookies','transport','bootstrap','identity','storage','connected'].includes(value)) setStage(value);
    };
    window.addEventListener('ffn-connection-stage',update);
    return () => window.removeEventListener('ffn-connection-stage',update);
  },[]);
  return { session: session.data, signIn, signOut, stage };
}

export function ConnectionError({ error }: { error: unknown }) {
  const { t } = useI18n();
  const value = toAppError(error);
  const fault = value.nativeConnectionFault;
  return <p role="alert" className="text-sm text-bad">
    {fault ? t(`ios.error.${fault.code}`) : value.message}
  </p>;
}

export function ConnectionReport({ busy = false }: { busy?: boolean }) {
  const { t } = useI18n();
  const [report, setReport] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const generate = useMutation({ mutationFn: () => api.diagnosticsReport(), retry: false, onSuccess: value => { setReport(value); setCopied(false); setCopyFailed(false); } });
  const share = useMutation({ mutationFn: () => api.shareConnectionReport(), retry: false });
  const copy = async () => {
    try { await navigator.clipboard.writeText(report); setCopied(true); setCopyFailed(false); }
    catch { setCopyFailed(true); }
  };
  return <div className="space-y-2 text-xs text-ink-mute">
    <p>{t('ios.report.hint')}</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={busy || generate.isPending} onClick={() => generate.mutate()}>{t('ios.report.generate')}</Button>
      <Button size="sm" variant="secondary" disabled={busy || share.isPending} onClick={() => share.mutate()}><Share2 />{t('ios.report.share')}</Button>
    </div>
    {(generate.isError || share.isError) && <p role="alert">{t('ios.report.failed')}</p>}
    {report && <>
      <textarea readOnly value={report} aria-label={t('ios.report.label')} dir="ltr" rows={8} className="w-full rounded-xl border border-edge bg-surface-2 p-3 text-xs font-mono" />
      <Button size="sm" variant="ghost" onClick={() => void copy()}><ClipboardCopy />{t(copied ? 'ios.report.copied' : 'ios.report.copy')}</Button>
      {copyFailed && <p role="alert">{t('ios.report.copyFailed')}</p>}
    </>}
  </div>;
}

function ConnectionMeasurements({ accountId }: { accountId?: string }) {
  const { t, formatNumber } = useI18n();
  const [open,setOpen] = useState(false);
  const query = useQuery({queryKey:['connectionMetrics',accountId],queryFn:api.connectionMetrics,enabled:open && Boolean(accountId),retry:false,staleTime:Infinity});
  const sample = query.data?.at(-1);
  const ms = (value:number) => t('ios.metrics.ms',{value:formatNumber(Math.round(value))});
  if (!accountId) return null;
  return <div className="text-xs text-ink-mute">
    <Button size="sm" variant="ghost" onClick={() => setOpen(value=>!value)} aria-expanded={open}>{t('ios.metrics.title')}</Button>
    {open && <div className="mt-2 space-y-2" role="status">
      <p>{t('ios.metrics.description')}</p>
      {sample ? <dl className="grid grid-cols-2 gap-2">
        <dt>{t('ios.metrics.queue')}</dt><dd>{ms(sample.queueMs)}</dd>
        <dt>{t('ios.metrics.bootstrap')}</dt><dd>{ms(sample.bootstrapMs + Math.max(0,sample.nativeMs-sample.totalMs))}</dd>
        <dt>{t('ios.metrics.provider')}</dt><dd>{ms(sample.providerMs)}</dd>
        <dt>{t('ios.metrics.parse')}</dt><dd>{ms(sample.parseMs)}</dd>
        <dt>{t('ios.metrics.total')}</dt><dd>{ms(sample.nativeMs)}</dd>
      </dl> : <p>{t(query.isError ? 'ios.metrics.failed' : 'ios.metrics.empty')}</p>}
      <Button size="sm" variant="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{t('ios.metrics.refresh')}</Button>
    </div>}
  </div>;
}

export function IosConnection() {
  const { t } = useI18n();
  const { session, signIn, signOut, stage } = useIosAccount();
  const busy = signIn.isPending || signOut.isPending;
  const error = signIn.error ?? signOut.error;
  return <Card>
    <CardHeader title={t('ios.account.title')} icon={<ShieldCheck className="size-4" />} />
    <CardBody className="space-y-4">
      <p className="text-sm text-ink-dim">{t('ios.account.description')}</p>
      <p className="text-xs text-ink-mute">{t('ios.signin.hint')}</p>
      {session?.account ? <div className="flex items-center gap-3">
        <Avatar author={session.account} size={48} />
        <div><p className="font-semibold">{session.account.displayName}</p><p className="text-sm text-ink-mute" dir="ltr">@{session.account.username}</p></div>
      </div> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => signIn.mutate()}>
          {signIn.isPending ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}
          {t(session?.account ? 'ios.account.switch' : 'ios.signin')}
        </Button>
        {session?.hasCredentials && <Button variant="secondary" disabled={busy} onClick={() => signOut.mutate()}><LogOut />{t('ios.signout')}</Button>}
      </div>
      {signIn.isPending && <p role="status" className="text-sm text-ink-dim">{t(`ios.stage.${stage}`)}</p>}
      {error && <ConnectionError error={error} />}
      <ConnectionReport busy={busy} />
      <ConnectionMeasurements accountId={session?.account?.id} />
      <p className="text-xs leading-relaxed text-ink-mute">{t('ios.account.privacy')}</p>
    </CardBody>
  </Card>;
}

export function IosWelcome() {
  const { t } = useI18n();
  const { session, signIn, stage } = useIosAccount();
  const setRoute = useAppStore(s => s.setRoute);
  useEffect(() => {
    if (isTauri()) void api.configureIosChrome(['','','','',''], 'following', true, false).catch(() => {});
  }, []);
  return <section className="ios-welcome">
    <div className="ios-welcome-orbit" aria-hidden="true"><Sparkles className="size-9" /></div>
    <div className="ios-eyebrow">{t('ios.welcome.eyebrow')}</div>
    <h1>{t('ios.welcome.title')}</h1>
    <p className="ios-welcome-description">{t('ios.welcome.description')}</p>
    <div className="ios-welcome-actions">
      <p className="text-sm text-ink-dim">{t('ios.signin.hint')}</p>
      <Button variant="primary" className="w-full min-h-14 rounded-2xl text-base" disabled={signIn.isPending || session?.checking} onClick={() => signIn.mutate()}>
        {signIn.isPending ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}
        {t(signIn.isPending ? 'ios.signingIn' : 'ios.signin')}
      </Button>
      <Button variant="ghost" className="w-full min-h-12" disabled={signIn.isPending} onClick={() => setRoute('settings')}><SlidersHorizontal />{t('nav.settings')}</Button>
      {signIn.isPending && <p role="status" className="text-sm text-ink-dim">{t(`ios.stage.${stage}`)}</p>}
      {signIn.error && <ConnectionError error={signIn.error} />}
      {signIn.error && toAppError(signIn.error).nativeConnectionFault?.retryable && <Button variant="secondary" disabled={signIn.isPending} onClick={() => signIn.mutate()}>{t('ios.connection.retry')}</Button>}
      <ConnectionReport busy={signIn.isPending} />
    </div>
    <div className="ios-welcome-privacy"><ShieldCheck className="size-4 shrink-0" /><p>{t('ios.account.privacy')}</p></div>
  </section>;
}
