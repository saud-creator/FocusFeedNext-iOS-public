export interface NativeFault { code: string; stage: string; retryable: boolean; httpStatus?: number | null; nativeErrorCode?: number; nativeErrorDomain?: string }
export class NativeFetchError extends Error {
  readonly fault: NativeFault;
  constructor(fault: NativeFault) { super(fault.code); this.fault = fault; }
}
interface NativeResponse { status: number; text: string; headers: Record<string, string>; fault?: NativeFault }
interface Bridge { postMessage(message: Record<string, unknown>): Promise<NativeResponse> }
let sequence = 0;

export async function providerFetch(url: string, init: RequestInit = {}, requestId?: string): Promise<Response> {
  const bridge = (globalThis as typeof globalThis & { webkit?: { messageHandlers?: { ffnHttp?: Bridge } } }).webkit?.messageHandlers?.ffnHttp;
  if (!bridge || requestId == null) return fetch(url, init);
  init.signal?.throwIfAborted();
  const jobId = String(++sequence);
  const supplied = new Headers(init.headers);
  const headers: Record<string,string> = {};
  for (const name of ['x-client-transaction-id','content-type']) {
    const value = supplied.get(name); if (value) headers[name] = value;
  }
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => {
      void bridge.postMessage({ action: 'cancel', requestId, jobId }).catch(() => {});
      reject(new DOMException('Request cancelled.', 'AbortError'));
    };
    init.signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([bridge.postMessage({ action: 'fetch', requestId, jobId, url, method: init.method ?? 'GET', headers, body: init.body ?? null }), cancelled]);
    if (result.fault) throw new NativeFetchError(result.fault);
    return new Response(result.text || null, { status: result.status, headers: result.headers });
  } finally { if (abort) init.signal?.removeEventListener('abort', abort); }
}
