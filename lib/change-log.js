'use strict';

/**
 * What changed, when, and through which door — in the live log and in a log that survives
 * a restart.
 *
 * Asked after issue #35, where a battery mode had changed and nobody could say how: the live
 * log covered the writes to the device, but not a settings page saved with something that
 * only the app uses, not a flow card the app refused, not the EMS switch, and not a value
 * changed in the FusionSolar app. And the live log is a ring of 1500 lines in memory, gone
 * with the next restart or update. So there are three doors, each logged in one place:
 *
 *   - the device settings page: withSettingsLog wraps a device class's onSettings once and
 *     writes "Settings saved: …" after Homey accepted the page, "Settings not saved: …" when
 *     onSettings refused it;
 *   - flow cards: wrapFlowCards wraps homey.flow.getActionCard, so every action card logs
 *     its arguments when it runs and the reason when it is refused, whoever registered it;
 *   - the device itself: applySettingSync stores what the poll read and logs a value that
 *     moved ("Setting follows the device"); lib/mode-settings.js does the same for modes.
 *
 * Each of those also goes into the device's change log: the last RING_MAX entries in the
 * device store, read by GET /changes and shown in Settings → Logs. A flow that runs every
 * minute must not push everything else out, so a repeat of the same entry within
 * COALESCE_MS replaces the last one and counts up, and the store is written at most once a
 * minute for new entries and once every COALESCE_MS for counted repeats.
 */

const STORE_KEY = 'change_log';
const RING_MAX = 50;
const COALESCE_MS = 15 * 60 * 1000;
const NEW_FLUSH_MS = 60 * 1000;

// The same words the "Copy configuration" button redacts (settings/index.html), so a pasted
// log can never carry a password, key, code or user name the copied configuration would not.
const SECRET_RE = /key|secret|password|token|code|credential|user/i;

// Cards that feed data rather than change anything: one line in the live log each, but kept
// out of the change log, where an hourly price feed would push the real changes out.
const FEED_CARDS = new Set(['ems_set_electricity_price', 'ems_set_price_forecast']);

const fmt = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (v === true) return 'on';
  if (v === false) return 'off';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  return /^-?\d+(\.\d+)?$/.test(s) ? s : JSON.stringify(s.length > 60 ? `${s.slice(0, 57)}…` : s);
};

const same = (a, b) => {
  if (a === b) return true;
  const x = Number(a), y = Number(b);
  return a !== '' && b !== '' && a !== null && b !== null && Number.isFinite(x) && Number.isFinite(y) && x === y;
};

// The setting definitions of a device's own driver, from the manifest — for dropdown names.
function manifestSettings(device) {
  try {
    const id = device.driver && device.driver.id;
    const d = device.homey.manifest.drivers.find((x) => x.id === id);
    const flat = (l) => (l || []).flatMap((x) => (x.type === 'group' ? flat(x.children) : [x]));
    return Object.fromEntries(flat(d && d.settings).map((s) => [s.id, s]));
  } catch (_) {
    return {};
  }
}

function settingsChange(device, { oldSettings = {}, newSettings = {}, changedKeys = [] }) {
  const defs = manifestSettings(device);
  return changedKeys.map((key) => {
    const def = defs[key] || {};
    if (def.type === 'password' || SECRET_RE.test(key)) return `${key} (changed)`;
    const to = newSettings[key];
    const label = def.values && (def.values.find((v) => v.id === String(to)) || {}).label;
    return `${key} ${fmt(oldSettings[key])} → ${fmt(to)}${label && label.en ? ` = ${label.en}` : ''}`;
  }).join(', ');
}

// ── the change log in the device store ────────────────────────────────────────

function ring(device) {
  if (!device._changeLog) {
    let stored = null;
    try { stored = device.getStoreValue(STORE_KEY); } catch (_) { /* no store yet */ }
    device._changeLog = Array.isArray(stored) ? stored : [];
  }
  return device._changeLog;
}

async function flush(device) {
  device._changeLogTimer = null;
  device._changeLogDue = 0;
  try {
    await device.setStoreValue(STORE_KEY, ring(device));
  } catch (err) {
    device.log('change log not stored:', err.message);
  }
}

function scheduleFlush(device, delay) {
  const due = Date.now() + delay;
  if (device._changeLogTimer && device._changeLogDue <= due) return; // a sooner write is already due
  if (device._changeLogTimer) device.homey.clearTimeout(device._changeLogTimer);
  device._changeLogDue = due;
  device._changeLogTimer = device.homey.setTimeout(() => { flush(device).catch(() => {}); }, delay);
}

/**
 * Add an entry to the device's change log. source is 'settings', 'flow', 'device' or
 * 'failed'; key groups repeats (a card id, a setting id) — none for an entry that must
 * always stand on its own, like a saved settings page.
 */
