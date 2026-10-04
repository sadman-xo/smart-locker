# Smart Locker

A two-locker self-service rental system built around an ESP32, a pair of
solenoid locks, and a small Node.js web app. A user picks a locker, a start
time, and an end time on their phone, pays (demo gateway), and receives a
four-digit PIN. On arrival they type the PIN into the touch terminal mounted
beside the lockers; the server authorises the request, the ESP32 fires the
right relay for three seconds, and the solenoid releases.

Everything the operator cares about — bookings, pricing, overdue handling,
grace windows, extensions, releases — lives on the laptop running
`server.js`. The ESP32 is deliberately dumb: it holds the API key, drives two
GPIO pins, and reports two door-sensor readings. If the laptop goes offline,
no new unlocks happen; if the ESP32 goes offline, bookings keep flowing and
the terminal shows the error.

## Demonstrations

Two short videos of the finished build in action:

- Demo 1 — https://youtu.be/GNXkbMc9p4c?si=2XzW24nYv9g9apm_
- Demo 2 — https://youtu.be/rNBdtJM_PQ8?si=n8_iOzEQPL7W1Z1L

---

## Table of contents

1. [What it does](#what-it-does)
2. [Architecture at a glance](#architecture-at-a-glance)
3. [The booking state machine](#the-booking-state-machine)
4. [Hardware](#hardware)
5. [Networking](#networking)
6. [Running it](#running-it)
7. [Pricing and timing](#pricing-and-timing)
8. [HTTP surface](#http-surface)
9. [Security notes](#security-notes)
10. [Repository layout](#repository-layout)

---

## What it does

The system runs two independent lockers (channels `1` and `2`) through a
single ESP32 and a single web server. For each locker it supports:

- **Reservation in advance** — a booking with a future `startTime` is
  accepted; the terminal refuses the PIN until the window opens.
- **Immediate booking** — a booking with `startTime = now` is also accepted;
  the PIN works as soon as the payment page confirms.
- **Extension** — the holder can push the end time outward from the terminal
  or from their phone, paying only for the added minutes.
- **Early release** — the holder can mark the locker free before their
  window ends; the slot immediately opens for someone else.
- **Overdue payment** — once the end time passes, every minute of overdue
  accrues at a surcharge rate. Paying it produces a short-lived *release
  PIN* that opens the door once and ends the rental.
- **Automatic sweep** — if an overdue booking is ignored, or an issued
  release PIN is never used, the slot auto-frees after a grace period so
  the hardware never gets stuck occupied.
- **Master override** — a single operator PIN unlocks any locker at the
  terminal regardless of state. It lives in the `MASTER_PIN` constant at
  the top of `server.js` and is never shown to users.

Two surfaces are served from the same process:

| Surface | URL | Reach | What it can do |
|---|---|---|---|
| **User Site** | `/` | Public, via a tunnel | View status, book, pay, extend, release, pay overdue, get PINs. **Cannot unlock a door.** |
| **Locker Terminal** | `/terminal` | Local LAN only | Enter PIN → unlock a solenoid. Also shows door-sensor readings. |

The split is enforced on every request by the `requireLocal` middleware
(`server.js:512`). A request that carries an `x-forwarded-for` header — the
hallmark of a reverse proxy or tunnel — is rejected from the terminal with
a `403`. Only requests that reach the Node process directly on the local
network can trigger a hardware unlock.

---

## Architecture at a glance

```
            ┌───────────────────────────────────────────────┐
            │                   User's phone                │
            │       (anywhere with internet, via tunnel)    │
            └───────────────┬───────────────────────────────┘
                            │  HTTPS
            ┌───────────────▼──────────────┐
            │   ngrok / Cloudflare /       │
            │   localtunnel                │   public → private bridge
            └───────────────┬──────────────┘
                            │  HTTP (adds x-forwarded-for)
            ┌───────────────▼──────────────┐
            │   Laptop running Node.js     │
            │   server.js (Express 5)      │
            │   port 3000 or 8080          │
            │                              │
            │   - User Site at /           │
            │   - Terminal at /terminal    │   local-only
            └───────────────┬──────────────┘
                            │  HTTP, API key in query
            ┌───────────────▼──────────────┐
            │   ESP32 @ 172.20.10.3        │
            │   locker.ino (WebServer)     │
            │                              │
            │   GPIO 26 → Relay 1 → Lock 1 │
            │   GPIO 27 → Relay 2 → Lock 2 │
            │   GPIO 32 ← Reed  switch 1   │
            │   GPIO 33 ← Reed  switch 2   │
            └──────────────────────────────┘
```

State lives in memory on the Node process (`server.js:27`). There is no
database. Restarting the server clears all bookings; this is a deliberate
choice for a device the operator physically owns and reboots infrequently.

---

## The booking state machine

Each locker carries exactly one `booking` or `null`. `phaseOf()` in
`server.js:60` derives one of five phases from the current time and the
booking fields; every page, every unlock attempt, and the janitor loop go
through this one function.

```
            ┌──────┐    user books    ┌──────────┐
            │ FREE │ ───────────────▶ │ UPCOMING │
            └──▲───┘                  └────┬─────┘
               │                           │ startTime arrives
               │  release / sweep          ▼
               │                       ┌────────┐
               │                       │ ACTIVE │
               │                       └────┬───┘
               │          endTime passes    │
               │                            ▼
               │                       ┌─────────┐
               │ sweep after 10 min    │ OVERDUE │
               │ ◀───────────────────  └────┬────┘
               │                            │ user pays overdue
               │                            ▼
               │   release PIN used /   ┌────────┐
               └───────────────────────│  GRACE  │
                   sweep after 15 min  └─────────┘
```

| Phase | Meaning | What the user sees | What the terminal does |
|---|---|---|---|
| **FREE** | No booking | "Available" card, book form | Rejects any non-master PIN |
| **UPCOMING** | Booked, `now < startTime` | Reservation card, Extend/Release buttons | Rejects booking PIN with "Not started" |
| **ACTIVE** | `startTime ≤ now ≤ endTime` | "Booked until X", Extend/Release | Accepts booking PIN, unlocks |
| **OVERDUE** | `now > endTime`, no release PIN yet | Red card, "Pay Overdue" button | Rejects booking PIN; prompts to pay or extend |
| **GRACE** | Overdue paid, release PIN issued | "Use your release PIN at the terminal", countdown | Accepts release PIN once; ends rental on unlock |

### Why the sweep exists

Lockers must never be *held* by a booking the user has walked away from.
Two timers protect against that, both implemented in `sweepLockers()`
(`server.js:73`), which runs every 15 seconds and before every HTTP
request:

- **OVERDUE grace** — if a booking goes `OVERDUE` and no one pays or
  extends within `OVERDUE_GRACE_MS` (10 minutes past the end time), the
  booking is dropped and the locker returns to `FREE`.
- **Release window** — once overdue has been paid, the release PIN is
  valid for `RELEASE_WINDOW_MS` (15 minutes). If the user never shows up
  at the terminal, the booking is dropped and the locker returns to
  `FREE`.

The release path also clears the booking the instant the release PIN
actually fires a solenoid (`server.js:612`), so a user who collects their
items does not have to wait for the timer.

---

## Hardware

Minimum bill of materials for a two-locker build:

| Qty | Component | Notes |
|---:|---|---|
| 1 | ESP32 dev board (any 30-pin variant) | WROOM-32 is cheapest and works |
| 1 | 2-channel 5 V relay module | Opto-isolated, active-LOW preferred |
| 2 | 12 V DC solenoid lock (fail-secure) | Rated for the current your supply provides |
| 2 | Reed switch + magnet | For door-closed sensing |
| 1 | 12 V, ≥ 2 A DC power supply | Shared between both solenoids |
| 1 | 5 V supply for the ESP32 | USB-micro cable from the same PSU is fine |
| — | Breadboard wiring or a small protoboard | Common ground between 5 V, 12 V, and ESP32 |

### Pin map

Defined in `locker.ino:20`:

| Function | GPIO | Direction |
|---|---:|---|
| Relay 1 (Locker 1 solenoid) | 26 | OUT |
| Relay 2 (Locker 2 solenoid) | 27 | OUT |
| Door sensor 1 | 32 | IN, pull-up |
| Door sensor 2 | 33 | IN, pull-up |

Door sensors are **display-only** — see the comment above `getDoorState()`
in `locker.ino:51`. They never gate an unlock. A broken reed switch or a
jammed door cannot keep the solenoid from firing; the operator decides
based on what they see in the terminal.

### Relay polarity

Blue-board clone relays are almost always active-LOW: `LOW` on the signal
pin energises the coil. If your module is wired the other way (its LEDs
are on while the coil is *off*), flip the `RELAY_ACTIVE_LOW` define in
`locker.ino:30`:

```c
#define RELAY_ACTIVE_LOW false
```

### Non-blocking unlock

`activateLocker()` sets the relay pin and stamps `millis()`. The main
`loop()` turns the relay back off after `UNLOCK_MS` (3000 ms). Nothing in
the hot path uses `delay()`, so a second unlock arriving mid-cycle is
handled on its own locker's timer without starving the first.

---

## Networking

The server was written against an iPhone Personal Hotspot (subnet
`172.20.10.0/28`), where the gateway is `172.20.10.1` and only a handful
of client addresses are available. The ESP32 claims `172.20.10.3`
statically so the server can reach it at the same URL every boot.

### Running on a normal router

If you swap the hotspot for a home router, three places need to agree:

1. `locker.ino:11` — the four `IPAddress` constants (`local_IP`,
   `gateway`, `subnet`, `primaryDNS`).
2. `server.js:13` — the `ESP32_IP` constant.
3. The Wi-Fi SSID and password in `locker.ino:4`.

If `WiFi.config()` fails for any reason, the firmware falls back to DHCP
and prints the assigned address over serial — set `ESP32_IP` to whatever
you see there.

### Public access

`server.js` only binds to the laptop's LAN. To let a phone on cellular
reach the User Site, run one of the three bundled tunnel scripts on
Windows. They all forward public HTTPS to local port 8080 and leave the
Terminal untouched (because the tunnel adds `x-forwarded-for`).

| Script | Underlying tool | URL stability | Set-up cost |
|---|---|---|---|
| `start.bat` | localtunnel | Fixed subdomain (`smartlocker-sizan.loca.lt`), but first-visit "tunnel password" prompt | Zero (uses `npx`) |
| `start-ngrok.bat` | ngrok | Fixed custom domain, no password | Needs a free ngrok account and the binary in `ngrok/` |
| `start-cloudflare.bat` | cloudflared | **Fresh random** `trycloudflare.com` URL each run | Needs the binary in `cloudflare/` |

Run **exactly one** at a time — they all compete for port 8080.

---

## Running it

### 1. Install the server

```bash
npm install
```

The only runtime dependency is Express 5 (`package.json:14`).

### 2. Flash the ESP32

Open `locker.ino` in Arduino IDE (ESP32 board support installed), edit
the SSID / password / IP block, select your board, and upload. On boot
the serial console prints:

```
SMART LOCKER STARTING
Connecting to WiFi: Sizan
..........
WiFi CONNECTED
ESP32 IP ADDRESS: 172.20.10.3
Locker 1 Door: CLOSED
Locker 2 Door: CLOSED
Hardware API started
ESP32 READY
```

### 3. Start the server

Default port is `3000`:

```bash
node server.js
```

Or override — the Windows launchers all do this:

```bash
PORT=8080 node server.js
```

The log on start lists both local URLs and the ESP32 target so you can
confirm the three agree:

```
User Site:       http://localhost:8080/
Locker Terminal: http://localhost:8080/terminal
ESP32 at:        http://172.20.10.3
```

### 4. Visit the surfaces

- On the terminal device (laptop, tablet pointed at the laptop) open
  `http://localhost:8080/terminal`.
- On a phone on the same Wi-Fi open `http://<laptop-lan-ip>:8080/`.
- To expose the User Site over the internet, run one of the `.bat`
  files on Windows, or run the equivalent `localtunnel` / `cloudflared` /
  `ngrok` command on another OS.

---

## Pricing and timing

All values live at the top of `server.js:11` and can be edited in one
place.

| Constant | Value | Meaning |
|---|---:|---|
| `PORT` | `3000` (env override) | HTTP port for the Node server |
| `MASTER_PIN` | *(see source)* | Operator unlock, never shown to users |
| `HARDWARE_KEY` | *(see source)* | Shared secret with the ESP32 (must match `API_KEY` in `locker.ino`) |
| `ESP32_IP` | `172.20.10.3` | Must match `locker.ino` |
| `PRICE_PER_HOUR` | `20` (BDT, "৳") | Billed as **ceil-to-the-hour** |
| `OVERDUE_PER_MINUTE` | `1` | Per-minute surcharge once the end time passes |
| `OVERDUE_GRACE_MS` | `10 min` | Window to pay before the booking auto-drops |
| `RELEASE_WINDOW_MS` | `15 min` | Lifetime of a release PIN after overdue payment |
| `UNLOCK_MS` (firmware) | `3000` | How long the solenoid is energised per unlock |

### How prices are computed

`priceForRange()` in `server.js:50` ceils the total minutes to a whole
hour, then multiplies by `PRICE_PER_HOUR`. A 10-minute booking and a
59-minute booking both cost ৳20. A 61-minute booking costs ৳40. The same
function is used for the initial booking and for extensions — an
extension is priced from `max(now, endTime)` to the new end time, so
extending a booking that's already in overdue starts the extension clock
*from now*, not from the already-passed end time.

### How overdue is computed

`minutesBetween(end, now)` in `server.js:44` ceils to the next minute,
then multiplies by `OVERDUE_PER_MINUTE`. One second into overdue costs
৳1; sixty-one seconds costs ৳2.

---

## HTTP surface

### User Site (public-safe)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Status cards for both lockers, booking form for any that are `FREE` |
| `POST` | `/booking-summary` | Validates the form, shows price and the pay button |
| `POST` | `/payment` | Renders the demo payment form |
| `POST` | `/payment/complete` | Issues the booking + PIN |
| `GET` | `/extend?locker=N` | PIN + new-end-time form |
| `POST` | `/extend/summary` | Validates, shows cost of extension |
| `POST` | `/extend/complete` | Applies the new end time, clears any `releasePin` |
| `GET` | `/release?locker=N` | PIN form to free the locker now |
| `POST` | `/release` | Clears the booking on correct PIN |
| `GET` | `/overdue?locker=N` | Overdue bill + payment form |
| `POST` | `/overdue/pay` | Issues the one-shot release PIN |

### Locker Terminal (LAN-only, guarded by `requireLocal`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/terminal` | Status cards (plus door-sensor readings) and the unlock form |
| `POST` | `/terminal/unlock` | Validates the PIN, bridges to the ESP32, reports success / hardware error |

### ESP32 (LAN-only, guarded by the shared `API_KEY`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Human-readable status for a browser smoke test |
| `GET` | `/status` | `{"locker1":"OPEN|CLOSED","locker2":"OPEN|CLOSED"}` |
| `GET/POST` | `/unlock?locker=N&key=…` | Fires relay `N` for `UNLOCK_MS` |

`GET` on `/unlock` is kept alongside `POST` for a very specific reason:
during install you can test the whole chain from a browser without
touching the Node server.

---

## Security notes

The system is designed for an operator-trusted environment: the laptop,
the ESP32, and the physical lockers are all under one person's control.
That shapes which attacks are in scope and which are not.

**In scope and defended:**

- Remote unlocking. The `requireLocal` middleware rejects any
  `/terminal*` request that carries `x-forwarded-for`, which is added by
  every HTTPS tunnel and reverse proxy. The public URL can display
  status, take bookings, and issue PINs; it cannot talk to the hardware.
- PIN guessing on an active booking. PINs are four digits, so brute-force
  is theoretically within reach, but the terminal returns a full page per
  wrong attempt and the keypad is a physical device next to the lockers.
  A real-world attacker would be visible on camera long before they
  guessed one of 9000 valid-looking PINs.
- Master PIN collision. `randomPin()` rerolls if it ever matches
  `MASTER_PIN`, so a user can never book a locker with the operator PIN.
- Stuck lockers. The sweep removes any booking that is overdue past the
  grace window or whose release PIN has expired, so a payment that never
  gets collected still frees the slot.

**Out of scope — do not deploy to a hostile environment without
addressing these:**

- The hardware key travels in the URL (`/unlock?key=…`) over plain HTTP
  on the LAN. Anyone sniffing the local Wi-Fi can replay it. If that
  matters, put the ESP32 on an isolated AP and never share the password.
- There is no HTTPS between the Node server and the ESP32. The ESP32's
  tiny `WebServer` library doesn't do TLS.
- There is no rate limit on PIN attempts at the terminal.
- All state is in RAM. A server restart drops every active booking.

---

## Repository layout

```
smart-locker/
├── server.js              Node.js + Express app. User Site + Terminal.
├── locker.ino             ESP32 firmware. WiFi, two relays, two sensors.
├── package.json           Single dependency: express ^5
├── package-lock.json
├── start.bat              Windows launcher: Node + localtunnel
├── start-ngrok.bat        Windows launcher: Node + ngrok (fixed domain)
├── start-cloudflare.bat   Windows launcher: Node + cloudflared (random URL)
├── .gitignore             node_modules, .env, binaries, swap files
└── README.md              This file
```

The entire system is `server.js` (one Express app, ≈ 670 lines) and
`locker.ino` (one Arduino sketch, ≈ 180 lines). The three `.bat` files
and the two tunnel directories (`ngrok/`, `cloudflare/`, both gitignored
as `*.exe`) are packaging for one specific Windows laptop; nothing in
`server.js` depends on them.
