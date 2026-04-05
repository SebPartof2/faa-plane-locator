// Stores flight plan data keyed by FDPS GUFI for enriching SMES tracks.
// SMES tracks carry an eramGufi field that matches the FDPS GUFI.

const MAX_PLANS = 20_000;
const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

class FlightPlanStore {
  constructor() {
    this.byFdpsGufi = new Map();   // fdpsGufi -> plan
    this.byCallsign = new Map();   // callsign -> plan
    this.pruneInterval = setInterval(() => this.prune(), 60_000);
  }

  upsert(plan) {
    plan.storedAt = Date.now();

    if (plan.fdpsGufi) {
      this.byFdpsGufi.set(plan.fdpsGufi, plan);
    }
    if (plan.callsign) {
      this.byCallsign.set(plan.callsign, plan);
    }
  }

  // Look up by ERAM GUFI (from SMES track) or callsign
  lookup(eramGufi, callsign) {
    if (eramGufi) {
      const plan = this.byFdpsGufi.get(eramGufi);
      if (plan) return plan;
    }
    if (callsign) {
      const plan = this.byCallsign.get(callsign);
      if (plan) return plan;
    }
    return null;
  }

  // Enrich an SMES track with flight plan data
  enrich(track) {
    const plan = this.lookup(track.gufi, track.callsign);
    if (!plan) return track;

    return {
      ...track,
      callsign: track.callsign || plan.callsign,
      aircraftType: track.aircraftType || plan.aircraftType,
      origin: track.origin || plan.origin,
      destination: track.destination || plan.destination,
      route: plan.route || null,
      flightStatus: plan.flightStatus || null,
      filedAltitude: plan.altitude || null,
      filedAirspeed: plan.airspeed || null,
    };
  }

  prune() {
    const now = Date.now();
    for (const [key, plan] of this.byFdpsGufi) {
      if (now - plan.storedAt > STALE_MS) this.byFdpsGufi.delete(key);
    }
    for (const [key, plan] of this.byCallsign) {
      if (now - plan.storedAt > STALE_MS) this.byCallsign.delete(key);
    }
    // Cap size
    if (this.byFdpsGufi.size > MAX_PLANS) {
      const entries = [...this.byFdpsGufi.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
      const toRemove = entries.slice(0, entries.length - MAX_PLANS);
      for (const [key] of toRemove) this.byFdpsGufi.delete(key);
    }
  }

  get size() {
    return this.byFdpsGufi.size;
  }

  stop() {
    clearInterval(this.pruneInterval);
  }
}

module.exports = FlightPlanStore;
