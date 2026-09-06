import { CopilotRequestMetrics } from './diagnosticLog';
import { CopilotAnalyticsSnapshot } from './copilotAnalytics';

/**
 * Stable contract for the single `metrics` message the extension host posts to the
 * dashboard webview. This is the only data channel between engine-derived state and the
 * UI; alternative front-ends can consume the same shape. Adding a field must stay
 * backward compatible — the webview treats every field as optional.
 */

/** Reorderable, hideable dashboard cards. `header` and control toolbar are always shown. */
export type DashboardCardId =
  | 'story'
  | 'request'
  | 'requestBreakdown'
  | 'gauges'
  | 'chart'
  | 'sources'
  | 'analytics'
  | 'actions';

export const DEFAULT_DASHBOARD_LAYOUT: DashboardCardId[] = [
  'story',
  'request',
  'requestBreakdown',
  'gauges',
  'chart',
  'sources',
  'analytics',
  'actions',
];

export interface DashboardThresholds {
  warn: number;
  critical: number;
}

export interface DashboardInventory {
  toolsCount?: number;
  instructionsCount?: number;
  editorsCount?: number;
  terminalsCount?: number;
}

export interface DashboardEnabledState {
  diagnostics?: boolean;
  otlp?: boolean;
}

/** The single event shape posted to the webview on every observation. */
export interface DashboardEvent {
  type: 'metrics';
  ts: number;
  total: number;
  peak: number;
  bySource: Record<string, number>;
  inventory: DashboardInventory;
  thresholds: DashboardThresholds;
  windowMinutes: number;
  enabled: DashboardEnabledState;
  /** Ordered list of visible cards; cards not listed are hidden. */
  layout: DashboardCardId[];
  request?: CopilotRequestMetrics;
  analytics?: CopilotAnalyticsSnapshot;
  /** Engine-ranked `unselect_tools` recommendation, when tool pressure is high enough. */
  toolFix?: { fixId: string; savedMin: number; savedMax: number; targetCount: number; execution: string };
}
