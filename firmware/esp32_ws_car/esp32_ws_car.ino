/*
 * Reference firmware for the browser remote: ESP32 + L298N / TB6612 dual H-bridge.
 *
 * - Creates a Wi-Fi access point "RC-Car" (password "drive1234").
 * - Serves a WebSocket on port 81 speaking the newline-delimited JSON protocol
 *   described in js/transport.js.
 * - Fail-safe: motors stop if no drive command arrives for 500 ms.
 * - Sends dead-reckoned telemetry 10x/s so the tracker panel shows a live path.
 *   Replace the estimate with wheel encoders / IMU if you have them.
 *
 * Libraries (Arduino Library Manager):
 *   - WebSockets by Markus Sattler (links2004/arduinoWebSockets)
 *   - ArduinoJson by Benoit Blanchon
 *
 * Browser: open the web app from a laptop/phone joined to the "RC-Car" network and
 * connect to ws://192.168.4.1:81
 */
#include <WiFi.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>

// ---- pins (adjust to your wiring) ----
const int L_IN1 = 26, L_IN2 = 27, L_PWM = 14;   // left motor
const int R_IN1 = 32, R_IN2 = 33, R_PWM = 12;   // right motor
const int HORN_PIN = 25;                        // buzzer
const int LIGHT_PIN = 13;                       // headlights
const int BATT_PIN = 34;                        // ADC on a divider (optional)

const char* AP_SSID = "RC-Car";
const char* AP_PASS = "drive1234";

WebSocketsServer ws(81);

// command state
float cmdX = 0, cmdY = 0; int cmdS = 60;
unsigned long lastCmdMs = 0;
const unsigned long FAILSAFE_MS = 500;

// dead-reckoned pose estimate
float poseX = 0, poseY = 0, headingDeg = 0, speedMs = 0;
const float MAX_SPEED = 1.5f;   // m/s at 100% — measure your car and tune
const float TURN_RATE = 150.f;  // deg/s at full steer

void setMotor(int in1, int in2, int pwmPin, float v) {   // v: -1..1
  int duty = (int)(fabs(v) * 255);
  digitalWrite(in1, v > 0); digitalWrite(in2, v < 0);
  analogWrite(pwmPin, duty);
}

void drive(float x, float y, int s) {
  float scale = s / 100.0f;
  float left  = constrain((y + x) * scale, -1.f, 1.f);
  float right = constrain((y - x) * scale, -1.f, 1.f);
  setMotor(L_IN1, L_IN2, L_PWM, left);
  setMotor(R_IN1, R_IN2, R_PWM, right);
}

void stopMotors() { cmdX = cmdY = 0; drive(0, 0, 0); }

void sendJson(uint8_t client, JsonDocument& doc) {
  String out; serializeJson(doc, out); out += '\n';
  ws.sendTXT(client, out);
}

void onEvent(uint8_t client, WStype_t type, uint8_t* payload, size_t len) {
  if (type == WStype_DISCONNECTED) { stopMotors(); return; }
  if (type != WStype_TEXT) return;

  StaticJsonDocument<256> doc;
  if (deserializeJson(doc, payload, len)) return;
  const char* t = doc["t"] | "";

  if (!strcmp(t, "drive")) {
    cmdX = doc["x"] | 0.f; cmdY = doc["y"] | 0.f; cmdS = doc["s"] | 60;
    lastCmdMs = millis();
    drive(cmdX, cmdY, cmdS);
  } else if (!strcmp(t, "stop")) {
    stopMotors();
  } else if (!strcmp(t, "horn")) {
    tone(HORN_PIN, 1200, 200);
  } else if (!strcmp(t, "lights")) {
    digitalWrite(LIGHT_PIN, doc["on"] | false);
  } else if (!strcmp(t, "ping")) {
    StaticJsonDocument<64> r; r["t"] = "pong"; r["ts"] = doc["ts"];
    sendJson(client, r);
  }
}

void setup() {
  for (int p : {L_IN1, L_IN2, L_PWM, R_IN1, R_IN2, R_PWM, HORN_PIN, LIGHT_PIN}) pinMode(p, OUTPUT);
  stopMotors();
  Serial.begin(115200);
  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.printf("AP up: %s  ->  ws://%s:81\n", AP_SSID, WiFi.softAPIP().toString().c_str());
  ws.begin();
  ws.onEvent(onEvent);
}

void loop() {
  ws.loop();
  static unsigned long lastTick = millis(), lastTel = 0;
  unsigned long now = millis();
  float dt = (now - lastTick) / 1000.f; lastTick = now;

  if (cmdY != 0 || cmdX != 0) {
    if (now - lastCmdMs > FAILSAFE_MS) { stopMotors(); Serial.println("failsafe stop"); }
  }

  // integrate pose estimate
  float target = cmdY * (cmdS / 100.f) * MAX_SPEED;
  speedMs += (target - speedMs) * min(1.f, dt * 6);
  float dir = fabs(speedMs) < 0.02f ? 1.f : (speedMs > 0 ? 1.f : -1.f);
  float pivot = fabs(cmdY) < 0.05f ? 0.6f : 1.f;
  headingDeg = fmodf(headingDeg + cmdX * TURN_RATE * dir * pivot * dt + 360.f, 360.f);
  float rad = headingDeg * DEG_TO_RAD;
  poseX += sinf(rad) * speedMs * dt;
  poseY += cosf(rad) * speedMs * dt;

  if (now - lastTel > 100) {
    lastTel = now;
    StaticJsonDocument<160> tel;
    tel["t"] = "tel"; tel["x"] = poseX; tel["y"] = poseY; tel["h"] = headingDeg; tel["v"] = speedMs;
    // 2S LiPo through 1:2 divider on a 3.3 V ADC → crude percentage; adapt to your pack.
    float volts = analogRead(BATT_PIN) / 4095.f * 3.3f * 2.f;
    tel["batt"] = constrain((volts - 6.6f) / (8.4f - 6.6f) * 100.f, 0.f, 100.f);
    String out; serializeJson(tel, out); out += '\n';
    ws.broadcastTXT(out);
  }
}
