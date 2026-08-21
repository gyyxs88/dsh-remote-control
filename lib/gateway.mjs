import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { DshRemoteError, TimeoutError } from './errors.mjs';

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

async function readJson(request, maxBytes = 1_048_576) {
  let total = 0;
  let body = '';
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new DshRemoteError('gateway request is too large', { code: 'GATEWAY_REQUEST_TOO_LARGE' });
    body += chunk;
  }
  try { return JSON.parse(body || '{}'); } catch { throw new DshRemoteError('gateway request JSON is invalid', { code: 'GATEWAY_REQUEST_INVALID' }); }
}

export class ModelGateway {
  constructor({ provider, hostTokenTtlMs = 15 * 60_000 } = {}) {
    if (!provider || typeof provider.listModels !== 'function' || typeof provider.generate !== 'function') throw new DshRemoteError('ModelGateway requires an injected provider adapter', { code: 'GATEWAY_PROVIDER_REQUIRED' });
    if (!Number.isInteger(hostTokenTtlMs) || hostTokenTtlMs < 1 || hostTokenTtlMs > 15 * 60_000) throw new DshRemoteError('Gateway token TTL is invalid', { code: 'GATEWAY_TOKEN_TTL_INVALID' });
    this.provider = provider;
    this.hostTokenTtlMs = hostTokenTtlMs;
    this.tokens = new Map();
    this.server = null;
  }

  issueHostToken(hostId, { ttlMs = this.hostTokenTtlMs } = {}) {
    if (!hostId) throw new DshRemoteError('hostId is required for a gateway token', { code: 'GATEWAY_HOST_REQUIRED' });
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > this.hostTokenTtlMs) throw new DshRemoteError('Gateway token TTL is invalid', { code: 'GATEWAY_TOKEN_TTL_INVALID' });
    const token = `dshgw_${randomBytes(24).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.tokens.set(hashToken(token), { hostId, expiresAt });
    return { token, endpoint: null, expiresAt };
  }

  async listen({ host = '127.0.0.1', port = 0 } = {}) {
    if (host !== '127.0.0.1') throw new DshRemoteError('Model Gateway may only bind loopback', { code: 'GATEWAY_BIND_INVALID' });
    if (this.server) return this.address();
    this.server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen({ host, port }, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    return this.address();
  }

  address() {
    const address = this.server?.address();
    if (!address || typeof address === 'string') return null;
    return { host: address.address, port: address.port, endpoint: `http://${address.address}:${address.port}` };
  }

  async close() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
  }

  async #handle(request, response) {
    try {
      if (request.method === 'GET' && request.url === '/health') return jsonResponse(response, 200, { status: 'ok', bind: '127.0.0.1', gateway: 'dsh-model-gateway' });
      if (request.method === 'GET' && request.url === '/v1/models') {
        const auth = this.#authorize(request);
        const models = await this.provider.listModels({ hostId: auth.hostId });
        return jsonResponse(response, 200, { models });
      }
      if (request.method === 'POST' && request.url === '/v1/generate') {
        const auth = this.#authorize(request);
        const body = await readJson(request);
        if (typeof body.model !== 'string' || typeof body.prompt !== 'string') throw new DshRemoteError('model and prompt are required', { code: 'GATEWAY_REQUEST_INVALID' });
        const models = await this.provider.listModels({ hostId: auth.hostId });
        if (!models.includes(body.model)) throw new DshRemoteError('model is not in the local gateway model directory', { code: 'MODEL_NOT_ALLOWED', details: { model: body.model } });
        const result = await this.provider.generate({ ...body, hostId: auth.hostId });
        return jsonResponse(response, 200, { result, hostId: auth.hostId });
      }
      return jsonResponse(response, 404, { error: { code: 'NOT_FOUND', message: 'gateway endpoint not found' } });
    } catch (error) {
      const status = error?.code === 'GATEWAY_UNAUTHORIZED' ? 401 : error?.code === 'MODEL_NOT_ALLOWED' ? 403 : 400;
      return jsonResponse(response, status, { error: { code: error?.code ?? 'GATEWAY_ERROR', message: error?.message ?? String(error) } });
    }
  }

  #authorize(request) {
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    const entry = token ? this.tokens.get(hashToken(token)) : null;
    if (!entry || Date.parse(entry.expiresAt) <= Date.now()) throw new DshRemoteError('gateway token is missing or expired', { code: 'GATEWAY_UNAUTHORIZED' });
    return entry;
  }
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export class NoProviderAdapter {
  async listModels() {
    return [];
  }

  async generate() {
    throw new DshRemoteError('no provider adapter is configured; this process never reads credentials', { code: 'GATEWAY_PROVIDER_NOT_CONFIGURED' });
  }
}

export class RemoteGatewayModelAdapter {
  constructor({ endpoint, token, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(endpoint ?? '') || !/^dshgw_[A-Za-z0-9_-]{32,}$/.test(token ?? '')) throw new DshRemoteError('remote gateway adapter binding is invalid', { code: 'GATEWAY_ADAPTER_BINDING_INVALID' });
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new DshRemoteError('remote gateway timeout is invalid', { code: 'GATEWAY_TIMEOUT_INVALID' });
    this.endpoint = endpoint;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async listModels() {
    const response = await this.#request('/v1/models', { method: 'GET' });
    return response.models;
  }

  async generate({ model, prompt, ...options }) {
    const response = await this.#request('/v1/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, prompt, ...options }) });
    return response.result;
  }

  async #request(path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${this.token}` }, signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new DshRemoteError(body?.error?.message ?? 'remote gateway request failed', { code: body?.error?.code ?? 'GATEWAY_REQUEST_FAILED', details: body?.error });
      return body;
    } catch (error) {
      if (error?.name === 'AbortError') throw new TimeoutError('remote gateway request timed out', { path: `${this.endpoint}${path}` });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
