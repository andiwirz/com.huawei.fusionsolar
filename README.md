# Huawei FusionSolar Manager – Homey App

**App ID:** `com.huawei.fusionsolar`
**SDK:** Homey SDK 3
**Kompatibel mit:** Homey Pro (Early 2023), Homey Pro (2019), Homey Bridge (Firmware >= 12.3.0)

---

## Unterstützte Verbindungsarten

Diese App unterstützt drei unabhängige Verbindungsarten zu einer Huawei FusionSolar Anlage:

| Verbindung     | Beschreibung                                                                  |
|----------------|-------------------------------------------------------------------------------|
| **Kiosk**      | Liest Anlagendaten über die öffentliche Kiosk-URL (kein Konto erforderlich)  |
| **OpenAPI**    | Verbindet sich über die offizielle Northbound API mit FusionSolar-Konto      |
| **Modbus TCP** | Direkte Kommunikation mit SUN2000, LUNA2000 und DTSU666 über das lokale Netz |

---

## Geräte

### FusionSolar Anlage (Kiosk)

Verbindung über die öffentliche Kiosk-URL. Kein FusionSolar-Konto erforderlich.

| Capability        | Beschreibung                    |
|-------------------|---------------------------------|
| Solarleistung     | Aktuelle Erzeugungsleistung (W) |
| Gesamtertrag      | Kumulierter Gesamtertrag (kWh)  |
| Tagesgesamtertrag | Tagesertrag (kWh)               |
| Monatsertrag      | Monatsertrag (kWh)              |
| Jahresertrag      | Jahresertrag (kWh)              |

---

### SUN2000 Wechselrichter (OpenAPI)

Verbindung über die Huawei FusionSolar Northbound API. Liefert Wechselrichter-, Netz- und PV-String-Daten.

| Capability             | Beschreibung                                            |
|------------------------|---------------------------------------------------------|
| Solarleistung          | DC-Eingangsleistung der PV-Strings (W)                  |
| Wirkleistung           | AC-Ausgangsleistung (W)                                 |
| Kühlkörpertemperatur   | Innentemperatur des Wechselrichters (°C)                |
| Gesamtertrag           | Kumulierter Gesamtertrag (kWh)                          |
| Tagesgesamtertrag      | Tagesertrag (kWh)                                       |
| Spannung PV1 / PV2     | DC-Spannung der PV-Strings (V)                          |
| Strom PV1 / PV2        | DC-Strom der PV-Strings (A)                             |
| Netzwirkleistung       | Aktuelle Netzleistung: positiv = Bezug, negativ = Einspeisung (W) |
| Netzeinspeisung gesamt | Kumulierte Gesamteinspeisung ins Netz (kWh)             |
| Netzbezug gesamt       | Kumulierter Gesamtbezug aus dem Netz (kWh)              |

> Netzwerte werden vom Power Sensor (Typ 47) oder Grid Meter (Typ 17) der Anlage bezogen.

---

### Batterie LUNA 2000 (OpenAPI)

Verbindung über die Huawei FusionSolar Northbound API.

| Capability               | Beschreibung                                         |
|--------------------------|------------------------------------------------------|
| Batterieleistung         | Aktuell: positiv = laden, negativ = entladen (W)     |
| Ladezustand              | SoC in Prozent (%)                                   |
| Batterieladeleistung     | Aktuelle Ladeleistung (W)                            |
| Batterieentladeleistung  | Aktuelle Entladeleistung (W)                         |
| Maximale Ladeleistung    | Konfiguriertes Maximum (W)                           |
| Maximale Entladeleistung | Konfiguriertes Maximum (W)                           |
| Tagesgesamtladung        | Heute geladene Energie (kWh)                         |
| Tagesgesamtentladung     | Heute entladene Energie (kWh)                        |
| Gesundheitszustand       | State of Health / SoH (%)                            |
| Batteriestatus           | Betriebszustand als Text (z. B. Running, Standby)    |

