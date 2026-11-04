import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EXECUTOR_WS_PROTOCOL, EXECUTOR_AUTH_PROTOCOL_PREFIX } from '@web3viz/core/transport';

const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const PROTOCOL = EXECUTOR_WS_PROTOCOL;
const AUTH_PROTOCOL = EXECUTOR_AUTH_PROTOCOL_PREFIX;

function origin(value: string): string {
  try {
    const parsed = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.origin !== value || parsed.username || parsed.password ||
        (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))) {
      throw new Error();
    }
    return parsed.origin;
  } catch {
    throw new Error('Invalid executor origin configuration');
  }
}

export class ExecutorAccess {
  private readonly digest: Buffer;
  private readonly viewerDigest?: Buffer;
  private readonly origins: Set<string>;

  constructor(token: string, allowedOrigins: readonly string[] = [], viewerToken?: string) {
    if (typeof token !== 'string' || !TOKEN.test(token)) {
      throw new Error('A configured executor access token is required');
    }
    this.digest = createHash('sha256').update(token).digest();
    if (viewerToken !== undefined) {
      if (!TOKEN.test(viewerToken) || viewerToken === token) throw new Error('A separate bounded viewer token is required');
      this.viewerDigest = createHash('sha256').update(viewerToken).digest();
    }
    this.origins = new Set(allowedOrigins.map(origin));
  }

  private matches(token: string | undefined, viewer = false): boolean {
    const digest = viewer ? this.viewerDigest : this.digest;
    return typeof token === 'string' && TOKEN.test(token) &&
      digest !== undefined && timingSafeEqual(digest, createHash('sha256').update(token).digest());
  }

  private safeTarget(request: IncomingMessage): boolean {
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) return false;
    try {
      const url = new URL(request.url, 'http://executor.invalid');
      return url.origin === 'http://executor.invalid' && !url.search && !url.hash;
    } catch {
      return false;
    }
  }

  allowsOrigin(request: IncomingMessage): boolean {
    const value = request.headers.origin;
    return value === undefined || this.origins.has(value);
  }

  private bearer(request: IncomingMessage): string | undefined {
    const count = request.rawHeaders.filter((_, index, values) => index % 2 === 0 && values[index].toLowerCase() === 'authorization').length;
    if (count !== 1) return undefined;
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(request.headers.authorization ?? '');
    return match?.[1];
  }

  authorizeHttp(request: IncomingMessage, response: ServerResponse): boolean {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Vary', 'Origin');
    if (!this.safeTarget(request) || !this.allowsOrigin(request)) {
      response.setHeader('Connection', 'close');
      response.writeHead(403).end(JSON.stringify({ error: 'Forbidden' }));
      return false;
    }
    if (request.headers.origin) response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
    if (request.method === 'OPTIONS') {
      if (!request.headers.origin) {
        response.writeHead(403).end(JSON.stringify({ error: 'Forbidden' }));
        return false;
      }
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.writeHead(204).end();
      return false;
    }
    const token = this.bearer(request);
    if (!(this.matches(token) || (request.method === 'GET' && this.matches(token, true)))) {
      response.setHeader('Connection', 'close');
      response.setHeader('WWW-Authenticate', 'Bearer realm="executor"');
      response.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
      return false;
    }
    return true;
  }

  authorizeWebSocket(request: IncomingMessage): boolean {
    if (!this.safeTarget(request) || !this.allowsOrigin(request)) return false;
    const protocols = (request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim());
    const credentials = protocols.filter(value => value.startsWith(AUTH_PROTOCOL));
    if (credentials.length) {
      return credentials.length === 1 && protocols.filter(value => value === PROTOCOL).length === 1 &&
        request.headers.authorization === undefined && this.matches(credentials[0].slice(AUTH_PROTOCOL.length), true);
    }
    const token = this.bearer(request);
    return this.matches(token) || this.matches(token, true);
  }
}

export const executorProtocol = PROTOCOL;
