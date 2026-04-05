const solace = require('solclientjs');
const EventEmitter = require('events');

class SolaceClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.session = null;
    this.consumer = null;
    this.connected = false;
  }

  init() {
    const factoryProps = new solace.SolclientFactoryProperties();
    factoryProps.profile = solace.SolclientFactoryProfiles.version10;
    factoryProps.logLevel = solace.LogLevel.WARN;
    solace.SolclientFactory.init(factoryProps);
  }

  connect() {
    this.init();

    const sessionProperties = new solace.SessionProperties();
    sessionProperties.url = this.config.host;
    sessionProperties.vpnName = this.config.vpn;
    sessionProperties.userName = this.config.username;
    sessionProperties.password = this.config.password;
    sessionProperties.connectRetries = 3;
    sessionProperties.reconnectRetries = -1; // infinite
    sessionProperties.reconnectRetryWaitInMsecs = 5000;

    this.session = solace.SolclientFactory.createSession(sessionProperties);

    this.session.on(solace.SessionEventCode.UP_NOTICE, () => {
      console.log('[Solace] Session connected');
      this.connected = true;
      this.bindQueue();
    });

    this.session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (event) => {
      console.error('[Solace] Connection failed:', event.infoStr);
      this.connected = false;
    });

    this.session.on(solace.SessionEventCode.DISCONNECTED, () => {
      console.log('[Solace] Disconnected');
      this.connected = false;
    });

    this.session.on(solace.SessionEventCode.RECONNECTING_NOTICE, () => {
      console.log('[Solace] Reconnecting...');
    });

    this.session.on(solace.SessionEventCode.RECONNECTED_NOTICE, () => {
      console.log('[Solace] Reconnected');
      this.connected = true;
    });

    try {
      this.session.connect();
      console.log('[Solace] Connecting to', this.config.host);
    } catch (err) {
      console.error('[Solace] Connect error:', err.message);
    }
  }

  bindQueue() {
    const consumerProperties = new solace.MessageConsumerProperties();
    consumerProperties.queueDescriptor = new solace.QueueDescriptor({
      type: solace.QueueType.QUEUE,
      durable: true,
      name: this.config.queue,
    });
    consumerProperties.acknowledgeMode = solace.MessageConsumerAcknowledgeMode.CLIENT;

    this.consumer = this.session.createMessageConsumer(consumerProperties);

    this.consumer.on(solace.MessageConsumerEventName.UP, () => {
      console.log('[Solace] Consumer bound to queue:', this.config.queue);
    });

    this.consumer.on(solace.MessageConsumerEventName.CONNECT_FAILED_ERROR, (event) => {
      console.error('[Solace] Consumer bind failed:', event.infoStr);
    });

    this.consumer.on(solace.MessageConsumerEventName.MESSAGE, (message) => {
      try {
        // Try multiple ways to get the message body
        let payload = message.getBinaryAttachment();
        if (payload == null) {
          payload = message.getSdtContainer()?.getValue();
        }
        if (payload == null) {
          payload = message.getXmlContent();
        }
        if (payload == null) {
          payload = message.getXmlContentDecoded();
        }
        if (payload instanceof Uint8Array) {
          payload = Buffer.from(payload).toString('utf-8');
        }
        this.emit('message', payload, message.getDestination()?.getName());
        message.acknowledge();
      } catch (err) {
        console.error('[Solace] Message processing error:', err.message);
        message.acknowledge();
      }
    });

    this.consumer.connect();
  }

  disconnect() {
    if (this.consumer) {
      this.consumer.disconnect();
    }
    if (this.session) {
      this.session.disconnect();
    }
    this.connected = false;
    console.log('[Solace] Client disconnected');
  }
}

module.exports = SolaceClient;
