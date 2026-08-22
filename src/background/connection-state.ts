/**
 * Authenticated-bridge connection state (design spec sections 4.3 and 8,
 * plan Task 7 Step 4, BLOCKING 2 rewrite).
 *
 * BLOCKING 2 resolution: the previous machine inferred "connected" from the
 * AGE of the last bridge report (a 30-second stale window). That was never an
 * honest liveness signal: the Fomo bridge only reports on page load, socket
 * open/close, and pagehide, so an IDLE but OPEN authenticated socket went
 * stale 30 seconds after opening - the normal steady state - and the popup
 * lied to the user with "Log in to Fomo".
 *
 * This machine tracks the socket's EXPLICIT open/closed state instead. The
 * spec (section 8) wants a login-required state while section 9 forbids
 * reading cookies (the only direct auth signal), so the auth signal is
 * derived from the MAIN-world interceptor observing that the authenticated
 * WebSocket actually opened: an unauthenticated page cannot open
 * wss://prod-api.fomo.family/ws, so "socket opened" is an honest
 * "authenticated" fact that never touches cookies, headers, or tokens.
 *
 * Per-tab tracking: each content bridge reports with its sender tab id, so a
 * logged-OUT second tab reporting page-presence cannot reset the connected
 * state of a tab whose authenticated socket is open. The snapshot aggregates
 * across tabs (any open socket / any authenticated socket).
 *
 * The machine is pure and storage-injected: per-tab state is persisted to
 * chrome.storage.session and re-seeded after a Manifest V3 suspension (the
 * worker re-seeds only entries whose tab id still exists, so a stale
 * socketOpen from a closed tab is never trusted).
 *
 * Residual honesty limit (documented): logging OUT while a Fomo page stays
 * open only closes the socket, which this machine reads as "authenticated,
 * reconnecting". The popup therefore shows a reconnecting state, never
 * login-required, until the page reloads and the fresh bridge reports
 * unauthenticated (no socket ever opens). Distinguishing "logged out" from
 * "socket reconnecting" without cookies would require observing a 401/403 on
 * Fomo's own REST traffic, which is out of scope for this fix.
 */

export type ConnectionPhase = 'connected' | 'offline';
export interface ConnectionSnapshot {
  /** Any tracked tab's authenticated socket is currently open. */
  connected: boolean;
  /** Any tracked tab has opened the authenticated socket (sticky per page). */
  authenticated: boolean;
}

export interface BridgeConnectionReport {
  connected: boolean;
  authenticated: boolean;
  at: number;
}

export interface TabConnectionState {
  authenticated: boolean;
  socketOpen: boolean;
  reportedAt: number;
}

/** Key under chrome.storage.session that holds the per-tab connection state. */
export const CONNECTION_STATE_STORAGE_KEY = 'connectionState.v1';

/** Upper bound on tracked tabs so a pathological report flood cannot grow unbounded. */
export const MAX_TRACKED_TABS = 32;

const isFiniteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const assertTabKey = (tabKey: string): void => {
  if (!isNonEmptyString(tabKey)) {
    throw new TypeError('tabKey must be a non-empty string');
  }
};

const assertReport = (report: BridgeConnectionReport): void => {
  if (!isBoolean(report.connected) || !isBoolean(report.authenticated)) {
    throw new TypeError('connected and authenticated must be booleans');
  }

  if (!isFiniteNonNegativeInteger(report.at)) {
    throw new TypeError('at must be a finite non-negative integer');
  }
};

export interface ConnectionStateMachineOptions {
  /** Re-seed from chrome.storage.session after a worker restart. */
  seed?: ReadonlyArray<readonly [string, TabConnectionState]>;
}

export class ConnectionStateMachine {
  private readonly tabs = new Map<string, TabConnectionState>();

