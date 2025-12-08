// OCPP command payload templates
const ocppTemplates = {
    'RemoteStartTransaction': { connectorId: 1, idTag: 'ADMIN_TAG' },
    'RemoteStopTransaction': { transactionId: 1 },
    'Reset': { type: 'Soft' },
    'UnlockConnector': { connectorId: 1 },
    'GetConfiguration': { key: [] },
    'ChangeConfiguration': { key: 'ConfigurationKey', value: 'NewValue' },
    'ChangeAvailability': { connectorId: 0, type: 'Operative' },
    'TriggerMessage': { requestedMessage: 'StatusNotification' },
    'GetDiagnostics': { location: 'ftp://example.com/diagnostics' },
    'UpdateFirmware': { location: 'ftp://example.com/firmware.bin', retrieveDate: new Date().toISOString() },
    'ClearCache': {},
    'DataTransfer': { vendorId: 'VendorName', messageId: 'MessageId', data: '' }
};
