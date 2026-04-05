// Stores all flights keyed by FDPS GUFI. Provides stats and query methods.
// Persists to disk periodically and loads on startup.

const fs = require('fs');
const path = require('path');

const STALE_MS = 4 * 60 * 60 * 1000; // remove flights not updated in 4 hours
const CACHE_INTERVAL_MS = 60_000;     // save cache every 60s

class FlightStore {
  constructor(cacheDir) {
    this.flights = new Map();
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

    const existing = this.flights.get(key);
    if (existing) {
      for (const [k, v] of Object.entries(plan)) {
        if (v !== null && v !== undefined) {
          existing[k] = v;
        }
      }
      existing.lastUpdated = Date.now();
      return existing;
    }

    plan.lastUpdated = Date.now();
    this.flights.set(key, plan);
    return plan;
  }

  getAll() {
    return Array.from(this.flights.values());
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
