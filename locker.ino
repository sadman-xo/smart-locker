#include <WiFi.h>
#include <WebServer.h>

const char* ssid = "Sizan";
const char* password = "12345678";

// ---- Fixed IP so the ESP32 is ALWAYS reachable at 172.20.10.3 ----
// These values match an iPhone Personal Hotspot (172.20.10.x, /28 subnet).
// If you switch to a normal router (e.g. 192.168.x.x), change all four to match
// that network, and update ESP32_IP in server.js to the same address.
IPAddress local_IP(172, 20, 10, 3);
IPAddress gateway(172, 20, 10, 1);
IPAddress subnet(255, 255, 255, 240);
IPAddress primaryDNS(8, 8, 8, 8);

// ============================================================
//  LOCKER 1  -> Relay channel 1
//  LOCKER 2  -> Relay channel 2
// ============================================================
#define RELAY1 26
#define DOOR1  32
#define RELAY2 27
#define DOOR2  33

const String API_KEY = "SMARTLOCKER2026";
const unsigned long UNLOCK_MS = 3000;  // solenoid stays unlocked for 3 seconds

// Relay polarity. Most blue relay boards are ACTIVE-LOW (LOW = relay ON).
// If your relay is the opposite (LED on at rest), set this to false.
#define RELAY_ACTIVE_LOW true

#if RELAY_ACTIVE_LOW
  #define RELAY_ON  LOW
  #define RELAY_OFF HIGH
#else
  #define RELAY_ON  HIGH
  #define RELAY_OFF LOW
#endif

WebServer server(80);

// Per-locker non-blocking relay timers (indices 1 and 2 used).
bool relayActive[3] = { false, false, false };
unsigned long relayStart[3] = { 0, 0, 0 };

int relayPinFor(int locker) {
  return (locker == 1) ? RELAY1 : RELAY2;
}

// Door sensor is DISPLAY ONLY. It never controls the solenoid.
String getDoorState(int pin) {
  if (digitalRead(pin) == LOW) {
    return "CLOSED";
  }
  return "OPEN";
}

// Fire the solenoid immediately and unconditionally. loop() turns it off after
// UNLOCK_MS, so this never blocks and always works on every command.
void activateLocker(int locker) {
  digitalWrite(relayPinFor(locker), RELAY_ON);   // solenoid ON (unlocked)
  relayActive[locker] = true;
  relayStart[locker] = millis();
  Serial.print("UNLOCK -> LOCKER ");
  Serial.print(locker);
  Serial.println("  (solenoid ON for 3s)");
}

void handleRoot() {
  String message = "SMART LOCKER ESP32 ONLINE\n";
  message += "Locker 1 Door: " + getDoorState(DOOR1) + "\n";
  message += "Locker 2 Door: " + getDoorState(DOOR2) + "\n";
  server.send(200, "text/plain", message);
}

void handleStatus() {
  String json = "{";
  json += "\"locker1\":\"" + getDoorState(DOOR1) + "\",";
  json += "\"locker2\":\"" + getDoorState(DOOR2) + "\"";
  json += "}";
  server.send(200, "application/json", json);
}

void handleUnlock() {
  if (!server.hasArg("key")) {
    server.send(403, "text/plain", "API_KEY_REQUIRED");
    return;
  }
  if (server.arg("key") != API_KEY) {
    server.send(403, "text/plain", "UNAUTHORIZED");
    return;
  }
  if (!server.hasArg("locker")) {
    server.send(400, "text/plain", "LOCKER_REQUIRED");
    return;
  }

  int locker = server.arg("locker").toInt();
  if (locker != 1 && locker != 2) {
    server.send(400, "text/plain", "INVALID_LOCKER");
    return;
  }

  activateLocker(locker);
  server.send(200, "text/plain", "SUCCESS");
}

void setup() {
  Serial.begin(115200);

  pinMode(RELAY1, OUTPUT);
  pinMode(RELAY2, OUTPUT);
  digitalWrite(RELAY1, RELAY_OFF);   // start locked
  digitalWrite(RELAY2, RELAY_OFF);   // start locked

  pinMode(DOOR1, INPUT_PULLUP);
  pinMode(DOOR2, INPUT_PULLUP);

  Serial.println();
  Serial.println("================================");
  Serial.println("SMART LOCKER STARTING");
  Serial.println("================================");
  Serial.print("Connecting to WiFi: ");
  Serial.println(ssid);

  // Apply the fixed IP before connecting. If it fails, it falls back to DHCP.
  if (!WiFi.config(local_IP, gateway, subnet, primaryDNS)) {
    Serial.println("Static IP config failed, using DHCP instead");
  }

  WiFi.begin(ssid, password);
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (millis() - wifiStart > 20000) {
      Serial.println();
      Serial.println("WiFi connect failed, restarting...");
      ESP.restart();
    }
  }

  Serial.println();
  Serial.println("WiFi CONNECTED");
  Serial.print("ESP32 IP ADDRESS: ");
  Serial.println(WiFi.localIP());
  Serial.print("Locker 1 Door: ");
  Serial.println(getDoorState(DOOR1));
  Serial.print("Locker 2 Door: ");
  Serial.println(getDoorState(DOOR2));

  server.on("/", HTTP_GET, handleRoot);
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/unlock", HTTP_POST, handleUnlock);
  server.on("/unlock", HTTP_GET, handleUnlock);  // GET allowed for manual browser testing
  server.begin();

  Serial.println("Hardware API started");
  Serial.println("ESP32 READY");
  Serial.println("================================");
}

void loop() {
  server.handleClient();

  // Non-blocking re-lock for each locker. Unsigned subtraction is overflow-safe.
  unsigned long now = millis();
  for (int locker = 1; locker <= 2; locker++) {
    if (relayActive[locker] && (now - relayStart[locker] >= UNLOCK_MS)) {
      digitalWrite(relayPinFor(locker), RELAY_OFF);   // re-lock
      relayActive[locker] = false;
      Serial.print("LOCKER ");
      Serial.print(locker);
      Serial.println(" re-locked");
    }
  }
}
