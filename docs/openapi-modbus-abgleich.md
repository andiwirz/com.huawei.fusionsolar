# OpenAPI gegen Modbus — Abgleich und Änderungsliste

**Entwicklernotiz, kein Benutzerdokument.** Aufgenommen bei App-Version 1.2.211. Entstanden aus
Issue #25 (Jamesquare78, Homey Energy zeigt die Batterie nicht in der Summe) und einer
Messreihe auf einer Anlage, die **beide Pfade gleichzeitig** betreibt — Modbus über
10.160.13.72 und OpenAPI über eu5, Station `NE=141986968`. Dadurch messen beide
Treibersätze dieselbe Hardware im selben Moment, und Abweichungen sind eindeutig einem
Treiber zuzuordnen.

**Stand nach 1.2.212** — teilweise umgesetzt. Erledigt sind:

| Punkt | Was |
|---|---|
| A1 | `active_power` und die drei Phasen im Zweig Leistungssensor (47) **und** Netzzähler (17) negiert |
| B1 | `active_power` im Netzblock des Wechselrichters negiert |
| B4, B5 | `meter_power` → `meter_power.grid_import`, `meter_power.exported` → `meter_power.grid_export`, alte Namen in `DEPRECATED_CAPABILITIES` |
| C3 | `measure_battery.soh` bei 0 nicht geschrieben — die Capability wird angelegt, sobald ein echter Wert kommt, und von Geräten entfernt, die heute 0 % zeigen |
| — | `enable_timeline_notifications` auf Wechselrichter und Batterie (im Original nicht aufgeführt); der Zähler bekommt keinen, weil `openapi_meter_status` bewusst entfernt wurde und es nichts zu melden gibt |

Regressionstests mit den Zahlen aus Abschnitt 2: `test/openapi-grid-sign.test.js`,
`test/openapi-parity.test.js`. Mutationsprobe 17/17.

**A2 bleibt bewusst offen.** Der EMMA-Zweig hat nachweislich eine eigene Konvention bei den
Zählern (`active_cap`/`reverse_active_cap` vertauscht), es gibt keine EMMA-Messung, und ein
Vorzeichen auf Verdacht zu drehen macht aus einer richtigen Anzeige eine falsche. Ein Test
hält den Zweig jetzt fest, damit die Negation nicht versehentlich hineinläuft.

Alles Übrige aus Abschnitt 4 und 7 steht weiterhin offen — insbesondere B2/B3/B6 (der
Ertrag auf die blanke `meter_power`, mit der Migration und dem Insights-Verlust), C1/C2,
D1, A3 und A4.

---

## 1 · Der Befund in einem Satz

Die OpenAPI-Treiber melden die **Netzleistung mit umgekehrtem Vorzeichen**, und der
OpenAPI-Wechselrichter legt den **Netzbezug in die blanke `meter_power`** eines
`solarpanel`-Geräts. Alles andere stimmt — die kumulierten Zähler decken sich mit Modbus
aufs Hundertstel.

---

## 2 · Die Messung

Beide Abzüge stammen aus Homey Developer Tools, wenige Sekunden auseinander.
Anlagenzustand: PV läuft, Batterie voll und im Leerlauf, Haus bezieht rund 2.4 kW,
Überschuss geht ins Netz.

### 2.1 Netzzähler

| Grösse | OpenAPI Leistungssensor | Modbus DTSU666 | Urteil |
|---|---|---|---|
| `measure_power` | **+4650** | **−4631** | ✗ Vorzeichen |
| Zustandstext | „4650 W **Import**" | „4631 W **Export**" | ✗ |
| Leistung A / B / C | **+1735 / +602 / +2312** | **−1786 / −594 / −2250** | ✗ jede Phase |
| Phasensumme | +4649 | −4630 | passt je zu `measure_power` |
| Netzbezug gesamt | 23167.8 | 23167.8 | ✓ identisch |
| Netzeinspeisung gesamt | 17062.67 | 17063.10 | ✓ 0.43 = Zeitversatz |
| Spannung A / B / C | 239 / 237.6 / 239.1 | 239 / 238.1 / 239.1 | ✓ |
| Strom A / B / C | 7.44 / 2.86 / 9.69 | 7.63 / 2.83 / 9.43 | ✓ |
| Netzfrequenz | 50 | — | nur OpenAPI |
| Phasen-Capabilities | `meter_u` `b_u` `c_u` / `meter_i` `b_i` `c_i` | `phase1/2/3` | uneinheitlich |

