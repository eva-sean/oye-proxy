#!/usr/bin/env node

const WebSocket = require('ws');
const crypto = require('crypto');

// Configuration
const PROXY_URL = process.env.PROXY_URL || 'ws://localhost:8080';
const CHARGE_POINT_ID = process.env.CHARGE_POINT_ID || 'TEST-CHARGER-001';
const OCPP_PROTOCOL = process.env.OCPP_PROTOCOL || 'ocpp1.6';

// Charger state
const chargerState = {
  status: 'Available',
  connectorId: 1,
  meterValue: 0,
  currentTransaction: null,
  idTag: null,
  meterValueInterval: null
};

// Configuration items (OCPP 1.6J standard)
const configurationKeys = {
  'AuthorizeRemoteTxRequests': { value: 'true', readonly: false },
  'ClockAlignedDataInterval': { value: '900', readonly: false },
  'ConnectionTimeOut': { value: '60', readonly: false },
  'GetConfigurationMaxKeys': { value: '50', readonly: true },
  'HeartbeatInterval': { value: '300', readonly: false },
  'LocalAuthorizeOffline': { value: 'true', readonly: false },
  'LocalPreAuthorize': { value: 'false', readonly: false },
  'MeterValuesAlignedData': { value: 'Energy.Active.Import.Register', readonly: false },
  'MeterValuesSampledData': { value: 'Energy.Active.Import.Register', readonly: false },
  'MeterValueSampleInterval': { value: '10', readonly: false },
  'NumberOfConnectors': { value: '1', readonly: true },
  'ResetRetries': { value: '3', readonly: false },
  'StopTransactionOnEVSideDisconnect': { value: 'true', readonly: false },
  'StopTransactionOnInvalidId': { value: 'true', readonly: false },
  'TransactionMessageAttempts': { value: '3', readonly: false },
  'TransactionMessageRetryInterval': { value: '60', readonly: false },
  'UnlockConnectorOnEVSideDisconnect': { value: 'true', readonly: false }
};

