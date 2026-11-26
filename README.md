# Sticks

A magic trick that is a web page. Point your phone's camera at a little stick figure
someone has drawn on paper, swipe, and the figure comes to life on the page: it waves, paces
up and down, has a think, gets an idea, tears a piece out of the paper beside it, turns the
piece over, writes a playing card on the back of it, holds it up, turns it face-up again and
pastes it back into the page, and walks home to stand exactly as it was drawn. The page
looks untouched; the card is now on the underside of the paper.

The page looks like a plain camera view. There are no buttons.

## Performing it

1. Open the page on a phone and allow the camera.
2. Have a stick figure drawn on plain paper, in pen: a round head, a body, two arms, two
   legs, a few centimetres tall. Hold the phone so the figure is upright on screen with
   some empty paper beside it.
3. A faint speck appears in the bottom-left corner when the figure has been found (dim =
   "something is there", brighter = "that's a figure I can animate").
4. **Set the card.** It is shown very small in the bottom-left corner, value then suit.
   - **Drag** a finger up or down anywhere on the screen to roll the value. It goes round
     and round (`A 2 … K A …`), so keep going one way until you reach it. Up counts up.
   - **Tap** to lock the value. Now dragging rolls the suit (♣ ♥ ♠ ♦, also round and
     round); **tap** to lock that too. The part a drag will change is the brighter one.
   Once the suit is locked the corner card disappears.
5. **Tap once more** to wake the figure. It only wakes a drawing it has recognised as a
   stick figure (head, body, arms, legs): if none is in view it keeps looking for about
   four seconds, then gives up quietly, and another tap tries again. The bright corner
   speck is the sign it has found one.
6. Keep the figure in view while it performs (about 23 seconds). You can move the phone;
   the scene follows the paper.
7. **Triple-tap** anywhere, at any time, to start over: back to the plain camera, choosing
   the value again.

**Card in the address instead:** `…/sticks/?7D`, `…/sticks/#7D` or `…/sticks/7D` loads the
7♦ already locked in (values `A 2–10 J Q K`, suits `C H S D`). It is wiped from the address
bar at once; one tap then wakes the figure.

A drawing that doesn't read as a figure (no closed head, a missing arm or leg) still
performs, but moves as one piece instead of bending. Hearts and diamonds are written as
outlines and spades and clubs filled in, the way a one-colour pen tells red from black.

Other switches: `?debug` shows a status line (`?debug=2` also shows the tracked spots),
`?nodot` hides the corner speck.

## How it works

| Step | Where |
|---|---|
| **Find the drawing.** Ink is whatever is clearly darker than the paper around it. Blobs of the right size and shape are candidates. | `src/vision/ink.js` |
| **Turn it back into pen strokes.** The blob is thinned to centre lines, which are walked into strokes and joined back up through crossings. | `src/vision/ink.js` |
| **Rig it.** The strokes go to the figure rigger from `kafoosh/tiny` (itself from `kafoosh/psychic-bassoon`), which finds head, body, arms, legs and joints. | `src/rig/` |
| **Follow the page.** A few dozen distinctive spots are followed from frame to frame (Lucas–Kanade, from the vendored jsfeat) to predict where the page went. | `src/vision/tracker.js` |
| **Hold on to the drawing.** The camera always sees the real ink, so each frame the map is corrected until the drawing's lines land exactly on it. This is what stops drift. | `src/vision/inklock.js` |
| **Erase the real figure.** Each line is covered with real paper copied from the live picture just either side of it, at full sharpness, so the cover has the page's own grain, shading and exposure. | `src/stage/paper.js`, `src/stage/compositor.js` |
| **Perform.** The routine is drawn on a flat canvas in page coordinates. | `src/anim/show.js`, `glyphs.js` |
| **Put it on the paper.** A WebGL shader lays that canvas onto the page in the camera picture, in perspective. | `src/stage/compositor.js` |

At the end the copy fades back into the real drawing, so the figure finishes exactly where
it was drawn, and the seam where the piece went back heals away: nothing is left on screen
but the real page.

## Running and testing

```bash
npm start        # http://localhost:8000 — cameras only work on https:// or localhost
npm test         # tracing, rigging, the ink lock and the routine's poses
```

To try it without a phone, film a pretend page and feed it to Chromium as the camera
(needs Playwright and ffmpeg):

```bash
node tools/make-test-video.mjs camera.mjpeg
chromium --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
  --use-file-for-fake-video-capture=$PWD/camera.mjpeg http://localhost:8000/?debug
node tools/track-check.mjs camera.mjpeg     # tracking error against the known camera path
```

On that video the map is within about half a pixel at the figure and one pixel at the torn
piece (in a 640-pixel-wide frame).

## Deploying

`.github/workflows/pages.yml` runs the tests and publishes to GitHub Pages on every push to
`main`. Enable it once: Settings → Pages → Source: **GitHub Actions**.

## Not yet proven

Everything above has been checked in desktop Chromium against a synthetic video. **Nothing
has been tried on a real phone, with a real pen on real paper.** Expect to tune:

- speed on a phone (the per-frame work has only been timed on a desktop);
- lined or squared paper, pencil, very thick markers, strong shadows across the page;
- fast camera moves or the figure leaving the picture mid-routine (it holds the last
  position and picks up again if the figure comes back close to where it was);
- iOS Safari camera start-up.

## Credits

- Figure rigging: from `kafoosh/tiny` / `kafoosh/psychic-bassoon`.
- [jsfeat](https://github.com/inspirit/jsfeat) by Eugene Zatepyakin (MIT, `vendor/jsfeat.LICENSE`).
