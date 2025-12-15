# Smart Charging Guide

The OYE Proxy allows you to control power management features (Smart Charging) of your connected charger by injecting OCPP commands.

## 1. Prerequisites (Important!)

**Before you begin:** Some chargers come configured in "Plug & Charge" mode (dumb mode) by default and will **ignore** all smart charging profiles unless specifically configured.

*   **Check Configuration Keys:** You may need to change a configuration key to enable smart features.
    *   Common keys: `ScheduledMode`, `LocalPreAuthorize`, `SmartChargingEnabled`.
    *   Example (setting `ScheduledMode` to `1`/`true`):
        ```bash
        # View current config
        curl -X POST http://localhost:8080/api/inject/{chargePointId} ... -d '{ "action": "GetConfiguration", "payload": { "key": ["ScheduledMode"] } }'
        
        # Enable it
        curl -X POST http://localhost:8080/api/inject/{chargePointId} ... -d '{ "action": "ChangeConfiguration", "payload": { "key": "ScheduledMode", "value": "1" } }'
        ```

## 2. Understanding Charging Profiles (Implemented Strategy)

We implement a simplified Smart Charging model suitable for most EVSEs:

*   **Persistent Limit (`ChargePointMaxProfile`)**:
    *   **Purpose:** Limits the *entire charger* (e.g., grid capacity).
    *   **Behavior:** Saved to the database. Automatically injected when the charger connects or reconnects.
    *   **Connector ID:** 0 (all connectors).
    *   **Stack Level:** 1.

*   **Session Limit (`TxProfile`)**:
    *   **Purpose:** Limits a *specific active session*.
    *   **Behavior:** One-time application. Not saved to DB.
    *   **Requirement:** applied to a specific `transactionId`.
    *   **Stack Level:** 1.

*   **Future Session Limit (`TxDefaultProfile`)**:
    *   **Purpose:** Limits *new* sessions that haven't started yet.
    *   **Behavior:** One-time application. Not saved to DB.
    *   **Stack Level:** 1.

---

## 3. Controlling via API

The Proxy provides a high-level API to manage these limits without constructing raw OCPP packets.

### endpoint: `POST /api/chargers/{cpId}/smart-charging`

#### A. Set Persistent Limit (Charger-Wide)
Limits the total power draw of the charger. This setting survives reboots and reconnections.

```json
{
  "maxPower": 32.0,
  "action": "apply"  // optional, implied
}
```

#### B. Set Session Limit (One-Time)
Limits the current active session.

```json
{
  "sessionLimit": 16.0,
  "transactionId": 12345
}
```
*   `transactionId` is required for `TxProfile` (active session).
*   If `transactionId` is omitted, it defaults to `TxDefaultProfile` (future sessions), which may not affect the car currently charging depending on the charger implementation.

#### C. Clear All Profiles
Removes all limits and clears the persistent setting from the database.

```json
{
  "action": "clear"
}
```

---

## 4. Manual Injection (Advanced)

If you prefer raw control, you can still inject `SetChargingProfile` manually via `/api/inject/{cpId}`.

### Scenario: Limit Active Transaction
```bash
curl -X POST http://localhost:8080/api/inject/{chargePointId} \
  -u admin:YOUR_PASSWORD \
  -H "Content-Type: application/json" \
  -d '{
    "action": "SetChargingProfile",
    "payload": {
      "connectorId": 1,
      "csChargingProfiles": {
        "chargingProfileId": 2,
        "transactionId": 12345,
        "stackLevel": 1,
        "chargingProfilePurpose": "TxProfile",
        "chargingProfileKind": "Absolute",
        "chargingSchedule": {
          "chargingRateUnit": "A",
          "chargingSchedulePeriod": [
            { "startPeriod": 0, "limit": 10.0 }
          ]
        }
      }
    }
  }'
```

---

## 5. Verification

To see what limit is currently active on the charger, use `GetCompositeSchedule`.

```bash
curl -X POST http://localhost:8080/api/inject/{chargePointId} \
  -u admin:YOUR_PASSWORD \
  -H "Content-Type: application/json" \
  -d '{
    "action": "GetCompositeSchedule",
    "payload": {
      "connectorId": 0,
      "duration": 60,
      "chargingRateUnit": "A"
    }
  }'
```

## Troubleshooting
*   **Persistent limit not applying?** Ensure the charger is rebooted or reconnected after the limit is set in the DB. The proxy applies it on the `connection` event.
*   **Session limit disabled?** The UI disables the session limit control if it cannot detect an active transaction ID. Ensure a session is in progress.
