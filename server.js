const express = require("express");
const http = require("http");
const app = express();

// Safety net: never let an unexpected error crash the server.
process.on("uncaughtException", err => console.error("[uncaughtException]", err));
process.on("unhandledRejection", err => console.error("[unhandledRejection]", err));

// ---------------- Config ----------------
const PORT = Number(process.env.PORT) || 3000;
const MASTER_PIN = "7079";
const HARDWARE_KEY = "SMARTLOCKER2026";
const ESP32_IP = "172.20.10.3"; // CHANGE THIS TO YOUR ESP32 IP
const PRICE_PER_HOUR = 20;
const OVERDUE_PER_MINUTE = 1;

// If overdue and NOT paid, auto-free the locker after this long past the end time.
const OVERDUE_GRACE_MS = 10 * 60 * 1000;   // 10 minutes
// After paying overdue, the release PIN is valid this long to unlock or extend.
// If the user does nothing, the locker auto-frees.
const RELEASE_WINDOW_MS = 15 * 60 * 1000;  // 15 minutes

// Active locker channels (both relay channels enabled).
const ACTIVE_LOCKERS = [1, 2];

// ---------------- In-memory storage (device cache) ----------------
const lockers = {};
for (const n of ACTIVE_LOCKERS) lockers[n] = { id: n, booking: null };

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------------- Helpers ----------------
function randomPin() {
  let pin;
  do {
    pin = Math.floor(1000 + Math.random() * 9000).toString();
  } while (pin === MASTER_PIN);
  return pin;
}
function formatDate(value) {
  return new Date(value).toLocaleString();
}
function minutesBetween(a, b) {
  return Math.max(0, Math.ceil((b - a) / 60000));
}
function minsLeft(target, now) {
  return Math.max(0, Math.ceil((new Date(target) - now) / 60000));
}
function priceForRange(start, end) {
  const mins = Math.ceil((end - start) / 60000);
  const hours = Math.max(1, Math.ceil(mins / 60));
  return hours * PRICE_PER_HOUR;
}
function ownerAuthorized(booking, enteredPin) {
  return enteredPin === MASTER_PIN || (booking && enteredPin === booking.pin);
}

// Derive the current phase of a locker.
function phaseOf(locker, now = new Date()) {
  const b = locker.booking;
  if (!b) return "FREE";
  if (b.releasePin) return "GRACE";          // overdue paid -> release window
  const start = new Date(b.startTime);
  const end = new Date(b.endTime);
  if (now < start) return "UPCOMING";
  if (now > end) return "OVERDUE";
  return "ACTIVE";
}

// Auto-free lockers whose grace/release windows have expired. Runs on every
// request AND on a timer, so a locker can never get stuck occupied.
function sweepLockers() {
  const now = new Date();
  for (const n of ACTIVE_LOCKERS) {
    const b = lockers[n].booking;
    if (!b) continue;
    if (b.releasePin) {
      // GRACE: paid overdue, release window running.
      if (now > new Date(b.releasePinExpires)) lockers[n].booking = null;
    } else {
      // OVERDUE unpaid: free after the grace period past end time.
      const end = new Date(b.endTime);
      if (now > new Date(end.getTime() + OVERDUE_GRACE_MS)) lockers[n].booking = null;
    }
  }
}
setInterval(sweepLockers, 15000);
app.use((req, res, next) => { sweepLockers(); next(); });

