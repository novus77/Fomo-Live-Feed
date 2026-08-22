/**
 * Minimal ambient typings for the Node.js builtins used ONLY by the E2E
 * harness (tests/e2e/fixture-server.ts and tests/e2e/live-feed.spec.ts).
 *
 * The repository deliberately has no @types/node dependency: the extension
 * itself is DOM-only, and the house rules forbid adding npm dependencies.
 * These declarations cover EXACTLY the surface this harness touches, so the
 * release gate (tsc --noEmit) stays green without a Node types package.
 * Do not expand them casually; prefer real @types/node if the harness's Node
 * usage ever grows beyond this list.
 */

declare module 'node:child_process' {
  export interface ChildProcess {
    kill(signal?: string): boolean;
  }

  export function execFileSync(
    file: string,
    args?: readonly string[],
    options?: { stdio?: unknown },
  ): Buffer;
}

declare module 'node:fs' {
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function readFileSync(path: string): Buffer;
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string, encoding?: string): void;
  export function existsSync(path: string): boolean;
}

declare module 'node:http' {
  export interface AddressInfo {
    readonly port: number;
  }

  export interface IncomingMessage {
    readonly url?: string | undefined;
  }

  export interface ServerResponse {
    writeHead(statusCode: number, headers?: Record<string, string>): this;
    end(data?: string | Buffer): void;
  }

  export interface Server {
    on(
      event: 'connect',
      listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
    ): this;
    listen(port: number, host: string, callback: () => void): this;
    address(): AddressInfo | string | null;
    close(callback?: () => void): this;
    emit(event: 'connection', socket: Duplex): boolean;
    once(event: 'error', listener: (error: Error) => void): this;
    removeListener(event: 'error', listener: (error: Error) => void): this;
  }

  export function createServer(
    listener?: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
}

declare module 'node:net' {
  export interface Socket {
    write(data: string): boolean;
    destroy(): void;
  }
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export const sep: string;
}

declare module 'node:stream' {
  export interface Duplex {
    on(event: string, listener: (...args: never[]) => void): this;
    unshift(chunk: string | Buffer): void;
  }
}

declare module 'node:tls' {
  import type { Duplex } from 'node:stream';

  export interface SecureContext {}

  export interface TlsSocketOptions {
    isServer: boolean;
    secureContext: SecureContext;
    SNICallback?: (servername: string, callback: (error: Error | null, context?: SecureContext) => void) => void;
  }

  export class TLSSocket {
    constructor(socket: Duplex, options: TlsSocketOptions);
    on(event: string, listener: (...args: never[]) => void): this;
    unshift(chunk: string | Buffer): void;
  }

  export function createSecureContext(options: { cert: string; key: string }): SecureContext;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

/** Global Node.js process (used only to read FOMO_E2E_HEADED). */
declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
};

/** Node.js Buffer, used only as the HTTP body/head byte container. */
declare class Buffer {
  readonly length: number;
  toString(encoding?: string): string;
}