function record(device, source, key, text, now = Date.now()) {
  if (!device || typeof device.getStoreValue !== 'function' || typeof device.setStoreValue !== 'function') return;
  try {
    const r = ring(device);
    const last = r[r.length - 1];
    if (key && last && last.key === key && last.source === source && now - last.t < COALESCE_MS) {
      last.t = now;
      last.text = text;
      last.n = (last.n || 1) + 1;
      scheduleFlush(device, COALESCE_MS);
      return;
    }
    r.push({ t: now, source, key: key || null, text });
    if (r.length > RING_MAX) r.splice(0, r.length - RING_MAX);
    scheduleFlush(device, NEW_FLUSH_MS);
  } catch (err) {
    try { device.log('change log entry dropped:', err.message); } catch (_) { /* nothing left to tell */ }
  }
}

const entries = (device) => {
  try { return ring(device).slice(); } catch (_) { return []; }
};

// ── door 1: the settings page ─────────────────────────────────────────────────

/**
 * Wrap a device class's onSettings once. The line is written after onSettings returned —
 * Homey stores the page only then — and a refused page is logged with the reason.
 */
function withSettingsLog(DeviceClass) {
  const proto = DeviceClass.prototype;
  if (!Object.prototype.hasOwnProperty.call(proto, 'onSettings')) return DeviceClass;
  const original = proto.onSettings;
  if (original.__changeLog) return DeviceClass;
  const wrapped = async function onSettings(args) {
    const change = settingsChange(this, args || {});
    let result;
    try {
      result = await original.call(this, args);
    } catch (err) {
      if (change) {
        const text = `Settings not saved: ${change} — ${err && err.message}`;
        this.log(text);
        record(this, 'failed', null, text);
      }
      throw err;
    }
    if (change) {
      const text = `Settings saved: ${change}`;
      this.log(text);
      record(this, 'settings', null, text);
    }
    return result;
  };
  wrapped.__changeLog = true;
  proto.onSettings = wrapped;
  return DeviceClass;
}

// ── door 2: flow cards ────────────────────────────────────────────────────────

const argValue = (v) => {
  if (v && typeof v === 'object') return fmt(v.name || v.id || '[object]');
  return fmt(v);
};
function flowArgs(args) {
  return Object.entries(args || {})
    .filter(([k]) => k !== 'device')
    .map(([k, v]) => `${k}=${argValue(v)}`)
    .join(', ');
}

/**
 * Wrap every action card the app registers, through homey.flow.getActionCard. Called once,
 * first thing in the app's onInit, before any driver registers a card.
 */
function wrapFlowCards(homey, appLog) {
  const flow = homey && homey.flow;
  if (!flow || typeof flow.getActionCard !== 'function' || flow.getActionCard.__changeLog) return;
  const getActionCard = flow.getActionCard.bind(flow);
  // Logging must never cost a card: if Homey refuses either replacement, the card works
  // unlogged and the reason is in the log once.
  const wrapCard = (id, card) => {
    try {
      const register = card.registerRunListener.bind(card);
      card.registerRunListener = (fn) => register(async (args, state) => {
        const device = args && args.device;
        const log = device && typeof device.log === 'function' ? device.log.bind(device) : appLog;
        const what = flowArgs(args);
        const text = `[flow] ${id}${what ? ` (${what})` : ''}`;
        log(text);
        if (!FEED_CARDS.has(id)) record(device, 'flow', id, text);
        try {
          return await fn(args, state);
        } catch (err) {
          const refused = `[flow] ${id} refused: ${err && err.message}`;
          log(refused);
          record(device, 'failed', `${id}:refused`, refused);
          throw err;
        }
      });
      card.__changeLog = true;
    } catch (err) {
      appLog(`[flow] ${id} not logged:`, err.message);
    }
  };
  const wrappedGet = (id) => {
    const card = getActionCard(id);
    if (card && !card.__changeLog && typeof card.registerRunListener === 'function') wrapCard(id, card);
    return card;
  };
  wrappedGet.__changeLog = true;
  try {
    flow.getActionCard = wrappedGet;
  } catch (err) {
    appLog('flow cards not logged:', err.message);
  }
}

// ── door 3: the device itself ─────────────────────────────────────────────────

/**
 * Store what the poll read into the settings, under the guard that keeps onSettings from
 * writing it straight back, and log every value that actually moved. A setting that held
 * nothing yet is being filled, not changed, and gets no line.
 */
async function applySettingSync(device, updates) {
  const keys = Object.keys(updates || {});
  if (!keys.length) return;
  const before = Object.fromEntries(keys.map((k) => [k, device.getSetting(k)]));
  device._updatingSettingFromModbus = true;
  try {
    await device.setSettings(updates);
  } catch (err) {
    device.log('setSettings sync failed:', err.message);
    return;
  } finally {
    device._updatingSettingFromModbus = false;
  }
  for (const k of keys) {
    const from = before[k];
    if (from === null || from === undefined || from === '' || same(from, updates[k])) continue;
    const text = `Setting follows the device [${k}]: ${fmt(from)} → ${fmt(updates[k])}`;
    device.log(text);
    record(device, 'device', k, text);
  }
}

module.exports = {
  STORE_KEY, RING_MAX, COALESCE_MS, NEW_FLUSH_MS, SECRET_RE, FEED_CARDS,
  record, entries, flush, withSettingsLog, wrapFlowCards, applySettingSync, settingsChange, flowArgs,
};
