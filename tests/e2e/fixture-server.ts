import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

/**
 * Deterministic HTTPS fixture server for the extension E2E suite (plan Task
 * 12 Step 2).
 *
 * The extension's manifest restricts content scripts and host permissions to
 * exactly `https://fomo.family`, `https://www.fomo.family`,
 * `https://dexscreener.com` and `https://gmgn.ai`, and the runtime guards in
 * src/messaging/guards.ts compare `window.location.origin` against the exact
 * strings `https://fomo.family` / `https://www.fomo.family`. A page origin
 * NEVER contains a non-default port, so a plain local HTTPS server on an
 * unprivileged port can never satisfy those guards.
 *
 * This server solves that cleanly WITHOUT touching the production manifest
 * or the guard catalog (spec section 9): Chromium is launched with
 * `--proxy-server=127.0.0.1:<port>`, so a request to
 * `https://fomo.family/fomo-page.html` is sent to this server as a
 * `CONNECT fomo.family:443` tunnel. The server terminates TLS with a
 * throwaway self-signed certificate (SANs for every supported host) and
 * serves the fixture files over the tunnel. Chromium still believes it is
 * talking to `fomo.family:443`, so `window.origin` is exactly
 * `https://fomo.family` and every content script, origin guard, and match
 * pattern behaves exactly as in production. `--ignore-certificate-errors`
 * (test-only launch flag) accepts the self-signed certificate.
 *
 * The certificate is generated at server start with openssl into a
 * per-process temp directory and deleted on close; it is a throwaway test
 * artifact and must never be used anywhere else.
 */

export const FIXTURE_HOSTS = [
  'fomo.family',
  'www.fomo.family',
  'dexscreener.com',
  'gmgn.ai',
  // The authenticated history endpoint lives on the production API host
  // (src/fomo/history-contract.ts FOMO_HISTORY_BASE_URL). The fixture serves
  // /v2/activities/me on ANY of these hosts, so the E2E suite can reach it at
  // its real origin once the recovery evidence gate is lifted.
  'prod-api.fomo.family',
  'translate.googleapis.com',
] as const;

const TRANSLATED_THESIS_FIXTURE = '轮动进入 L1 板块';

const CERT_CNF = [
  '[req]',
  'distinguished_name = dn',
  'prompt = no',
  'req_extensions = v3_req',
  'x509_extensions = v3_req',
  '[dn]',
  'CN = fomo.family',
  '[v3_req]',
  'subjectAltName = @alt_names',
  'basicConstraints = CA:FALSE',
  'keyUsage = digitalSignature, keyEncipherment',
  'extendedKeyUsage = serverAuth',
  '[alt_names]',
  'DNS.1 = fomo.family',
  'DNS.2 = www.fomo.family',
  'DNS.3 = dexscreener.com',
  'DNS.4 = gmgn.ai',
  'DNS.5 = prod-api.fomo.family',
  'DNS.6 = localhost',
  'DNS.7 = translate.googleapis.com',
  'IP.1 = 127.0.0.1',
  '',
].join('\n');

interface GeneratedCert {
  certPem: string;
  keyPem: string;
  cleanup(): void;
}

