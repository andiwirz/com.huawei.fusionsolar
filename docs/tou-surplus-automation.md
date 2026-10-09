# Automating TOU surplus handling (Feed to Grid ↔ Charge Battery)

**The problem this solves:** in Time-of-Use mode the inverter has a fixed rule for what to
do with surplus PV — either *Feed to Grid* or *Charge Battery*. Set it to *Charge Battery*
and the inverter can cut off once the battery is full. Set it to *Feed to Grid* and you
give away energy the battery could have stored. This guide switches that setting
automatically, based on the battery's state of charge.

Everything below is done with Flows in Homey. Nothing needs to be edited in the app itself.

---

## Before you start

Three prerequisites. Skip any of them and the flows will appear to run but change nothing.

**1. Your battery must be listed in the EMS settings.**
Open the *Energy Management* device → **Settings** → **Home Batteries**, and add your
battery there. The `EMS: battery is full` / `EMS: battery is low` triggers only ever fire
for batteries in that list — a battery that merely exists in Homey is not enough.

**2. The inverter must already be in TOU mode, with its time segments configured.**
This app can *select* the working mode, but it cannot define the TOU time segments. Those
still have to be set in the Huawei FusionSolar app. If no segments are defined, TOU mode
does nothing regardless of what the surplus setting says.

**3. No remote dispatch may be active.**
If your installer or grid operator has remote dispatch enabled (register 47589), it
overrides the working mode. Writes will be accepted and silently have no effect.

---

## Which action card is yours

There are **two** cards with the identical title **“Set excess PV energy use in TOU mode”** — one
per connection type. They are not interchangeable. Tell them apart by the hint shown under
the title:

| Your setup | Card hint says | Register |
|---|---|---|
| Direct Modbus to the inverter (`LUNA2000 Modbus` device) | “…via Modbus” | 47299 |
| Via an EMMA (`LUNA2000 EMMA Modbus` device) | “…via EMMA Modbus” | 40001 |

The device picker in each card only offers devices of the matching type, so if your battery
does not appear in the list, you have picked the wrong one of the two.

Both cards offer the same dropdown: **Feed to Grid** and **Charge Battery**.

---

## The two flows

### Flow 1 — battery full, stop charging it

```
WHEN   EMS: battery is full
AND    Excess PV energy use in TOU mode  is not  Feed to Grid
THEN   Set excess PV energy use in TOU mode  →  Feed to Grid
```

### Flow 2 — battery has room again, charge it

```
WHEN   EMS: battery is low
AND    Excess PV energy use in TOU mode  is not  Charge Battery
THEN   Set excess PV energy use in TOU mode  →  Charge Battery
```

The condition card is called **“Excess PV energy use in TOU mode is / is not”** and works for both
connection types, so there is only one of it.

**Why the condition matters.** Without it, every trigger writes the register whether or not
the value actually changes. With it, the register is only written when the setting really
has to flip — a handful of times a day instead of continuously. This is the single most
useful line in both flows.

---

## What the thresholds actually are

The triggers do not have their own threshold setting, and the in-app hints on these two
cards are out of date — they name settings that no longer exist. The real values are
derived from your EMS configuration:

- **If you have configured a surplus ramp** (EMS settings → the SoC ramp with a lower and
  an upper point), then `battery is full` fires at the **upper** ramp point and
  `battery is low` at the **lower** one.
- **If you have not**, the defaults are **95 %** for full and **80 %** for low.

Each trigger fires **once per crossing**, not repeatedly. `battery is full` re-arms only
after the SoC has fallen 5 points back below the threshold, so a battery hovering at the
limit will not produce a burst of writes.

**If you want different thresholds than those,** do not use these triggers. Build the flows
on the battery's own SoC capability instead:

```
WHEN   Battery SoC  changed
AND    Battery SoC  is greater than  <your number>
AND    Excess PV energy use in TOU mode  is not  Feed to Grid
THEN   Set excess PV energy use in TOU mode  →  Feed to Grid
```

The third line is doing real work here — a *changed* trigger fires on every poll, so
without the condition you would write the register continuously.

---

## Optional: Fully Fed to Grid

If instead of switching the surplus setting you want to move the whole battery out of the
way — for instance during a negative-price window — use the **“Set storage working mode”**
action with **Fully Fed to Grid**. Same two-card situation as above: a Modbus variant and
an EMMA variant.

Note that the EMMA card offers only four modes (Maximise Self-Consumption, Fully Fed to
Grid, Time of Use, Third-party Scheduling); Adaptive, Fixed Charge/Discharge and TOU (LG)
are not available through EMMA.

Remember to switch the mode **back to Time of Use** in a second flow, or the battery will
stay out of the picture.

---

## Checking that it works

**The action cards are fire-and-forget.** A flow step will show as successful even when the
Modbus write failed. There is exactly one place the failure appears — the app log:

```
Write failed [luna2000_set_excess_pv → reg 47299]: <message>
```

So if the behaviour is not what you expect, check the app log rather than the flow history.

**Two more things worth knowing:**

- **The displayed value can lag.** The control registers are only read on every 5th poll.
  With a 10-second poll interval that is under a minute; with the maximum 300-second
  interval it can be up to 25 minutes. The condition card reads the same cached value, so
  right after a manual change it may still see the old one. If that bothers you, shorten
  the poll interval.
- **The picker on the device tile is a live write, not a preview.** Changing “Excess PV
  energy use” on the device page writes the register immediately.

---

## The short version

1. Add the battery under EMS → Home Batteries.
2. Confirm TOU mode and its time segments in the FusionSolar app.
3. Build two flows: `battery is full` → Feed to Grid, `battery is low` → Charge Battery.
4. Put an `is not` condition in both so the register is written only on a real change.
5. If something misbehaves, look in the app log for `Write failed`.