### 2.2 Wechselrichter

| Grösse | OpenAPI | Modbus | Urteil |
|---|---|---|---|
| `measure_power` | 7028 | 7033 | ✓ |
| `measure_power.mppt` | 7028 | — | nur OpenAPI, zeichengleich |
| `measure_power.active_power` | 7028 | 7033 | ✓ |
| Temperatur | 58.2 | 58.2 | ✓ identisch |
| Gesamtertrag | `meter_power.inv_total` 47407.43 | `meter_power` 47408.07 | ✓ 0.64 = Versatz |
| Tagesertrag | `.inv_daily` 19.01 | `.daily` 19.65 | ✓ 0.64 |
| PV1 V / A | 554.2 / 7.33 | 558.1 / 7.37 | ✓ |
| PV2 V / A | 397.3 / 7.97 | 397.3 / 7.97 | ✓ identisch |
| Netzwirkleistung | **+4650** | **−4616** | ✗ Vorzeichen |
| Netzeinspeisung gesamt | `meter_power.exported` 17062.67 | `meter_power.grid_export` 17063.07 | ✓ |
| **Netzbezug gesamt** | **`meter_power` 23167.8** | **`meter_power.grid_import` 23167.8** | ✗ Ablage |
| Status | „Grid-connected" | „On-grid" | Wortlaut |
| Netzfrequenz | 50.02 | — | nur OpenAPI |
| Wirkungsgrad | 100 | — | konstant 100, wertlos |

### 2.3 Batterie

| Grösse | OpenAPI | Modbus | Urteil |
|---|---|---|---|
| `measure_power` | 0 | 0 | ✓ |
| Ladezustand | 100 | 100 | ✓ |
| Gesamtladung | 15834.93 | 15834.93 | ✓ identisch |
| Gesamtentladung | 15659.47 | 15659.47 | ✓ identisch |
| Laden / Entladen | 0 / 0 | 0 / 0 | ✓ |
| max. laden / entladen | 5000 / 5000 | 5000 / 5000 | ✓ |
| heute geladen / entladen | 13.12 / 4.53 | 13.12 / 4.53 | ✓ identisch |
| Status | „Running" (`openapi_battery_status`) | „Running" (`luna2000_battery_status`) | zwei Capabilities |
| Betriebsmodus | „Automatic charge/discharge" | `storage_working_mode_settings` = 2 | gleichbedeutend |
| Zustandstext | „Full (100%)" | „Voll (100%)" | ✗ nicht übersetzt |
| Gesundheitszustand | **0** | — | ✗ Huawei liefert konstant 0 |
| Batteriespannung | 787.3 | — | nur OpenAPI |

### 2.4 Plausibilität

| Rechnung | Modbus | OpenAPI |
|---|---|---|
| PV − Netz − Batterie | 7033 − 4631 − 0 = **2402 W** | 7028 **+** 4650 = **11 678 W** |
| SDongle Verbrauchsleistung | **2402** ✓ | — |
| EMS Hausverbrauch | 2400 ✓ | — |
| mit gedrehtem Vorzeichen | — | 7028 − 4650 = **2378** ✓ |

Der Dreher macht aus 2.4 kW Hausverbrauch 11.7 kW.

### 2.5 Der Versatz — die Cloud ist nicht falsch, nur später

Die kumulierten OpenAPI-Werte entsprechen exakt den Modbus-Werten eines Abfragezyklus
vorher (Intervall 10 Minuten):

| Zähler | OpenAPI jetzt | Modbus vorherige Aufnahme | Modbus jetzt |
|---|---|---|---|
| Gesamtertrag | 47407.43 | **47407.43** | 47408.07 |
| Tagesertrag | 19.01 | **19** | 19.65 |
| Netzeinspeisung | 17062.67 | **17062.67** | 17063.10 |