---

### Energiezähler (OpenAPI)

Verbindung über die Huawei FusionSolar Northbound API. Wird als P1-Zähler (kumulativ) registriert.

| Capability             | Beschreibung                                              |
|------------------------|-----------------------------------------------------------|
| Netzwirkleistung       | Aktuell: positiv = Bezug, negativ = Einspeisung (W)       |
| Netzbezug gesamt       | Kumulierter Gesamtbezug (kWh)                             |
| Netzeinspeisung gesamt | Kumulierte Gesamteinspeisung (kWh)                        |
| Spannung Phase A/B/C   | Phasenspannungen (V) – dynamisch                          |
| Strom Phase A/B/C      | Phasenströme (A) – dynamisch                              |
| Leistung Phase A/B/C   | Phasenleistungen (W) – dynamisch                          |

---

### SUN2000 Wechselrichter (Modbus)

Direkte Modbus TCP Verbindung zum SUN2000 Wechselrichter oder SDongle.

| Capability                 | Beschreibung                                              |
|----------------------------|-----------------------------------------------------------|
| Solarleistung              | DC-Eingangsleistung der PV-Strings (W)                    |
| Wirkleistung               | AC-Ausgangsleistung (W)                                   |
| Kühlkörpertemperatur       | Innentemperatur des Wechselrichters (°C)                  |
| Gesamtertrag               | Kumulierter Gesamtertrag (kWh)                            |
| Tagesgesamtertrag          | Tagesertrag (kWh)                                         |
| Spannung PV1 / PV2         | DC-Spannung der PV-Strings (V)                            |
| Strom PV1 / PV2            | DC-Strom der PV-Strings (A)                               |
| Status des Wechselrichters | Betriebszustand als Text                                  |
| Wirkleistungs-Steuermodus  | Einstellbare Einspeisebegrenzung                          |
| Netzwirkleistung           | Aktuell (W) – nur wenn DTSU666 verbunden                  |
| Netzbezug gesamt           | Kumuliert (kWh) – nur wenn DTSU666 verbunden              |
| Netzeinspeisung gesamt     | Kumuliert (kWh) – nur wenn DTSU666 verbunden              |

---

### Batterie LUNA 2000 (Modbus)

Direkte Modbus TCP Verbindung zur LUNA2000 Batterie über den SUN2000 / SDongle.

#### Lesbare Werte

| Capability               | Beschreibung                                         |
|--------------------------|------------------------------------------------------|
| Batterieleistung         | Aktuell: positiv = laden, negativ = entladen (W)     |
| Ladezustand              | SoC in Prozent (%)                                   |
| Gesamte geladene Energie | Kumuliert seit Inbetriebnahme (kWh)                  |
| Gesamte entladene Energie| Kumuliert seit Inbetriebnahme (kWh)                  |
| Batterieladeleistung     | Aktuelle Ladeleistung (W)                            |
| Batterieentladeleistung  | Aktuelle Entladeleistung (W)                         |
| Maximale Ladeleistung    | Konfiguriertes Maximum (W)                           |
| Maximale Entladeleistung | Konfiguriertes Maximum (W)                           |
| Tagesgesamtladung        | Heute geladene Energie (kWh)                         |
| Tagesgesamtentladung     | Heute entladene Energie (kWh)                        |
| Batteriestatus           | Betriebszustand als Text (z. B. Running, Standby)    |

#### Steuerbare Werte

| Capability                       | Optionen                                                                      |
|----------------------------------|-------------------------------------------------------------------------------|
| Speicher-Betriebsmodus           | Adaptiv · Festes Laden/Entladen · Eigenverbrauch maximieren · TOU · Volleinspeisung · Drittanbieter |
| Erzwungenes Laden/Entladen       | Stopp · Laden · Entladen                                                      |
| Überschuss-PV-Energie (TOU)      | Ins Netz einspeisen · Batterie laden                                          |
| Fernsteuerung Laden/Entladen     | Lokale Steuerung · Max Eigenverbrauch · Volleinspeisung · TOU · KI · Drittanbieter |

