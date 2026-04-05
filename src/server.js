require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const SolaceClient = require('./solace-client');
const { parseFixmMessage } = require('./fixm-parser');
const { parseTfmsMessage } = require('./tfms-parser');
const FlightStore = require('./flight-store');

const PORT = process.env.PORT || 3000;

// --- Express + HTTP ---
const app = express();
const server = http.createServer(app);
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Flight store ---
const flightStore = new FlightStore();

// --- WebSocket server ---
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (${clients.size} total)`);

  ws.send(JSON.stringify({
    type: 'snapshot',
    flights: flightStore.getAll(),
    stats: flightStore.getStats(),
  }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (${clients.size} total)`);
  });
});

function broadcast(data) {
  const json = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(json);
    }
  }
}

// --- Collect updates between broadcasts ---
const pendingUpdates = new Map();

// --- Flush updates every 500ms ---
setInterval(() => {
  if (pendingUpdates.size === 0) return;
  broadcast({
    type: 'batch',
    flights: Array.from(pendingUpdates.values()),
    stats: flightStore.getStats(),
  });
  pendingUpdates.clear();
}, 500);

// --- Full sync every 10s ---
setInterval(() => {
  broadcast({
    type: 'snapshot',
    flights: flightStore.getAll(),
    stats: flightStore.getStats(),
  });
}, 10_000);

// --- Helper to upsert and queue for broadcast ---
function ingestFlight(plan) {
  const flight = flightStore.upsert(plan);
  pendingUpdates.set(flight.fdpsGufi || flight.callsign, flight);
}

// --- FDPS Solace client ---
const fdpsClient = new SolaceClient({
  host: process.env.FDPS_HOST,
  vpn: process.env.FDPS_VPN,
  username: process.env.FDPS_USERNAME,
  password: process.env.FDPS_PASSWORD,
  queue: process.env.FDPS_QUEUE,
});

let fdpsMsgCount = 0;

fdpsClient.on('message', (payload) => {
  try {
    const plans = parseFixmMessage(payload);
    if (!plans) return;
    for (const plan of plans) {
      ingestFlight(plan);
      fdpsMsgCount++;
    }
  } catch (err) {
    console.error('[FDPS] Parse error:', err.message);
  }
});

// --- TFMS Solace client ---
const tfmsClient = new SolaceClient({
  host: process.env.TFMS_HOST,
  vpn: process.env.TFMS_VPN,
  username: process.env.TFMS_USERNAME,
  password: process.env.TFMS_PASSWORD,
  queue: process.env.TFMS_QUEUE,
});

let tfmsMsgCount = 0;

tfmsClient.on('message', (payload) => {
  try {
    const flights = parseTfmsMessage(payload);
    if (!flights) return;
    for (const flight of flights) {
      ingestFlight(flight);
      tfmsMsgCount++;
    }
  } catch (err) {
    console.error('[TFMS] Parse error:', err.message);
  }
});

// --- Paginated flights API ---
app.get('/api/flights', (req, res) => {
  const status = req.query.status || 'ACTIVE';
  const search = (req.query.search || '').toUpperCase();
  const airline = req.query.airline || '';
  const page = parseInt(req.query.page) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);

  let flights = flightStore.getAll();

  // Filter by status
  if (status !== 'all') {
    flights = flights.filter(f => f.flightStatus === status);
  }

  // Filter by airline code
  if (airline) {
    flights = flights.filter(f => {
      const match = (f.callsign || '').match(/^([A-Z]+)/);
      return match && match[1] === airline;
    });
  }

  // Search
  if (search) {
    flights = flights.filter(f =>
      (f.callsign || '').includes(search) ||
      (f.airline || '').includes(search) ||
      (f.origin || '').includes(search) ||
      (f.destination || '').includes(search) ||
      (f.aircraftType || '').includes(search) ||
      (f.centre || '').includes(search)
    );
  }

  // Sort by callsign
  flights.sort((a, b) => (a.callsign || '').localeCompare(b.callsign || ''));

  const total = flights.length;
  const paged = flights.slice(page * limit, (page + 1) * limit);

  res.json({
    flights: paged,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
    stats: flightStore.getStats(),
  });
});