Damit ist `total_cap` als verlässlich belegt. Für Issue #25 heisst das: James'
`meter_power.inv_total` von 35123.36 gegen 7652.04 seines Kiosk-Werks ist eine Anomalie in
seinen Huawei-Daten, kein Treiberfehler.

---

## 3 · Warum das Vorzeichen kein Zweifelsfall ist

Zwei unabhängige Belege, keine Annahme:

**Erstens** sagt der Modbus-Treiber, warum er dreht — `drivers/dtsu666_modbus/device.js`:

```js
// PDF sign convention: >0 = feed-in to grid, <0 = supply from grid.
const negate = (v) => (v !== null && v !== undefined) ? -v : null;
const gridPower = negate(meter.powerMeterActivePower);
```

**Zweitens** folgt der OpenAPI-Treiber derselben Huawei-Konvention bereits — aber nur bei
den Zählern, `drivers/powermeter_openapi_fusionsolar/device.js`:

```js
await this._set('meter_power',          sumKwh(psMaps, 'reverse_active_cap')); // Bezug
await this._set('meter_power.exported', sumKwh(psMaps, 'active_cap'));         // Einspeisung
```

`active_*` ist bei Huawei die Einspeiserichtung. Für die Energie steht es so da, für die
Leistung nicht. Der Treiber widerspricht sich selbst, und die Zähler sind nachweislich die
richtige Hälfte (Abschnitt 2.1).