// ---------------- Page shell / styling ----------------
function htmlPage(title, content) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{
  --bg:#eef1f6; --card:#ffffff; --ink:#1c2430; --muted:#6b7688;
  --line:#e4e8ef; --brand:#2563eb; --brand2:#1e40af;
  --green:#15803d; --greenbg:#e7f6ec; --red:#dc2626; --redbg:#fdecec;
  --amber:#b45309; --amberbg:#fdf3e3; --slate:#475569; --slatebg:#eef1f6;
}
*{box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,Arial,sans-serif;background:var(--bg);margin:0;color:var(--ink)}
header{background:linear-gradient(135deg,#1e293b,#2563eb);color:#fff;padding:26px 18px 18px;text-align:center}
header h1{margin:0;font-size:24px;letter-spacing:.5px}
header p{margin:6px 0 0;opacity:.85;font-size:13px}
nav{margin-top:16px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
nav a{color:#fff;text-decoration:none;background:rgba(255,255,255,.14);padding:8px 16px;border-radius:20px;font-size:14px;font-weight:600}
nav a:hover{background:rgba(255,255,255,.28)}
.container{max-width:940px;margin:auto;padding:26px 18px 60px}
h2.section{text-align:center;font-weight:700;margin:6px 0 20px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:18px}
.card{background:var(--card);padding:22px;border-radius:16px;box-shadow:0 6px 22px rgba(20,30,50,.07);border:1px solid var(--line)}
.card h3{margin:0 0 12px;font-size:20px;letter-spacing:.5px}
.badge{display:inline-block;padding:5px 13px;border-radius:20px;font-size:13px;font-weight:700;letter-spacing:.4px}
.badge.free{color:var(--green);background:var(--greenbg)}
.badge.active{color:var(--brand);background:#e6effe}
.badge.upcoming{color:var(--slate);background:var(--slatebg)}
.badge.overdue{color:var(--red);background:var(--redbg)}
.badge.grace{color:var(--amber);background:var(--amberbg)}
.meta{font-size:14px;color:var(--muted);margin:12px 0 0;line-height:1.5}
.door{margin-top:12px;font-size:14px}
.door b{color:var(--ink)}
.actions{margin-top:16px;display:flex;gap:8px;flex-wrap:wrap}
.box{max-width:560px;background:var(--card);margin:24px auto;padding:30px;border-radius:16px;box-shadow:0 6px 22px rgba(20,30,50,.07);border:1px solid var(--line)}
.box h2{margin-top:0}
label{display:block;text-align:left;font-weight:600;margin-top:16px;font-size:14px}
input,select{width:100%;padding:13px;margin-top:7px;font-size:16px;border:1px solid #cbd2dd;border-radius:10px;background:#fbfcfe}
input:focus,select:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px #dbe6fe}
button,.button{display:inline-block;padding:12px 22px;margin-top:18px;border:0;border-radius:10px;background:var(--brand);color:#fff;font-size:15px;font-weight:600;text-decoration:none;cursor:pointer;transition:.15s}
button:hover,.button:hover{background:var(--brand2)}
.button.sm{margin-top:0;padding:9px 15px;font-size:13px}
.secondary{background:var(--slate)} .secondary:hover{background:#334155}
.danger{background:var(--red)} .danger:hover{background:#b91c1c}
.warn{background:var(--amber)} .warn:hover{background:#92400e}
.success{color:var(--green)} .error{color:var(--red)} .warning{color:var(--amber)}
.pin{font-size:40px;font-weight:800;letter-spacing:10px;background:#eef4ff;color:var(--brand2);padding:18px;border-radius:12px;text-align:center;margin:14px 0}
.small{font-size:13px;color:var(--muted)}
table{width:100%;border-collapse:collapse;margin-top:6px}
td{padding:10px 8px;border-bottom:1px solid var(--line);font-size:15px}
.center{text-align:center}
</style>
</head>
<body>
<header>
<h1>🔐 SMART LOCKER SYSTEM</h1>
<p>Self-service locker rental</p>
<nav>
<a href="/">User Site</a>
<a href="/terminal">Locker Terminal</a>
</nav>
</header>
<div class="container">${content}</div>
</body>
</html>`;
}
function badge(phase) {
  const map = {
    FREE: ["free", "FREE"], ACTIVE: ["active", "OCCUPIED"],
    UPCOMING: ["upcoming", "RESERVED"], OVERDUE: ["overdue", "OVERDUE"],
    GRACE: ["grace", "GRACE"]
  };
  const [cls, text] = map[phase] || ["upcoming", phase];
  return `<span class="badge ${cls}">${text}</span>`;
}

// ---------------- ESP32 bridge ----------------
function requestESP32(path, method = "GET") {
  return new Promise((resolve, reject) => {
    const options = { hostname: ESP32_IP, port: 80, path, method, timeout: 40000 };
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const req = http.request(options, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => done(resolve, { status: res.statusCode, body: data }));
      res.on("error", () => {
        if (data.length > 0) done(resolve, { status: res.statusCode || 200, body: data });
        else done(reject, new Error("ESP32 connection reset"));
      });
    });
    req.on("timeout", () => { req.destroy(); done(reject, new Error("ESP32 timeout")); });
    req.on("error", err => done(reject, err));
    req.end();
  });
}
async function hardwareStatus() {
  try {
    const result = await requestESP32("/status");
    if (result.status !== 200) throw new Error("Hardware error");
    return JSON.parse(result.body);
  } catch {
    return { locker1: "UNKNOWN", locker2: "UNKNOWN" };
  }
}
async function hardwareUnlock(locker) {
  const path = `/unlock?locker=${locker}&key=${encodeURIComponent(HARDWARE_KEY)}`;
  return requestESP32(path, "POST");
}

// ============================================================
//  USER SITE
// ============================================================
app.get("/", (req, res) => {
  const now = new Date();
  let cards = "";
  for (const number of ACTIVE_LOCKERS) {
    const locker = lockers[number];
    const phase = phaseOf(locker, now);
    const b = locker.booking;
    let meta = "";
    let actions = "";

    if (phase === "UPCOMING") {
      meta = `Reserved. Starts at <b>${formatDate(b.startTime)}</b><br>Ends at ${formatDate(b.endTime)}`;
      actions = extendReleaseButtons(number);
    } else if (phase === "ACTIVE") {
      meta = `Booked until <b>${formatDate(b.endTime)}</b>`;
      actions = extendReleaseButtons(number);
    } else if (phase === "OVERDUE") {
      const end = new Date(b.endTime);
      const overdue = minutesBetween(end, now);
      const amount = overdue * OVERDUE_PER_MINUTE;
      const freeIn = minsLeft(new Date(end.getTime() + OVERDUE_GRACE_MS), now);
      meta = `Ended ${formatDate(end)}<br><span class="error">Overdue ${overdue} min · Outstanding ৳${amount}</span><br><span class="small">Auto-frees in ${freeIn} min if not handled</span>`;
      actions = `<a class="button sm danger" href="/overdue?locker=${number}">Pay Overdue</a>` + extendReleaseButtons(number);
    } else if (phase === "GRACE") {
      const releaseLeft = minsLeft(b.releasePinExpires, now);
      meta = `<span class="warning">Overdue paid. Use your release PIN at the terminal.</span><br><span class="small">Release window: ${releaseLeft} min left, then auto-frees</span>`;
      actions = extendReleaseButtons(number);
    }

    cards += `
<div class="card">
<h3>LOCKER 0${number}</h3>
${badge(phase)}
${meta ? `<p class="meta">${meta}</p>` : ""}
${actions ? `<div class="actions">${actions}</div>` : ""}
</div>`;
  }

  const freeOptions = ACTIVE_LOCKERS
    .filter(n => phaseOf(lockers[n], now) === "FREE")
    .map(n => `<option value="${n}">Locker ${n}</option>`).join("");
  const bookingForm = freeOptions ? `
<div class="box">
<h2>Book a Locker</h2>
<form action="/booking-summary" method="POST">
<label>Select Locker</label>
<select name="locker" required><option value="">Choose locker</option>${freeOptions}</select>
<label>Start Time</label>
<input type="datetime-local" name="startTime" required>
<label>End Time</label>
<input type="datetime-local" name="endTime" required>
<button type="submit">CONTINUE</button>
</form>
</div>` : `<div class="box center"><h2>All lockers are currently occupied.</h2><p class="small">Come back once one is freed.</p></div>`;

  res.send(htmlPage("User Site", `
<h2 class="section">User Booking Site</h2>
<div class="cards">${cards}</div>
${bookingForm}`));
});

function extendReleaseButtons(number) {
  return `<a class="button sm warn" href="/extend?locker=${number}">Extend</a>` +
         `<a class="button sm secondary" href="/release?locker=${number}">Unoccupy</a>`;
}

// ---------------- Booking flow ----------------
app.post("/booking-summary", (req, res) => {
  const lockerNumber = Number(req.body.locker);
  const { startTime, endTime } = req.body;
  if (!ACTIVE_LOCKERS.includes(lockerNumber) || !startTime || !endTime) {
    return res.send(htmlPage("Error", errorBox("Invalid booking information.", "/")));
  }
  if (phaseOf(lockers[lockerNumber]) !== "FREE") {
    return res.send(htmlPage("Occupied", errorBox(`Locker ${lockerNumber} is not available.`, "/")));
  }
  const start = new Date(startTime), end = new Date(endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return res.send(htmlPage("Invalid Time", errorBox("End time must be after start time.", "/")));
  }
  const price = priceForRange(start, end);
  const duration = minutesBetween(start, end);
  res.send(htmlPage("Booking Summary", `
<div class="box">
<h2>Booking Summary</h2>
<table>
<tr><td>Locker</td><td>Locker ${lockerNumber}</td></tr>
<tr><td>Start</td><td>${formatDate(start)}</td></tr>
<tr><td>End</td><td>${formatDate(end)}</td></tr>
<tr><td>Duration</td><td>${duration} minute(s)</td></tr>
<tr><td>Rate</td><td>৳${PRICE_PER_HOUR}/hour</td></tr>
<tr><td><strong>Total</strong></td><td><strong>৳${price}</strong></td></tr>
</table>
<form action="/payment" method="POST">
<input type="hidden" name="locker" value="${lockerNumber}">
<input type="hidden" name="startTime" value="${startTime}">
<input type="hidden" name="endTime" value="${endTime}">
<input type="hidden" name="price" value="${price}">
<button type="submit">PROCEED TO PAYMENT</button>
</form>
<a class="button secondary" href="/">CHANGE BOOKING</a>
</div>`));
});

app.post("/payment", (req, res) => {
  const { locker, startTime, endTime, price } = req.body;
  res.send(htmlPage("Payment", paymentForm({
    action: "/payment/complete", amount: price,
    hidden: { locker, startTime, endTime, price }
  })));
});

app.post("/payment/complete", (req, res) => {
  const lockerNumber = Number(req.body.locker);
  const { startTime, endTime, price } = req.body;
  if (!ACTIVE_LOCKERS.includes(lockerNumber)) {
    return res.send(htmlPage("Error", errorBox("Invalid locker.", "/")));
  }
  if (phaseOf(lockers[lockerNumber]) !== "FREE") {
    return res.send(htmlPage("Unavailable", errorBox("Locker became unavailable.", "/")));
  }
  const pin = randomPin();
  lockers[lockerNumber].booking = {
    pin, startTime, endTime,
    price: Number(price), paymentStatus: "PAID",
    releasePin: null, releasePinExpires: null
  };
  res.send(htmlPage("Payment Successful", `
<div class="box center">
<h1 class="success">✅ PAYMENT SUCCESSFUL</h1>
<p>Locker ${lockerNumber} is booked.</p>
<p class="small">Your access PIN</p>
<div class="pin">${pin}</div>
<p class="small">Valid: ${formatDate(startTime)} → ${formatDate(endTime)}</p>
<a class="button" href="/terminal">OPEN TERMINAL</a>
<a class="button secondary" href="/">USER SITE</a>
</div>`));
});

// ---------------- Unoccupy (release anytime) ----------------
app.get("/release", (req, res) => {
  const n = Number(req.query.locker);
  if (!ACTIVE_LOCKERS.includes(n) || !lockers[n].booking) return res.redirect("/");
  res.send(htmlPage("Unoccupy Locker", `
<div class="box">
<h2>Unoccupy Locker ${n}</h2>
<p class="small">Enter your locker PIN to release it. The locker becomes FREE immediately.</p>
<form action="/release" method="POST">
<input type="hidden" name="locker" value="${n}">
<label>Your PIN</label>
<input type="password" name="pin" maxlength="4" inputmode="numeric" placeholder="••••" required>
<button type="submit" class="danger">UNOCCUPY NOW</button>
</form>
<a class="button secondary" href="/">CANCEL</a>
</div>`));
});
app.post("/release", (req, res) => {
  const n = Number(req.body.locker);
  const pin = String(req.body.pin || "");
  if (!ACTIVE_LOCKERS.includes(n) || !lockers[n].booking) return res.redirect("/");
  if (!ownerAuthorized(lockers[n].booking, pin)) {
    return res.send(htmlPage("Denied", errorBox("Wrong PIN. Locker not released.", `/release?locker=${n}`)));
  }
  lockers[n].booking = null;
  res.send(htmlPage("Released", `
<div class="box center">
<h1 class="success">✅ LOCKER ${n} RELEASED</h1>
<p>It is now FREE for others to book.</p>
<a class="button" href="/">USER SITE</a>
</div>`));
});

// ---------------- Extend validity ----------------
app.get("/extend", (req, res) => {
  const n = Number(req.query.locker);
  if (!ACTIVE_LOCKERS.includes(n) || !lockers[n].booking) return res.redirect("/");
  const b = lockers[n].booking;
  res.send(htmlPage("Extend Locker", `
<div class="box">
<h2>Extend Locker ${n}</h2>
<p class="small">Current end: <b>${formatDate(b.endTime)}</b>. Enter your PIN and a new end time.</p>
<form action="/extend/summary" method="POST">
<input type="hidden" name="locker" value="${n}">
<label>Your PIN</label>
<input type="password" name="pin" maxlength="4" inputmode="numeric" placeholder="••••" required>
<label>New End Time</label>
<input type="datetime-local" name="newEnd" required>
<button type="submit">CONTINUE</button>
</form>
<a class="button secondary" href="/">CANCEL</a>
</div>`));
});
app.post("/extend/summary", (req, res) => {
  const n = Number(req.body.locker);
  const pin = String(req.body.pin || "");
  const newEnd = req.body.newEnd;
  if (!ACTIVE_LOCKERS.includes(n) || !lockers[n].booking) return res.redirect("/");
  const b = lockers[n].booking;
  if (!ownerAuthorized(b, pin)) {
    return res.send(htmlPage("Denied", errorBox("Wrong PIN.", `/extend?locker=${n}`)));
  }
  const now = new Date();
  const reference = new Date(Math.max(now.getTime(), new Date(b.endTime).getTime()));
  const end = new Date(newEnd);
  if (Number.isNaN(end.getTime()) || end <= reference) {
    return res.send(htmlPage("Invalid", errorBox("New end time must be later than the current end / now.", `/extend?locker=${n}`)));
  }
  const price = priceForRange(reference, end);
  const addMins = minutesBetween(reference, end);
  res.send(htmlPage("Extend Summary", `
<div class="box">
<h2>Extension Summary — Locker ${n}</h2>
<table>
<tr><td>Extra time</td><td>${addMins} minute(s)</td></tr>
<tr><td>New end</td><td>${formatDate(end)}</td></tr>
<tr><td>Rate</td><td>৳${PRICE_PER_HOUR}/hour</td></tr>
<tr><td><strong>Amount</strong></td><td><strong>৳${price}</strong></td></tr>
</table>
${paymentInner({ action: "/extend/complete", amount: price, hidden: { locker: n, pin, newEnd } })}
<a class="button secondary" href="/">CANCEL</a>
</div>`));
});
app.post("/extend/complete", (req, res) => {
  const n = Number(req.body.locker);
  const pin = String(req.body.pin || "");
  const newEnd = req.body.newEnd;
  if (!ACTIVE_LOCKERS.includes(n) || !lockers[n].booking) return res.redirect("/");
  const b = lockers[n].booking;
  if (!ownerAuthorized(b, pin)) {
    return res.send(htmlPage("Denied", errorBox("Wrong PIN.", `/extend?locker=${n}`)));
  }
  const now = new Date();
  const reference = new Date(Math.max(now.getTime(), new Date(b.endTime).getTime()));
  const end = new Date(newEnd);
  if (Number.isNaN(end.getTime()) || end <= reference) {
    return res.send(htmlPage("Invalid", errorBox("Invalid new end time.", `/extend?locker=${n}`)));
  }
  // Apply extension: push end time out and clear any overdue/grace state.
  b.endTime = end.toISOString();
  b.releasePin = null;
  b.releasePinExpires = null;
  res.send(htmlPage("Extended", `
<div class="box center">
<h1 class="success">✅ VALIDITY EXTENDED</h1>
<p>Locker ${n} is now booked until</p>
<p><strong>${formatDate(end)}</strong></p>
<p class="small">Keep using your original PIN <b>${b.pin}</b>.</p>
<a class="button" href="/">USER SITE</a>
</div>`));
});

// ---------------- Overdue payment -> release PIN ----------------
app.get("/overdue", (req, res) => {
  const n = Number(req.query.locker);
  if (!ACTIVE_LOCKERS.includes(n) || !lockers[n].booking) return res.redirect("/");
  if (phaseOf(lockers[n]) !== "OVERDUE") return res.redirect("/");
  const b = lockers[n].booking;
  const end = new Date(b.endTime), now = new Date();
  const overdueMinutes = minutesBetween(end, now);
  const amount = overdueMinutes * OVERDUE_PER_MINUTE;
  res.send(htmlPage("Overdue Payment", `
<div class="box">
<h2>Overdue Payment — Locker ${n}</h2>
<table>
<tr><td>Booking ended</td><td>${formatDate(end)}</td></tr>
<tr><td>Overdue</td><td>${overdueMinutes} minute(s)</td></tr>
<tr><td>Rate</td><td>৳${OVERDUE_PER_MINUTE}/minute</td></tr>
<tr><td><strong>Amount</strong></td><td><strong>৳${amount}</strong></td></tr>
</table>
${paymentInner({ action: "/overdue/pay", amount, hidden: { locker: n } })}
<a class="button secondary" href="/">CANCEL</a>
</div>`));
});
app.post("/overdue/pay", (req, res) => {
  const n = Number(req.body.locker);
  if (!ACTIVE_LOCKERS.includes(n) || !lockers[n].booking) return res.redirect("/");
  const b = lockers[n].booking;
  const releasePin = randomPin();
  b.releasePin = releasePin;
  b.releasePinExpires = new Date(Date.now() + RELEASE_WINDOW_MS).toISOString();
  const mins = Math.round(RELEASE_WINDOW_MS / 60000);
  res.send(htmlPage("Overdue Paid", `
<div class="box center">
<h1 class="success">✅ OVERDUE PAID</h1>
<p class="small">Your release PIN</p>
<div class="pin">${releasePin}</div>
<p>Valid for <b>${mins} minutes</b>. Use it at the terminal to collect your items,
or <a href="/extend?locker=${n}">extend</a> your booking.</p>
<p class="small">If unused, the locker frees automatically after ${mins} minutes.</p>
<a class="button" href="/terminal">OPEN TERMINAL</a>
<a class="button secondary" href="/">USER SITE</a>
</div>`));
});

// ============================================================
//  LOCKER TERMINAL (device) - ON-SITE / LOCAL NETWORK ONLY
// ============================================================
// Requests that come through the public tunnel carry an x-forwarded-for header.
// Direct access on the local network (the screen at the locker) does not.
// So we allow the terminal only for local requests and block remote unlocking.
function isLocalRequest(req) {
  return !req.headers["x-forwarded-for"];
}
function requireLocal(req, res, next) {
  if (isLocalRequest(req)) return next();
  res.status(403).send(htmlPage("Terminal Unavailable", `
<div class="box center">
<h1 class="error">🔒 TERMINAL IS ON-SITE ONLY</h1>
<p>The unlock terminal can only be used from the locker's local network.</p>
<p class="small">Booking, PIN, Extend and Unoccupy are available on the User Site.</p>
<a class="button" href="/">GO TO USER SITE</a>
</div>`));
}

app.get("/terminal", requireLocal, async (req, res) => {
  const status = await hardwareStatus();
  let cards = "";
  for (const number of ACTIVE_LOCKERS) {
    const phase = phaseOf(lockers[number]);
    const door = status["locker" + number] || "UNKNOWN";
    cards += `
<div class="card">
<h3>LOCKER 0${number}</h3>
${badge(phase)}
<p class="door">Door sensor: <b>${door}</b></p>
</div>`;
  }
  const lockerOptions = ACTIVE_LOCKERS.map(n => `<option value="${n}">Locker ${n}</option>`).join("");
  res.send(htmlPage("Locker Terminal", `
<h2 class="section">Locker Device</h2>
<div class="cards">${cards}</div>
<div class="box">
<h2>Unlock Locker</h2>
<form action="/terminal/unlock" method="POST">
<label>Select Locker</label>
<select name="locker" required><option value="">Choose locker</option>${lockerOptions}</select>
<label>Enter PIN</label>
<input type="password" name="pin" maxlength="4" inputmode="numeric" placeholder="••••" required>
<button type="submit">UNLOCK</button>
</form>
<p class="small">The solenoid opens for 3 seconds, then re-locks automatically.</p>
</div>`));
});

app.post("/terminal/unlock", requireLocal, async (req, res) => {
  const n = Number(req.body.locker);
  const enteredPin = String(req.body.pin || "");
  if (!ACTIVE_LOCKERS.includes(n)) {
    return res.send(htmlPage("Error", errorBox("Select a valid locker.", "/terminal")));
  }
  const locker = lockers[n];
  const booking = locker.booking;
  const now = new Date();
  let releaseAccess = false;
  let accessType = "";

  if (enteredPin === MASTER_PIN) {
    accessType = "MASTER";
  } else if (!booking) {
    return res.send(htmlPage("Denied", errorBox("This locker has no active booking.", "/terminal")));
  } else if (booking.releasePin && enteredPin === booking.releasePin) {
    if (now <= new Date(booking.releasePinExpires)) {
      releaseAccess = true;
      accessType = "OVERDUE_RELEASE";
    } else {
      return res.send(htmlPage("Expired", errorBox("Release PIN expired. The locker will free automatically.", "/")));
    }
  } else if (enteredPin === booking.pin) {
    if (booking.releasePin) {
      return res.send(htmlPage("Use Release PIN", errorBox("This booking is overdue. Use your release PIN, not the original PIN.", "/terminal")));
    }
    const start = new Date(booking.startTime), end = new Date(booking.endTime);
    if (now < start) {
      return res.send(htmlPage("Not Started", `<div class="box center"><h1 class="warning">BOOKING NOT STARTED</h1><p>Starts at ${formatDate(start)}</p><a class="button" href="/terminal">BACK</a></div>`));
    }
    if (now > end) {
      const overdue = minutesBetween(end, now);
      const amount = overdue * OVERDUE_PER_MINUTE;
      return res.send(htmlPage("Expired", `
<div class="box center">
<h1 class="error">PIN EXPIRED</h1>
<p>Booking ended ${formatDate(end)}</p>
<p class="error">Overdue ${overdue} min · ৳${amount}</p>
<a class="button danger" href="/overdue?locker=${n}">PAY OVERDUE</a>
<a class="button warn" href="/extend?locker=${n}">EXTEND</a>
<a class="button secondary" href="/terminal">BACK</a>
</div>`));
    }
    accessType = "ACTIVE_BOOKING";
  } else {
    return res.send(htmlPage("Invalid PIN", errorBox("Access denied. Wrong PIN.", "/terminal")));
  }

  try {
    const result = await hardwareUnlock(n);
    if (result.status !== 200 || result.body.trim() !== "SUCCESS") {
      return res.send(htmlPage("Hardware Error", `
<div class="box center">
<h1 class="error">UNLOCK FAILED</h1>
<p>ESP32 response: <strong>${result.body}</strong></p>
<a class="button" href="/terminal">BACK</a>
</div>`));
    }
    if (releaseAccess) locker.booking = null;   // release-pin unlock ends the rental
    res.send(htmlPage("Unlocked", `
<div class="box center">
<h1 class="success">🔓 LOCKER ${n} UNLOCKED</h1>
<p>Solenoid released for 3 seconds — open the door now. It re-locks automatically.</p>
<p class="small">Access type: ${accessType}</p>
${releaseAccess
  ? `<p class="success"><strong>Rental completed. Locker ${n} is now FREE.</strong></p>`
  : `<p class="small">Locker remains occupied for the active rental.</p>`}
<a class="button" href="/terminal">BACK TO TERMINAL</a>
</div>`));
  } catch (error) {
    res.send(htmlPage("ESP32 Offline", `
<div class="box center">
<h1 class="error">ESP32 CONNECTION FAILED</h1>
<p>${error.message}</p>
<p class="small">Check ESP32 IP, Wi-Fi and power.</p>
<a class="button" href="/terminal">BACK</a>
</div>`));
  }
});

// ---------------- Small shared UI pieces ----------------
function errorBox(msg, back) {
  return `<div class="box center"><h2 class="error">${msg}</h2><a class="button" href="${back}">BACK</a></div>`;
}
function paymentInner({ action, amount, hidden }) {
  const hiddenFields = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`).join("");
  return `
<p class="warning" style="margin-top:18px"><strong>DEMO PAYMENT</strong> — auto-approved</p>
<form action="${action}" method="POST">
${hiddenFields}
<label>Customer Name</label>
<input name="customerName" placeholder="Enter name" required>
<label>Mobile Number</label>
<input name="mobile" placeholder="01XXXXXXXXX" required>
<label>Transaction / Card Number</label>
<input name="transaction" placeholder="DEMO123456" required>
<button type="submit">PAY ৳${amount}</button>
</form>`;
}
function paymentForm(opts) {
  return `<div class="box"><h2>Payment Gateway</h2><p>Amount: <strong>৳${opts.amount}</strong></p>${paymentInner(opts)}<a class="button secondary" href="/">CANCEL</a></div>`;
}

// ---------------- Start ----------------
const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`User Site:       http://localhost:${PORT}/`);
  console.log(`Locker Terminal: http://localhost:${PORT}/terminal`);
  console.log(`ESP32 at:        http://${ESP32_IP}`);
});
httpServer.on("error", err => {
  if (err.code === "EADDRINUSE") console.error(`Port ${PORT} in use. Try:  PORT=8080 node server.js`);
  else if (err.code === "EACCES") console.error(`Port ${PORT} blocked/reserved. Try:  PORT=8080 node server.js`);
  else console.error("Server failed to start:", err);
  process.exit(1);
});