function generateCert(): GeneratedCert {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fomo-e2e-cert-'));

  try {
    const cnfPath = path.join(dir, 'server.cnf');
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');

    writeFileSync(cnfPath, CERT_CNF, 'utf8');

    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '30',
      '-config',
      cnfPath,
    ], { stdio: 'ignore' });

    return {
      certPem: readFileSync(certPath, 'utf8'),
      keyPem: readFileSync(keyPath, 'utf8'),
      cleanup: () => {
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveFixture(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  fixturesDir: string,
): void {
  const requestUrl = new URL(req.url ?? '/', 'https://fixture.invalid');

  if (requestUrl.pathname === '/') {
    res.writeHead(302, { Location: '/fomo-page.html' });
    res.end();
    return;
  }

  if (requestUrl.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Only the fixture files are ever served; the URL path is resolved
  // strictly inside fixturesDir.
  const relative = requestUrl.pathname.replace(/^\/+/, '');
  const filePath = path.resolve(fixturesDir, relative);

  if (!filePath.startsWith(path.resolve(fixturesDir) + path.sep)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }

  let body: Buffer | null = null;

  try {
    body = readFileSync(filePath);
  } catch {
    res.writeHead(404);
    res.end('not found');
    return;
  }

  const contentType =
    CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Authenticated history fixture (GET /v2/activities/me)
// ---------------------------------------------------------------------------

/**
 * Failure-mode controls for the fixture history endpoint. `ok` serves the
 * queued server-only events; the other modes simulate the failures the
 * production adapter maps to ActivitySyncState outcomes (401/403 -> auth ->
 * login-required, 429 -> server -> failed/retryable, malformed -> failed/
 * permanent, delay -> slow network). The modes can be selected per request
 * with `?status=` (contract tests) or set server-side through the control
 * (recovery tests).
 */
export type HistoryServerMode = 'ok' | '401' | '403' | '429' | 'malformed';

const HISTORY_MODES: readonly string[] = ['ok', '401', '403', '429', 'malformed'];

/** Max accepted page size; mirrors src/fomo/history-contract.ts bounds. */
const HISTORY_MAX_LIMIT = 200;

interface HistoryFixtureState {
  events: unknown[];
  mode: HistoryServerMode;
  delayMs: number;
}

/**
 * Test-side control over the fixture history queue. Events added here are
 * "server-only": they are served by GET /v2/activities/me but are NEVER
 * emitted through the fixture WebSocket, so they can only reach the extension
 * through a recovery backfill.
 */
export interface HistoryFixtureControl {
  /** Replaces the server-only history queue. */
  setEvents(events: readonly unknown[]): void;
  /** Appends one server-only event (never emitted via WebSocket). */
  add(event: unknown): void;
  /** Empties the queue. */
  clear(): void;
  /** Sets the default response mode; per-request ?status= overrides it. */
  setMode(mode: HistoryServerMode): void;
  /** Sets a response delay in milliseconds (0 = none). */
  setDelayMs(ms: number): void;
  /** Current queue and mode, for assertions. */
  snapshot(): { events: unknown[]; mode: HistoryServerMode; delayMs: number };
}

const readActivityTimestamp = (event: unknown): number => {
  if (typeof event === 'object' && event !== null) {
    const createdAt = (event as { createdAt?: unknown }).createdAt;
    if (typeof createdAt === 'string') {
      const parsed = Date.parse(createdAt);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return 0;
};

/**
 * Serves one GET /v2/activities/me request. Pages arrive NEWEST-FIRST (the
 * contract's ordering) with an opaque `page:<offset>` cursor; `limit` is
 * clamped to [1, 200] with a default of 50. `?status=` selects a failure
 * mode for that request and `?delayMs=` holds the response (network delay).
 * The envelope matches src/fomo/history-contract.ts historyPageSchema so a
 * future enabled adapter can parse it unchanged.
 */
async function serveHistoryEndpoint(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  state: HistoryFixtureState,
): Promise<void> {
  const requestUrl = new URL(req.url ?? '/', 'https://fixture.invalid');

  const requestedStatus = requestUrl.searchParams.get('status') ?? '';
  const mode: HistoryServerMode = HISTORY_MODES.includes(requestedStatus)
    ? (requestedStatus as HistoryServerMode)
    : state.mode;

  const requestedDelay = Number(requestUrl.searchParams.get('delayMs') ?? '');
  const delayMs =
    Number.isFinite(requestedDelay) && requestedDelay > 0 ? requestedDelay : state.delayMs;

  if (delayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  const respondJson = (status: number, body: unknown): void => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };

  switch (mode) {
    case '401':
      respondJson(401, { error: 'unauthorized' });
      return;
    case '403':
      respondJson(403, { error: 'forbidden' });
      return;
    case '429':
      respondJson(429, { error: 'rate_limited' });
      return;
    case 'malformed':
      // A page whose single activity fails the shared raw activity schema:
      // parseHistoryPage rejects the whole page -> 'malformed'.
      respondJson(200, {
        responseObject: { activities: [{ id: '' }], nextCursor: null, hasMore: false },
      });
      return;
    default:
      break;
  }

  const rawLimit = Number(requestUrl.searchParams.get('limit') ?? '50');
  const limit =
    Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= HISTORY_MAX_LIMIT
      ? rawLimit
      : 50;

  const cursor = requestUrl.searchParams.get('cursor');
  let offset = 0;

  if (cursor !== null && cursor.length > 0) {
    const match = /^page:(\d+)$/u.exec(cursor);

    if (match === null) {
      respondJson(400, { error: 'invalid cursor' });
      return;
    }

    offset = Number(match[1]);
  }

  const sorted = [...state.events].sort((a, b) => {
    const byTime = readActivityTimestamp(b) - readActivityTimestamp(a);

    if (byTime !== 0) {
      return byTime;
    }

    return String((a as { id?: unknown }).id).localeCompare(
      String((b as { id?: unknown }).id),
    );
  });

  const page = sorted.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  const nextCursor = nextOffset < sorted.length ? `page:${nextOffset}` : null;

  respondJson(200, {
    responseObject: {
      activities: page,
      nextCursor,
      hasMore: nextCursor !== null,
    },
    note: 'fixture history endpoint',
  });
}

export interface FixtureServer {
  readonly port: number;
  /** Server-only authenticated-history queue for recovery fixtures. */
  readonly history: HistoryFixtureControl;
  close(): Promise<void>;
}

/**
 * Starts the CONNECT-proxy HTTPS fixture server on a random free loopback
 * port. In addition to activity frames, the browser fixture exposes explicit
 * socket-open/socket-close controls so connection and health UI transitions
 * remain deterministic. Resolves once the server is listening.
 */
export async function startFixtureServer(fixturesDir: string): Promise<FixtureServer> {
  const cert = generateCert();
  const secureContext = tls.createSecureContext({
    cert: cert.certPem,
    key: cert.keyPem,
  });

  const historyState: HistoryFixtureState = {
    events: [],
    mode: 'ok',
    delayMs: 0,
  };

  const history: HistoryFixtureControl = {
    setEvents: (events) => {
      historyState.events = [...events];
    },
    add: (event) => {
      historyState.events.push(event);
    },
    clear: () => {
      historyState.events = [];
    },
    setMode: (mode) => {
      historyState.mode = mode;
    },
    setDelayMs: (ms) => {
      historyState.delayMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
    },
    snapshot: () => ({
      events: [...historyState.events],
      mode: historyState.mode,
      delayMs: historyState.delayMs,
    }),
  };

  // The request handler runs over the TLS tunnels established by the
  // CONNECT proxy below; it is a plain HTTP server fed raw sockets.
  const app = createHttpServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'https://fixture.invalid');

    if (requestUrl.pathname === '/translate_a/single') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify([[[TRANSLATED_THESIS_FIXTURE, '', null, null, 1]]]));
      return;
    }

    if (requestUrl.pathname === '/v2/activities/me') {
      void serveHistoryEndpoint(req, res, historyState).catch(() => {
        // A dropped tunnel must not crash the server; the browser side
        // handles the failed request itself.
      });
      return;
    }

    serveFixture(req, res, fixturesDir);
  });

  // Plain (non-CONNECT) requests are unexpected: every supported fixture URL
  // is https. Reject them loudly instead of serving plaintext.
  const proxy = createHttpServer((req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('fixture server expects HTTPS CONNECT tunnels only');
  });

  proxy.on('connect', (req, clientSocket, head) => {
    const hostPort = req.url ?? '';
    const host = hostPort.split(':')[0] ?? '';

    if (!(FIXTURE_HOSTS as readonly string[]).includes(host)) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext,
      SNICallback: (_servername, callback) => {
        callback(null, secureContext);
      },
    });

    tlsSocket.on('error', () => {
      // A dropped tunnel must not crash the server; the browser side
      // handles the failed request itself.
    });

    tlsSocket.on('secure', () => {
      if (head.length > 0) {
        tlsSocket.unshift(head);
      }

      app.emit('connection', tlsSocket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', () => {
      proxy.removeListener('error', reject);
      resolve();
    });
  });

  const address = proxy.address();

  if (address === null || typeof address === 'string') {
    throw new Error('fixture server failed to bind a TCP port');
  }

  return {
    port: address.port,
    history,
    close: async (): Promise<void> => {
      cert.cleanup();

      await new Promise<void>((resolve) => {
        proxy.close(() => resolve());
      });

      // The TLS tunnels belong to `proxy`'s sockets, so closing the proxy
      // closes them; `app` never bound a port of its own.
      await new Promise<void>((resolve) => {
        app.close(() => resolve());
      });
    },
  };
}
