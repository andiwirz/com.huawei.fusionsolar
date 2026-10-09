'use strict';

const {
  login,
  getStationRealKpi,
  getDevList,
  getDevRealKpi,
} = require('./openapi-client');

const DEFAULT_BASE_URL      = 'https://eu5.fusionsolar.huawei.com';
const DEFAULT_INTERVAL_MIN  = 5;
const MIN_INTERVAL_MIN      = 5;
const INTER_REQUEST_DELAY   = 1500; // ms between sequential API calls to avoid 407

// Huawei's traffic-limiting policy names two kinds of refusal and prescribes a different
// answer to each. 407 is this user calling one interface too often — "lower your frequency
// of calls to this API until the frequency drops to the allowed range". 403 and 429 are the
// system as a whole being busy — "wait for 1 minute and try again".
//
// Neither is a device that stopped reporting, which is what both used to look like from
// here: getDevRealKpi returns a refusal as an empty device list, an empty list fed the
// starved check, and the check took the device offline saying "No data from FusionSolar for
// device type 39". A plant in #28 was read that way for days while its battery answered
// perfectly well.
const RATE_LIMIT_USER   = new Set([407]);
const RATE_LIMIT_SYSTEM = new Set([403, 429]);
const isRateLimit = (code) => RATE_LIMIT_USER.has(code) || RATE_LIMIT_SYSTEM.has(code);

// The allowance for getDevRealKpi, from section 3.1.6.1 of the northbound API guide:
//
//   calls per 5 minutes = Σ over device types of Roundup(devices of that type / 100)
//
// On any household plant that is one call per device type per five minutes — which is one
// poll cycle's worth, since this coordinator makes one call per type. The allowance and the
// poll shape cancel, and a five-minute floor falls out of the arithmetic.
//
// Only getDevRealKpi is covered. getStationRealKpi, getDevList and login each carry their
// own restriction and this app has no figures for those; they are called at most once per
// cycle and are left out of the sum rather than guessed at.
const DEV_KPI_WINDOW_MS = 5 * 60 * 1000;
const devKpiAllowance = (idsByType) =>
  Object.values(idsByType || {}).reduce((n, ids) => n + Math.ceil((ids.length || 0) / 100), 0);
const INITIAL_POLL_DELAY_MS = 10_000; // wait for all devices to register on boot
// How long a cached reading may stand in for a live one. Three poll cycles: long enough to
// ride out a single failed call or a brief cloud hiccup, short enough that a permanent
// fault is noticed within a quarter of an hour rather than after half a day. Field report
// (issue #26): with no limit at all, a battery sat at 22 % for hours while the official app
// showed it charging, and nothing on screen suggested the figure was old.
const MAX_STALE_MS = 3 * MIN_INTERVAL_MIN * 60_000;
// The device list (getDevList) is what every later decision stands on. Until 1.2.280 it was
// fetched once per app start, so one empty or incomplete answer stayed until the next
// restart. Now it is fetched again once a day, and once more after DEV_LIST_RETRY_MS while a
// registered device finds none of its types in it — a passing gap is closed, not kept.
const DEV_LIST_MAX_AGE_MS = 24 * 60 * 60_000;
const DEV_LIST_RETRY_MS   = 15 * 60_000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── StationSession ──────────────────────────────────────────────────────────
//
// Manages all polling for a single station code. Multiple device instances
// (inverter, battery, meter) share one session → one API call set per interval.

class StationSession {

  constructor(homey, stationCode) {
    this._homey            = homey;
    this._stationCode      = stationCode;
    this._devices          = new Set();
    this._token            = null;
    this._devIdsByType     = null;
    // typeId -> the reason last logged for an empty answer, so a type that stays empty says
    // so once rather than every poll, and says so again when the reason changes.
    this._loggedEmptyReason = {};
    this._loggedAllowance   = false;
    this._lastStationKpi    = null;  // { kpi, at } — kept for the diagnostic report
    this._backoffUntil     = 0;
    this._timer            = null;
    this._initialTimer     = null;
    this._fetchInProgress  = false;
    this._lastPollAt       = 0;
    // typeId -> { maps, at }. The timestamp is the point: without it a reading from six
    // hours ago is served exactly like one from five minutes ago.
    this._lastGoodKpiByType = {};
    // typeId -> consecutive cycles that brought nothing. After a start there is no cache to
    // bridge with, and one empty answer used to mark the device as having no data at once.
    this._emptyStreak       = {};
    this._devIdsAt          = 0;         // when the device list was last fetched
    this._devListFetches    = 0;         // how many lists have been fetched since start
    // device -> the list number in which it first found none of its types. Absent from a
    // later list as well, it is absent for real; absent from one, it is looked up again.
    this._absentSince       = new Map();
    this._staleSince        = null;  // first poll that brought nothing fresh at all
    this._lastFailMessage   = null;  // why, in words a user can act on
    this._staleAnnounced    = false; // so the log says it once, not every five minutes
  }

