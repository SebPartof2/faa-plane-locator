// Maintains the current state of all tracked targets.
// Tracks are keyed by airport + trackId. Stale tracks are pruned periodically.

const STALE_TIMEOUT_MS = 60_000; // remove tracks not updated in 60s

class TrackManager {
  constructor() {
    this.tracks = new Map(); // key: "airport:trackId" -> track object
    this.pruneInterval = setInterval(() => this.pruneStale(), 10_000);
  }

  getKey(airport, trackId) {
    return `${airport}:${trackId}`;
  }

  update(parsed) {
    const key = this.getKey(parsed.airport, parsed.trackId);
    const existing = this.tracks.get(key);

    if (existing && !parsed.full) {
      // Partial update: merge only non-null fields
      for (const [k, v] of Object.entries(parsed)) {
        if (v !== null && v !== undefined) {
          existing[k] = v;
        }
      }
      existing.lastUpdated = Date.now();
      return existing;
    }

    // Full update or new track
    parsed.lastUpdated = Date.now();
    this.tracks.set(key, parsed);
    return parsed;
  }

  remove(airport, trackId) {
    this.tracks.delete(this.getKey(airport, trackId));
  }

  pruneStale() {
    const now = Date.now();
    for (const [key, track] of this.tracks) {
      if (now - track.lastUpdated > STALE_TIMEOUT_MS) {
        this.tracks.delete(key);
      }
    }
  }

  getAll() {
    return Array.from(this.tracks.values());
  }

  getByAirport(airport) {
    return this.getAll().filter(t => t.airport === airport);
  }

  stop() {
    clearInterval(this.pruneInterval);
  }
}

module.exports = TrackManager;
