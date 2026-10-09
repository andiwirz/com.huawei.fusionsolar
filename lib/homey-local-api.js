'use strict';

/**
 * Homey Pro Local REST API client.
 * Authenticates via Bearer token (Homey API Key).
 * Covers Devices, Flows, Advanced Flows, and Apps.
 */

const DEFAULT_TIMEOUT_MS = 8_000;

class HomeyLocalApi {

  /**
   * @param {object} opts
   * @param {import('homey').Homey} opts.homey  - Homey SDK instance (for cloud.getLocalAddress)
   * @param {string}  [opts.apiKey]             - Bearer token; can be updated via setApiKey()
   * @param {number}  [opts.timeout]            - Request timeout in ms (default 8 s)
   */
  constructor({ homey, apiKey = '', timeout = DEFAULT_TIMEOUT_MS } = {}) {
    this._homey    = homey;
    this._apiKey   = apiKey;
    this._timeout  = timeout;
    this._baseUrl  = null; // resolved once from cloud.getLocalAddress()
  }

  setApiKey(apiKey) {
    this._apiKey  = apiKey;
    this._baseUrl = null; // reset so address is re-resolved if key changes
  }

  // ─── Internal request helper ──────────────────────────────────────────

  async _baseUrl_() {
    if (!this._baseUrl) {
      const addr = await this._homey.cloud.getLocalAddress();
      this._baseUrl = `http://${addr}/api`;
    }
    return this._baseUrl;
  }

  async _req(method, path, body) {
    const url        = `${await this._baseUrl_()}${path}`;
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), this._timeout);

    const opts = {
      method,
      headers: { Authorization: `Bearer ${this._apiKey}` },
      signal: controller.signal,
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    try {
      const res  = await fetch(url, opts);
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path}: ${text.slice(0, 300)}`);
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (e) {
        // A 2xx with a non-JSON body (proxy error page, truncated response, …) —
        // surface a clear, contextual error instead of a bare "Unexpected token".
        throw new Error(`Invalid JSON from ${method} ${path}: ${text.slice(0, 200)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Devices ─────────────────────────────────────────────────────────

  /** Returns all devices of all apps as { [id]: DeviceObj } */
  async getDevices() {
    return this._req('GET', '/manager/devices/device');
  }

  /** Returns a single device object */
  async getDevice(deviceId) {
    return this._req('GET', `/manager/devices/device/${deviceId}`);
  }

  /** Reads a single capability value (returns null on error) */
  async getCapability(deviceId, capabilityId) {
    try {
      const device = await this._req('GET', `/manager/devices/device/${deviceId}`);
      const capObj = device?.capabilitiesObj || device?.capabilities || {};
      const entry  = !Array.isArray(capObj) ? capObj[capabilityId] : null;
      if (entry !== null && entry !== undefined) {
        return typeof entry === 'object' ? (entry.value ?? null) : entry;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Writes a capability value */
  async setCapability(deviceId, capabilityId, value) {
    try {
      await this._req('PUT', `/manager/devices/device/${deviceId}/capability/${capabilityId}`, { value });
    } catch (err) {
      this._homey.log(`[HomeyAPI] setCapability ${capabilityId} on ${deviceId}: ${err.message}`);
    }
  }

  // ─── Flow Folders ────────────────────────────────────────────────────

  /** Returns all flow folders as { [id]: FolderObj } */
  async getFlowFolders() {
    return this._req('GET', '/manager/flow/flowfolder');
  }

  /** Creates a flow folder; returns the new FolderObj */
  async createFlowFolder(folder) {
    return this._req('POST', '/manager/flow/flowfolder', folder);
  }

  // ─── Flows ───────────────────────────────────────────────────────────

  /** Returns all standard flows as { [id]: FlowObj } */
  async getFlows() {
    return this._req('GET', '/manager/flow/flow');
  }

  /** Creates a standard flow; returns the new FlowObj */
  async createFlow(flow) {
    return this._req('POST', '/manager/flow/flow', flow);
  }

  /** Deletes a standard flow by ID */
  async deleteFlow(flowId) {
    return this._req('DELETE', `/manager/flow/flow/${flowId}`);
  }

  /** Triggers a standard flow by ID */
  async triggerFlow(flowId) {
    return this._req('POST', `/manager/flow/flow/${flowId}/trigger`, {});
  }

  /** Returns all available flow action cards as { [id]: CardObj } */
  async getFlowActionCards() {
    return this._req('GET', '/manager/flow/flowcardaction');
  }

  /** Returns all available flow trigger cards as { [id]: CardObj } */
  async getFlowTriggerCards() {
    return this._req('GET', '/manager/flow/flowcardtrigger');
  }

  /** Returns all available flow condition cards as { [id]: CardObj } */
  async getFlowConditionCards() {
    return this._req('GET', '/manager/flow/flowcardcondition');
  }

  /** Returns one standard flow by id */
  async getFlow(flowId) {
    return this._req('GET', `/manager/flow/flow/${encodeURIComponent(flowId)}`);
  }

  /** Returns all advanced flows (Homey Pro) as { [id]: FlowObj } */
  async getAdvancedFlows() {
    return this._req('GET', '/manager/flow/flowadv');
  }

  /** Creates an advanced flow; returns the new FlowObj */
  async createAdvancedFlow(flow) {
    return this._req('POST', '/manager/flow/flowadv', flow);
  }

  /** Deletes an advanced flow by ID */
  async deleteAdvancedFlow(flowId) {
    return this._req('DELETE', `/manager/flow/flowadv/${flowId}`);
  }

  /** Triggers an advanced flow by ID */
  async triggerAdvancedFlow(flowId) {
    return this._req('POST', `/manager/flow/flowadv/${flowId}/trigger`, {});
  }

  // ─── Apps ────────────────────────────────────────────────────────────

  /** Returns all installed apps as { [id]: AppObj } */
  async getApps() {
    return this._req('GET', '/manager/apps/app');
  }

  /** Returns a single app object */
  async getApp(appId) {
    return this._req('GET', `/manager/apps/app/${appId}`);
  }

  /** Enables or disables an app */
  async setAppEnabled(appId, enabled) {
    return this._req('PUT', `/manager/apps/app/${appId}/enabled`, { enabled });
  }

  /** Restarts an app */
  async restartApp(appId) {
    return this._req('POST', `/manager/apps/app/${appId}/restart`, {});
  }

}

module.exports = HomeyLocalApi;