// --- Missing codes endpoint ---
app.get('/codes', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'codes.html'));
});

app.get('/api/codes/missing', (req, res) => {
  // Load current lookup files
  let airportLookup = {}, airlineLookup = {};
  try {
    airportLookup = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'airports.json'), 'utf-8'));
    airlineLookup = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'airlines.json'), 'utf-8'));
  } catch (e) { /* ignore */ }

  const flights = flightStore.getAll();

  // Count frequency of each missing code
  const missingAirlines = {};  // code -> count
  const missingAirports = {};  // code -> count
  const flightsByCode = {};    // code -> sample flight

  for (const f of flights) {
    if (!f.callsign || /^N\d/.test(f.callsign)) continue;

    const airlineMatch = f.callsign.match(/^([A-Z]{2,})\d/);
    const airlineCode = airlineMatch ? airlineMatch[1] : null;

    if (airlineCode && !airlineLookup[airlineCode] && airlineCode.length >= 3) {
      missingAirlines[airlineCode] = (missingAirlines[airlineCode] || 0) + 1;
      if (!flightsByCode[airlineCode]) flightsByCode[airlineCode] = f;
    }
    if (f.origin && !airportLookup[f.origin]) {
      missingAirports[f.origin] = (missingAirports[f.origin] || 0) + 1;
      if (!flightsByCode[f.origin]) flightsByCode[f.origin] = f;
    }
    if (f.destination && !airportLookup[f.destination]) {
      missingAirports[f.destination] = (missingAirports[f.destination] || 0) + 1;
      if (!flightsByCode[f.destination]) flightsByCode[f.destination] = f;
    }
  }

  if (Object.keys(missingAirlines).length === 0 && Object.keys(missingAirports).length === 0) {
    return res.json({ message: 'All codes covered!' });
  }

  // ERAM internal codes to ignore (not real airlines)
  const ignoredAirlineCodes = new Set(['LN', 'RV', 'QQ', 'ZZ', 'XX', 'TT']);

  // Score each flight by total priority (sum of frequencies of its missing codes)
  // Airlines weighted 2x since they affect more flights
  const scored = [];
  const seen = new Set();
  for (const f of flights) {
    if (!f.callsign || /^N\d/.test(f.callsign)) continue;

    const airlineMatch = f.callsign.match(/^([A-Z]{2,})\d/);
    const airlineCode = airlineMatch ? airlineMatch[1] : null;

    const codes = {};
    let priority = 0;

    if (airlineCode && !ignoredAirlineCodes.has(airlineCode) && missingAirlines[airlineCode]) {
      codes.airline = { code: airlineCode, count: missingAirlines[airlineCode] };
      priority += missingAirlines[airlineCode] * 2;
    }
    if (f.origin && missingAirports[f.origin]) {
      codes.origin = { code: f.origin, count: missingAirports[f.origin] };
      priority += missingAirports[f.origin];
    }
    if (f.destination && missingAirports[f.destination]) {
      codes.dest = { code: f.destination, count: missingAirports[f.destination] };
      priority += missingAirports[f.destination];
    }

    if (priority > 0) {
      // Dedupe by missing code combo
      const key = [codes.airline?.code, codes.origin?.code, codes.dest?.code].join('|');
      if (!seen.has(key)) {
        seen.add(key);
        scored.push({ flight: f, codes, priority });
      }
    }
  }

  scored.sort((a, b) => b.priority - a.priority);

  // Dedupe by priority value so Next always shows a different priority level
  const uniqueByPriority = [];
  const seenPriorities = new Set();
  for (const s of scored) {
    if (!seenPriorities.has(s.priority)) {
      seenPriorities.add(s.priority);
      uniqueByPriority.push(s);
    }
  }

  const skip = parseInt(req.query.skip) || 0;
  const top = uniqueByPriority[skip % uniqueByPriority.length];
  if (!top) return res.json({ message: 'All codes covered!' });

  const f = top.flight;
  res.json({
    callsign: f.callsign,
    airlineCode: f.callsign.match(/^([A-Z]+)/)?.[1] || null,
    origin: f.origin || null,
    destination: f.destination || null,
    aircraftType: f.aircraftType || null,
    flightStatus: f.flightStatus || null,
    actualAltitude: f.actualAltitude || null,
    altitude: f.altitude || null,
    groundSpeed: f.groundSpeed || null,
    airspeed: f.airspeed || null,
    heading: f.heading || null,
    centre: f.centre || null,
    _codes: top.codes,
    _priority: top.priority,
    _totalMissingAirlines: Object.keys(missingAirlines).length,
    _totalMissingAirports: Object.keys(missingAirports).length,
  });
});

