const { XMLParser } = require('fast-xml-parser');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
});

// Parse "lat lon" string from <pos> element
function parsePos(posStr) {
  if (typeof posStr !== 'string') return null;
  const parts = posStr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const lat = parseFloat(parts[0]);
  const lon = parseFloat(parts[1]);
  if (isNaN(lat) || isNaN(lon)) return null;
  return { lat, lon };
}

function parseFixmMessage(xmlString) {
  const parsed = xmlParser.parse(xmlString);

  const collection = parsed.MessageCollection;
  if (!collection) return null;

  // Can be a single message or array
  const messages = Array.isArray(collection.message)
    ? collection.message
    : collection.message ? [collection.message] : [];

  const results = [];

  for (const msg of messages) {
    const flight = msg.flight;
    if (!flight) continue;

    const flightId = flight.flightIdentification || {};
    const departure = flight.departure || {};
    const arrival = flight.arrival || {};
    const aircraft = flight.aircraftDescription || {};
    const agreed = flight.agreed || {};
    const route = agreed.route || {};
    const status = flight.flightStatus || {};
    const supplemental = flight.supplementalData || {};
    const reqAlt = flight.requestedAltitude || {};
    const reqSpd = flight.requestedAirspeed || {};
    const enRoute = flight.enRoute || {};

    // Extract GUFI
    const gufi = flight.gufi?.['#text'] || flight.gufi || null;

    // Extract FDPS GUFI from supplemental data
    const additionalInfo = supplemental.additionalFlightInformation?.nameValue;
    let fdpsGufi = null;
    if (Array.isArray(additionalInfo)) {
      const entry = additionalInfo.find(nv => nv['@_name'] === 'FDPS_GUFI');
      fdpsGufi = entry?.['@_value'] || null;
    }

    // Extract altitude — check assignedAltitude (active flights) then requestedAltitude (filed)
    let altitude = null;
    const assignedAlt = flight.assignedAltitude || {};
    const altSources = [assignedAlt, reqAlt];
    for (const src of altSources) {
      const altVal = src.simple || src.vfrPlus || src.altitude || src.nasAltitude;
      if (altVal != null) {
        altitude = parseFloat(altVal['#text'] || altVal);
        if (!isNaN(altitude)) break;
        altitude = null;
      }
    }

    // Extract filed airspeed
    let airspeed = null;
    const spdVal = reqSpd.nasAirspeed || reqSpd.airspeed;
    if (spdVal) airspeed = parseFloat(spdVal['#text'] || spdVal);

    // Extract real-time position from enRoute track data
    let lat = null, lon = null, actualAltitude = null, groundSpeed = null, heading = null;
    const trackPos = enRoute.position;
    if (trackPos) {
      // Position: enRoute.position.position.location.pos = "lat lon"
      const posLocation = trackPos.position?.location?.pos;
      const coords = parsePos(posLocation);
      if (coords) {
        lat = coords.lat;
        lon = coords.lon;
      }

      // Actual altitude from track
      const trackAlt = trackPos.altitude;
      if (trackAlt != null) {
        actualAltitude = parseFloat(trackAlt['#text'] || trackAlt);
        if (isNaN(actualAltitude)) actualAltitude = null;
      }

      // Ground speed from track
      const actualSpd = trackPos.actualSpeed;
      if (actualSpd) {
        const spdSurv = actualSpd.surveillance || actualSpd.calculated;
        if (spdSurv != null) {
          groundSpeed = parseFloat(spdSurv['#text'] || spdSurv);
          if (isNaN(groundSpeed)) groundSpeed = null;
        }
      }

      // Heading from track velocity (atan2 of x,y knots)
      const vel = trackPos.trackVelocity;
      if (vel) {
        const vx = parseFloat(vel.x?.['#text'] || vel.x);
        const vy = parseFloat(vel.y?.['#text'] || vel.y);
        if (!isNaN(vx) && !isNaN(vy)) {
          heading = (Math.atan2(vx, -vy) * 180 / Math.PI + 360) % 360;
        }
      }
    }

    // Extract controlling unit / sector
    const controllingUnit = flight.controllingUnit || {};
    const sector = controllingUnit['@_sectorIdentifier'] || null;

    const plan = {
      gufi: typeof gufi === 'string' ? gufi : null,
      fdpsGufi,
      callsign: flightId['@_aircraftIdentification'] || null,
      computerId: flightId['@_computerId'] || null,
      origin: departure['@_departurePoint'] || null,
      destination: arrival['@_arrivalPoint'] || null,
      aircraftType: aircraft.aircraftType?.icaoModelIdentifier || null,
      route: route['@_nasRouteText'] || null,
      flightStatus: status['@_fdpsFlightStatus'] || null,
      flightType: flight['@_flightType'] || null,
      centre: flight['@_centre'] || null,
      sector,
      dataSource: flight['@_centre'] ? `ERAM ${flight['@_centre']}` : null,
      altitude,
      airspeed,
      lat,
      lon,
      actualAltitude,
      groundSpeed,
      heading,
      timestamp: flight['@_timestamp'] || null,
    };

    if (plan.fdpsGufi || plan.gufi) {
      results.push(plan);
    }
  }

  return results.length > 0 ? results : null;
}

module.exports = { parseFixmMessage };
