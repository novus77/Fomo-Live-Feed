import {
  SidePanelApp,
  type SidePanelDependencies,
} from '../sidepanel/SidePanelApp';

/** @deprecated The extension now uses the persistent side-panel composition root. */
export type PopupDependencies = SidePanelDependencies;

/** @deprecated Kept as a thin compatibility wrapper for existing consumers. */
export function PopupApp(props: { deps: PopupDependencies }) {
  return <SidePanelApp deps={{ ...props.deps, variant: 'popup' }} />;
}
