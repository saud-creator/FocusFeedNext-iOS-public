import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IosWelcome } from './IosConnection';
import { api } from '@/lib/api';
import { renderWithProviders } from '@/test/factories';
describe('native iPhone sign-in', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('requests native sign-in without asking for password or cookie fields', async () => {
    vi.spyOn(api, 'sessionStatus').mockResolvedValue({ hasCredentials: false, checking: false } as Awaited<ReturnType<typeof api.sessionStatus>>);
    const signIn = vi.spyOn(api, 'signInIos').mockRejectedValue(new Error('Sign-in was cancelled.'));
    renderWithProviders(<IosWelcome />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Twitter' }));
    expect(signIn).toHaveBeenCalledExactlyOnceWith();
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in was cancelled.');
    expect(screen.getByRole('button', { name: 'Sign in with Twitter' })).toBeEnabled();
  });
  it('localizes a bootstrap failure and keeps technical details in diagnostics',async()=>{
    vi.spyOn(api,'sessionStatus').mockResolvedValue({hasCredentials:false,checking:false} as Awaited<ReturnType<typeof api.sessionStatus>>);
    vi.spyOn(api,'signInIos').mockRejectedValue({code:'schema_changed',message:'safe fallback',nativeConnectionFault:{code:'transaction_bootstrap',stage:'bootstrap',requestId:'12',retryable:true}});
    renderWithProviders(<IosWelcome/>);
    await userEvent.click(screen.getByRole('button',{name:'Sign in with Twitter'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('connection metadata could not be read');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Request 12');
    expect(screen.getByRole('button',{name:'Retry sign-in'})).toBeEnabled();
  });
  it('makes a diagnostic file available before any account can sign in',async()=>{
    vi.spyOn(api,'sessionStatus').mockResolvedValue({hasCredentials:false,checking:false} as Awaited<ReturnType<typeof api.sessionStatus>>);
    const report = vi.spyOn(api,'diagnosticsReport').mockResolvedValue('{"schema":1,"events":[{"stage":"identity","status":403}]}');
    const share = vi.spyOn(api,'shareConnectionReport').mockResolvedValue();
    renderWithProviders(<IosWelcome/>);
    await userEvent.click(screen.getByRole('button',{name:'View sign-in diagnostics'}));
    expect(await screen.findByRole('textbox',{name:'Sign-in diagnostic report'})).toHaveValue('{"schema":1,"events":[{"stage":"identity","status":403}]}');
    expect(report).toHaveBeenCalledExactlyOnceWith();
    await userEvent.click(screen.getByRole('button',{name:'Share diagnostic file'}));
    expect(share).toHaveBeenCalledExactlyOnceWith();
  });
  it('shows clear rate-limit recovery without automatically retrying',async()=>{
    vi.spyOn(api,'sessionStatus').mockResolvedValue({hasCredentials:false,checking:false} as Awaited<ReturnType<typeof api.sessionStatus>>);
    const login = vi.spyOn(api,'signInIos').mockRejectedValue({code:'rate_limited',message:'safe',nativeConnectionFault:{code:'rate_limited',stage:'identity',retryable:false,httpStatus:429}});
    renderWithProviders(<IosWelcome/>);
    await userEvent.click(screen.getByRole('button',{name:'Sign in with Twitter'}));
    expect(await screen.findByRole('alert')).not.toHaveTextContent('HTTP 429');
    expect(screen.getByRole('alert')).toHaveTextContent('Wait before checking again');
    expect(login).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button',{name:'Retry sign-in'})).not.toBeInTheDocument();
  });
});
