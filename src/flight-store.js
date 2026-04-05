// Stores all flights keyed by FDPS GUFI. Provides stats and query methods.
// Persists to disk periodically and loads on startup.

const fs = require('fs');
const path = require('path');

const STALE_MS = 4 * 60 * 60 * 1000; // remove flights not updated in 4 hours
const CACHE_INTERVAL_MS = 60_000;     // save cache every 60s

class FlightStore {
  constructor(cacheDir) {
    this.flights = new Map();
    this.callsignIndex = new Map(); // callsign -> primary key
    this.cacheFile = path.join(cacheDir || process.env.CACHE_DIR || './data', 'flight-cache.json');
    this.loadCache();
    this.pruneInterval = setInterval(() => this.prune(), 60_000);
    this.cacheInterval = setInterval(() => this.saveCache(), CACHE_INTERVAL_MS);
  }

  loadCache() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8'));
        let loaded = 0;
        const now = Date.now();
        for (const flight of data) {
          if (now - flight.lastUpdated < STALE_MS) {
            // Restore dataSources as Set from cached array
            if (Array.isArray(flight.dataSources)) {
              flight.dataSources = new Set(flight.dataSources);
            }
            this.flights.set(flight.fdpsGufi || flight.gufi, flight);
            loaded++;
          }
        }
        console.log(`[Cache] Loaded ${loaded} flights from ${this.cacheFile}`);
      }
    } catch (err) {
      console.error('[Cache] Failed to load:', err.message);
    }
  }

  saveCache() {
    try {
      const dir = path.dirname(this.cacheFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.getAll()));
      console.log(`[Cache] Saved ${this.flights.size} flights`);
    } catch (err) {
      console.error('[Cache] Failed to save:', err.message);
    }
  }

  upsert(plan) {
    const key = plan.fdpsGufi || plan.gufi;
    if (!key) return plan;

    // Try primary key first, then fall back to callsign index
    let existing = this.flights.get(key);
    let foundViaAlias = false;
    if (!existing && plan.callsign) {
      const aliasKey = this.callsignIndex.get(plan.callsign);
      if (aliasKey && aliasKey !== key) {
        existing = this.flights.get(aliasKey);
        if (existing) {
          // Store under both keys so either GUFI resolves
          this.flights.set(key, existing);
          foundViaAlias = true;
        }
      }
    }
    if (existing) {
      // Accumulate data sources
      if (plan.dataSource) {
        if (!existing.dataSources) existing.dataSources = new Set();
        if (typeof existing.dataSources === 'object' && !(existing.dataSources instanceof Set)) {
          existing.dataSources = new Set(existing.dataSources);
        }
        // For ERAM, only keep the most recent centre (replace old ERAM entries)
        if (plan.dataSource.startsWith('ERAM ')) {
          for (const src of existing.dataSources) {
            if (src.startsWith('ERAM ')) existing.dataSources.delete(src);
          }
        }
        existing.dataSources.add(plan.dataSource);
      }

      // Terminal statuses are sticky — don't let them regress
      const terminalStatuses = new Set(['COMPLETED', 'DROPPED']);
      const existingIsTerminal = terminalStatuses.has(existing.flightStatus);

      for (const [k, v] of Object.entries(plan)) {
        if (k === 'dataSources') continue; // managed above
        if (k === 'flightStatus' && existingIsTerminal && !terminalStatuses.has(v)) continue;
        if (v !== null && v !== undefined) {
          existing[k] = v;
        }
      }
      existing.lastUpdated = Date.now();
      if (existing.callsign) this.callsignIndex.set(existing.callsign, key);
      return existing;
    }

    // New flight — init dataSources set
    if (plan.dataSource) {
      plan.dataSources = new Set([plan.dataSource]);
    }

    plan.lastUpdated = Date.now();
    this.flights.set(key, plan);
    if (plan.callsign) this.callsignIndex.set(plan.callsign, key);
    return plan;
  }

  getAll() {
    // Dedupe since one record can be stored under multiple keys
    const seen = new Set();
    const results = [];
    for (const f of this.flights.values()) {
      const id = f.fdpsGufi || f.gufi;
      if (seen.has(id)) continue;
      seen.add(id);
      results.push({
        ...f,
        dataSources: f.dataSources instanceof Set ? [...f.dataSources] : (f.dataSources || []),
      });
    }
    return results;
  }

  getStats() {
    let active = 0, proposed = 0, other = 0;
    for (const f of this.flights.values()) {
      if (f.flightStatus === 'ACTIVE') active++;
      else if (f.flightStatus === 'PROPOSED') proposed++;
      else other++;
    }
    return { total: this.flights.size, active, proposed, other };
  }

  prune() {
    const now = Date.now();
    for (const [key, flight] of this.flights) {
      if (now - flight.lastUpdated > STALE_MS) {
        if (flight.callsign) this.callsignIndex.delete(flight.callsign);
        this.flights.delete(key);
      }
    }
  }

  stop() {
    clearInterval(this.pruneInterval);
    clearInterval(this.cacheInterval);
    this.saveCache();
  }
}

module.exports = FlightStore;
