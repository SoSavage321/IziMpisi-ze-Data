#include <Servo.h>

// ---------- Pins ----------
const int PIN_SOIL   = A1;   // conductivity reading
const int PIN_TEMP   = A2;   // KY 013 temperature
const int PIN_BUZZER = 5;    // piezo buzzer
const int PIN_SERVO  = 6;    // FS90 valve
const int PIN_TRIG   = 10;   // ultrasonic trigger
const int PIN_ECHO   = 11;   // ultrasonic echo
const int PIN_ALARM  = 12;   // alarm LED

// ---------- Calibration (replaced after the cup test) ----------
int COND_CLEAN = 700;
int COND_DIRTY = 400;

// ---------- Settings ----------
const float TANK_FULL_CM = 4.0;   // closer than this means tank full
const int   CONFIRM      = 3;     // readings needed before switching
const int   VALVE_RIVER  = 0;     // servo angle, water passes to river
const int   VALVE_TANK   = 90;    // servo angle, water diverted

Servo valve;
int  failCount = 0;
int  passCount = 0;
bool failing   = false;
bool alarmOn   = false;

int readAverage(int pin) {
  long total = 0;
  for (int i = 0; i < 10; i++) {
    total = total + analogRead(pin);
    delay(5);
  }
  return total / 10;
}

float readTempC() {
  int raw = readAverage(PIN_TEMP);
  if (raw <= 0 || raw >= 1023) {
    return -99;
  }
  float r = 10000.0 * (1023.0 / raw - 1.0);
  float logR = log(r);
  float kelvin = 1.0 / (0.001129148 + 0.000234125 * logR
                        + 0.0000000876741 * logR * logR * logR);
  return kelvin - 273.15;
}

float readTankCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  long t = pulseIn(PIN_ECHO, HIGH, 30000);
  if (t == 0) {
    return -1;
  }
  return t * 0.0343 / 2.0;
}

int dirtyScore(int value, int clean, int dirty) {
  if (clean == dirty) {
    return 0;
  }
  long score = (long)(value - clean) * 100 / (dirty - clean);
  return constrain(score, 0, 100);
}

void setup() {
  Serial.begin(9600);
  pinMode(PIN_ALARM, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);

  valve.attach(PIN_SERVO);
  valve.write(VALVE_RIVER);
  digitalWrite(PIN_ALARM, LOW);
  noTone(PIN_BUZZER);

  Serial.println("AcidShield node started");
  Serial.println("Valve on RIVER, waiting for first reading");
}

void loop() {
  int   cond   = readAverage(PIN_SOIL);
  float tempC  = readTempC();
  float tankCm = readTankCm();

  int  risk   = dirtyScore(cond, COND_CLEAN, COND_DIRTY);
  bool badNow = (risk >= 50);

  if (badNow) {
    failCount = failCount + 1;
    passCount = 0;
  } else {
    passCount = passCount + 1;
    failCount = 0;
  }

  if (!failing && failCount >= CONFIRM) {
    failing = true;
    valve.write(VALVE_TANK);
    Serial.println(">>> AMD DETECTED: valve to TREATMENT");
  }
  if (failing && passCount >= CONFIRM) {
    failing = false;
    valve.write(VALVE_RIVER);
    Serial.println(">>> Water clean: valve to RIVER");
  }

  bool tankFull = (tankCm > 0 && tankCm < TANK_FULL_CM);

  if (failing || tankFull) {
    alarmOn = !alarmOn;
    digitalWrite(PIN_ALARM, alarmOn ? HIGH : LOW);
    tone(PIN_BUZZER, alarmOn ? 1000 : 700);
  } else {
    alarmOn = false;
    digitalWrite(PIN_ALARM, LOW);
    noTone(PIN_BUZZER);
  }

  Serial.print("Cond ");
  Serial.print(cond);
  Serial.print(" | Temp ");
  Serial.print(tempC, 1);
  Serial.print(" C | Tank ");
  if (tankCm < 0) {
    Serial.print("no reading");
  } else {
    Serial.print(tankCm, 1);
    Serial.print(" cm");
  }
  Serial.print(" | AMD risk ");
  Serial.print(risk);
  Serial.print("% | ");
  Serial.print(failing ? "FAIL" : "PASS");
  if (tankFull) {
    Serial.print(" | TANK FULL");
  }
  Serial.println();

  delay(500);
}