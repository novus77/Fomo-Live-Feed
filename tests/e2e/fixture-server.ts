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
] as const;

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
  'DNS.5 = localhost',
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

export interface FixtureServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Starts the CONNECT-proxy HTTPS fixture server on a random free loopback
 * port. Resolves once the server is listening.
 */
export async function startFixtureServer(fixturesDir: string): Promise<FixtureServer> {
  const cert = generateCert();
  const secureContext = tls.createSecureContext({
    cert: cert.certPem,
    key: cert.keyPem,
  });

  // The request handler runs over the TLS tunnels established by the
  // CONNECT proxy below; it is a plain HTTP server fed raw sockets.
  const app = createHttpServer((req, res) => {
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
