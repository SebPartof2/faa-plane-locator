// Stores active flow restrictions (ground stops, MIT, APREQ, etc.)
// Keyed by restriction ID. Auto-prunes expired restrictions.

class FlowStore {
  constructor() {
    this.restrictions = new Map(); // id -> restriction
    this.pruneInterval = setInterval(() => this.prune(), 30_000);
  }

  upsert(restriction) {
    const key = restriction.id || `${restriction.category}-${restriction.airport}-${restriction.startTime}`;

    // Action 4 = new/update, action 3 = cancel
    if (restriction.action === '3') {
      this.restrictions.delete(key);
      return null;
    }

    restriction.lastUpdated = Date.now();
    this.restrictions.set(key, restriction);
    return restriction;
  }

  getAll() {
    return Array.from(this.restrictions.values());
  }

  getActive() {
    const now = new Date().toISOString();
    return this.getAll().filter(r => !r.stopTime || r.stopTime > now);
  }

  getByAirport(icao) {
    return this.getActive().filter(r => r.airport === icao);
  }

  prune() {
    const now = new Date().toISOString();
    for (const [key, r] of this.restrictions) {
      // Remove restrictions that ended more than 30 min ago
      if (r.stopTime) {
        const stopMs = new Date(r.stopTime).getTime();
        if (Date.now() - stopMs > 30 * 60 * 1000) {
          this.restrictions.delete(key);
        }
      }
    }
  }

  stop() {
    clearInterval(this.pruneInterval);
  }
}

module.exports = FlowStore;
