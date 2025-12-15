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

## 2. Understanding Charging Profiles

A "Charging Profile" defines a power schedule. To set one, you use the `SetChargingProfile` command. The most important fields are:

*   **ChargingProfilePurpose**: Defines *what* this profile applies to.
    *   `ChargePointMaxProfile`: Limits the entire charger (e.g., grid connection limit).
    *   `TxDefaultProfile`: The default profile used for *new* transactions (e.g., "weekday 8am-5pm limit").
    *   `TxProfile`: Applies to a *specific* ongoing transaction (overrides defaults for that user/session).
*   **StackLevel**: Determines priority when multiple profiles conflict. Higher numbers take precedence.
*   **ConnectorId**: `0` for the entire charger, `1` (or higher) for specific connectors.

---

## 3. Common Scenarios

### Scenario A: Limit the Entire Charger (Grid Limit)
**Purpose:** `ChargePointMaxProfile`
**Use Case:** Your breaker is 40A, but you want to ensure the charger never pulls more than 32A total, regardless of how many cars are plugged in.

```bash
curl -X POST http://localhost:8080/api/inject/{chargePointId} \
  -u admin:YOUR_PASSWORD \
  -H "Content-Type: application/json" \
  -d '{
    "action": "SetChargingProfile",
    "payload": {
      "connectorId": 0,
      "csChargingProfiles": {
        "chargingProfileId": 1,
        "stackLevel": 0,
        "chargingProfilePurpose": "ChargePointMaxProfile",
        "chargingProfileKind": "Absolute",
        "chargingSchedule": {
          "chargingRateUnit": "A",
          "chargingSchedulePeriod": [
            { "startPeriod": 0, "limit": 32.0 }
          ]
        }
      }
    }
  }'
```

### Scenario B: Default User Behavior (Time of Use)
**Purpose:** `TxDefaultProfile`
**Use Case:** You want all charging sessions to be limited to 6A during peak hours (e.g., start of day) but go full speed (e.g., 32A) after 8 hours. Note: `startPeriod` is relative to the start of the transaction.

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
        "stackLevel": 0,
        "chargingProfilePurpose": "TxDefaultProfile",
        "chargingProfileKind": "Relative",
        "chargingSchedule": {
          "chargingRateUnit": "A",
          "chargingSchedulePeriod": [
            { "startPeriod": 0, "limit": 6.0 },
            { "startPeriod": 28800, "limit": 32.0 } 
          ]
        }
      }
    }
  }'
```
*Note: 28800 seconds = 8 hours.*

### Scenario C: Throttle an Active Session
**Purpose:** `TxProfile`
**Use Case:** A specific user is charging (transaction ID 12345), and you want to throttle them immediately.

```bash
curl -X POST http://localhost:8080/api/inject/{chargePointId} \
  -u admin:YOUR_PASSWORD \
  -H "Content-Type: application/json" \
  -d '{
    "action": "SetChargingProfile",
    "payload": {
      "connectorId": 1,
      "csChargingProfiles": {
        "chargingProfileId": 3,
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
*Note: You must provide the valid `transactionId` of the active session.*

---

## 4. Clearing Profiles

To remove a profile, use `ClearChargingProfile`.

```bash
curl -X POST http://localhost:8080/api/inject/{chargePointId} \
  -u admin:YOUR_PASSWORD \
  -H "Content-Type: application/json" \
  -d '{
    "action": "ClearChargingProfile",
    "payload": {
      "id": 1
    }
  }'
```
*   `id`: The `chargingProfileId` you want to remove. Omit to clear all/matching criteria.

---

## 5. Viewing All Profiles (`GetChargingProfiles`)

To see a list of *all* profiles currently installed on the charger, use `GetChargingProfiles`.

```bash
curl -X POST http://localhost:8080/api/inject/{chargePointId} \
  -u admin:YOUR_PASSWORD \
  -H "Content-Type: application/json" \
  -d '{
    "action": "GetChargingProfiles",
    "payload": {
      "connectorId": 0,
      "chargingProfilePurpose": "ChargePointMaxProfile" 
    }
  }'
```
**Payload Options:**
*   `connectorId`: Filters by connector (0 = whole charger).
*   `chargingProfilePurpose`: Optional filter (e.g., `TxDefaultProfile`). Omit to potentially see more (depending on charger implementation).

**Note:** This command triggers an asynchronous response. The charger will reply with a `GetChargingProfilesResponse` (e.g., `Accepted` or `NoProfiles`). Then, if profiles exist, it will likely send the actual data via a separate `ReportChargingProfiles` message (OCPP 1.6 logic), which you will see in the **UPSTREAM** logs.

---

## 6. Viewing the Active Limit (`GetCompositeSchedule`)

This command differs from `GetChargingProfiles`. It asks the charger: "Considering all these profiles and constraints, what is my **net result** right now?"

```bash
curl -X POST http://localhost:8080/api/inject/{chargePointId} \
  -u admin:YOUR_PASSWORD \
  -H "Content-Type: application/json" \
  -d '{
    "action": "GetCompositeSchedule",
    "payload": {
      "connectorId": 0,
      "duration": 3600,
      "chargingRateUnit": "A"
    }
  }'
```

**Success Response (Example):**
```json
{
  "status": "Accepted",
  "scheduleStart": "2023-12-15T10:00:00Z",
  "connectorId": 0,
  "chargingSchedule": {
    "duration": 3600,
    "chargingRateUnit": "A",
    "chargingSchedulePeriod": [
      {
        "startPeriod": 0,
        "limit": 16.0
      }
    ]
  }
}
```

## Troubleshooting
*   **"NotSupported" response**: It is very common for chargers to respond with "NotSupported" to `GetChargingProfiles`. This means the charger firmware does not allow retrieving profiles, even if they are active.
*   **No "ReportChargingProfiles" message**: If you sent `GetChargingProfiles` and got an "Accepted" response but no collection of profiles followed:
    1.  The charger might have no profiles set.
    2.  The charger might be failing to send the report.
    3.  (Fixed in this version) Ensure your proxy version supports `ReportChargingProfiles` acknowledgement if running offline.
*   **"Rejected"**: The profile might be invalid (e.g., `TxProfile` without `transactionId`, or limits outside accepted range).