  constructor(options: ConnectionStateMachineOptions = {}) {
    if (options.seed !== undefined) {
      for (const [tabKey, state] of options.seed) {
        assertTabKey(tabKey);

        if (
          !isBoolean(state.authenticated) ||
          !isBoolean(state.socketOpen) ||
          !isFiniteNonNegativeInteger(state.reportedAt)
        ) {
          throw new TypeError('invalid seeded tab connection state');
        }

        this.tabs.set(tabKey, {
          authenticated: state.authenticated,
          socketOpen: state.socketOpen,
          reportedAt: state.reportedAt,
        });
      }
    }
  }

  /**
   * Applies one bridge report for a tab. authenticated is authoritative per
   * report: the bridge only forwards authenticated:true after the socket
   * actually opened and forwards authenticated:false when a fresh page (or
   * pagehide) has no socket, so a reconnect keeps authenticated while a page
   * reload resets it.
   */
  report(tabKey: string, report: BridgeConnectionReport): void {
    assertTabKey(tabKey);
    assertReport(report);

    this.tabs.set(tabKey, {
      authenticated: report.authenticated,
      socketOpen: report.connected,
      reportedAt: report.at,
    });

    if (this.tabs.size > MAX_TRACKED_TABS) {
      this.evictOldest();
    }
  }

  removeTab(tabKey: string): void {
    this.tabs.delete(tabKey);
  }

  snapshot(): ConnectionSnapshot {
    let connected = false;
    let authenticated = false;

    for (const state of this.tabs.values()) {
      connected = connected || state.socketOpen;
      authenticated = authenticated || state.authenticated;
    }

    return { connected, authenticated };
  }

  /** Defensive copy of the per-tab state, for persistence. */
  persisted(): Array<readonly [string, TabConnectionState]> {
    return [...this.tabs.entries()].map(([tabKey, state]) => [tabKey, { ...state }]);
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;

    for (const [tabKey, state] of this.tabs) {
      if (state.reportedAt < oldestAt) {
        oldestAt = state.reportedAt;
        oldestKey = tabKey;
      }
    }

    if (oldestKey !== undefined) {
      this.tabs.delete(oldestKey);
    }
  }
}

/** Minimal chrome.storage.session surface, injectable in unit tests. */
export interface SessionStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface PersistedConnectionState {
  tabs: Array<{
    tabKey: string;
    authenticated: boolean;
    socketOpen: boolean;
    reportedAt: number;
  }>;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sanitizePersistedTabs = (value: unknown): PersistedConnectionState['tabs'] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const tabs: PersistedConnectionState['tabs'] = [];

  for (const entry of value) {
    if (tabs.length >= MAX_TRACKED_TABS) {
      break;
    }

    if (!isPlainRecord(entry)) {
      continue;
    }

    const tabKey = entry.tabKey;
    const authenticated = entry.authenticated;
    const socketOpen = entry.socketOpen;
    const reportedAt = entry.reportedAt;

    if (
      !isNonEmptyString(tabKey) ||
      !isBoolean(authenticated) ||
      !isBoolean(socketOpen) ||
      !isFiniteNonNegativeInteger(reportedAt)
    ) {
      continue;
    }

    tabs.push({ tabKey, authenticated, socketOpen, reportedAt });
  }

  return tabs;
};

export async function readConnectionState(
  storage: SessionStorageLike,
): Promise<PersistedConnectionState | undefined> {
  const stored = await storage.get([CONNECTION_STATE_STORAGE_KEY]);
  const value = stored[CONNECTION_STATE_STORAGE_KEY];

  if (!isPlainRecord(value)) {
    return undefined;
  }

  const tabs = sanitizePersistedTabs(value.tabs);

  if (tabs.length === 0) {
    return undefined;
  }

  return { tabs };
}

export async function writeConnectionState(
  storage: SessionStorageLike,
  state: PersistedConnectionState,
): Promise<void> {
  const tabs = sanitizePersistedTabs(state.tabs);

  if (tabs.length !== state.tabs.length) {
    throw new TypeError('connection state contains invalid tab entries');
  }

  await storage.set({ [CONNECTION_STATE_STORAGE_KEY]: { tabs } });
}
