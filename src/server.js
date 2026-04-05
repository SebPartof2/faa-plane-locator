require('dotenv').config();
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
  const flights = flightStore.getAll();
  const missing = [];

  for (const f of flights) {
    if (!f.callsign) continue;

    const airlineMatch = f.callsign.match(/^([A-Z]+)\d/);
    const airlineCode = airlineMatch ? airlineMatch[1] : null;
    const isNNumber = /^N\d/.test(f.callsign);

    // Skip N-numbers
    if (isNNumber) continue;

    const needs = [];
    if (airlineCode && airlineCode.length >= 2) needs.push('airline');
    if (f.origin) needs.push('origin');
    if (f.destination) needs.push('destination');

    if (needs.length > 0) {
      missing.push({
        callsign: f.callsign,
        airlineCode: airlineCode || null,
        origin: f.origin || null,
        destination: f.destination || null,
        aircraftType: f.aircraftType || null,
        flightStatus: f.flightStatus || null,
      });
    }
  }

  // Pick a random one
  if (missing.length === 0) {
    return res.json({ message: 'All codes covered!' });
  }

  const pick = missing[Math.floor(Math.random() * missing.length)];
  res.json(pick);
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
