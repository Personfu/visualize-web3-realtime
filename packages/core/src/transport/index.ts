export const EXECUTOR_WS_PROTOCOL = 'web3viz.v1';
export const EXECUTOR_AUTH_PROTOCOL_PREFIX = 'web3viz.auth.';

export function executorProtocols(token?: string): string[] {
  if (token === undefined) return [];
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Invalid executor access token');
  return [EXECUTOR_WS_PROTOCOL, EXECUTOR_AUTH_PROTOCOL_PREFIX + token];
}

const PUBLIC_STREAM = 'wss://api.speraxos.io/agents/v1/stream';
const REVIEWED_VIEWER_ENDPOINTS = [
  'ws://localhost:8765/',
  'ws://127.0.0.1:8765/',
  'ws://[::1]:8765/',
  PUBLIC_STREAM,
] as const;

export function validateViewerUrl(value: string, authenticated = false): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback))) {
    throw new Error('Invalid viewer connection URL');
  }
  // Return a reviewed constant, never the caller-controlled destination. Adding a
  // private production endpoint requires source review before viewer credentials.
  const endpoint = REVIEWED_VIEWER_ENDPOINTS.find(candidate => candidate === url.href);
  if (!endpoint || (authenticated && endpoint === PUBLIC_STREAM)) {
    throw new Error('Viewer destination requires operator review');
  }
  return endpoint;
}