// --- Health API (for Docker healthcheck) ---
app.get('/api/health', (req, res) => {
  const flights = flightStore.getAll();

  // Data coverage
  let hasPos = 0, hasType = 0, hasAirline = 0, hasRoute = 0;
  const statuses = {}, centres = {}, topAirlines = {}, topOrigins = {}, topDests = {};
  for (const f of flights) {
    if (f.lat != null) hasPos++;
    if (f.aircraftType) hasType++;
    if (f.airline) hasAirline++;
    if (f.route) hasRoute++;
    statuses[f.flightStatus || 'UNKNOWN'] = (statuses[f.flightStatus || 'UNKNOWN'] || 0) + 1;
    if (f.centre) centres[f.centre] = (centres[f.centre] || 0) + 1;
    if (f.airline) topAirlines[f.airline] = (topAirlines[f.airline] || 0) + 1;
    if (f.origin) topOrigins[f.origin] = (topOrigins[f.origin] || 0) + 1;
    if (f.destination) topDests[f.destination] = (topDests[f.destination] || 0) + 1;
  }

  const sortObj = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

  // Load lookup sizes
  let airportCount = 0, airlineCount = 0;
  try {
    airportCount = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'airports.json'), 'utf-8'))).length;
    airlineCount = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'airlines.json'), 'utf-8'))).length;
  } catch (e) { /* ignore */ }

  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    connections: { fdps: fdpsClient.connected, tfms: tfmsClient.connected },
    flights: { total: flights.length, statuses },
    coverage: {
      position: hasPos,
      aircraftType: hasType,
      airline: hasAirline,
      route: hasRoute,
    },
    lookups: { airports: airportCount, airlines: airlineCount },
    topCentres: sortObj(centres, 10),
    topAirlines: sortObj(topAirlines, 10),
    topOrigins: sortObj(topOrigins, 10),
    topDestinations: sortObj(topDests, 10),
  });
});

// --- Health dashboard ---
app.get('/health', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'health.html'));
});

// --- Stats logging ---
setInterval(() => {
  const stats = flightStore.getStats();
  console.log(`[Stats] Flights: ${stats.total} (Active: ${stats.active}, Proposed: ${stats.proposed}) | FDPS/10s: ${fdpsMsgCount} | TFMS/10s: ${tfmsMsgCount}`);
  fdpsMsgCount = 0;
  tfmsMsgCount = 0;
}, 10_000);

// --- Start ---
server.listen(PORT, () => {
  console.log(`[Server] Listening on http://localhost:${PORT}`);
  fdpsClient.connect();
  tfmsClient.connect();
});

// --- Graceful shutdown ---
function shutdown() {
  console.log('\nShutting down...');
  fdpsClient.disconnect();
  tfmsClient.disconnect();
  flightStore.stop();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