  addDevice(device) {
    this._devices.add(device);
    this._restartTimer();
    this._scheduleInitialPoll();
  }

  removeDevice(device) {
    this._devices.delete(device);
    this._absentSince.delete(device);
    if (this._devices.size === 0) {
      this._stopTimer();
    } else {
      this._restartTimer();
    }
  }

  isEmpty() { return this._devices.size === 0; }

  /**
   * Everything this session last received, so a diagnostic can show it without spending a
   * single API call.
   *
   * getDevRealKpi is allowed Σ Roundup(devices per type / 100) calls every five minutes —
   * one per device type on a household plant — and the poller already uses one per type per
   * cycle. A diagnostic that fetches the same types again is asking for a second helping of
   * a budget that was exactly one helping wide, which is why running it produced failCode
   * 407 on the last type and, before the reason was surfaced, an empty list that read as a
   * missing device.
   *
   * Ages travel with the values. A reading of unstated age is the thing this app refuses to
   * draw anywhere else, and a diagnostic is the last place to start.
   */
  snapshot() {
    const kpiByType = {};
    for (const [typeId, entry] of Object.entries(this._lastGoodKpiByType || {})) {
      if (entry && entry.maps) kpiByType[typeId] = { maps: entry.maps, at: entry.at };
    }
    return {
      stationCode:  this._stationCode,
      devIdsByType: this._devIdsByType || {},
      stationKpi:   this._lastStationKpi ? this._lastStationKpi.kpi : null,
      stationKpiAt: this._lastStationKpi ? this._lastStationKpi.at : null,
      kpiByType,
      intervalMs:   this._intervalMs(),
    };
  }

  /**
   * Stand aside, so a diagnostic run has the call allowance to itself.
   *
   * Reuses the same field the rate-limit backoff sets: _ensureToken refuses to log in while
   * it is in the future, which stops a poll before it makes any call at all. A second
   * mechanism for "do not poll right now" would be a second thing to keep in step.
   */
  pausePolling(ms) {
    this._backoffUntil = Math.max(this._backoffUntil, Date.now() + ms);
  }

  invalidateToken()      { this._token = null; }
  invalidateDeviceList() { this._devIdsByType = null; }

  triggerPoll() {
    this._poll().catch((err) => this._homey.error('[Coordinator] Triggered poll error:', err.message));
  }