function log(type, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${type}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function generateMessageId() {
  return crypto.randomUUID();
}

function sendMessage(ws, messageType, messageId, actionOrPayload, payload = null) {
  let message;
  if (messageType === 2) {
    // Call (Request)
    message = [messageType, messageId, actionOrPayload, payload];
  } else if (messageType === 3) {
    // CallResult (Success Response)
    message = [messageType, messageId, actionOrPayload];
  } else if (messageType === 4) {
    // CallError
    message = [messageType, messageId, actionOrPayload, payload || '', {}];
  }

  const messageStr = JSON.stringify(message);
  log('SEND', `${messageType === 2 ? 'Call' : messageType === 3 ? 'CallResult' : 'CallError'}`, message);
  ws.send(messageStr);
}

function handleIncomingMessage(ws, messageStr) {
  log('RECV', 'Raw message', messageStr);

  try {
    const message = JSON.parse(messageStr);
    const [messageType, messageId, actionOrError, payload] = message;

    if (messageType === 2) {
      // Call (Request from CSMS or injected command)
      log('HANDLE', `Incoming Call: ${actionOrError}`, payload);
      handleCall(ws, messageId, actionOrError, payload);
    } else if (messageType === 3) {
      // CallResult (Response to our request)
      log('HANDLE', `CallResult for message ${messageId}`, payload);
    } else if (messageType === 4) {
      // CallError
      log('HANDLE', `CallError for message ${messageId}`, { error: actionOrError, description: payload });
    }
  } catch (err) {
    log('ERROR', 'Failed to parse message', err.message);
  }
}

function handleCall(ws, messageId, action, payload) {
  switch (action) {
    case 'GetConfiguration':
      handleGetConfiguration(ws, messageId, payload);
      break;

    case 'ChangeConfiguration':
      handleChangeConfiguration(ws, messageId, payload);
      break;

    case 'RemoteStartTransaction':
      handleRemoteStartTransaction(ws, messageId, payload);
      break;

    case 'RemoteStopTransaction':
      handleRemoteStopTransaction(ws, messageId, payload);
      break;

    case 'Reset':
      handleReset(ws, messageId, payload);
      break;

    case 'UnlockConnector':
      handleUnlockConnector(ws, messageId, payload);
      break;

    case 'GetDiagnostics':
      handleGetDiagnostics(ws, messageId, payload);
      break;

    case 'ChangeAvailability':
      handleChangeAvailability(ws, messageId, payload);
      break;

    case 'TriggerMessage':
      handleTriggerMessage(ws, messageId, payload);
      break;

    default:
      log('WARN', `Unsupported action: ${action}`, payload);
      sendMessage(ws, 4, messageId, 'NotSupported', `Action ${action} is not supported`);
  }
}

function handleGetConfiguration(ws, messageId, payload) {
  const requestedKeys = payload.key || [];
  const configurationKey = [];
  const unknownKey = [];

  if (requestedKeys.length === 0) {
    // Return all keys
    for (const [key, config] of Object.entries(configurationKeys)) {
      configurationKey.push({
        key,
        readonly: config.readonly,
        value: config.value
      });
    }
  } else {
    // Return requested keys
    for (const key of requestedKeys) {
      if (configurationKeys[key]) {
        configurationKey.push({
          key,
          readonly: configurationKeys[key].readonly,
          value: configurationKeys[key].value
        });
      } else {
        unknownKey.push(key);
      }
    }
  }

  const response = { configurationKey };
  if (unknownKey.length > 0) {
    response.unknownKey = unknownKey;
  }

  sendMessage(ws, 3, messageId, response);
}

function handleChangeConfiguration(ws, messageId, payload) {
  const { key, value } = payload;

  if (!configurationKeys[key]) {
    sendMessage(ws, 3, messageId, { status: 'NotSupported' });
  } else if (configurationKeys[key].readonly) {
    sendMessage(ws, 3, messageId, { status: 'Rejected' });
  } else {
    configurationKeys[key].value = value;
    log('INFO', `Configuration changed: ${key} = ${value}`);
    sendMessage(ws, 3, messageId, { status: 'Accepted' });
  }
}

function handleRemoteStartTransaction(ws, messageId, payload) {
  const { connectorId, idTag } = payload;

  if (chargerState.currentTransaction) {
    sendMessage(ws, 3, messageId, { status: 'Rejected' });
    return;
  }

  chargerState.status = 'Charging';
  chargerState.idTag = idTag;
  chargerState.currentTransaction = Math.floor(Math.random() * 1000000);
  chargerState.meterValue = 0; // Reset meter at start of transaction

  log('INFO', `Starting transaction ${chargerState.currentTransaction} for ${idTag} on connector ${connectorId}`);
  sendMessage(ws, 3, messageId, { status: 'Accepted' });

  // Send StatusNotification
  setTimeout(() => {
    const statusMsgId = generateMessageId();
    sendMessage(ws, 2, statusMsgId, 'StatusNotification', {
      connectorId,
      errorCode: 'NoError',
      status: 'Charging'
    });
  }, 500);

  // Start sending meter values
  startMeterValues(ws);
}

function handleRemoteStopTransaction(ws, messageId, payload) {
  const { transactionId } = payload;

  if (!chargerState.currentTransaction || chargerState.currentTransaction !== transactionId) {
    sendMessage(ws, 3, messageId, { status: 'Rejected' });
    return;
  }

  // Stop meter values
  stopMeterValues();

  chargerState.status = 'Available';
  chargerState.currentTransaction = null;
  chargerState.idTag = null;

  log('INFO', `Stopping transaction ${transactionId}`);
  sendMessage(ws, 3, messageId, { status: 'Accepted' });

  // Send StatusNotification
  setTimeout(() => {
    const statusMsgId = generateMessageId();
    sendMessage(ws, 2, statusMsgId, 'StatusNotification', {
      connectorId: chargerState.connectorId,
      errorCode: 'NoError',
      status: 'Available'
    });
  }, 500);
}

function handleReset(ws, messageId, payload) {
  const { type } = payload;
  log('INFO', `Reset requested: ${type}`);
  sendMessage(ws, 3, messageId, { status: 'Accepted' });

  // Stop meter values if running
  stopMeterValues();

  // In a real charger, this would trigger a reboot
  // For testing, we just reset state
  setTimeout(() => {
    chargerState.status = 'Available';
    chargerState.currentTransaction = null;
    chargerState.idTag = null;
    log('INFO', 'Charger reset complete');
  }, 1000);
}

function handleUnlockConnector(ws, messageId, payload) {
  const { connectorId } = payload;
  log('INFO', `Unlocking connector ${connectorId}`);
  sendMessage(ws, 3, messageId, { status: 'Unlocked' });
}

function handleGetDiagnostics(ws, messageId, payload) {
  log('INFO', 'Diagnostics requested', payload);
  sendMessage(ws, 3, messageId, { fileName: 'diagnostics.log' });
}

function handleChangeAvailability(ws, messageId, payload) {
  const { connectorId, type } = payload;
  log('INFO', `Changing availability of connector ${connectorId} to ${type}`);
  sendMessage(ws, 3, messageId, { status: 'Accepted' });
}

function handleTriggerMessage(ws, messageId, payload) {
  const { requestedMessage, connectorId } = payload;
  log('INFO', `Trigger message requested: ${requestedMessage}`);
  sendMessage(ws, 3, messageId, { status: 'Accepted' });

  // Send the requested message
  setTimeout(() => {
    const triggerMsgId = generateMessageId();
    if (requestedMessage === 'StatusNotification') {
      sendMessage(ws, 2, triggerMsgId, 'StatusNotification', {
        connectorId: connectorId || chargerState.connectorId,
        errorCode: 'NoError',
        status: chargerState.status
      });
    } else if (requestedMessage === 'BootNotification') {
      sendMessage(ws, 2, triggerMsgId, 'BootNotification', {
        chargePointVendor: 'TestVendor',
        chargePointModel: 'TestModel',
        chargePointSerialNumber: CHARGE_POINT_ID,
        firmwareVersion: '1.0.0'
      });
    }
  }, 500);
}

function sendBootNotification(ws) {
  const messageId = generateMessageId();
  const payload = {
    chargePointVendor: 'TestVendor',
    chargePointModel: 'TestModel',
    chargePointSerialNumber: CHARGE_POINT_ID,
    firmwareVersion: '1.0.0'
  };

  log('INFO', 'Sending BootNotification');
  sendMessage(ws, 2, messageId, 'BootNotification', payload);
}

function sendMeterValues(ws) {
  if (!chargerState.currentTransaction) {
    return;
  }

  // Simulate realistic charging: increment by 0.5-2.0 kWh per minute
  const increment = Math.random() * 1.5 + 0.5;
  chargerState.meterValue += increment;

  // Simulate realistic voltage and current for Level 2 charging
  const voltage = 230 + (Math.random() * 10 - 5); // 225-235V
  const current = 16 + (Math.random() * 16); // 16-32A

  const messageId = generateMessageId();
  const payload = {
    connectorId: chargerState.connectorId,
    transactionId: chargerState.currentTransaction,
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [
          {
            value: chargerState.meterValue.toFixed(2),
            context: 'Sample.Periodic',
            format: 'Raw',
            measurand: 'Energy.Active.Import.Register',
            unit: 'Wh'
          },
          {
            value: voltage.toFixed(1),
            context: 'Sample.Periodic',
            format: 'Raw',
            measurand: 'Voltage',
            unit: 'V'
          },
          {
            value: current.toFixed(1),
            context: 'Sample.Periodic',
            format: 'Raw',
            measurand: 'Current.Import',
            unit: 'A'
          }
        ]
      }
    ]
  };

  log('INFO', `Sending MeterValues: ${chargerState.meterValue.toFixed(2)} Wh, ${voltage.toFixed(1)}V, ${current.toFixed(1)}A`);
  sendMessage(ws, 2, messageId, 'MeterValues', payload);
}

