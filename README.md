# Moon Rider Webcam Controller — skeleton (Architecture A)

Inject webcam hand-tracking as controller input on the **official** Moon Rider site
(so you keep its live BeatSaver music — no fork, no audio sourcing). This is a
*skeleton*: it gets the plumbing right and gives you a staged way to test. The
coordinate mapping and the entity selectors are meant to be tuned by you.

## Layout
```
manifest.json        MV3 manifest (MAIN + ISOLATED content scripts, offscreen)
background.js        service worker: offscreen lifecycle + POSE relay
offscreen.html/js    camera + MediaPipe HandLandmarker (extension origin)
content-bridge.js    ISOLATED world: runtime msg -> window CustomEvent
content-main.js      MAIN world: discover / sine-test / pose->entity  (window.__mr)
vendor/tasks-vision  MediaPipe ESM bundle + wasm (already vendored)
vendor/models        <-- you must drop hand_landmarker.task here
```

## One missing asset (required for the camera path only)
The pose model is not redistributed here. Download it once:

  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task

…and save it as `vendor/models/pose_landmarker_lite.task`.
(Use the `lite` model — `full`/`heavy` are slower and not worth it here.)
Detection now uses the body skeleton: left wrist = landmark 15 -> left
controller, right wrist = 16 -> right controller. Sides are anatomically
anchored, so they don't swap. Frame your upper body (shoulders visible).

> Stage 0 and Stage 1 below need NO camera and NO model — do those first.

## Load it
1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open https://supermedium.com/moonrider/ and start a song.

## Camera permission gotcha
Offscreen documents can't show a permission prompt. If the camera never starts,
open `chrome-extension://<your-extension-id>/offscreen.html` in a normal tab
once and allow camera — the grant then sticks for the offscreen document.

---

# Testing — do it in stages

The whole point: separate "can I move the in-game controllers?" from
"is my computer-vision any good?". Never debug both at once.

## Stage 0 — entity reachability (no camera, no model)
1. On the running game, open DevTools console. The console runs in the page's
   MAIN world, so it can see `window.__mr`.
2. Run `__mr.discover()`. You get a table of candidate controller entities.
3. Pick the right/left controller and set them, e.g.:
   `__mr.setSelectors('#rightHand', '#leftHand')`
   (use whatever id/selector discover() revealed).
✅ Pass: discover() lists entities and setSelectors logs your choice.

## Stage 1 — drive the game WITHOUT a camera (sine self-test)
1. Start **Punch Mode** (it only needs hand position + motion — easiest).
2. In console: `__mr.test()`.
✅ Pass: the in-game controllers visibly oscillate back/forth and **register
   hits** on incoming stars. This proves the game reads entity position and your
   write path works. Stop with `__mr.test(false)`.
✋ If controllers move but hits don't register: the hit logic may read a real
   WebXR input source, not the entity — cross-check by manually moving the
   debug controller via `?debugcontroller=punch` (shift/ctrl + h/j/k/l). If that
   scores, mimic whatever attribute it writes; if it doesn't, you need
   Architecture B (fake WebXR device).

## Stage 2 — camera + MediaPipe ALONE (no game coupling)
1. Drop the model in `vendor/models/`, reload the extension.
2. Click the toolbar icon on the game tab to start the offscreen camera.
3. Watch the service worker console (chrome://extensions → "service worker")
   for relayed messages, or temporarily set `__mr.cfg.log = true` and run
   `__mr.poseStart()` to see incoming pose objects in the page console.
✅ Pass: pose objects stream in at ~25–30/s with sane normalized x/y.
   Measure FPS here; if it's low, switch wasm to `nosimd` or delegate to CPU.

## Stage 3 — end to end
1. `__mr.setSelectors(...)` (from Stage 0) then `__mr.poseStart()`.
2. Play Punch Mode; move your hands.
✅ Pass: controllers follow your hands and crush stars.
🔧 Tuning knobs on `__mr.cfg`: `scaleX/scaleY/offsetY/planeZ` (reach & height),
   `mirror` (selfie flip), `smoothing` (jitter vs latency).

## Measuring latency (do this — rhythm games are latency-sensitive)
Stamp time at three points and diff:
- capture: `t` already on each hand object from offscreen.
- arrival: `performance.now()` inside `onPose`.
- (optional) apply: right after `applyToEntity`.
Log `arrival - hand.t`. Budget the whole chain (capture→infer→relay→apply)
under ~50 ms or hits feel late. If relay dominates, consider running MediaPipe
inside the ISOLATED content script instead of offscreen (removes the SW hop, at
the cost of page-origin camera permission + CSP wasm-load handling).

## Known limits
- **Classic Mode** needs slice *direction* (wrist roll) — unreliable from a
  single camera. Start with Punch Mode; add direction later if at all.
- **Depth** is faked from hand size; punches in/out will feel approximate.
- If `delegate:'GPU'` errors in offscreen, change it to `'CPU'` in offscreen.js.
