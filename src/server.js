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

    if (airlineCode && !airlineLookup[airlineCode]) {
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

  // Prioritize: airlines first (sorted by frequency), then airports (sorted by frequency)
  const sortedAirlines = Object.entries(missingAirlines).sort((a, b) => b[1] - a[1]);
  const sortedAirports = Object.entries(missingAirports).sort((a, b) => b[1] - a[1]);
  const topCode = sortedAirlines[0]?.[0] || sortedAirports[0]?.[0];

  if (!topCode) {
    return res.json({ message: 'All codes covered!' });
  }

  const sample = flightsByCode[topCode];
  res.json({
    callsign: sample.callsign,
    airlineCode: sample.callsign.match(/^([A-Z]+)/)?.[1] || null,
    origin: sample.origin || null,
    destination: sample.destination || null,
    aircraftType: sample.aircraftType || null,
    flightStatus: sample.flightStatus || null,
    actualAltitude: sample.actualAltitude || null,
    altitude: sample.altitude || null,
    groundSpeed: sample.groundSpeed || null,
    airspeed: sample.airspeed || null,
    heading: sample.heading || null,
    centre: sample.centre || null,
    _missingCode: topCode,
    _frequency: sortedAirlines[0]?.[0] === topCode ? sortedAirlines[0][1] : sortedAirports[0][1],
    _totalMissingAirlines: sortedAirlines.length,
    _totalMissingAirports: sortedAirports.length,
  });
});

// --- Health check endpoint ---
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    fdps: fdpsClient.connected,
    tfms: tfmsClient.connected,
    flights: flightStore.getStats(),
  });
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