---

### Energiezähler (Modbus)

Direkte Modbus TCP Verbindung zum DTSU666 Smart Meter über den SUN2000 / SDongle. Wird als P1-Zähler (kumulativ) registriert.

| Capability             | Beschreibung                                              |
|------------------------|-----------------------------------------------------------|
| Netzwirkleistung       | Aktuell: positiv = Bezug, negativ = Einspeisung (W)       |
| Netzbezug gesamt       | Kumulierter Gesamtbezug (kWh)                             |
| Netzeinspeisung gesamt | Kumulierte Gesamteinspeisung (kWh)                        |
| Spannung Phase A/B/C   | Phasenspannungen (V)                                      |
| Strom Phase A/B/C      | Phasenströme (A)                                          |
| Leistung Phase A/B/C   | Phasenleistungen (W)                                      |

---

## Installation

### Voraussetzungen

#### Kiosk
- FusionSolar Kiosk-URL (in der FusionSolar App unter Teilen → Kiosk URL)

#### OpenAPI
- FusionSolar-Konto mit aktivierter Northbound API
- Benutzername und System Code (API-Passwort)
- Regionaler Server: z. B. `https://eu5.fusionsolar.huawei.com`

#### Modbus
- SUN2000 Wechselrichter oder SDongle über LAN erreichbar
- Modbus TCP aktiviert (Standard-Port: **502**, SDongle: **6607**)
- Statische IP-Adresse empfohlen (DHCP-Reservierung im Router)

### Einrichtung in Homey

1. App aus dem Homey App Store installieren
2. Gerät hinzufügen: **Geräte → + → Huawei FusionSolar Manager**
3. Verbindungsart wählen und Verbindungsdaten eingeben
4. Verbindungstest – bei Erfolg wird das Gerät angelegt

---

## Geräteeinstellungen

### Kiosk

| Einstellung              | Standard  | Beschreibung                                 |
|--------------------------|-----------|----------------------------------------------|
| Kiosk URL                | –         | Öffentliche Kiosk-URL der Anlage             |
| Aktualisierungsintervall | 10 Min.   | Wie oft Daten abgerufen werden (min. 10 Min.)|

### OpenAPI

| Einstellung              | Standard                          | Beschreibung                                  |
|--------------------------|-----------------------------------|-----------------------------------------------|
| Server URL               | eu5.fusionsolar.huawei.com        | Regionaler FusionSolar API-Server             |
| Benutzername             | –                                 | FusionSolar API-Benutzername                  |
| System Code              | –                                 | API-Passwort                                  |
| Anlagencode              | –                                 | Wird beim Koppeln automatisch gesetzt         |
| Aktualisierungsintervall | 10 Min.                           | Wie oft Daten abgerufen werden (min. 10 Min.) |

> Huawei begrenzt API-Anfragen. Ein Intervall unter 10 Minuten wird nicht empfohlen.

### Modbus (SUN2000 / LUNA2000 / DTSU666)

| Einstellung                  | Standard | Beschreibung                              |
|------------------------------|----------|-------------------------------------------|
| IP-Adresse                   | –        | IP des SUN2000 / SDongle                  |
| Modbus Port                  | 502      | SDongle verwendet typischerweise 6607     |
| Modbus Geräte-ID             | 1        | Unit ID des Geräts (Standard: 1)          |
| Aktualisierungsintervall (s) | 60       | Wie oft abgefragt wird (min. 10 s)        |

---

## Flow-Karten

### Auslöser (Triggers)