Der Kommentar auf Zeile 149 („active_power: positive = import, negative = export") ist die
falsche Hälfte und gehört mit korrigiert.

**Hinweis zu James' Daten:** seine ±11 W können das nicht widerlegen — bei dieser Grösse
passen beide Lesarten zu seiner Bilanz.

---

## 4 · Änderungsliste

### A · Leistungssensor → `dtsu666_modbus`

| # | Änderung | Stelle |
|---|---|---|
| A1 | `active_power` und `active_power_a/b/c` **negieren** | `powermeter_openapi_fusionsolar/device.js:150`, 172–174 |
| A2 | Gleiches im **EMMA-Zweig** | ebd. 114, 139–141 |
| A3 | Phasennamen `meter_u/b_u/c_u`, `meter_i/b_i/c_i` → `phase1/2/3` | ebd. 167–172 + Migration in `onInit` |
| A4 | `EXTRA_CAPABILITIES`-Schleife **vor** den ersten Schreibvorgang einer Zusatz-Capability | ebd. Zeile 156 vs. 162 |

A1 zieht mit: `measure_power`, die drei Phasenleistungen, `powermeter_state_string` — und
die Flow-Auslöser „Einspeisung begonnen" / „Bezug begonnen", die heute verkehrt feuern.

A2 ist ungeprüft: es gibt keine EMMA-Messung zum Vergleich. Dasselbe Feld, vermutlich
dieselbe Konvention — vor dem Ausliefern an einer EMMA-Anlage bestätigen lassen.

A4 erklärt, warum `powermeter_state_string` beim ersten erfolgreichen Abruf leer bleibt:
geschrieben auf Zeile 156, angelegt erst auf Zeile 162.

Ohne Gegenstück: `measure_frequency` (nur OpenAPI, schadet nicht), `dtsu666_meter_status`
(kein API-Feld).

### B · Wechselrichter → `sun2000_modbus`

| # | Änderung | heute | danach |
|---|---|---|---|
| B1 | `active_power` im Netzblock negieren (`device.js:206`) | +4650 | −4650 |
| B2 | `meter_power.inv_total` → **`meter_power`** | Ertrag auf Unter-Cap | wie Modbus |
| B3 | `meter_power.inv_daily` → **`meter_power.daily`** | | wie Modbus |
| B4 | `meter_power` → **`meter_power.grid_import`** | Netzbezug auf der blanken Cap | wie Modbus |
| B5 | `meter_power.exported` → **`meter_power.grid_export`** | | wie Modbus |
| B6 | energy-Block → `{"meterPowerExportedCapability": "meter_power"}` | zeigt auf `inv_total` | identisch zu Modbus |
| B7 | `huawei_status` auf „On-grid" abbilden | „Grid-connected" | gleicher Wortlaut |
| B8 | `openapi_inverter_efficiency` entfernen | konstant 100 | Modbus hat es nicht |

**Reihenfolge der Migration bei B2/B4:** `meter_power` ist besetzt. Erst
`meter_power.grid_import` anlegen und den Wert übernehmen, dann `meter_power` entfernen,
dann neu anlegen und mit dem Ertrag füllen. Die bisherige Insights-Kurve von `meter_power`
enthält Netzbezugswerte und lässt sich nicht retten — das muss in den Changelog.

Nicht identisch machbar: `activepower_controlmode`, `sun2000_software_version` — weder
Felder noch Schreibpfad über die OpenAPI. `measure_power.mppt` ist zeichengleich mit
`measure_power`; kann weg oder als DC-Anzeige bleiben.

### C · Batterie → `luna2000_modbus`

Alle Messwerte stimmen bereits überein. Es fehlt nur die Fassade.

| # | Änderung | heute | danach |
|---|---|---|---|
| C1 | `openapi_battery_status` → **`luna2000_battery_status`** | eigene Capability | dieselbe wie Modbus, **erbt Auslöser und Bedingungskarte** |
| C2 | `'Full'`/`'Empty'` → `this.homey.__('modbus.battery.state.full'/'empty')` | „Full (100%)" | „Voll (100%)" |
| C3 | `measure_battery.soh` nicht schreiben, wenn 0 | 0 % | Modbus hat es nicht |

C2 ist eine Zeile je Wort: die beiden Baublöcke sind sonst zeichengleich — der
OpenAPI-Treiber sagt selbst „same logic as luna2000_modbus" (`device.js:158`) und hat
allein die zwei Sprachschlüssel nicht übernommen.

C3: 0 % auf zwei unabhängigen Huawei-Konten gemessen.

Nicht identisch machbar: die vier Steuer-Enums, `measure_battery_modules`, die
Unit-Kennzeichen, die Software-Version. `openapi_battery_mode` bleibt eine reine Anzeige,
weil die OpenAPI keinen Schreibpfad hat — das ist die ehrliche Form, kein Mangel.

### D · Beide Seiten

| # | Änderung | Begründung |
|---|---|---|
| D1 | `"batteries": ["INTERNAL"]` aus **allen vier** Hausbatterie-Treibern streichen | laut Doku beschreibt es Geräte, die *aus* Batterien gespeist werden — steht seit 1.2.207 als offener Punkt |
| D2 | Verfügbarkeitsregel auf mehrere Zyklen in Folge | ein ausgelassener Zyklus setzt heute ein Gerät mit gültigen Daten offline |

Zu D2, `lib/openapi-coordinator.js`:

```js
const present = types.filter((t) => (this._devIdsByType[t] || []).length);
const starved = present.length > 0 && present.every((t) => typesWithoutData.has(t));
```

Beobachtet wurde beides: die Batterie stand auf `Available: No (No data from FusionSolar
for device type 39)` mit fünfzehn gültigen, acht Minuten alten Werten — ein einziger
ausgelassener Zyklus genügt. Umgekehrt bekommt ein Gerät, dessen Typen **alle** fehlen
(`present.length === 0`), gar keine Warnung und bleibt stumm auf `null` stehen. Die Regel
schlägt im harmlosesten Fall an und schweigt im schlimmsten.

`_devIdsByType` wird zudem einmal geholt und bis zum App-Neustart behalten
(`if (this._devIdsByType) return;`) — ein unvollständiger erster Abruf bleibt unvollständig.

---

## 5 · Die Treiber gegen die Energy-Doku

Geprüft gegen <https://apps.developer.homey.app/the-basics/devices/energy>.

| Treiber | Klasse | energy-Block | Urteil |
|---|---|---|---|
| `sun2000_modbus` | `solarpanel` | `meterPowerExportedCapability: meter_power` | ✓ konform |
| `sun2000_openapi_fusionsolar` | `solarpanel` | `meterPowerExportedCapability: meter_power.inv_total` | ✗ blanke `meter_power` trägt den Netzbezug |
| `dtsu666_modbus` | `sensor` | `cumulative` + imported/exported | ✓ konform |
| `powermeter_openapi_fusionsolar` | `sensor` | `cumulative` + imported/exported | ✗ Vorzeichen verdreht |
| `luna2000_modbus` | `battery` | `homeBattery` + imported/exported + `batteries` | ✓ bis auf `batteries` |
| `luna2000_openapi_fusionsolar` | `battery` | dito | ✓ bis auf `batteries` |
| `sdongle_a_modbus` | `sensor` | kein Block | ✗ meldet den Hausverbrauch als eigenen Verbrauch |
| `energy_management` | `other` | kein Block | ✓ per `energy_exclude` draussen |
| `isitepower_home_openapi_fusionsolar` | `sensor` | `cumulative` + imported/exported | ✗ Hausverbrauch als oberster Zähler |

Die belegenden Stellen der Doku:

- Solarpanel: „the driver must have a `meter_power` capability that will be set to the
  **total generated energy** in kWh as a positive value."
- Cumulative: „these are the **highest level** measuring devices in a home. All other power
  consuming or generating devices in a home are measured by these devices."
- Hausbatterie: „positive values to indicate the battery is consuming power (charging),
  negative values to indicate the battery is delivering power back to the home."

### Die zwei offenen Punkte ausserhalb der OpenAPI-Treiber

**`sdongle_a_modbus`** hat Klasse `sensor`, keinen energy-Block, und schreibt in
`measure_power` den **Hausverbrauch** (gemessen: 2402 W). Homey verbucht das als Verbrauch
dieses Geräts, also das Haus ein zweites Mal. Auf der Messanlage ist es von Hand über
`energy_exclude: true` entschärft. Steht seit 1.2.207 offen.

**`isitepower_home_openapi_fusionsolar`** ist dieselbe Form, aber schärfer: es meldet
ebenfalls den Hausverbrauch (`loadW`) und trägt zusätzlich `cumulative: true`. Wer auch das
Netz-Gerät hat, betreibt damit zwei oberste Zähler. Sein `cumulativeExportedCapability`
zeigt zudem auf eine Capability, die fest auf `0` gesetzt wird (`device.js:21`) — die Doku:
„If the device only supports measuring imported energy you can omit the
`cumulativeExportedCapability`." Vorschlag: energy-Block ersatzlos streichen.

---

## 6 · Warnung für Parallelbetrieb

Solange beide Pfade gleichzeitig gepaart sind, ist die Energieansicht wertlos:

| Rolle | Geräte | `energy_exclude` | Homey rechnet mit |
|---|---|---|---|
| Solarpanel | Wechselrichter + Inverter (OpenAPI) | beide `false` | 7033 + 7028 = **14 061 W** |
| Hausbatterie | Huawei Batterie + LUNA2000 (OpenAPI) | beide `false` | 0 + 0 |
| Cumulative Zähler | Energiezähler + Leistungssensor | beide `false` | −4631 **+** 4650 = **+19 W** |

Solar zählt doppelt, und die zwei Netzzähler löschen einander wegen des Vorzeichenfehlers
fast aus. Fürs Vergleichen in Ordnung, für den Dauerbetrieb nicht — eine Seite gehört auf
`energy_exclude: true`.

---

## 7 · Reihenfolge

1. **A1/A2, B1** — Vorzeichen. Die einzigen Änderungen, die Zahlen verfälschen, und je eine
   Zeile.
2. **B2–B6** — `meter_power` des Wechselrichters. Braucht die Migration aus Abschnitt 4 B.
3. **C1–C3** — Batterie-Fassade. Risikoarm.
4. **D2** — Verfügbarkeitsregel.
5. **D1** — `batteries: ["INTERNAL"]`.
6. **A3, B7, B8** — Namen und Wortlaute.
7. SDongle und iSitePower Home aus Energy nehmen (Abschnitt 5).

Für Punkt 1 und 2 gehören Regressionstests mit den Zahlen aus Abschnitt 2 dazu — die
Messung ist reproduzierbar, weil beide Pfade dieselbe Anlage lesen.
