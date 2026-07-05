import { logger } from '#platform/server/log';

// Lightweight, always-on diagnostics for the Android "PWA hangs on reopen"
// bug (see worker-bridge.ts's shared-worker liveness watchdog). Renders a
// small on-page badge with the bridge's live state, and mirrors every event
// into a capped localStorage ring buffer so a hang that happened hours ago
// can still be inspected — reload the same URL in a plain mobile Chrome tab
// (same origin = same storage) and tap the badge.

const LOG_KEY = 'actual:pwa-debug-log';
const RELOAD_COUNT_KEY = 'actual:pwa-watchdog-reloads';
const MAX_LOG_ENTRIES = 500;

type LogEntry = { t: number; e: string; d?: Record<string, unknown> };

type OverlayState = {
  role: string;
  budgetId: string | null;
  started: boolean;
  watchdogArmed: boolean;
  watchdogReloads: number;
  lastResumeSentAt: number | null;
  lastSharedMessageAt: number | null;
  lastMessageType: string | null;
};

function readWatchdogReloadCount(): number {
  try {
    return Number(sessionStorage.getItem(RELOAD_COUNT_KEY)) || 0;
  } catch {
    return 0;
  }
}

export function recordWatchdogReload() {
  try {
    sessionStorage.setItem(
      RELOAD_COUNT_KEY,
      String(readWatchdogReloadCount() + 1),
    );
  } catch {
    // sessionStorage unavailable — nothing to persist
  }
}

const state: OverlayState = {
  role: 'UNKNOWN',
  budgetId: null,
  started: false,
  watchdogArmed: false,
  watchdogReloads: readWatchdogReloadCount(),
  lastResumeSentAt: null,
  lastSharedMessageAt: null,
  lastMessageType: null,
};

export function debugLog(event: string, data?: Record<string, unknown>) {
  const entry: LogEntry = { t: Date.now(), e: event, d: data };
  logger.debug('[PWA debug]', entry);
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const entries: LogEntry[] = raw ? JSON.parse(raw) : [];
    entries.push(entry);
    while (entries.length > MAX_LOG_ENTRIES) entries.shift();
    localStorage.setItem(LOG_KEY, JSON.stringify(entries));
  } catch {
    // localStorage unavailable or quota exceeded — logging is best-effort
  }
}

function readDebugLog(): LogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function clearDebugLog() {
  try {
    localStorage.removeItem(LOG_KEY);
  } catch {
    // ignore
  }
}

function formatLog(entries: LogEntry[]): string {
  return entries
    .map(
      ({ t, e, d }) =>
        `${new Date(t).toISOString()} ${e}${d ? ' ' + JSON.stringify(d) : ''}`,
    )
    .join('\n');
}

function formatTime(t: number | null): string {
  return t == null ? '—' : new Date(t).toLocaleTimeString();
}

// ---- On-page overlay ----

let container: HTMLDivElement | null = null;
let badge: HTMLDivElement | null = null;
let panel: HTMLDivElement | null = null;
let expanded = false;

function ensureOverlay() {
  if (container || typeof document === 'undefined') return;

  container = document.createElement('div');
  container.style.cssText =
    'position:fixed;bottom:8px;right:8px;z-index:2147483647;' +
    'font-family:monospace;font-size:11px;color:#0f0;';

  badge = document.createElement('div');
  badge.style.cssText =
    'background:rgba(0,0,0,0.65);padding:4px 6px;border-radius:4px;' +
    'white-space:nowrap;cursor:pointer;';
  badge.addEventListener('click', () => {
    expanded = !expanded;
    renderPanel();
  });

  panel = document.createElement('div');
  panel.style.cssText =
    'display:none;margin-top:4px;background:rgba(0,0,0,0.85);' +
    'padding:8px;border-radius:4px;max-width:90vw;max-height:60vh;overflow:auto;';

  container.appendChild(badge);
  container.appendChild(panel);

  const attach = () => document.body.appendChild(container as HTMLDivElement);
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach);
}

function renderBadge() {
  if (!badge) return;
  const wd = state.watchdogArmed ? 'ARMED' : 'off';
  badge.textContent =
    `${state.role} started:${state.started} ` +
    `wd:${wd} reloads:${state.watchdogReloads}`;
}

function renderPanel() {
  if (!panel) return;

  if (!expanded) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  panel.innerHTML = '';

  const rows: Array<[string, string]> = [
    ['role', state.role],
    ['budgetId', String(state.budgetId)],
    ['started', String(state.started)],
    ['watchdogArmed', String(state.watchdogArmed)],
    ['watchdogReloads (this session)', String(state.watchdogReloads)],
    ['lastResumeSentAt', formatTime(state.lastResumeSentAt)],
    ['lastSharedMessageAt', formatTime(state.lastSharedMessageAt)],
    ['lastMessageType', String(state.lastMessageType)],
  ];
  for (const [k, v] of rows) {
    const row = document.createElement('div');
    row.textContent = `${k}: ${v}`;
    panel.appendChild(row);
  }

  const textarea = document.createElement('textarea');
  textarea.readOnly = true;
  textarea.style.cssText =
    'display:none;width:100%;height:200px;margin-top:6px;' +
    'background:#111;color:#0f0;font-family:monospace;font-size:10px;';

  const buttonRow = document.createElement('div');
  buttonRow.style.cssText = 'margin-top:6px;display:flex;gap:6px;';

  const showLogBtn = document.createElement('button');
  showLogBtn.textContent = 'Show log';
  showLogBtn.addEventListener('click', () => {
    textarea.value = formatLog(readDebugLog());
    textarea.style.display = 'block';
    textarea.focus();
    textarea.select();
  });

  const clearLogBtn = document.createElement('button');
  clearLogBtn.textContent = 'Clear log';
  clearLogBtn.addEventListener('click', () => {
    clearDebugLog();
    textarea.value = '';
  });

  buttonRow.appendChild(showLogBtn);
  buttonRow.appendChild(clearLogBtn);
  panel.appendChild(buttonRow);
  panel.appendChild(textarea);
}

export function updateOverlay(partial: Partial<OverlayState>) {
  Object.assign(state, partial);
  ensureOverlay();
  renderBadge();
  renderPanel();
}