| Karte                                 | Gerät                | Token          | Beschreibung                             |
|---------------------------------------|----------------------|----------------|------------------------------------------|
| Leistungsabgabe hat sich geändert     | Kiosk                | `power` (W)    | Bei jeder Leistungsänderung              |
| Tagesertrag aktualisiert              | Kiosk                | `daily_energy` | Bei Aktualisierung des Tagesertrags      |
| Leistungsabgabe geändert (Modbus)     | SUN2000 Modbus       | `power` (W)    | Bei jeder Leistungsänderung              |
| Leistungsabgabe geändert (OpenAPI)    | SUN2000 OpenAPI      | `power` (W)    | Bei jeder Leistungsänderung              |
| Ladezustand der Batterie geändert     | LUNA2000 Modbus      | `soc` (%)      | Bei jeder SoC-Änderung                  |
| Batterie-Ladestatus hat sich geändert | LUNA2000 Modbus      | `state`        | `charging` / `discharging` / `idle`     |
| Ladezustand der Batterie geändert     | Batterie OpenAPI     | `soc` (%)      | Bei jeder SoC-Änderung                  |
| Batterie-Ladestatus hat sich geändert | Batterie OpenAPI     | `state`        | `charging` / `discharging` / `idle`     |
| Einspeisung ins Netz begonnen         | Energiezähler Modbus | `power` (W)    | Wenn Bezug auf Einspeisung wechselt     |
| Netzbezug begonnen                    | Energiezähler Modbus | `power` (W)    | Wenn Einspeisung auf Bezug wechselt     |

### Bedingungen (Conditions)

| Karte                          | Gerät           | Beschreibung                                 |
|--------------------------------|-----------------|----------------------------------------------|
| Erzeugt gerade Strom           | Kiosk           | Prüft ob die Anlage aktuell Strom erzeugt    |
| Erzeugt gerade Strom (Modbus)  | SUN2000 Modbus  | Prüft ob der Wechselrichter aktuell erzeugt  |

---

## Energiedashboard

Die App ist vollständig für das Homey Energiedashboard konfiguriert:

| Gerät                    | Homey-Kategorie | Funktion                                                  |
|--------------------------|-----------------|-----------------------------------------------------------|
| Kiosk                    | Solarpanel      | Gesamtertrag → Erzeugte Energie                           |
| SUN2000 OpenAPI          | Solarpanel      | Gesamtertrag Wechselrichter → Erzeugte Energie            |
| SUN2000 Modbus           | Solarpanel      | Gesamtertrag → Erzeugte Energie                           |
| Batterie LUNA 2000 OpenAPI | Hausbatterie  | Lade- und Entladeleistung                                 |
| Batterie LUNA 2000 Modbus  | Hausbatterie  | Geladene / entladene Energie + Lade-/Entladeleistung      |
| Energiezähler OpenAPI    | P1-Zähler       | Netzbezug (kumulativ) + Netzeinspeisung (kumulativ)       |
| Energiezähler Modbus     | P1-Zähler       | Netzbezug (kumulativ) + Netzeinspeisung (kumulativ)       |

---

## Technischer Hintergrund

- **Kiosk:** HTTP-Abruf der öffentlichen FusionSolar Kiosk-API
- **OpenAPI:** HTTPS-Verbindung zur Huawei FusionSolar Northbound API (xsrf-token Authentifizierung, automatisches Re-Login bei Session-Ablauf). Geräte derselben Anlage teilen eine gemeinsame Session (ein API-Aufruf pro Intervall für alle Geräte)
- **Modbus:** TCP-Verbindung über [`jsmodbus`](https://www.npmjs.com/package/jsmodbus) nach Huawei SUN2000 Modbus Interface Definition A. Alle Modbus-Geräte am selben Host teilen eine serialisierte Warteschlange (`withHostLock`) – keine gleichzeitigen Verbindungen

---

## Lizenz

MIT License – siehe [LICENSE](LICENSE)

---

## KI-Entwicklung

Diese App wurde vollständig mit Hilfe von **Claude (Anthropic AI)** entwickelt.
