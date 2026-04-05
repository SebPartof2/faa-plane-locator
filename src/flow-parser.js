const { XMLParser } = require('fast-xml-parser');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  isArray: (name) => name === 'restrictionMessage',
});

function parseFlowMessage(xmlString) {
  const parsed = xmlParser.parse(xmlString);
  const service = parsed.tfmDataService;
  if (!service) return null;

  const fiOutput = service.fiOutput;
  if (!fiOutput) return null;

  const fiMessage = fiOutput.fiMessage;
  if (!fiMessage) return null;

  const msgType = fiMessage['@_msgType'];
  const results = [];

  // Restriction messages (ground stops, MIT, APREQ, etc.)
  if (fiMessage.restrictionMessage) {
    for (const msg of fiMessage.restrictionMessage) {
      const airport = msg.airports || null;
      const restriction = {
        type: 'restriction',
        id: msg.restrictionId || null,
        category: msg.restrictionCategory || null,
        restrictionType: msg.restrictionType || null,
        airport: airport && airport.length === 3 ? 'K' + airport : airport,
        facility: msg.facility || null,
        reason: msg.reasonText || null,
        startTime: msg.startTime || null,
        stopTime: msg.stopTime || null,
        action: msg.action || null,
        mitValue: msg.mitValue ? parseInt(msg.mitValue) : null,
        qualifier: msg.qualifier || null,
        remarks: msg.remarks || null,
        timestamp: fiMessage['@_sourceTimeStamp'] || null,
      };
      results.push(restriction);
    }
  }

  return results.length > 0 ? results : null;
}

module.exports = { parseFlowMessage };
