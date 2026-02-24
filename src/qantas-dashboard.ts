/**
 * Qantas Award Monitor Dashboard
 * - Monitor blocks: each tracks an outbound + return leg pair
 * - Tracks combined (round-trip) points per cabin
 * - Alerts Andy on new lowest price or new availability slot
 * - Server does hourly background refresh
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 3001;
const ANDY_DIR = '/workspace/extra/weon';
const MONITOR_DIR = path.join(ANDY_DIR, 'qantas-monitor');
const MONITORS_FILE = path.join(MONITOR_DIR, 'monitors.json');
const ALERTS_FILE = path.join(MONITOR_DIR, 'alerts-pending.json');
const KEY_FILE = path.join(ANDY_DIR, 'seats-aero-key');
const CASH_REQUESTS_FILE = path.join(MONITOR_DIR, 'cash-requests.json');
const CASH_RESULTS_FILE = path.join(MONITOR_DIR, 'cash-results.json');
const USAGE_FILE = path.join(ANDY_DIR, 'usage.json');
const TASKS_FILE = '/workspace/nanoclaw-ipc/current_tasks.json';
const TASKS_META_FILE = path.join(MONITOR_DIR, 'scheduled-tasks.json');

// ── Types ──────────────────────────────────────────────────────

interface Leg {
  origin: string;
  destination: string;
  dateFrom: string;
  dateTo: string;
}

interface LowestRecord {
  points: number;
  outboundDate: string;
  returnDate: string;
  seenAt: string;
  totalTaxes?: number;
  taxesCurrency?: string;
  isDirect?: boolean;
}

interface CashRecord {
  aud: number;
  outboundDate: string;
  returnDate: string;
  seenAt: string;
  isDirect?: boolean;
}

interface Monitor {
  id: string;
  label: string;
  cabins: string[];          // ['business','premium','economy','first']
  source?: 'awards' | 'cash';    // 'awards' = seats.aero; 'cash' = Google Flights via Andy
  availType?: 'rewards' | 'any'; // awards only: 'rewards' = classic; 'any' = incl. Points+Pay
  outbound: Leg;
  return: Leg;
  createdAt: string;
  lastChecked?: string;
  // Awards tracking
  currentCombined?: Record<string, LowestRecord>;
  lowestCombined?: Record<string, LowestRecord>;
  knownSlots?: string[];
  lastOutbound?: NormalizedFlight[];
  lastReturn?: NormalizedFlight[];
  // Cash tracking
  currentCash?: Record<string, CashRecord>;
  lowestCash?: Record<string, CashRecord>;
  cashPending?: boolean;
  cashRequestedAt?: string;
}

interface MonitorsFile {
  monitors: Monitor[];
}

interface NormalizedFlight {
  Date: string;
  cabin: string;
  MileageCost: number;
  RemainingSeats: number;
  IsDirect: boolean;
  Airlines: string;
  TaxesCurrency: string;
  TotalTaxes: number;
}

interface PendingAlert {
  monitorId: string;
  monitorLabel: string;
  messages: string[];
  createdAt: string;
}

// ── Persistence ────────────────────────────────────────────────

function readMonitors(): MonitorsFile {
  try { return JSON.parse(fs.readFileSync(MONITORS_FILE, 'utf-8')); }
  catch { return { monitors: [] }; }
}

function writeMonitors(data: MonitorsFile): void {
  fs.mkdirSync(MONITOR_DIR, { recursive: true });
  fs.writeFileSync(MONITORS_FILE, JSON.stringify(data, null, 2));
}

function readKey(): string {
  return fs.readFileSync(KEY_FILE, 'utf-8').trim();
}

function appendAlert(monitorId: string, label: string, messages: string[]): void {
  let pending: PendingAlert[] = [];
  try { pending = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8')); } catch {}
  pending.push({ monitorId, monitorLabel: label, messages, createdAt: new Date().toISOString() });
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(pending, null, 2));
}

function writeCashRequest(monitor: Monitor): void {
  let requests: Record<string, unknown>[] = [];
  try { requests = JSON.parse(fs.readFileSync(CASH_REQUESTS_FILE, 'utf-8')); } catch {}
  requests = requests.filter((r) => r['monitorId'] !== monitor.id);
  requests.push({
    monitorId: monitor.id,
    label: monitor.label,
    outbound: monitor.outbound,
    return: monitor.return,
    cabins: monitor.cabins,
    requestedAt: monitor.cashRequestedAt,
  });
  fs.mkdirSync(MONITOR_DIR, { recursive: true });
  fs.writeFileSync(CASH_REQUESTS_FILE, JSON.stringify(requests, null, 2));
}

function processCashResults(): void {
  let results: Record<string, unknown>[];
  try { results = JSON.parse(fs.readFileSync(CASH_RESULTS_FILE, 'utf-8')); } catch { return; }
  if (!results.length) return;

  const data = readMonitors();
  let changed = false;

  for (const result of results) {
    const monitor = data.monitors.find(m => m.id === result['monitorId']);
    if (!monitor || monitor.source !== 'cash') continue;

    monitor.cashPending = false;
    monitor.lastChecked = result['checkedAt'] as string || new Date().toISOString();
    monitor.currentCash = monitor.currentCash || {};
    monitor.lowestCash = monitor.lowestCash || {};

    const CASH_CABIN_CODES: Record<string, string> = { business: 'J', premium: 'W', economy: 'Y', first: 'F' };
    const CASH_CABIN_LABELS: Record<string, string> = { J: 'Business', W: 'Prem Eco', Y: 'Economy', F: 'First' };
    const rawPrices = result['prices'] as Record<string, CashRecord> || {};
    // Normalize keys to cabin codes (J/W/Y/F)
    const prices: Record<string, CashRecord> = {};
    for (const [k, v] of Object.entries(rawPrices)) {
      const code = CASH_CABIN_CODES[k] ?? k.toUpperCase();
      prices[code] = v;
    }
    const alerts: string[] = [];
    for (const [code, price] of Object.entries(prices)) {
      monitor.currentCash[code] = price;
      const prev = monitor.lowestCash[code];
      if (!prev || price.aud < prev.aud) {
        monitor.lowestCash[code] = { ...price };
        const label = CASH_CABIN_LABELS[code] ?? code;
        const saving = prev ? ` (was AUD $${prev.aud})` : ' (first record)';
        alerts.push(`💰 New lowest ${label} cash fare: AUD $${price.aud}${saving} — out ${price.outboundDate} · ret ${price.returnDate}`);
      }
    }
    if (alerts.length) appendAlert(monitor.id, monitor.label, alerts);
    changed = true;
  }

  if (changed) {
    writeMonitors(data);
    fs.writeFileSync(CASH_RESULTS_FILE, '[]');
  }
}

// Poll for cash results every 30s
setInterval(() => { try { processCashResults(); } catch (e) { console.error('cash poll:', e); } }, 30000);

// ── seats.aero ─────────────────────────────────────────────────

const CABIN_CODES: Record<string, string> = { business: 'J', premium: 'W', economy: 'Y', first: 'F' };
const CODE_LABELS: Record<string, string> = { J: 'Business', W: 'Prem Eco', Y: 'Economy', F: 'First' };

function normalizeFlights(raw: Record<string, unknown>[], cabins: string[], availType: 'rewards' | 'any' = 'rewards'): NormalizedFlight[] {
  const codes = cabins.map(c => CABIN_CODES[c] ?? c.toUpperCase());
  const result: NormalizedFlight[] = [];
  const sfx = availType === 'any' ? 'Raw' : '';
  for (const f of raw) {
    for (const code of codes) {
      const available = f[`${code}Available${sfx}`];
      const mileage = parseFloat(f[`${code}MileageCost${sfx}`] as string) || (f[`${code}MileageCost${sfx}`] as number) || 0;
      if (available && mileage > 0) {
        const directMileage = (f[`${code}DirectMileageCost${sfx}`] as number) || 0;
        result.push({
          Date: f['Date'] as string,
          cabin: code,
          MileageCost: mileage,
          RemainingSeats: (f[`${code}RemainingSeats${sfx}`] as number) || 0,
          IsDirect: directMileage > 0 && directMileage === mileage,
          Airlines: (f[`${code}Airlines${sfx}`] as string) || '',
          TaxesCurrency: f['TaxesCurrency'] as string,
          TotalTaxes: ((f[`${code}TotalTaxes${sfx}`] as number) || 0) / 100,
        });
      }
    }
  }
  return result.sort((a, b) => a.Date.localeCompare(b.Date));
}

const FETCH_TIMEOUT_MS = 30_000; // 30 seconds

async function fetchLeg(leg: Leg, cabins: string[], availType: 'rewards' | 'any' = 'rewards'): Promise<NormalizedFlight[]> {
  const key = readKey();
  const url = `https://seats.aero/partnerapi/search?origin_airport=${leg.origin}&destination_airport=${leg.destination}&sources=qantas&cabins=economy,premium,business,first&start_date=${leg.dateFrom}&end_date=${leg.dateTo}&order_by=lowest_mileage&take=500`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers: { 'Partner-Authorization': key }, signal: controller.signal });
    if (!resp.ok) throw new Error(`seats.aero ${resp.status}: ${await resp.text()}`);
    const data = (await resp.json()) as { data?: Record<string, unknown>[] };
    return normalizeFlights(data.data ?? [], cabins, availType);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Refresh logic ──────────────────────────────────────────────

async function refreshMonitor(monitor: Monitor): Promise<string[]> {
  const availType = monitor.availType ?? 'rewards';
  const [outbound, ret] = await Promise.all([
    fetchLeg(monitor.outbound, monitor.cabins, availType),
    fetchLeg(monitor.return, monitor.cabins, availType),
  ]);

  const alerts: string[] = [];
  const knownSlots = new Set(monitor.knownSlots ?? []);
  const newSlots: string[] = [];

  // Detect new availability slots
  for (const f of outbound) {
    const key = `${f.Date}|${f.cabin}|out`;
    if (!knownSlots.has(key)) {
      newSlots.push(key);
      alerts.push(`✈ New outbound ${CODE_LABELS[f.cabin] ?? f.cabin} available: ${f.Date} for ${f.MileageCost.toLocaleString()} pts`);
    }
  }
  for (const f of ret) {
    const key = `${f.Date}|${f.cabin}|ret`;
    if (!knownSlots.has(key)) {
      newSlots.push(key);
      alerts.push(`✈ New return ${CODE_LABELS[f.cabin] ?? f.cabin} available: ${f.Date} for ${f.MileageCost.toLocaleString()} pts`);
    }
  }

  // Compute current + track historical lowest per cabin
  const codes = monitor.cabins.map(c => CABIN_CODES[c] ?? c.toUpperCase());
  const lowestCombined = monitor.lowestCombined ?? {};
  const currentCombined: Record<string, LowestRecord> = {};

  for (const code of codes) {
    const bestOut = outbound.filter(f => f.cabin === code).sort((a, b) => a.MileageCost - b.MileageCost)[0];
    const bestRet = ret.filter(f => f.cabin === code).sort((a, b) => a.MileageCost - b.MileageCost)[0];
    if (!bestOut || !bestRet) continue;

    const combined = bestOut.MileageCost + bestRet.MileageCost;
    const now = new Date().toISOString();
    const rec: LowestRecord = {
      points: combined,
      outboundDate: bestOut.Date,
      returnDate: bestRet.Date,
      seenAt: now,
      totalTaxes: (bestOut.TotalTaxes || 0) + (bestRet.TotalTaxes || 0),
      taxesCurrency: bestOut.TaxesCurrency || bestRet.TaxesCurrency || 'AUD',
      isDirect: bestOut.IsDirect && bestRet.IsDirect,
    };

    currentCombined[code] = rec;

    const prev = lowestCombined[code];
    if (!prev || combined < prev.points) {
      lowestCombined[code] = { ...rec };
      const label = CODE_LABELS[code] ?? code;
      const saving = prev ? ` (was ${prev.points.toLocaleString()})` : ' (first record)';
      alerts.push(`🏆 New lowest ${label} round-trip: ${combined.toLocaleString()} pts${saving} — out ${bestOut.Date} + ret ${bestRet.Date}`);
    }
  }

  // Persist updates
  monitor.lastChecked = new Date().toISOString();
  monitor.lastOutbound = outbound;
  monitor.lastReturn = ret;
  monitor.currentCombined = currentCombined;
  monitor.lowestCombined = lowestCombined;
  monitor.knownSlots = [...knownSlots, ...newSlots];

  return alerts;
}

async function refreshAll(): Promise<void> {
  const data = readMonitors();
  let changed = false;
  for (const monitor of data.monitors) {
    if (monitor.source === 'cash') {
      // Cash monitors are refreshed by Andy — just re-queue if not pending
      if (!monitor.cashPending) {
        monitor.cashPending = true;
        monitor.cashRequestedAt = new Date().toISOString();
        writeCashRequest(monitor);
        changed = true;
      }
      continue;
    }
    try {
      const alerts = await refreshMonitor(monitor);
      if (alerts.length > 0) appendAlert(monitor.id, monitor.label, alerts);
      changed = true;
    } catch (err) {
      console.error(`Refresh failed for ${monitor.label}:`, err);
    }
  }
  if (changed) writeMonitors(data);
}

// Hourly background refresh
setInterval(() => { refreshAll().catch(console.error); }, 60 * 60 * 1000);
// Also refresh on startup after a short delay
setTimeout(() => { refreshAll().catch(console.error); }, 5000);

// ── HTTP server ────────────────────────────────────────────────

function respond(res: http.ServerResponse, status: number, body: string, type = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const MAX_DATE_RANGE_DAYS_SERVER = 5;

function validateLegDateRange(leg: { dateFrom?: string; dateTo?: string } | undefined, label: string): string | null {
  if (!leg?.dateFrom || !leg?.dateTo) return null;
  const days = (new Date(leg.dateTo).getTime() - new Date(leg.dateFrom).getTime()) / 86_400_000;
  if (days < 0) return `${label}: end date must be after start date`;
  if (days > MAX_DATE_RANGE_DAYS_SERVER) return `${label}: date range cannot exceed ${MAX_DATE_RANGE_DAYS_SERVER} days`;
  return null;
}

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1 MB

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ── HTML ───────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Qantas Award Monitor</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f0f5;color:#1d1d1f;font-size:14px}
header{background:#e8002d;color:white;padding:14px 20px;display:flex;align-items:center;justify-content:space-between}
header h1{font-size:1rem;font-weight:600}
.hdr-right{display:flex;align-items:center;gap:10px;font-size:.78rem;opacity:.9}
main{max-width:1000px;margin:20px auto;padding:0 16px;display:grid;gap:16px}
/* Monitor block */
.block{background:white;border-radius:14px;box-shadow:0 1px 4px rgba(0,0,0,.1);overflow:hidden}
.block-head{padding:14px 16px;display:flex;align-items:flex-start;justify-content:space-between;border-bottom:1px solid #f0f0f5}
.block-title{font-weight:600;font-size:.95rem}
.block-meta{font-size:.75rem;color:#6e6e73;margin-top:3px}
.block-actions{display:flex;gap:6px;align-items:center;flex-shrink:0;margin-left:12px}
.block-body{padding:14px 16px}
/* Summary row */
.summary{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.sum-card{background:#f9f9fb;border-radius:10px;padding:10px 14px;flex:1;min-width:160px}
.sum-label{font-size:.72rem;color:#6e6e73;margin-bottom:6px}
.sum-row{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.sum-now-lbl{font-size:.68rem;font-weight:600;color:#6e6e73;min-width:28px}
.sum-low-lbl{font-size:.68rem;font-weight:600;color:#aaa;min-width:28px}
.sum-pts{font-size:1.05rem;font-weight:700;color:#1d1d1f}
.sum-pts.new-low{color:#34c759}
.sum-pts-low{font-size:.85rem;font-weight:600;color:#aaa;text-decoration:line-through}
.sum-cash{font-size:.72rem;color:#6e6e73}
.sum-dates{font-size:.72rem;color:#6e6e73;margin-top:2px}
.sum-sub{font-size:.72rem;color:#6e6e73;margin-top:2px}
.badge-new{display:inline-block;background:#34c759;color:white;font-size:.65rem;font-weight:700;padding:1px 6px;border-radius:8px;margin-left:6px;vertical-align:middle}
/* Two-column legs */
.legs{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:600px){.legs{grid-template-columns:1fr}}
.leg-title{font-size:.75rem;font-weight:600;color:#6e6e73;margin-bottom:7px;text-transform:uppercase;letter-spacing:.04em}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:5px 8px;color:#6e6e73;font-weight:500;border-bottom:1px solid #e5e5ea;font-size:.72rem;white-space:nowrap}
td{padding:7px 8px;border-bottom:1px solid #f5f5f7;font-size:.8rem}
tr:last-child td{border-bottom:none}
tr:hover td{background:#fafafa}
tr.new-slot td{background:#f0fff4}
.badge{padding:1px 6px;border-radius:8px;font-size:.68rem;font-weight:600}
.bJ{background:#fff3cd;color:#856404}
.bW{background:#d1ecf1;color:#0c5460}
.bY{background:#e9d5ff;color:#6b21a8}
.bF{background:#fce7f3;color:#9d174d}
.ok{color:#34c759}.dim{color:#6e6e73}.err{color:#ff3b30}
.empty{text-align:center;padding:20px;color:#6e6e73;font-size:.82rem}
/* Buttons */
.btn{padding:6px 12px;border-radius:8px;border:none;cursor:pointer;font-size:.78rem;font-weight:500}
.btn:hover{opacity:.85}
.btn-red{background:#e8002d;color:#fff}
.btn-gray{background:#e5e5ea;color:#1d1d1f}
.btn-del{background:#ff3b30;color:#fff}
.btn-sm{padding:3px 9px;font-size:.72rem}
/* Spinner */
.spin{display:inline-block;width:12px;height:12px;border:2px solid #e5e5ea;border-top-color:#e8002d;border-radius:50%;animation:sp .7s linear infinite;vertical-align:middle;margin-right:4px}
@keyframes sp{to{transform:rotate(360deg)}}
/* Add form */
.add-block{background:white;border-radius:14px;box-shadow:0 1px 4px rgba(0,0,0,.1);padding:16px}
.add-block h2{font-size:.9rem;font-weight:600;margin-bottom:14px;color:#6e6e73}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.form-grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px}
label{font-size:.75rem;color:#6e6e73;display:block;margin-bottom:3px}
input{width:100%;padding:7px 10px;border:1px solid #d2d2d7;border-radius:8px;font-size:.82rem;outline:none}
input:focus{border-color:#e8002d}
.cabin-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.cabin-cb{display:flex;align-items:center;gap:5px;font-size:.82rem;color:#1d1d1f;cursor:pointer}
.cabin-cb input{width:auto;margin:0}
.leg-section{border:1px solid #e5e5ea;border-radius:10px;padding:12px;margin-bottom:10px}
.leg-section h3{font-size:.8rem;font-weight:600;color:#6e6e73;margin-bottom:10px}
.refreshing td{opacity:.5}
.badge-cash{display:inline-block;background:#007aff;color:white;font-size:.65rem;font-weight:700;padding:1px 6px;border-radius:8px;margin-left:6px;vertical-align:middle}
.badge-pending{display:inline-block;background:#ff9500;color:white;font-size:.65rem;font-weight:700;padding:1px 6px;border-radius:8px;margin-left:6px;vertical-align:middle}
.edit-form{background:#f9f9fb;border-top:1px solid #e5e5ea;padding:14px 16px;display:none}
.edit-form.open{display:block}
.edit-form h3{font-size:.8rem;font-weight:600;color:#6e6e73;margin-bottom:8px}
.reset-note{font-size:.72rem;color:#ff9500;margin-top:8px}
/* Tabs */
.tab-nav{display:flex;gap:0;background:white;border-bottom:1px solid #e5e5ea;padding:0 16px;position:sticky;top:56px;z-index:9}
.tab-btn{padding:8px 18px;border:none;background:none;cursor:pointer;font-size:.82rem;font-weight:500;color:#6e6e73;border-bottom:2px solid transparent;margin-bottom:-1px}
.tab-btn.active{color:#e8002d;border-bottom-color:#e8002d}
.tab-btn:hover:not(.active){color:#1d1d1f}
/* Usage tab */
.usage-section{background:white;border-radius:14px;box-shadow:0 1px 4px rgba(0,0,0,.1);padding:16px;margin-bottom:16px}
.usage-section h2{font-size:.9rem;font-weight:600;color:#6e6e73;margin-bottom:12px}
.usage-totals{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.uc{background:#f9f9fb;border-radius:10px;padding:10px 14px;flex:1;min-width:120px}
.uc-label{font-size:.72rem;color:#6e6e73;margin-bottom:4px}
.uc-val{font-size:1.1rem;font-weight:700;color:#1d1d1f}
/* Scheduled tasks */
.task-card{background:white;border-radius:14px;box-shadow:0 1px 4px rgba(0,0,0,.1);padding:16px;margin-bottom:12px;display:flex;align-items:center;gap:14px}
.task-card.paused{opacity:.6}
.task-icon{font-size:1.4rem;flex-shrink:0}
.task-body{flex:1;min-width:0}
.task-name{font-size:.88rem;font-weight:600;color:#1d1d1f;margin-bottom:2px}
.task-desc{font-size:.75rem;color:#6e6e73;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.task-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:.72rem;color:#6e6e73}
.task-meta span{display:flex;align-items:center;gap:3px}
.badge-active{display:inline-block;background:#d4edda;color:#155724;font-size:.65rem;font-weight:700;padding:1px 7px;border-radius:8px}
.badge-paused{display:inline-block;background:#fff3cd;color:#856404;font-size:.65rem;font-weight:700;padding:1px 7px;border-radius:8px}
</style>
</head>
<body>
<header>
  <div style="display:flex;align-items:center;gap:8px">
    <span style="font-size:1.3rem">✈</span>
    <h1>Qantas Award Monitor</h1>
  </div>
  <div class="hdr-right">
    <span id="next-refresh"></span>
    <button class="btn btn-sm" style="background:rgba(255,255,255,.2);color:white;border:none" onclick="refreshAll()">Refresh all</button>
  </div>
</header>
<nav class="tab-nav">
  <button class="tab-btn active" id="tab-btn-monitors" onclick="showTab('monitors')">Monitors</button>
  <button class="tab-btn" id="tab-btn-tasks" onclick="showTab('tasks')">Scheduled Tasks</button>
  <button class="tab-btn" id="tab-btn-usage" onclick="showTab('usage')">API Usage</button>
</nav>
<div id="panel-monitors">
<main id="monitors-container">
  <div class="empty"><span class="spin"></span>Loading…</div>
</main>
</div>
<div id="panel-tasks" style="display:none;padding:16px">
  <div id="tasks-container"><div class="empty"><span class="spin"></span>Loading…</div></div>
</div>
<div id="panel-usage" style="display:none;padding:16px">
  <div class="usage-section">
    <h2>Token Usage &amp; Cost</h2>
    <div class="usage-totals" id="usage-totals">
      <div class="uc"><div class="uc-label">Total Input Tokens</div><div class="uc-val" id="ut-in">—</div></div>
      <div class="uc"><div class="uc-label">Total Output Tokens</div><div class="uc-val" id="ut-out">—</div></div>
      <div class="uc"><div class="uc-label">Total Cost (USD)</div><div class="uc-val" id="ut-cost">—</div></div>
      <div class="uc"><div class="uc-label">Runs Tracked</div><div class="uc-val" id="ut-runs">—</div></div>
    </div>
  </div>
  <div class="usage-section">
    <h2>Daily Breakdown</h2>
    <table id="usage-table">
      <thead><tr><th>Date</th><th>Runs</th><th>Input Tokens</th><th>Output Tokens</th><th>Cost (USD)</th></tr></thead>
      <tbody id="usage-tbody"><tr><td colspan="5" class="empty">Loading…</td></tr></tbody>
    </table>
  </div>
</div>

<script>
let monitors = [];
let refreshTimer = 3600;

function fmt(s) {
  if (!s) return '';
  const [y, m, d] = s.slice(0, 10).split('-');
  return d + '/' + m + '/' + y;
}
function fmtDt(s) {
  if (!s) return '';
  const d = new Date(s);
  return fmt(d.toISOString().slice(0, 10)) + ' ' +
    d.toLocaleTimeString('en-AU', {hour:'2-digit', minute:'2-digit', hour12:false});
}

// ── Countdown timer ──
setInterval(() => {
  refreshTimer--;
  if (refreshTimer <= 0) { refreshTimer = 3600; refreshAll(); }
  const m = String(Math.floor(refreshTimer/60)).padStart(2,'0');
  const s = String(refreshTimer%60).padStart(2,'0');
  document.getElementById('next-refresh').textContent = 'Next refresh: ' + m + ':' + s;
}, 1000);

// ── Init ──
async function init() {
  await loadMonitors();
}

async function loadMonitors() {
  const r = await fetch('/api/monitors');
  monitors = await r.json();
  renderAll();
}

async function refreshAll() {
  refreshTimer = 3600;
  // Mark all blocks as refreshing
  document.querySelectorAll('tbody').forEach(t => t.classList.add('refreshing'));
  const r = await fetch('/api/monitors/refresh-all', {method:'POST'});
  monitors = await r.json();
  renderAll();
}

async function refreshOne(id) {
  const block = document.getElementById('block-' + id);
  if (block) block.querySelectorAll('tbody').forEach(t => t.classList.add('refreshing'));
  const r = await fetch('/api/monitors/' + id + '/refresh', {method:'POST'});
  const updated = await r.json();
  monitors = monitors.map(m => m.id === id ? updated : m);
  renderAll();
}

async function removeMonitor(id) {
  if (!confirm('Remove this monitor?')) return;
  await fetch('/api/monitors/' + id, {method:'DELETE'});
  monitors = monitors.filter(m => m.id !== id);
  renderAll();
}

// ── Rendering ──
const CABIN_LABELS = {J:'Business',W:'Prem Eco',Y:'Economy',F:'First'};
const CABIN_NAMES = {business:'J',premium:'W',economy:'Y',first:'F'};

function renderAll() {
  const container = document.getElementById('monitors-container');
  const html = monitors.map(m => renderBlock(m)).join('') + renderAddForm();
  container.innerHTML = html || ('<div class="empty">No monitors yet. Add one below.</div>' + renderAddForm());
}

function renderBlock(m) {
  const low = m.lowestCombined || {};
  const codes = (m.cabins||[]).map(c => CABIN_NAMES[c]||c.toUpperCase()).filter(Boolean);

  // Summary cards — awards use pts, cash use AUD (both keyed by cabin code J/W/Y/F)
  const isCash = m.source === 'cash';
  const cur = isCash ? (m.currentCash || {}) : (m.currentCombined || {});
  const summaryCards = codes.map(code => {
    const current = cur[code];
    const best = isCash ? (m.lowestCash || {})[code] : low[code];
    if (!current && !best) return '';
    const curVal  = isCash ? (current ? 'AUD $' + current.aud.toLocaleString() : '') : (current ? current.points.toLocaleString() + ' pts' : '');
    const bestVal = isCash ? (best ? 'AUD $' + best.aud.toLocaleString() : '') : (best ? best.points.toLocaleString() + ' pts' : '');
    const curNum  = isCash ? (current ? current.aud : Infinity) : (current ? current.points : Infinity);
    const bestNum = isCash ? (best ? best.aud : Infinity) : (best ? best.points : Infinity);
    const isNewLow = current && best && curNum <= bestNum;
    const hasPrev = best && current && bestNum < curNum;
    const taxes = (!isCash && current && current.totalTaxes) ? (current.taxesCurrency||'AUD') + ' $' + current.totalTaxes.toFixed(0) + ' cash' : '';
    const directStr = current && current.isDirect === true ? ' · Direct ✓' : '';
    return '<div class="sum-card">' +
      '<div class="sum-label">' + (CABIN_LABELS[code]||code) + ' round-trip' + (isNewLow ? '<span class="badge-new">NEW LOW</span>' : '') + '</div>' +
      (current ?
        '<div class="sum-row"><span class="sum-now-lbl">Now</span><span class="sum-pts' + (isNewLow?' new-low':'') + '">' + curVal + '</span>' + (taxes ? '<span class="sum-cash">' + taxes + directStr + '</span>' : directStr ? '<span class="sum-cash">' + directStr + '</span>' : '') + '</div>' +
        '<div class="sum-dates" style="margin-left:36px">out ' + fmt(current.outboundDate) + ' · ret ' + fmt(current.returnDate) + '</div>'
        : '') +
      (hasPrev ?
        '<div class="sum-row" style="margin-top:6px"><span class="sum-low-lbl">Low</span><span class="sum-pts-low">' + bestVal + '</span><span class="sum-cash dim">(' + fmt(best.seenAt.slice(0,10)) + ')</span></div>'
        : (!current && best ?
          '<div class="sum-row"><span class="sum-low-lbl">Low</span><span class="sum-pts">' + bestVal + '</span></div>' +
          '<div class="sum-dates" style="margin-left:36px">out ' + fmt(best.outboundDate) + ' · ret ' + fmt(best.returnDate) + '</div>'
          : '')) +
      '</div>';
  }).filter(Boolean).join('');

  // Leg tables
  const outRows = renderLegRows(m.lastOutbound||[], m.knownSlots||[], 'out', codes);
  const retRows = renderLegRows(m.lastReturn||[], m.knownSlots||[], 'ret', codes);
  const lastChecked = m.lastChecked ? 'Updated ' + fmtDt(m.lastChecked) : 'Not yet refreshed';

  const cabinLabels = codes.map(c => CABIN_LABELS[c]||c).join(', ');
  const typeLabel = isCash ? 'Cash (Google Flights)' : (m.availType === 'any') ? 'Any awards' : 'Rewards';
  const outDateStr = m.outbound.dateFrom === m.outbound.dateTo ? fmt(m.outbound.dateFrom) : fmt(m.outbound.dateFrom) + ' – ' + fmt(m.outbound.dateTo);
  const retDateStr = m.return.dateFrom === m.return.dateTo ? fmt(m.return.dateFrom) : fmt(m.return.dateFrom) + ' – ' + fmt(m.return.dateTo);

  return '<div class="block" id="block-' + m.id + '">' +
    '<div class="block-head">' +
      '<div>' +
        '<div class="block-title">' + m.label + (isCash ? '<span class="badge-cash">CASH</span>' : '') + '</div>' +
        '<div class="block-meta">' +
          'Out: ' + m.outbound.origin + '→' + m.outbound.destination + ' ' + outDateStr +
          ' &nbsp;|&nbsp; Ret: ' + m.return.origin + '→' + m.return.destination + ' ' + retDateStr +
        '</div>' +
        '<div class="block-meta dim">' + cabinLabels + ' · ' + typeLabel + ' · ' + lastChecked + (m.cashPending ? '<span class="badge-pending">Awaiting Andy</span>' : '') + '</div>' +
      '</div>' +
      '<div class="block-actions">' +
        '<button class="btn btn-gray btn-sm" data-id="' + m.id + '" onclick="refreshOne(this.dataset.id)">↻</button>' +
        '<button class="btn btn-gray btn-sm" data-id="' + m.id + '" onclick="toggleEdit(this.dataset.id)">Edit</button>' +
        '<button class="btn btn-del btn-sm" data-id="' + m.id + '" onclick="removeMonitor(this.dataset.id)">Remove</button>' +
      '</div>' +
    '</div>' +
    renderEditForm(m) +
    '<div class="block-body">' +
      (summaryCards ? '<div class="summary">' + summaryCards + '</div>' : '') +
      (isCash ? (m.cashPending && !Object.keys(m.currentCash||{}).length ? '<div class="empty"><span class="spin"></span>Waiting for Andy to check Google Flights…</div>' : (!summaryCards ? '<div class="empty">No cash price data yet — hit ↻ to request a check from Andy.</div>' : '')) :
        '<div class="legs">' +
          '<div>' +
            '<div class="leg-title">Outbound · ' + m.outbound.origin + ' → ' + m.outbound.destination + '</div>' +
            (outRows ? '<table><thead><tr><th>Date</th><th>Cabin</th><th>Points</th><th>Cash (fees)</th><th>Direct</th></tr></thead><tbody>' + outRows + '</tbody></table>' : '<div class="empty">No availability for ' + cabinLabels + '</div>') +
          '</div>' +
          '<div>' +
            '<div class="leg-title">Return · ' + m.return.origin + ' → ' + m.return.destination + '</div>' +
            (retRows ? '<table><thead><tr><th>Date</th><th>Cabin</th><th>Points</th><th>Cash (fees)</th><th>Direct</th></tr></thead><tbody>' + retRows + '</tbody></table>' : '<div class="empty">No availability for ' + cabinLabels + '</div>') +
          '</div>' +
        '</div>') +
    '</div>' +
  '</div>';
}

function renderLegRows(flights, knownSlots, dir, codes) {
  const filtered = flights.filter(f => codes.includes(f.cabin));
  if (!filtered.length) return '';
  // Pick cheapest flight per cabin across the date range
  const best = {};
  for (const f of filtered) {
    if (!best[f.cabin] || f.MileageCost < best[f.cabin].MileageCost) best[f.cabin] = f;
  }
  return Object.values(best).map(f => {
    const isNew = !knownSlots.includes(f.Date + '|' + f.cabin + '|' + dir);
    const badge = '<span class="badge b' + f.cabin + '">' + (CABIN_LABELS[f.cabin]||f.cabin) + '</span>';
    const taxes = f.TotalTaxes ? (f.TaxesCurrency||'AUD') + ' $' + f.TotalTaxes.toFixed(0) : '—';
    const direct = f.IsDirect ? '<span class="ok">✓</span>' : '<span class="dim">cnx</span>';
    return '<tr' + (isNew?' class="new-slot"':'') + '>' +
      '<td>' + fmt(f.Date) + (isNew ? ' <span class="badge-new">NEW</span>' : '') + '</td>' +
      '<td>' + badge + '</td>' +
      '<td>' + f.MileageCost.toLocaleString() + '</td>' +
      '<td class="dim">' + taxes + '</td>' +
      '<td>' + direct + '</td>' +
      '</tr>';
  }).join('');
}

function renderAddForm() {
  return '<div class="add-block">' +
    '<h2>+ New Monitor</h2>' +
    '<div style="margin-bottom:10px"><label>Label (e.g. "SYD \u2194 SCL Winter 2026")</label><input id="f-label" placeholder="SYD \u2194 SCL Winter 2026"></div>' +
    '<div class="cabin-row">' +
      '<span style="font-size:.75rem;color:#6e6e73;align-self:center">Cabins:</span>' +
      '<label class="cabin-cb"><input type="checkbox" id="f-J" checked> Business</label>' +
      '<label class="cabin-cb"><input type="checkbox" id="f-W" checked> Premium Eco</label>' +
      '<label class="cabin-cb"><input type="checkbox" id="f-Y"> Economy</label>' +
      '<label class="cabin-cb"><input type="checkbox" id="f-F"> First</label>' +
    '</div>' +
    '<div class="cabin-row" style="margin-bottom:8px">' +
      '<span style="font-size:.75rem;color:#6e6e73;align-self:center">Source:</span>' +
      '<select id="f-source" style="padding:4px 8px;border:1px solid #d2d2d7;border-radius:8px;font-size:.82rem" onchange="toggleAwardType(this.value)">' +
        '<option value="awards">Awards (seats.aero)</option>' +
        '<option value="cash">Cash prices (Google Flights via Andy)</option>' +
      '</select>' +
    '</div>' +
    '<div class="cabin-row" style="margin-bottom:12px" id="f-availtype-row">' +
      '<span style="font-size:.75rem;color:#6e6e73;align-self:center">Type:</span>' +
      '<select id="f-availtype" style="padding:4px 8px;border:1px solid #d2d2d7;border-radius:8px;font-size:.82rem">' +
        '<option value="rewards">Rewards (Classic Award seats)</option>' +
        '<option value="any">Any awards (incl. Points + Pay)</option>' +
      '</select>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
      '<div class="leg-section">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
          '<h3 style="margin:0">Outbound</h3>' +
          '<label class="cabin-cb" style="font-size:.75rem"><input type="checkbox" id="f-out-single" data-prefix="f-out" data-from-label="Earliest departure" onchange="toggleSingleDate(this)"> Single date</label>' +
        '</div>' +
        '<div class="form-grid">' +
          '<div><label>From</label><input id="f-out-orig" placeholder="SYD" maxlength="3" style="text-transform:uppercase"></div>' +
          '<div><label>To</label><input id="f-out-dest" placeholder="SCL" maxlength="3" style="text-transform:uppercase"></div>' +
        '</div>' +
        '<div class="form-grid">' +
          '<div><label id="f-out-from-lbl">Earliest departure</label><input type="date" id="f-out-from" data-sync-single="f-out" oninput="syncSingle(this)"></div>' +
          '<div id="f-out-to-grp"><label>Latest departure</label><input type="date" id="f-out-to"></div>' +
        '</div>' +
      '</div>' +
      '<div class="leg-section">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
          '<h3 style="margin:0">Return</h3>' +
          '<label class="cabin-cb" style="font-size:.75rem"><input type="checkbox" id="f-ret-single" data-prefix="f-ret" data-from-label="Earliest return" onchange="toggleSingleDate(this)"> Single date</label>' +
        '</div>' +
        '<div class="form-grid">' +
          '<div><label>From</label><input id="f-ret-orig" placeholder="SCL" maxlength="3" style="text-transform:uppercase"></div>' +
          '<div><label>To</label><input id="f-ret-dest" placeholder="SYD" maxlength="3" style="text-transform:uppercase"></div>' +
        '</div>' +
        '<div class="form-grid">' +
          '<div><label id="f-ret-from-lbl">Earliest return</label><input type="date" id="f-ret-from" data-sync-single="f-ret" oninput="syncSingle(this)"></div>' +
          '<div id="f-ret-to-grp"><label>Latest return</label><input type="date" id="f-ret-to"></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<button class="btn btn-red" onclick="addMonitor()">Add Monitor</button>' +
  '</div>';
}

function renderEditForm(m) {
  const id = m.id;
  const cb = (code, name) => {
    const checked = (m.cabins||[]).includes(name) ? ' checked' : '';
    return '<label class="cabin-cb"><input type="checkbox" id="e-' + code + '-' + id + '"' + checked + '> ' +
      (code==='J'?'Business':code==='W'?'Prem Eco':code==='Y'?'Economy':'First') + '</label>';
  };
  const outSingle = m.outbound.dateFrom === m.outbound.dateTo;
  const retSingle = m.return.dateFrom === m.return.dateTo;
  const availType = m.availType || 'rewards';
  return '<div class="edit-form" id="edit-' + id + '">' +
    '<div style="margin-bottom:10px"><label>Label</label><input id="e-label-' + id + '" value="' + m.label.replace(/"/g,'&quot;') + '"></div>' +
    '<div class="cabin-row" style="margin-bottom:8px">' +
      '<span style="font-size:.75rem;color:#6e6e73;align-self:center">Cabins:</span>' +
      cb('J','business') + cb('W','premium') + cb('Y','economy') + cb('F','first') +
    '</div>' +
    '<div class="cabin-row" style="margin-bottom:8px">' +
      '<span style="font-size:.75rem;color:#6e6e73;align-self:center">Source:</span>' +
      '<select id="e-source-' + id + '" style="padding:4px 8px;border:1px solid #d2d2d7;border-radius:8px;font-size:.82rem" onchange="toggleEditAwardType(this.value,\\'' + id + '\\')">' +
        '<option value="awards"' + (m.source !== 'cash' ? ' selected' : '') + '>Awards (seats.aero)</option>' +
        '<option value="cash"' + (m.source === 'cash' ? ' selected' : '') + '>Cash prices (Google Flights via Andy)</option>' +
      '</select>' +
    '</div>' +
    '<div class="cabin-row" style="margin-bottom:12px"' + (m.source === 'cash' ? ' style="display:none"' : '') + ' id="e-availtype-row-' + id + '">' +
      '<span style="font-size:.75rem;color:#6e6e73;align-self:center">Type:</span>' +
      '<select id="e-availtype-' + id + '" style="padding:4px 8px;border:1px solid #d2d2d7;border-radius:8px;font-size:.82rem">' +
        '<option value="rewards"' + (availType !== 'any' ? ' selected' : '') + '>Rewards (Classic Award seats)</option>' +
        '<option value="any"' + (availType === 'any' ? ' selected' : '') + '>Any awards (incl. Points + Pay)</option>' +
      '</select>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px">' +
      '<div class="leg-section">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
          '<h3 style="margin:0">Outbound</h3>' +
          '<label class="cabin-cb" style="font-size:.75rem"><input type="checkbox" id="e-out-single-' + id + '" data-prefix="e-out-' + id + '" data-from-label="Earliest departure"' + (outSingle?' checked':'') + ' onchange="toggleSingleDate(this)"> Single date</label>' +
        '</div>' +
        '<div class="form-grid">' +
          '<div><label>From</label><input id="e-out-orig-' + id + '" value="' + m.outbound.origin + '" maxlength="3" style="text-transform:uppercase"></div>' +
          '<div><label>To</label><input id="e-out-dest-' + id + '" value="' + m.outbound.destination + '" maxlength="3" style="text-transform:uppercase"></div>' +
        '</div>' +
        '<div class="form-grid">' +
          '<div><label id="e-out-' + id + '-from-lbl">' + (outSingle?'Date':'Earliest departure') + '</label><input type="date" id="e-out-' + id + '-from" value="' + m.outbound.dateFrom + '" data-sync-single="e-out-' + id + '" oninput="syncSingle(this)"></div>' +
          '<div id="e-out-' + id + '-to-grp"' + (outSingle?' style="display:none"':'') + '><label>Latest departure</label><input type="date" id="e-out-' + id + '-to" value="' + m.outbound.dateTo + '"></div>' +
        '</div>' +
      '</div>' +
      '<div class="leg-section">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
          '<h3 style="margin:0">Return</h3>' +
          '<label class="cabin-cb" style="font-size:.75rem"><input type="checkbox" id="e-ret-single-' + id + '" data-prefix="e-ret-' + id + '" data-from-label="Earliest return"' + (retSingle?' checked':'') + ' onchange="toggleSingleDate(this)"> Single date</label>' +
        '</div>' +
        '<div class="form-grid">' +
          '<div><label>From</label><input id="e-ret-orig-' + id + '" value="' + m.return.origin + '" maxlength="3" style="text-transform:uppercase"></div>' +
          '<div><label>To</label><input id="e-ret-dest-' + id + '" value="' + m.return.destination + '" maxlength="3" style="text-transform:uppercase"></div>' +
        '</div>' +
        '<div class="form-grid">' +
          '<div><label id="e-ret-' + id + '-from-lbl">' + (retSingle?'Date':'Earliest return') + '</label><input type="date" id="e-ret-' + id + '-from" value="' + m.return.dateFrom + '" data-sync-single="e-ret-' + id + '" oninput="syncSingle(this)"></div>' +
          '<div id="e-ret-' + id + '-to-grp"' + (retSingle?' style="display:none"':'') + '><label>Latest return</label><input type="date" id="e-ret-' + id + '-to" value="' + m.return.dateTo + '"></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn btn-red btn-sm" data-id="' + id + '" onclick="saveEdit(this.dataset.id)">Save</button>' +
      '<button class="btn btn-gray btn-sm" data-id="' + id + '" onclick="toggleEdit(this.dataset.id)">Cancel</button>' +
      '<span class="reset-note">Changing route, dates, or cabins resets price history.</span>' +
    '</div>' +
  '</div>';
}

function toggleEdit(id) {
  const form = document.getElementById('edit-' + id);
  form.classList.toggle('open');
}

async function saveEdit(id) {
  const gv = s => document.getElementById(s).value.trim();
  const label      = gv('e-label-' + id);
  const outOrig    = gv('e-out-orig-' + id).toUpperCase();
  const outDest    = gv('e-out-dest-' + id).toUpperCase();
  const outSingle  = document.getElementById('e-out-single-' + id).checked;
  const outFrom    = gv('e-out-' + id + '-from');
  const outTo      = outSingle ? outFrom : gv('e-out-' + id + '-to');
  const retOrig    = gv('e-ret-orig-' + id).toUpperCase();
  const retDest    = gv('e-ret-dest-' + id).toUpperCase();
  const retSingle  = document.getElementById('e-ret-single-' + id).checked;
  const retFrom    = gv('e-ret-' + id + '-from');
  const retTo      = retSingle ? retFrom : gv('e-ret-' + id + '-to');
  const source     = document.getElementById('e-source-' + id).value;
  const availType  = document.getElementById('e-availtype-' + id).value;
  const cabinMap = {J:'business',W:'premium',Y:'economy',F:'first'};
  const cabins = Object.entries(cabinMap)
    .filter(([code]) => document.getElementById('e-' + code + '-' + id).checked)
    .map(([,name]) => name);

  if (!label||!outOrig||!outDest||!outFrom||!outTo||!retOrig||!retDest||!retFrom||!retTo||!cabins.length) {
    alert('Please fill in all fields.');
    return;
  }
  const rangeErr = validateDateRange(outFrom, outTo, 'Outbound') || validateDateRange(retFrom, retTo, 'Return');
  if (rangeErr) { alert(rangeErr); return; }

  const body = {label, cabins, source, availType,
    outbound: {origin:outOrig, destination:outDest, dateFrom:outFrom, dateTo:outTo},
    return:   {origin:retOrig, destination:retDest, dateFrom:retFrom, dateTo:retTo},
  };
  const r = await fetch('/api/monitors/' + id, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const updated = await r.json();
  monitors = monitors.map(m => m.id === id ? updated : m);
  renderAll();
  // If core fields changed, the server cleared history — do a fresh refresh
  if (!updated.lastChecked) refreshOne(id);
}

function toggleAwardType(source) {
  const row = document.getElementById('f-availtype-row');
  if (row) row.style.display = source === 'cash' ? 'none' : '';
}

function toggleEditAwardType(source, id) {
  const row = document.getElementById('e-availtype-row-' + id);
  if (row) row.style.display = source === 'cash' ? 'none' : '';
}

function toggleSingleDate(el) {
  const prefix = el.dataset.prefix;
  const single = el.checked;
  const toGrp = document.getElementById(prefix + '-to-grp');
  const fromLbl = document.getElementById(prefix + '-from-lbl');
  if (toGrp) toGrp.style.display = single ? 'none' : '';
  if (fromLbl) fromLbl.textContent = single ? 'Date' : (el.dataset.fromLabel || 'Departure');
  if (single) {
    const fromEl = document.getElementById(prefix + '-from');
    const toEl = document.getElementById(prefix + '-to');
    if (fromEl && toEl) toEl.value = fromEl.value;
  }
}

const MAX_DATE_RANGE_DAYS = 5;

function validateDateRange(from, to, label) {
  if (!from || !to) return null;
  const days = (new Date(to) - new Date(from)) / 86400000;
  if (days < 0) return label + ': end date must be after start date.';
  if (days > MAX_DATE_RANGE_DAYS) return label + ': date range cannot exceed ' + MAX_DATE_RANGE_DAYS + ' days.';
  return null;
}

function syncSingle(el) {
  const prefix = el.dataset.syncSingle;
  if (!prefix) return;
  const singleEl = document.getElementById(prefix + '-single');
  if (singleEl && singleEl.checked) {
    const toEl = document.getElementById(prefix + '-to');
    if (toEl) toEl.value = el.value;
  }
}

async function addMonitor() {
  const label      = document.getElementById('f-label').value.trim();
  const outOrig    = document.getElementById('f-out-orig').value.trim().toUpperCase();
  const outDest    = document.getElementById('f-out-dest').value.trim().toUpperCase();
  const outSingle  = document.getElementById('f-out-single').checked;
  const outFrom    = document.getElementById('f-out-from').value;
  const outTo      = outSingle ? outFrom : document.getElementById('f-out-to').value;
  const retOrig    = document.getElementById('f-ret-orig').value.trim().toUpperCase();
  const retDest    = document.getElementById('f-ret-dest').value.trim().toUpperCase();
  const retSingle  = document.getElementById('f-ret-single').checked;
  const retFrom    = document.getElementById('f-ret-from').value;
  const retTo      = retSingle ? retFrom : document.getElementById('f-ret-to').value;
  const source     = document.getElementById('f-source').value;
  const availType  = document.getElementById('f-availtype').value;

  const cabinMap = {J:'business',W:'premium',Y:'economy',F:'first'};
  const cabins = Object.entries(cabinMap)
    .filter(([code]) => document.getElementById('f-'+code).checked)
    .map(([,name]) => name);

  if (!label||!outOrig||!outDest||!outFrom||!outTo||!retOrig||!retDest||!retFrom||!retTo||!cabins.length) {
    alert('Please fill in all fields and select at least one cabin.');
    return;
  }
  const rangeErr = validateDateRange(outFrom, outTo, 'Outbound') || validateDateRange(retFrom, retTo, 'Return');
  if (rangeErr) { alert(rangeErr); return; }

  const body = {label, cabins, source, availType,
    outbound: {origin:outOrig, destination:outDest, dateFrom:outFrom, dateTo:outTo},
    return:   {origin:retOrig, destination:retDest, dateFrom:retFrom, dateTo:retTo},
  };
  const r = await fetch('/api/monitors', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const created = await r.json();
  monitors.push(created);
  renderAll();
  // Kick off initial refresh in background
  refreshOne(created.id);
}

// ── Tab switching ──
function showTab(name) {
  document.getElementById('panel-monitors').style.display = name === 'monitors' ? '' : 'none';
  document.getElementById('panel-tasks').style.display   = name === 'tasks'    ? '' : 'none';
  document.getElementById('panel-usage').style.display   = name === 'usage'    ? '' : 'none';
  document.getElementById('tab-btn-monitors').classList.toggle('active', name === 'monitors');
  document.getElementById('tab-btn-tasks').classList.toggle('active',    name === 'tasks');
  document.getElementById('tab-btn-usage').classList.toggle('active',    name === 'usage');
  if (name === 'usage') loadUsage();
  if (name === 'tasks') loadTasks();
}

// ── Scheduled tasks ──
function cronDesc(expr) {
  if (!expr) return expr;
  const p = expr.trim().split(/\s+/);
  if (p.length < 5) return expr;
  const [min, hr, , , dow] = p;
  const days = {0:'Sun',1:'Mon',2:'Tue',3:'Wed',4:'Thu',5:'Fri',6:'Sat'};
  function fmtHrs(h) {
    return h.split(',').map(v => {
      const n = parseInt(v);
      return n === 0 ? '12am' : n < 12 ? n+'am' : n === 12 ? '12pm' : (n-12)+'pm';
    }).join(' & ');
  }
  if (dow !== '*') {
    const dayName = days[parseInt(dow)] || 'day '+dow;
    return 'Weekly ' + dayName + ' at ' + fmtHrs(hr);
  }
  return 'Daily at ' + fmtHrs(hr);
}

function taskIcon(name) {
  if (/flight|monitor|seat|award/i.test(name)) return '✈';
  if (/point|sale|promot/i.test(name)) return '🎯';
  return '⏰';
}

async function loadTasks() {
  const r = await fetch('/api/scheduled-tasks');
  const tasks = await r.json();
  const el = document.getElementById('tasks-container');
  if (!tasks.length) { el.innerHTML = '<div class="empty">No scheduled tasks found.</div>'; return; }
  el.innerHTML = tasks.map(t => {
    const badge = t.status === 'active'
      ? '<span class="badge-active">Active</span>'
      : '<span class="badge-paused">Paused</span>';
    const sched = t.scheduleDisplay || cronDesc(t.scheduleValue || t.schedule_value || '');
    const nextRun = t.next_run ? fmtDt(t.next_run) : '—';
    const desc = t.description || (t.prompt ? t.prompt.slice(0, 100) + '…' : '');
    const name = t.name || t.id;
    return '<div class="task-card' + (t.status === 'paused' ? ' paused' : '') + '">' +
      '<div class="task-icon">' + taskIcon(name) + '</div>' +
      '<div class="task-body">' +
        '<div class="task-name">' + name + ' ' + badge + '</div>' +
        '<div class="task-desc">' + desc + '</div>' +
        '<div class="task-meta">' +
          '<span>🕐 ' + sched + '</span>' +
          '<span>⏭ Next: ' + nextRun + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Usage ──
async function loadUsage() {
  const r = await fetch('/api/usage');
  const data = await r.json();
  const runs = data.runs || [];
  const totals = data.totals || {};

  document.getElementById('ut-in').textContent = (totals.inputTokens || 0).toLocaleString();
  document.getElementById('ut-out').textContent = (totals.outputTokens || 0).toLocaleString();
  document.getElementById('ut-cost').textContent = '$' + (totals.costUsd || 0).toFixed(4);
  document.getElementById('ut-runs').textContent = runs.length.toLocaleString();

  // Group by date
  const byDay = {};
  for (const run of runs) {
    const d = run.date || (run.timestamp ? run.timestamp.slice(0,10) : 'unknown');
    if (!byDay[d]) byDay[d] = {runs:0,in:0,out:0,cost:0};
    byDay[d].runs++;
    byDay[d].in  += run.inputTokens  || 0;
    byDay[d].out += run.outputTokens || 0;
    byDay[d].cost += run.costUsd     || 0;
  }
  const days = Object.keys(byDay).sort().reverse();
  const tbody = document.getElementById('usage-tbody');
  if (days.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No usage recorded yet.</td></tr>';
    return;
  }
  tbody.innerHTML = days.map(d => {
    const v = byDay[d];
    return '<tr><td>' + d + '</td><td>' + v.runs + '</td><td>' + v.in.toLocaleString() +
           '</td><td>' + v.out.toLocaleString() + '</td><td>$' + v.cost.toFixed(4) + '</td></tr>';
  }).join('');
}

init();
</script>
</body>
</html>`;

// ── Request handler ────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean);  // ['api','monitors','id','refresh']

  try {
    // GET /
    if (parts.length === 0 && method === 'GET') {
      return respond(res, 200, HTML, 'text/html; charset=utf-8');
    }

    // GET /api/monitors
    if (parts[0]==='api' && parts[1]==='monitors' && !parts[2] && method==='GET') {
      const data = readMonitors();
      return respond(res, 200, JSON.stringify(data.monitors));
    }

    // POST /api/monitors  (create)
    if (parts[0]==='api' && parts[1]==='monitors' && !parts[2] && method==='POST') {
      const body = JSON.parse(await readBody(req));
      const rangeErr = validateLegDateRange(body.outbound, 'Outbound') ?? validateLegDateRange(body.return, 'Return');
      if (rangeErr) return respond(res, 400, JSON.stringify({ error: rangeErr }));
      const monitor: Monitor = {
        id: crypto.randomUUID(),
        label: body.label,
        cabins: body.cabins,
        source: body.source ?? 'awards',
        availType: body.availType ?? 'rewards',
        outbound: body.outbound,
        return: body.return,
        createdAt: new Date().toISOString(),
      };
      const data = readMonitors();
      data.monitors.push(monitor);
      writeMonitors(data);
      return respond(res, 201, JSON.stringify(monitor));
    }

    // PUT /api/monitors/:id  (edit — resets tracking if core fields changed)
    if (parts[0]==='api' && parts[1]==='monitors' && parts[2] && !parts[3] && method==='PUT') {
      const id = parts[2];
      const body = JSON.parse(await readBody(req));
      const rangeErr = validateLegDateRange(body.outbound, 'Outbound') ?? validateLegDateRange(body.return, 'Return');
      if (rangeErr) return respond(res, 400, JSON.stringify({ error: rangeErr }));
      const data = readMonitors();
      const monitor = data.monitors.find(m => m.id === id);
      if (!monitor) return respond(res, 404, '{"error":"Not found"}');

      const coreChanged =
        body.outbound.origin      !== monitor.outbound.origin      ||
        body.outbound.destination !== monitor.outbound.destination  ||
        body.outbound.dateFrom    !== monitor.outbound.dateFrom     ||
        body.outbound.dateTo      !== monitor.outbound.dateTo       ||
        body.return.origin        !== monitor.return.origin         ||
        body.return.destination   !== monitor.return.destination    ||
        body.return.dateFrom      !== monitor.return.dateFrom       ||
        body.return.dateTo        !== monitor.return.dateTo         ||
        (body.availType ?? 'rewards') !== (monitor.availType ?? 'rewards') ||
        JSON.stringify((body.cabins||[]).sort()) !== JSON.stringify((monitor.cabins||[]).sort());

      monitor.label     = body.label;
      monitor.cabins    = body.cabins;
      monitor.source    = body.source ?? 'awards';
      monitor.availType = body.availType ?? 'rewards';
      monitor.outbound  = body.outbound;
      monitor.return    = body.return;

      if (coreChanged) {
        delete monitor.currentCombined;
        delete monitor.lowestCombined;
        delete monitor.knownSlots;
        delete monitor.lastOutbound;
        delete monitor.lastReturn;
        delete monitor.lastChecked;
        delete monitor.currentCash;
        delete monitor.lowestCash;
        delete monitor.cashPending;
        delete monitor.cashRequestedAt;
      }

      writeMonitors(data);
      return respond(res, 200, JSON.stringify(monitor));
    }

    // POST /api/monitors/refresh-all
    if (parts[0]==='api' && parts[1]==='monitors' && parts[2]==='refresh-all' && method==='POST') {
      await refreshAll();
      const data = readMonitors();
      return respond(res, 200, JSON.stringify(data.monitors));
    }

    // POST /api/monitors/:id/refresh
    if (parts[0]==='api' && parts[1]==='monitors' && parts[3]==='refresh' && method==='POST') {
      const id = parts[2];
      const data = readMonitors();
      const monitor = data.monitors.find(m => m.id === id);
      if (!monitor) return respond(res, 404, '{"error":"Not found"}');
      if (monitor.source === 'cash') {
        monitor.cashPending = true;
        monitor.cashRequestedAt = new Date().toISOString();
        writeCashRequest(monitor);
        writeMonitors(data);
      } else {
        const alerts = await refreshMonitor(monitor);
        if (alerts.length > 0) appendAlert(monitor.id, monitor.label, alerts);
        writeMonitors(data);
      }
      return respond(res, 200, JSON.stringify(monitor));
    }

    // DELETE /api/monitors/:id
    if (parts[0]==='api' && parts[1]==='monitors' && parts[2] && !parts[3] && method==='DELETE') {
      const id = parts[2];
      const data = readMonitors();
      data.monitors = data.monitors.filter(m => m.id !== id);
      writeMonitors(data);
      return respond(res, 200, '{"ok":true}');
    }

    // GET /api/scheduled-tasks — merge IPC snapshot (source of truth) with metadata file
    if (parts[0]==='api' && parts[1]==='scheduled-tasks' && method==='GET') {
      try {
        const raw: {id:string;groupFolder:string;prompt:string;schedule_type:string;schedule_value:string;status:string;next_run:string|null}[] =
          fs.existsSync(TASKS_FILE) ? JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8')) : [];
        // Load optional metadata (human-readable names/descriptions from Weon)
        type TaskMeta = {id:string;name:string;description:string;scheduleDisplay:string;status:string};
        let meta: TaskMeta[] = [];
        try { meta = JSON.parse(fs.readFileSync(TASKS_META_FILE, 'utf-8')).tasks || []; } catch { /* ignore */ }
        const metaById = Object.fromEntries(meta.map(m => [m.id, m]));
        const merged = raw.map(t => ({
          ...t,
          name: metaById[t.id]?.name || null,
          description: metaById[t.id]?.description || null,
          scheduleDisplay: metaById[t.id]?.scheduleDisplay || null,
        }));
        return respond(res, 200, JSON.stringify(merged));
      } catch { return respond(res, 200, '[]'); }
    }

    // GET /api/usage
    if (parts[0]==='api' && parts[1]==='usage' && method==='GET') {
      try {
        const raw = fs.existsSync(USAGE_FILE) ? fs.readFileSync(USAGE_FILE, 'utf-8') : '{"runs":[],"totals":{"inputTokens":0,"outputTokens":0,"costUsd":0}}';
        return respond(res, 200, raw);
      } catch { return respond(res, 200, '{"runs":[],"totals":{"inputTokens":0,"outputTokens":0,"costUsd":0}}'); }
    }

    respond(res, 404, '{"error":"Not found"}');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Error:', msg);
    respond(res, 500, JSON.stringify({ error: msg }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Qantas Award Monitor → http://100.114.240.29:${PORT}`);
});
