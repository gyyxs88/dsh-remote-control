import { randomUUID } from 'node:crypto';
import { DshRemoteError } from './errors.mjs';

const SESSION_ID = /^session-[A-Za-z0-9-]{8,128}$/u;
const METHOD = /^[a-z][A-Za-z0-9.]{1,127}$/u;

function validateEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new DshRemoteError('DSH HTTP endpoint is invalid', { code: 'DSH_HTTP_ENDPOINT_INVALID' }); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash) throw new DshRemoteError('DSH HTTP client only accepts an explicit loopback endpoint', { code: 'DSH_HTTP_ENDPOINT_INVALID' });
  return url.origin;
}

export class DshHttpClient {
  constructor({ endpoint, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new DshRemoteError('DSH HTTP client configuration is invalid', { code: 'DSH_HTTP_CONFIG_INVALID' });
    this.endpoint = validateEndpoint(endpoint);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async waitUntilReady({ timeoutMs = 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'not started';
    while (Date.now() < deadline) {
      try {
        const response = await this.fetchImpl(`${this.endpoint}/`, { signal: AbortSignal.timeout(Math.min(2_000, this.timeoutMs)) });
        if (response.ok) return { ready: true };
        lastError = `HTTP ${response.status}`;
      } catch (error) { lastError = error.message; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new DshRemoteError('DSH loopback endpoint did not become ready', { code: 'DSH_HTTP_NOT_READY', details: { lastError } });
  }

  async call(method, payload = {}) {
    if (!METHOD.test(method ?? '') || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new DshRemoteError('DSH HTTP RPC request is invalid', { code: 'DSH_HTTP_REQUEST_INVALID' });
    const rpcId = randomUUID();
    const response = await this.fetchImpl(`${this.endpoint}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new DshRemoteError('DSH HTTP RPC transport failed', { code: 'DSH_HTTP_TRANSPORT_FAILED', details: { method, status: response.status } });
    const body = await response.json();
    if (body?.type !== 'server-response' || body.rpcId !== rpcId || !body.result || typeof body.result.ok !== 'boolean') throw new DshRemoteError('DSH HTTP RPC response is invalid', { code: 'DSH_HTTP_RESPONSE_INVALID', details: { method } });
    if (!body.result.ok) throw new DshRemoteError(body.result.error?.message ?? `DSH RPC ${method} failed`, { code: body.result.error?.code ?? 'DSH_HTTP_RPC_FAILED', details: { method, error: body.result.error } });
    return body.result.value;
  }

  async ensureController({ workspacePath, sessionId, agentPreset } = {}) {
    if (typeof workspacePath !== 'string' || !workspacePath.startsWith('/') || workspacePath.includes('\0') || workspacePath.split('/').includes('..') || !SESSION_ID.test(sessionId ?? '')) throw new DshRemoteError('controller Workspace or Session identity is invalid', { code: 'DSH_CONTROLLER_IDENTITY_INVALID' });
    const workspaceResult = await this.call('workspace.create', { path: workspacePath });
    const workspace = workspaceResult?.workspace;
    if (!workspace?.workspaceId || workspace.path !== workspacePath || !Array.isArray(workspace.sessionIds)) throw new DshRemoteError('DSH did not return the requested controller Workspace', { code: 'DSH_CONTROLLER_WORKSPACE_INVALID' });
    if (!workspace.sessionIds.includes(sessionId)) {
      try {
        const created = await this.call('session.create', { workspaceId: workspace.workspaceId, sessionId, ...(agentPreset ? { agentPreset } : {}) });
        if (created?.sessionId !== sessionId) throw new DshRemoteError('DSH created a different controller Session', { code: 'DSH_CONTROLLER_SESSION_INVALID' });
      } catch (error) {
        const listed = await this.call('workspace.list', {});
        const durable = listed?.items?.find((entry) => entry.workspaceId === workspace.workspaceId);
        if (!durable?.sessionIds?.includes(sessionId)) throw error;
      }
    }
    return { workspaceId: workspace.workspaceId, sessionId, workspacePath };
  }

  async warmController(sessionId, title = 'DSH Remote Controller') {
    if (!SESSION_ID.test(sessionId ?? '')) throw new DshRemoteError('controller Session identity is invalid', { code: 'DSH_CONTROLLER_IDENTITY_INVALID' });
    if (typeof title !== 'string' || title.trim().length === 0 || title.length > 120) throw new DshRemoteError('controller title is invalid', { code: 'DSH_CONTROLLER_IDENTITY_INVALID' });
    const result = await this.call('session.rename', { sessionId, title: title.trim() });
    if (result?.title !== title.trim() || !Number.isSafeInteger(result.seq)) throw new DshRemoteError('DSH controller warmup did not resolve a live Agent', { code: 'DSH_CONTROLLER_WARMUP_FAILED' });
    return { warmed: true, sessionId, title: result.title, seq: result.seq };
  }
}
