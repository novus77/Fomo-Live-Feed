export interface FomoRefreshState {
  hasFomoTab: boolean;
  observerInstalled: boolean;
  socketObserved: boolean;
  connected: boolean;
}

/** Whether the user should be prompted to refresh an already-open Fomo tab. */
export function needsFomoRefresh(state: FomoRefreshState): boolean {
  return state.hasFomoTab
    && state.observerInstalled
    && !state.socketObserved
    && !state.connected;
}