  _scheduleInitialPoll() {
    if (this._initialTimer) this._homey.clearTimeout(this._initialTimer);
    this._initialTimer = this._homey.setTimeout(() => {
      this._initialTimer = null;
      this._poll().catch((err) => this._homey.error('[Coordinator] Initial poll error:', err.message));
    }, INITIAL_POLL_DELAY_MS);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _intervalMs() {
    let min = DEFAULT_INTERVAL_MIN;
    for (const d of this._devices) {
      const v = parseInt(d.getSetting('poll_interval'), 10);
      if (Number.isFinite(v) && v >= MIN_INTERVAL_MIN && v < min) min = v;
    }
    return min * 60 * 1000;
  }

  // The region dropdown carries the URL as its own value, so resolving it is a choice
  // between the two fields — no second copy of the server list anywhere.
  static resolveBaseUrl(read) {
    const region = read('base_url_region');
    const raw = (region && region !== 'custom') ? region : read('base_url');
    return (raw || DEFAULT_BASE_URL).trim().replace(/\/$/, '');
  }

  _getCredentials() {
    for (const d of this._devices) {
      const baseUrl    = StationSession.resolveBaseUrl((k) => d.getSetting(k));
      const username   = d.getSetting('username');
      const systemCode = d.getSetting('system_code');
      if (username && systemCode) return { baseUrl, username, systemCode };
    }
    return null;
  }

  // One session serves every device sharing a station code, and _getCredentials() takes
  // whichever of them comes first. So changing the server or the credentials on any other
  // device changed nothing at all — silently, while its settings page cheerfully showed
  // the new value. Copying the edit onto the siblings makes it not matter which device you
  // opened, and it survives a restart; a "the last edit wins" rule would not, because
  // after a restart the first device would win again with its stale value.
  //
  // Reads from newSettings when given: onSettings runs BEFORE Homey persists, so
  // getSetting() would still hand back the old value here.
  async adoptCredentialsFrom(device, newSettings) {
    const KEYS = ['base_url_region', 'base_url', 'username', 'system_code'];
    const read = (k) => ((newSettings && k in newSettings) ? newSettings[k] : device.getSetting(k));
    const src  = {};
    for (const k of KEYS) src[k] = read(k);

    for (const d of this._devices) {
      if (d === device) continue;
      const patch = {};
      for (const k of KEYS) if (d.getSetting(k) !== src[k]) patch[k] = src[k];
      if (!Object.keys(patch).length) continue;
      try {
        await d.setSettings(patch);
        this._homey.log(`[Coordinator] ${d.getName()}: adopted ${Object.keys(patch).join(', ')} from ${device.getName()}`);
      } catch (err) {
        this._homey.error(`[Coordinator] ${d.getName()}: could not adopt settings — ${err.message}`);
      }
    }
  }

  _restartTimer() {
    this._stopTimer();
    this._timer = this._homey.setInterval(
      () => this._poll().catch((err) => this._homey.error('[Coordinator] Poll error:', err.message)),
      this._intervalMs(),
    );
  }

  _stopTimer() {
    if (this._timer) {
      this._homey.clearInterval(this._timer);
      this._timer = null;
    }
    if (this._initialTimer) {
      this._homey.clearTimeout(this._initialTimer);
      this._initialTimer = null;
    }
  }

  async _ensureToken(creds) {
    if (this._token) return this._token;
    const remaining = this._backoffUntil - Date.now();
    if (remaining > 0) {
      throw new Error(`Rate limited — login paused for ${Math.ceil(remaining / 60000)} more minute(s)`);
    }
    this._token = await login(creds.baseUrl, creds.username, creds.systemCode);
    return this._token;
  }

  async _withAutoRelogin(creds, fn) {
    const token  = await this._ensureToken(creds);
    let   result = await fn(token);
    // Only re-login once per poll cycle — if we already refreshed the token
    // this poll, don't attempt another login even if the API still returns expired.
    if (result.expired && !this._tokenRefreshedThisPoll) {
      this._tokenRefreshedThisPoll = true;
      this._token = null;
      result      = await fn(await this._ensureToken(creds));
    }
    return result;
  }

  // The types of this plant a device reads from — none means the plant does not list it.
  _presentTypes(device) {
    const types = typeof device.getDevTypes === 'function' ? device.getDevTypes() : [];
    return types.filter((t) => ((this._devIdsByType || {})[t] || []).length);
  }

  _absenceConfirmed(device) {
    return this._absentSince.has(device) && this._devListFetches > this._absentSince.get(device);
  }

  async _ensureDevIds(creds, now = Date.now()) {
    const age = now - this._devIdsAt;
    const lookAgain = this._devIdsByType && age >= DEV_LIST_RETRY_MS
      && [...this._devices].some((d) => !this._presentTypes(d).length && !this._absenceConfirmed(d));
    if (this._devIdsByType && age < DEV_LIST_MAX_AGE_MS && !lookAgain) return;

    const byType = await this._loadDevList(creds);
    const count  = Object.values(byType).reduce((n, ids) => n + ids.length, 0);
    const had    = Object.values(this._devIdsByType || {}).some((ids) => ids.length);
    if (!count && had) {
      // An empty answer never replaces a list that had devices in it: that would take every
      // device of the plant offline on the strength of one reply.
      this._devIdsAt = now;
      this._homey.log(`[Coordinator] Device list for ${this._stationCode} came back empty — keeping the one from before`);
      return;
    }
    this._devIdsByType   = byType;
    this._devIdsAt       = now;
    this._devListFetches += 1;
    this._homey.log(`[Coordinator] Device list for ${this._stationCode}:`,
      JSON.stringify(Object.fromEntries(
        Object.entries(this._devIdsByType).map(([k, v]) => [k, v.length]),
      )));
  }

  async _loadDevList(creds) {
    const { devices } = await this._withAutoRelogin(creds,
      (t) => getDevList(creds.baseUrl, t, this._stationCode),
    );
    // devTypeId reference (from Huawei SmartPVMS Northbound API):
    //   1   – string inverter (SUN2000)
    //   2   – SmartLogger
    //   8   – STS
    //   10  – EMI
    //   13  – protocol converter
    //   16  – general device
    //   17  – grid meter (DTSU666)
    //   22  – PID
    //   37  – Pinnet data logger
    //   38  – residential inverter
    //   39  – battery (LUNA2000 residential)
    //   40  – backup box
    //   41  – ESS (C&I / utility battery)
    //   45  – PLC
    //   46  – optimizer
    //   47  – power sensor
    //   62  – Dongle
    //   63  – distributed SmartLogger
    //   70  – safety box
    //   60001 – mains
    //   60003 – genset
    //   60043 – SSU group
    //   60044 – SSU
    //   60092 – power converter
    //   60014 – lithium battery rack
    //   60010 – AC output power distribution
    //   23070 – SmartAssistant
    const byType = {};
    for (const d of devices || []) {
      const typeId = Number(d.devTypeId);
      if (!byType[typeId]) byType[typeId] = [];
      if (d.id) byType[typeId].push(String(d.id));
    }
    return byType;
  }

  async _poll() {
    if (this._fetchInProgress || this._devices.size === 0) return;

    // Minimum gap guard — prevent polls closer than the configured interval
    const now = Date.now();
    const minGap = this._intervalMs();
    if (this._lastPollAt && (now - this._lastPollAt) < minGap * 0.8) return;

    this._fetchInProgress        = true;
    this._lastPollAt             = now;
    this._tokenRefreshedThisPoll = false;

    const creds = this._getCredentials();
    if (!creds) { this._fetchInProgress = false; return; }

    try {
      // 1. Station-level KPI
      const stationResult = await this._withAutoRelogin(creds,
        (t) => getStationRealKpi(creds.baseUrl, t, this._stationCode, (m) => this._homey.log(m)),
      );
      const stationKpi = stationResult.kpi || null;
      if (stationKpi) this._lastStationKpi = { kpi: stationKpi, at: Date.now() };

      // 2. Device list — fetched once, then daily, and sooner while a device is missing from it
      await this._ensureDevIds(creds, now);

      // 3. Collect all dev types needed across registered devices
      const neededTypes = new Set();
      for (const device of this._devices) {
        for (const type of device.getDevTypes()) neededTypes.add(type);
      }

      // 4. Fetch device KPIs for each needed type (with delay between calls)
      const kpiByType = {};
      const freshKpiByType = {}; // only types with live API data this poll cycle
      const rateLimited = new Map(); // typeId -> { failCode, failMessage }, refused this cycle
      const graceTypes  = new Set(); // empty for the first time with nothing cached — one more cycle
      let requestCount = 0;
      for (const typeId of neededTypes) {
        const ids = this._devIdsByType[typeId] || [];
        if (!ids.length) continue;
        // Overridable so a test can run a multi-type poll without waiting out the real
        // pacing; production never sets it.
        if (requestCount > 0) await sleep(this._interRequestDelayMs ?? INTER_REQUEST_DELAY);
        const result = await this._withAutoRelogin(creds,
          (t) => getDevRealKpi(creds.baseUrl, t, ids, typeId),
        );
        const maps = result.devices.map((d) => d.dataItemMap).filter(Boolean);
        if (maps.length) {
          kpiByType[typeId] = maps;
          freshKpiByType[typeId] = maps;
          this._lastGoodKpiByType[typeId] = { maps, at: Date.now() };
          // Kept honest rather than load-bearing: after an answer there is a cache, and the
          // grace below needs none — so no outcome depends on this reset today.
          this._emptyStreak[typeId] = 0;
          // Cleared so a later dry spell is reported afresh rather than suppressed as a
          // repeat of one that has since ended.
          delete this._loggedEmptyReason[typeId];
        } else {
          this._emptyStreak[typeId] = (this._emptyStreak[typeId] || 0) + 1;
          // Why, where Huawei says why. Without this the log shows a device going
          // unavailable with no cause, and a permission problem reads exactly like a
          // transient outage — see the note in lib/openapi-client.js.
          if (isRateLimit(result.failCode)) {
            rateLimited.set(typeId, { failCode: result.failCode, failMessage: result.failMessage });
          }
          const reason = result.failCode
            ? `failCode ${result.failCode}: ${result.failMessage}`
            : 'the API answered successfully with an empty list';
          if (this._loggedEmptyReason[typeId] !== reason) {
            this._loggedEmptyReason[typeId] = reason;
            this._homey.log(`[Coordinator] No devices for type ${typeId} — ${reason}`);
          }
          const cached = this._lastGoodKpiByType[typeId];
          const ageMs  = cached ? Date.now() - cached.at : Infinity;
          if (cached && ageMs <= MAX_STALE_MS) {
            // Bridging a gap, not papering over one: the reading is recent enough that
            // showing it is still the honest answer.
            kpiByType[typeId] = cached.maps;
            this._homey.log(`[Coordinator] Using cached KPI for type ${typeId} (${Math.round(ageMs / 1000)}s old)`);
          } else if (cached) {
            // Past the limit the cache is dropped rather than served. Handing the device
            // a value this old is worse than handing it nothing: nothing is visible as
            // nothing, an old number is indistinguishable from a measurement.
            delete this._lastGoodKpiByType[typeId];
            this._homey.log(`[Coordinator] Dropped cached KPI for type ${typeId} — ${Math.round(ageMs / 60_000)} min old`);
          } else if (this._emptyStreak[typeId] === 1) {
            // Nothing cached — right after a start, or a type that never answered yet — and
            // this is the first empty answer. One cycle of grace: a single passing gap after a
            // restart used to take a working battery offline (the dev note's D2). A cache
            // dropped for age above gets none — a value that old must not stay on screen (#26).
            graceTypes.add(typeId);
            this._homey.log(`[Coordinator] Type ${typeId} answered empty with nothing cached — one more cycle before its devices count as without data`);
          }
        }
        requestCount++;
      }

      // Did this cycle bring anything at all? A failed station KPI does not throw — it
      // returns kpi:null — and a failed device KPI returns an empty list, so the catch
      // below never sees an access failure. Without this check the loop went on calling
      // setAvailable() on every poll, which does not merely fail to flag stale data: it
      // actively asserts the device is fine while serving figures from hours ago.
      const gotSomething = stationKpi !== null || Object.keys(freshKpiByType).length > 0;
      if (gotSomething) {
        this._staleSince      = null;
        this._lastFailMessage = null;
      } else {
        if (this._staleSince === null) this._staleSince = Date.now();
        if (stationResult.failMessage) this._lastFailMessage = stationResult.failMessage;
      }
      const staleMs = this._staleSince === null ? 0 : Date.now() - this._staleSince;
      const tooStale = staleMs > MAX_STALE_MS;
      if (tooStale && !this._staleAnnounced) {
        this._staleAnnounced = true;
        this._homey.error(`[Coordinator] Station ${this._stationCode}: nothing fresh for `
          + `${Math.round(staleMs / 60_000)} min — ${this._lastFailMessage || 'no data from the API'}`);
      }
      if (!tooStale) this._staleAnnounced = false;

      // A type this plant HAS devices for, which ended this cycle with nothing to serve:
      // either it came back empty and there was no cache, or the cache was just dropped
      // for being too old. Both are decided above, so this needs no clock of its own.
      //
      // The station-wide staleness check answers "is the API talking to us at all", and it
      // is deliberately generous — one type delivering keeps the station healthy. That left
      // a gap the size of a whole device: in a plant reported on 2026-09-02,
      // getDevRealKpi(type=39) returned successfully with zero devices while types 1 and
      // 23070 delivered normally. gotSomething was true, nothing was announced, and the
      // battery kept the last figures it ever received.
      //
      // Which defeats the decision made a few lines up. The cache is dropped rather than
      // served because "an old number is indistinguishable from a measurement" — and then
      // the driver, handed no data, returns early and leaves that same old number standing.
      // The guard has to reach the device, not just the cache.
      // No filter on device ids here: the per-device check below already restricts itself
      // to types this plant owns, and a second copy of that rule is a second place to get
      // it wrong. Hence the plain name — this is "types with nothing to serve", which
      // includes types that were never here.
      // Said once per app start: it changes only when the plant or the interval does, and a
      // line repeated every five minutes is a line nobody reads.
      if (!this._loggedAllowance && requestCount > 0) {
        this._loggedAllowance = true;
        const allowance = devKpiAllowance(this._devIdsByType);
        const perWindow = requestCount * (DEV_KPI_WINDOW_MS / this._intervalMs());
        this._homey.log(`[Coordinator] getDevRealKpi allowance for ${this._stationCode}: `
          + `${allowance} calls / 5 min; this app makes ${requestCount} per poll at `
          + `${Math.round(this._intervalMs() / 60_000)} min = ${perWindow.toFixed(1)} / 5 min`
          + (perWindow > allowance ? ' — OVER the allowance, expect failCode 407' : ''));
      }

      // The 15-minute pause below this function existed only in the catch block, and
      // getDevRealKpi does not throw on a refusal — it returns one as an empty list. So the
      // app went on calling at the same rate while the policy asked it to slow down.
      //
      // Only for 407, which is this user's own frequency. A 403 or 429 is the system being
      // busy, and the policy asks for a minute; the next poll is at least five minutes out,
      // so there is nothing left to pause.
      if ([...rateLimited.values()].some((r) => RATE_LIMIT_USER.has(r.failCode))) {
        this._backoffUntil = Date.now() + 15 * 60 * 1000;
        this._homey.log('[Coordinator] getDevRealKpi rate limit (407) — polling paused 15 minutes');
      }

      // Refused types stay in here. The distinction between "refused" and "went quiet" is
      // drawn at the device below, where the message is chosen, and drawing it twice would
      // be two places to get it wrong: excluding them here as well changed no outcome,
      // because the refusal branch is tested before the starved one.
      const typesWithoutData = new Set([...neededTypes].filter((t) => !kpiByType[t] && !graceTypes.has(t)));

      // 5. Distribute data to all registered devices
      for (const device of this._devices) {
        try {
          await device.onPollData({ stationKpi, kpiByType, freshKpiByType, devIdsByType: this._devIdsByType });

          // Only the types this plant actually has count. A driver naming four types in a
          // plant that owns one must not be called starved because the other three are
          // absent — they were never coming. And a device is starved only when EVERY type
          // it could have read from is dry: the inverter driver also asks for meter types,
          // and losing those is not losing the inverter.
          const types    = typeof device.getDevTypes === 'function' ? device.getDevTypes() : [];
          const present  = this._presentTypes(device);
          const starved  = present.length > 0 && present.every((t) => typesWithoutData.has(t));
          // None of its types in the list at all. A claim about the plant, not about data, so
          // it is made only once a second list says the same — see _ensureDevIds — and then
          // with its own reason. Before 1.2.280 such a device was left alone for good and
          // went on showing the last values it ever had.
          const absent   = types.length > 0 && present.length === 0;
          if (absent && !this._absentSince.has(device)) this._absentSince.set(device, this._devListFetches);
          if (!absent) this._absentSince.delete(device);
          const absentForReal = absent && this._absenceConfirmed(device);
          // Only where nothing else answered: a device reading three types does not go
          // offline because one of them was refused.
          const served   = present.some((t) => kpiByType[t] !== undefined);
          const limited  = served ? [] : present.filter((t) => rateLimited.has(t));

          if (tooStale) {
            await device.setUnavailable(this._lastFailMessage || 'No fresh data from FusionSolar');
          } else if (limited.length) {
            // Nothing to serve is right — there is no reading — but the reason has to be the
            // true one. "No data for device type 39" sent issue #28 hunting a broken battery
            // for days; the battery was fine and the call had been refused.
            await device.setUnavailable(rateLimited.get(limited[0]).failMessage
              || 'FusionSolar rate limit reached — reading again shortly');
          } else if (absentForReal) {
            await device.setUnavailable(
              `FusionSolar lists no device of type ${types.join('/')} for this plant`);
          } else if (starved) {
            await device.setUnavailable(
              `No data from FusionSolar for device type ${present.join('/')}`);
          } else if (absent) {
            // Looked up again before anything is said about it — see _ensureDevIds.
          } else if (!device.getAvailable()) {
            await device.setAvailable();
          }
        } catch (err) {
          this._homey.error(`[Coordinator] onPollData error (${device.getName()}):`, err.message);
        }
      }

    } catch (err) {
      this._homey.error(`[Coordinator] Station ${this._stationCode} poll error:`, err.message);

      if (err.message.includes('407') || err.message.includes('Rate limit')) {
        this._backoffUntil = Date.now() + 15 * 60 * 1000;
        this._token = null;
        this._homey.log('[Coordinator] Rate limit hit — login paused 15 minutes');
      } else if (err.message.includes('Login failed') || err.message.includes('noCredentials')) {
        this._token = null;
      }

      for (const device of this._devices) {
        await device.setUnavailable(err.message).catch(() => {});
      }
    } finally {
      this._fetchInProgress = false;
    }
  }

}

// ─── OpenAPICoordinator ──────────────────────────────────────────────────────

class OpenAPICoordinator {

