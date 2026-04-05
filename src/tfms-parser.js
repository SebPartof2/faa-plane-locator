const { XMLParser } = require('fast-xml-parser');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
});

function parseTfmsMessage(xmlString) {
  const parsed = xmlParser.parse(xmlString);
  const service = parsed.tfmDataService;
  if (!service) return null;

  const results = [];

  // R14 Flight Data (fltdOutput)
  const fltdOutput = service.fltdOutput;
  if (fltdOutput) {
    const messages = Array.isArray(fltdOutput.fltdMessage)
      ? fltdOutput.fltdMessage
      : fltdOutput.fltdMessage ? [fltdOutput.fltdMessage] : [];

    for (const msg of messages) {
      const flight = parseFlightMessage(msg);
      if (flight) results.push(flight);
    }
  }

  return results.length > 0 ? results : null;
}

function parseFlightMessage(msg) {
  // Get qualified aircraft ID from whichever sub-element carries it
  const modify = msg.ncsmFlightModify || msg.ncsmFlightTimes ||
                 msg.ncsmFlightCreate || msg.ncsmTrackInformation || {};
  const qId = modify.qualifiedAircraftId || {};
  const airlineData = modify.airlineData || {};
  const statusSpec = airlineData.flightStatusAndSpec || modify.flightStatusAndSpec || {};
  const flightTimes = airlineData.flightTimeData || modify.flightTimeData || {};

  // Extract GUFI
  const fdpsGufi = qId.gufi || null;
  if (!fdpsGufi) return null;

  // ETD / ETA
  const etd = airlineData.etd || modify.etd || {};
  const eta = airlineData.eta || modify.eta || {};

  const flight = {
    fdpsGufi,
    callsign: qId.aircraftId || msg['@_acid'] || null,
    origin: qId.departurePoint?.airport || msg['@_depArpt'] || null,
    destination: qId.arrivalPoint?.airport || msg['@_arrArpt'] || null,
    aircraftType: statusSpec.aircraftModel || null,
    aircraftCategory: qId['@_aircraftCategory'] || null,
    userCategory: qId['@_userCategory'] || null,
    airline: msg['@_airline'] || null,
    majorAirline: msg['@_major'] || null,
    flightStatus: statusSpec.flightStatus || null,
    // Gate & runway times
    gateOut: flightTimes['@_gateDeparture'] || flightTimes['@_airlineOutTime'] || null,
    gateIn: flightTimes['@_gateArrival'] || flightTimes['@_airlineInTime'] || null,
    wheelsOff: flightTimes['@_runwayDeparture'] || flightTimes['@_airlineOffTime'] || null,
    wheelsOn: flightTimes['@_runwayArrival'] || flightTimes['@_airlineOnTime'] || null,
    // ETD/ETA
    etd: etd['@_timeValue'] || null,
    eta: eta['@_timeValue'] || null,
    etdType: etd['@_etdType'] || null,
    etaType: eta['@_etaType'] || null,
    // Source
    source: 'tfms',
  };

  // Normalize origin/destination to ICAO (TFMS sometimes uses FAA codes without K prefix)
  if (flight.origin && flight.origin.length === 3) flight.origin = 'K' + flight.origin;
  if (flight.destination && flight.destination.length === 3) flight.destination = 'K' + flight.destination;

  return flight;
}

module.exports = { parseTfmsMessage };
