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
2. Have a stick figure drawn on paper (plain, lined or squared), in pen: a round head, a
   body, arms, two legs, a few centimetres tall. Hold the phone over it with some empty
   paper beside it.
3. Watch the small line in the bottom-left corner: **looking…** (no figure in view),
   **figure?** (something there, not recognised yet) or **figure ✓** (ready).
4. **Set the card.** It is shown very small in the bottom-left corner, value then suit.
   - **Drag** a finger up or down anywhere on the screen to roll the value. It goes round
     and round (`A 2 … K A …`), so keep going one way until you reach it. Up counts up.
   - **Tap** to lock the value. Now dragging rolls the suit (♣ ♥ ♠ ♦, also round and
     round); **tap** to lock that too. The part a drag will change is the brighter one.
   Once the suit is locked the corner card disappears.
5. **Tap once more.** The corner counts down **3, 2, 1**, and then the figure comes to life.
   It only wakes a drawing it has recognised as a stick figure; if none is in view the
   corner says **finding…** for a few seconds, then **no figure**, and another tap tries
   again. (`?count=5` makes the countdown 5 seconds; `?count=0` skips it.)
6. Keep the figure in view while it performs (about 23 seconds). You can move the phone;
   the scene follows the paper.
7. **Triple-tap** anywhere, at any time, to start over: back to the plain camera, choosing
   the value again.

**Card in the address instead:** `…/sticks/?7D`, `…/sticks/#7D` or `…/sticks/7D` loads the
7♦ already locked in (values `A 2–10 J Q K`, suits `C H S D`). It is wiped from the address
bar at once; one tap then starts the countdown.

A drawing that doesn't read as a figure (no closed head, a missing arm or leg) still
performs, but moves as one piece instead of bending. Hearts and diamonds are written as
outlines and spades and clubs filled in, the way a one-colour pen tells red from black.

Other switches: `?debug` shows a status line (`?debug=2` also shows the tracked spots),
`?nodot` hides the corner line (figure found, countdown).

## How it works

| Step | Where |
|---|---|
| **Find the ink.** Ink is a thin dark line on lighter paper: darker than its surroundings *and* filled in by a small closing, so the table past a card's edge, or a shadow, never counts. A line with paper on one side and table on the other is the edge of the paper, at any angle, and is left out. Pieces join a figure only if they sit on the same paper. | `src/vision/ink.js` |
| **Take out ruled lines.** Families of long, parallel straight lines (lined or squared paper, at any angle) are found with a Hough transform and removed, except where the pen crosses one or runs along it (thicker or darker than the rule there). A lone straight line is never removed: it may be part of the drawing. | `src/vision/ink.js` |
| **Read it close up.** Each candidate is cropped from the camera's full-resolution picture, turned upright if the drawing is at a slant (the head shows which way is up), and the line test is resized to the pen's measured width. | `src/vision/detect.js` |
| **Find the head as a shape.** Everything the ink encloses is filled in; the head is the round empty inside near the top (a face drawn in it is kept as separate strokes), or, for a scribbled-in marker head, the thickest part. Small gaps in the loop are bridged. It becomes one clean closed stroke. | `src/vision/ink.js` |
| **Turn it back into pen strokes.** The rest is thinned to centre lines, walked into strokes and joined back up through crossings. | `src/vision/ink.js` |
| **Is it a stick figure?** A shape test on the upright tracing: a head; one body line down from under it; two feet apart; arms out to both sides; sensible proportions; no rays round the head (a sun, a flower). | `src/vision/detect.js` |
| **Rig it.** The strokes go to the figure rigger from `kafoosh/tiny` (itself from `kafoosh/psychic-bassoon`), which finds body parts and joints. If it can't place every limb, the figure still performs, moving as one piece. | `src/rig/` |
| **Follow the page.** A few dozen distinctive spots are followed from frame to frame (Lucas–Kanade, from the vendored jsfeat) to predict where the page went. | `src/vision/tracker.js` |
| **Hold on to the drawing.** The camera always sees the real ink, so each frame the map is corrected until the drawing's lines land exactly on it. This is what stops drift. | `src/vision/inklock.js` |
| **Erase the real figure.** Each line is covered with real paper copied from the live picture just either side of it, at full sharpness, so the cover has the page's own grain, shading and exposure. On ruled paper the cover is copied from beside the figure *along* the rules (from a spot with no other drawing), brightness-matched each frame, so the rules run straight on through. | `src/stage/paper.js`, `src/stage/compositor.js` |
| **Keep hold of it.** If the picture jumps (the phone stalls for a moment), the lock looks further afield, and if still lost slides the drawing's outline about to where its lines land on ink, then fits again. | `src/vision/inklock.js` |
| **Perform.** The routine is drawn on a flat canvas in page coordinates. | `src/anim/show.js`, `glyphs.js` |
| **Put it on the paper.** A WebGL shader lays that canvas onto the page in the camera picture, in perspective. | `src/stage/compositor.js` |

At the end the copy fades back into the real drawing, so the figure finishes exactly where
it was drawn, and the seam where the piece went back heals away: nothing is left on screen
but the real page.

## Running and testing

```bash
npm start        # http://localhost:8000 — cameras only work on https:// or localhost
npm test         # tracing, rigging, recognition, the ink lock and the routine's poses
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

### Recognition bench

```bash
node tools/bench/run.mjs 300            # 300 frames with a figure, 75 without
node tools/bench/run.mjs 300 1 --show 20   # and save the first 20 failures as PNGs
```

It makes camera frames of hand-wobbly stick figures in many styles on cards and pages
(plain, lined, squared, cream) on stone, wood, dark and white tables, in biro, felt tip,
pencil and marker, small to large, turned and tilted, with other doodles and writing
nearby, uneven light, shadows, blur and noise; and frames with doodles but no figure. It
runs the page's own detector over them and reports, per condition, how often the figure
was found and how often something else was taken for one.

**Real drawings.** `tests/fixtures` holds frames from photos of real pen drawings: lined
cards (rules both ways), notebook pages, plain cards, a figure leaning over, one with a
shadow across its card, and the first frame of a screen recording of the trick. `node
tools/bench/real.mjs` checks each; all are found, and `npm test` requires that. Add more
from any photo with `node tools/make-fixtures.mjs photo.jpg name x0,y0,x1,y1 …` (the
figure's box in the photo).

At the time of writing, over two independent sets of 300: **61–64% found** (biro, felt tip
and pencil about two thirds; thick marker and figures under a tenth of the frame about
40%) and **0–4%** of figure-less frames mistaken for one. The first version of the detector
gave 45% and 7%.

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