  constructor(homey) {
    this._homey    = homey;
    this._sessions = new Map(); // stationCode → StationSession
  }

  register(device) {
    const code = device.getSetting('station_code');
    if (!code) return;

    if (!this._sessions.has(code)) {
      this._sessions.set(code, new StationSession(this._homey, code));
    }
    this._sessions.get(code).addDevice(device);
  }

  /** The last poll's data for one station, or null when nothing is paired for it. */
  snapshotFor(stationCode) {
    const session = this._sessions.get(stationCode);
    return session ? session.snapshot() : null;
  }

  /** Hold every station's polling for a while — see StationSession.pausePolling. */
  pauseAll(ms) {
    for (const session of this._sessions.values()) session.pausePolling(ms);
  }

  unregister(device) {
    const code = device.getSetting('station_code');
    if (!code) return;
    const session = this._sessions.get(code);
    if (!session) return;
    session.removeDevice(device);
    if (session.isEmpty()) this._sessions.delete(code);
  }

  // Call when credentials or poll_interval change (but station_code is the same)
  settingsChanged(device, newSettings = null) {
    const code = device.getSetting('station_code');
    const session = this._sessions.get(code);
    if (!session) return;
    session.adoptCredentialsFrom(device, newSettings)
      .catch((err) => this._homey.error('[Coordinator] adopt failed:', err.message));
    // Homey persists the new settings only after onSettings resolves, so getSetting() is
    // still stale at this point — and so is the poll, which reads it. Polling immediately
    // meant logging in against the old server once more and only picking up the change at
    // the next scheduled poll, up to an hour later. A short delay lets the write land.
    this._homey.setTimeout(() => {
      session.invalidateToken();
      session.invalidateDeviceList();
      session.triggerPoll();
    }, 2000);
  }

  // Call when station_code itself changes
  reregister(device, oldStationCode) {
    if (oldStationCode) {
      const old = this._sessions.get(oldStationCode);
      if (old) {
        old.removeDevice(device);
        if (old.isEmpty()) this._sessions.delete(oldStationCode);
      }
    }
    this.register(device);
  }

}

module.exports = OpenAPICoordinator;
// Exported for the tests: resolving the server address is the one piece of this file
// that is pure and worth pinning, since getting it wrong points every API call at the
// wrong host without any error to show for it.
module.exports.StationSession = StationSession;
// Exported so the diagnostic in api.js paces itself by the same number rather than a second
// copy of it. Two different answers to "how fast may we call Huawei" is how the diagnostic
// came to trip a rate limit the poller was built to avoid.
module.exports.INTER_REQUEST_DELAY = INTER_REQUEST_DELAY;
// The diagnostic in api.js works out the same allowance from its own device list, and has
// to arrive at the same number as the poller does — so it borrows the arithmetic rather
// than restating it.
module.exports.DEV_KPI_WINDOW_MS  = DEV_KPI_WINDOW_MS;
module.exports.devKpiAllowance    = devKpiAllowance;
