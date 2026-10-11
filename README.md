# RC Car Remote

> **Project status: FAILED (2026-10-11)**
>
> The target vehicle is an MN Model MN82 Land Cruiser 1:12, which is controlled only by its
> proprietary 2.4 GHz pistol-grip transmitter. It has no Bluetooth, Wi-Fi, or app interface, so
> no browser or desktop software can reach it without adding a bridge board (for example an ESP32
> in the transmitter or in the car), and the project constraint was zero hardware spend.
>
> The software side is complete and works in Simulation mode (controls, movement tracker,
> WebSocket / Bluetooth / Serial links, reference ESP32 firmware, mock car server). It can be
> picked up again if a bridge board becomes available.

A browser-based remote control for a toy RC car, with a mini movement tracker panel.
Plain HTML/CSS/JS, no build step, works on desktop and phone.

![layout](docs/screenshot.png)

## Features

- **Controls**: on-screen D-pad, virtual joystick (touch/mouse), keyboard (`W A S D` / arrows,
  `Space` = stop, `H` = horn, `L` = lights), speed limiter, horn, lights, E-STOP.
- **Movement tracker**: top-down map showing the car's path, heading, speed, distance and
  position. Uses live telemetry from the car when it sends any; otherwise dead-reckons the
  path from the commands you send. Follow-car or fit-whole-path view, 1 m grid.
- **Link panel**: Wi-Fi (WebSocket), Bluetooth (Web Bluetooth), USB (Web Serial), or a
  built-in **Simulation** mode so you can try everything with no hardware.
- **Safety**: drive commands are re-sent every 250 ms while moving so the car can stop itself
  if the link drops (the reference firmware does this after 500 ms of silence).

## Run it

```sh
python3 -m http.server 8080      # or any static file server
# open http://localhost:8080
```

Pick **Simulation** and press **Connect** to try it without a car.

> Web Bluetooth and Web Serial only work in Chromium browsers (Chrome, Edge) and only from
> `https://` or `http://localhost`. WebSocket works everywhere, including from a phone.

## What you need to connect to a real car

The browser cannot drive motors directly. The car needs a small controller board that
speaks one of the three links. Pick one:

| Link | Car side | Good for |
|------|----------|----------|
| **Wi-Fi / WebSocket** (recommended) | ESP32 or ESP8266 running `firmware/esp32_ws_car`, or a Raspberry Pi running any WebSocket server | Phone or laptop, no pairing, longest range |
| **Bluetooth / Web Bluetooth** | ESP32 / nRF52 / HM-10 exposing a Nordic UART Service (NUS) | Phone control without a Wi-Fi network |
| **USB / Web Serial** | Arduino / ESP32 over a USB cable at 115200 baud | Bench testing, tethered cars |

Hardware shopping list for the reference build:

1. **ESP32 dev board** (any; the sketch uses the Arduino core).
2. **Dual H-bridge motor driver** such as L298N or TB6612FNG, wired to the drive motor(s).
   For a steering servo instead of a second motor, drive the servo from `cmdX` in the sketch.
3. **Battery** for the motors (the ESP32 can share it through its 5 V regulator), optional
   voltage divider on an ADC pin for the battery readout.
4. Optional **buzzer** (horn) and **LEDs** (lights).

Flash `firmware/esp32_ws_car/esp32_ws_car.ino`, join the Wi-Fi network `RC-Car`
(password `drive1234`) from your phone or laptop, open the web app, choose
**Wi-Fi · WebSocket** with `ws://192.168.4.1:81`, and press Connect.

## Testing

**1. No hardware (2 minutes).** Serve the folder and use the built-in simulator:

```sh
python3 -m http.server 8080
# open http://localhost:8080 → Link: Simulation → Connect
```

Drive with `W A S D`, the D-pad or the joystick. The tracker should draw a path, heading and
distance should change, and the Link log should show `tx {"t":"drive",...}` lines.

**2. Real Wi-Fi link, still no hardware.** The mock car is a WebSocket server that behaves
like the ESP32 firmware (telemetry, pong, fail-safe stop), with no dependencies:

```sh
node tools/mock-car.js 8081        # terminal 1
python3 -m http.server 8080        # terminal 2
# open http://localhost:8080 → Link: Wi-Fi · WebSocket → ws://127.0.0.1:8081 → Connect
```

Terminal 1 prints every command the browser sends (`drive`, `stop`, `BEEP`, `lights ON`).
Stop the server with Ctrl+C while driving: the app should show *Disconnected* immediately.

**3. From your phone.** Keep the servers above running, find your laptop's LAN address
(`ipconfig` / `ip addr`), and open `http://<laptop-ip>:8080` on the phone. Use
`ws://<laptop-ip>:8081` as the WebSocket URL. This also checks the touch controls.

**4. Real car.** Flash `firmware/esp32_ws_car`, open the Arduino serial monitor at 115200
to confirm `AP up: RC-Car -> ws://192.168.4.1:81`, join the `RC-Car` Wi-Fi network, serve
the app locally and connect to `ws://192.168.4.1:81`. Put the car on a stand with the wheels
off the ground for the first run, then check in this order:

- Latency shows a number (ping/pong works).
- Forward / reverse / left / right spin the right wheels the right way. If a side is
  reversed, swap that motor's `IN1`/`IN2` pins in the sketch.
- Release every control: wheels stop within half a second.
- Turn the laptop's Wi-Fi off mid-drive: the firmware's fail-safe stops the motors.
- Lower the speed limit slider before the first run on the floor.

The page must be served over plain `http://` (or opened on `localhost`) when using a
`ws://` URL: browsers block unencrypted WebSockets from `https://` pages.

**Automated check.** The repo has no test runner; the `tools/mock-car.js` server plus any
WebSocket client is enough to script the protocol. A headless Chromium run through
Playwright was used to verify the simulator and WebSocket paths.

## Protocol

Newline-delimited JSON in both directions. Any controller that speaks this works with the app.

| Direction | Message | Meaning |
|-----------|---------|---------|
| → car | `{"t":"drive","x":-1..1,"y":-1..1,"s":0..100,"seq":n}` | steer, throttle, speed limit |
| → car | `{"t":"stop"}` | stop now |
| → car | `{"t":"horn"}` / `{"t":"lights","on":true}` | accessories |
| → car | `{"t":"ping","ts":ms}` | latency probe |
| car → | `{"t":"pong","ts":ms}` | reply to ping |
| car → | `{"t":"tel","x":m,"y":m,"h":deg,"v":m/s,"batt":%}` | optional telemetry; any subset of fields |

If your car has wheel encoders, a GPS, or an IMU, put real values in the `tel` message and
the tracker switches from "Estimated from commands" to "Live from car telemetry".

## Files

```
index.html                       UI
css/style.css                    styling (dark, responsive)
js/app.js                        input handling, 20 Hz control loop, render loop
js/transport.js                  WebSocket / Bluetooth / Serial / Simulation links
js/tracker.js                    movement tracker (path, dead reckoning, canvas)
firmware/esp32_ws_car/           reference ESP32 firmware
tools/mock-car.js                mock car WebSocket server for testing
```