function startMeterValues(ws) {
  // Use the configured interval from configuration
  const interval = parseInt(configurationKeys['MeterValueSampleInterval'].value) * 1000;

  if (chargerState.meterValueInterval) {
    clearInterval(chargerState.meterValueInterval);
  }

  chargerState.meterValueInterval = setInterval(() => {
    sendMeterValues(ws);
  }, interval);
}

function stopMeterValues() {
  if (chargerState.meterValueInterval) {
    clearInterval(chargerState.meterValueInterval);
    chargerState.meterValueInterval = null;
  }
}

function startHeartbeat(ws) {
  const interval = parseInt(configurationKeys['HeartbeatInterval'].value) * 1000;

  setInterval(() => {
    const messageId = generateMessageId();
    log('INFO', 'Sending Heartbeat');
    sendMessage(ws, 2, messageId, 'Heartbeat', {});
  }, interval);
}

function connectToProxy() {
  const url = `${PROXY_URL}/ocpp/${CHARGE_POINT_ID}`;
  log('INFO', `Connecting to proxy at ${url} with protocol ${OCPP_PROTOCOL}`);

  const ws = new WebSocket(url, [OCPP_PROTOCOL]);

  ws.on('open', () => {
    log('SUCCESS', `Connected to proxy as ${CHARGE_POINT_ID}`);
    sendBootNotification(ws);
    startHeartbeat(ws);
  });

  ws.on('message', (data) => {
    handleIncomingMessage(ws, data.toString());
  });

  ws.on('close', (code, reason) => {
    log('WARN', `Connection closed: ${code} - ${reason}`);
    log('INFO', 'Reconnecting in 5 seconds...');
    setTimeout(() => connectToProxy(), 5000);
  });

  ws.on('error', (err) => {
    log('ERROR', 'WebSocket error', err.message);
  });
}

// Start the test charger
log('INFO', '=== OCPP Test Charger Emulator ===');
log('INFO', `Charge Point ID: ${CHARGE_POINT_ID}`);
log('INFO', `OCPP Protocol: ${OCPP_PROTOCOL}`);
log('INFO', `Proxy URL: ${PROXY_URL}`);
log('INFO', '===================================');

connectToProxy();
