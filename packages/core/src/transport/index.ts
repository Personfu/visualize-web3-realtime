export const EXECUTOR_WS_PROTOCOL = 'web3viz.v1';
export const EXECUTOR_AUTH_PROTOCOL_PREFIX = 'web3viz.auth.';

export function executorProtocols(token?: string): string[] {
  if (token === undefined) return [];
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Invalid executor access token');
  return [EXECUTOR_WS_PROTOCOL, EXECUTOR_AUTH_PROTOCOL_PREFIX + token];
}

export function validateViewerUrl(value: string): void {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback))) {
    throw new Error('Invalid viewer connection URL');
  }
}
