const { XMLParser } = require('fast-xml-parser');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  isArray: (name) => {
    // positionReport and adsbReport can appear multiple times in AT/AD batches
    return name === 'positionReport' || name === 'adsbReport';
  },
});

function parsePositionReport(report, airport) {
  const position = report.position || {};
  const flightId = report.flightId || {};
  const flightInfo = report.flightInfo || {};
  const movement = report.movement || {};
  const enhanced = report.enhancedData || {};

  const lat = parseFloat(position.latitude);
  const lon = parseFloat(position.longitude);
  if (isNaN(lat) || isNaN(lon)) return null;

  return {
    type: 'position',
    airport,
    trackId: String(report.track || ''),
    time: report.time || null,
    lat,
    lon,
    altitude: parseFloat(position.altitude) || null,
    callsign: flightId.aircraftId || null,
    squawk: flightId.mode3ACode || null,
    aircraftType: flightInfo.acType || null,
    targetType: flightInfo.tgtType || null,
    wake: flightInfo.wake || null,
    speed: parseFloat(movement.speed) || null,
    heading: parseFloat(movement.heading) || null,
    gufi: enhanced.eramGufi || null,
    full: report['@_full'] === 'true',
  };
}

function parseAdsbReport(report, airport) {
  const basic = report.report?.basicReport || {};
  const position = basic.position || {};
  const enhanced = report.enhancedData || {};

  const lat = parseFloat(position.lat);
  const lon = parseFloat(position.lon);
  if (isNaN(lat) || isNaN(lon)) return null;

  return {
    type: 'adsb',
    airport,
    trackId: String(basic.track || ''),
    time: basic.time || null,
    lat,
    lon,
    altitude: null,
    callsign: null,
    squawk: null,
    aircraftType: null,
    targetType: null,
    wake: null,
    speed: null,
    heading: null,
    gufi: enhanced.eramGufi || null,
    full: report['@_full'] === 'true',
  };
}

function parseSurfaceMovementEvent(msg) {
  const lat = parseFloat(msg.position?.latitude);
  const lon = parseFloat(msg.position?.longitude);
  if (isNaN(lat) || isNaN(lon)) return null;

  const enhanced = msg.enhancedData || {};

  return {
    type: 'surface_event',
    airport: msg.airport || null,
    trackId: String(msg.track || ''),
    time: msg.time || null,
    lat,
    lon,
    altitude: parseFloat(msg.altitude) || null,
    callsign: msg.callsign || null,
    squawk: msg.mode3ACode || null,
    aircraftType: msg.aircraftType || null,
    targetType: null,
    wake: null,
    speed: null,
    heading: null,
    gufi: enhanced.eramGufi || null,
    event: msg.event || null,
    runway: msg.runway || null,
    origin: enhanced.departureAirport || null,
    destination: enhanced.destinationAirport || null,
    full: true,
  };
}

function parseSmesMessage(xmlString) {
  const parsed = xmlParser.parse(xmlString);
  const results = [];

  // Handle asdexMsg (AT, AD topic types)
  const msg = parsed.asdexMsg;
  if (msg) {
    const airport = msg.airport || null;

    // positionReport — can be an array (AT batch) or single
    if (msg.positionReport) {
      for (const report of msg.positionReport) {
        const track = parsePositionReport(report, airport);
        if (track) results.push(track);
      }
    }

    // adsbReport — can be an array or single
    if (msg.adsbReport) {
      for (const report of msg.adsbReport) {
        const track = parseAdsbReport(report, airport);
        if (track) results.push(track);
      }
    }
  }

  // Handle SurfaceMovementEventMessage (SE topic type)
  const se = parsed.SurfaceMovementEventMessage;
  if (se) {
    const track = parseSurfaceMovementEvent(se);
    if (track) results.push(track);
  }

  return results.length > 0 ? results : null;
}

module.exports = { parseSmesMessage };
