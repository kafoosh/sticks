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
4. **Set the card.** Either show it to the camera or dial it in.
   - **Show it.** Let the camera see the card's face, or just one of its corners (the value
     with the suit under it), for about a second, any way up. The corner shows what was read,
     e.g. **7♦**, for a couple of seconds and it is locked in; no other card is then looked
     for until you start over (triple-tap). Nothing is read rather than guessed: two
     different cards in view, a card it isn't sure of, or an unusual deck (four-colour suits,
     novelty faces) all leave the card for you to dial in.
   - **Dial it in.** It is shown very small in the bottom-left corner, value then suit. Once
     you start, the camera stops reading cards.
   - **Drag** a finger up or down anywhere on the screen to roll the value. It goes round
     and round (`A 2 … K A …`), so keep going one way until you reach it. Up counts up.
   - **Tap** to lock the value. Now dragging rolls the suit (♣ ♥ ♠ ♦, also round and
     round); **tap** to lock that too. The part a drag will change is the brighter one.
   Once the suit is locked the corner card disappears.
5. **Tap the figure.** This last tap, on the drawing itself, says which one you mean. The
   corner counts down **3, 2, 1** (the figure is followed if the phone moves meanwhile), and
   then it comes to life. Whatever is drawn where you tapped is taken on your word, even
   if it hadn't been recognised by itself; a tap on empty paper wakes the nearest
   recognised figure instead. If nothing can be found the corner says **finding…** for a
   few seconds, then **no figure**, and another tap tries again. (`?count=5` makes the
   countdown 5 seconds; `?count=0` skips it.)
6. Keep the figure in view while it performs (about 23 seconds). You can move the phone;
   the scene follows the paper.
7. **Triple-tap** anywhere, at any time, to start over: back to the plain camera, choosing
   the value again.

**Card in the address instead:** `…/sticks/?7D`, `…/sticks/#7D` or `…/sticks/7D` loads the
7♦ already locked in (values `A 2–10 J Q K`, suits `C H S D`). It is wiped from the address
bar at once; one tap on the figure then starts the countdown.

A drawing that doesn't read as a figure (no closed head, a missing arm or leg) still
performs, but moves as one piece instead of bending. Hearts and diamonds are written as
outlines and spades and clubs filled in, the way a one-colour pen tells red from black.

Other switches: `?debug` shows a status line (`?debug=2` also shows the tracked spots),
`?nodot` hides the corner line (figure found, countdown), `?nocard` stops the camera reading
playing cards, `?tear=peel`, `?tear=rip` or `?tear=flap` tries another way of tearing the
piece out (the paper lifting along a fold; the default is unchanged), `?noworker` does all the looking
on the page's own thread (see "Stay smooth" below), and `?perf` records how long each frame
took (`__sticks.perf()` in the console reports and clears it).

## How it works

| Step | Where |
|---|---|
| **Find the ink.** Ink is a thin dark line on lighter paper: darker than its surroundings *and* filled in by a small closing, so the table past a card's edge, or a shadow, never counts. A line with paper on one side and table on the other is the edge of the paper, at any angle, and is left out. Pieces join a figure only if they sit on the same paper, and a straight bar far thicker than the pen (the side of a pad of sticky notes) never joins one. Where something bigger does take a drawing in, the drawing is also tried by itself. | `src/vision/ink.js` |
| **Take out ruled lines.** Families of long, parallel straight lines (lined or squared paper, at any angle) are found with a Hough transform and removed, except where the pen crosses one or runs along it (thicker or darker than the rule there). A lone straight line is never removed: it may be part of the drawing. | `src/vision/ink.js` |
| **Read it close up.** Each candidate is cropped from the camera's full-resolution picture, turned upright if the drawing is at a slant (the head shows which way is up), and the line test is resized to the pen's measured width. | `src/vision/detect.js` |
| **Find the head as a shape.** Everything the ink encloses is filled in; the head is the round empty inside near the top (a face drawn in it is kept as separate strokes), or, for a scribbled-in marker head, the thickest part. Small gaps in the loop are bridged. That tidy outline is only for understanding the figure: what is DRAWN is the head's real traced lines, so a head that is a spiral, an open loop or has a line through it stays exactly so. (On ruled paper, small nicks left where a rule crossed the head are mended from the outline.) Pen width is measured from how much ink there is, not from the soft-edged mask, so the copy is as thin as the pen. | `src/vision/ink.js`, `src/vision/label.js` |
| **Turn it back into pen strokes.** The rest is thinned to centre lines, walked into strokes and joined back up through crossings. | `src/vision/ink.js` |
| **Read its anatomy.** The traced lines are a graph of ends and joins. From the head, the one route down that ends in two feet gives the body, the hip (where the routes to the two feet part) and the legs; what else branches off the body is an arm; elbows and knees go at a line's bend, or halfway. Small gaps where the pen was lifted are bridged. Each point gets its body part and each limb starts exactly at its joint. This is also what says "that is a stick figure" unprompted: head, body, two legs going down, an arm, in proportion. | `src/vision/label.js` |
| **Fall back.** A figure that doesn't read that way goes to the general rigger from `kafoosh/tiny` (itself from `kafoosh/psychic-bassoon`), which guesses parts from where strokes sit; if that can't place every limb, the figure still performs, moving as one piece. A looser shape test (`looksLikeStickFigure`) decides whether a drawing the performer tapped passes as "sure". | `src/rig/`, `src/vision/detect.js` |
| **Follow the page.** A few dozen distinctive spots are followed from frame to frame (Lucas–Kanade, from the vendored jsfeat) to predict where the page went. | `src/vision/tracker.js` |
| **Hold on to the drawing.** The camera always sees the real ink, so each frame the map is corrected until the drawing's lines land exactly on it. This is what stops drift. | `src/vision/inklock.js` |
| **Erase the real figure.** Each line is covered with real paper copied from the live picture just either side of it, at full sharpness, so the cover has the page's own grain, shading and exposure. On ruled paper the cover is copied from beside the figure *along* the rules (from a spot with no other drawing), brightness-matched each frame, so the rules run straight on through. | `src/stage/paper.js`, `src/stage/compositor.js` |
| **Keep hold of it.** If the picture jumps (the phone stalls for a moment), the lock looks further afield, and if still lost slides the drawing's outline about to where its lines land on ink, then fits again. | `src/vision/inklock.js` |
| **Stay on the paper.** The sheet round the figure is found in the starting frame: the area of the same, smoothly varying brightness as the paper under it, stopping where a card or page ends and at the edge of the screen. The piece is always torn from the right of the figure, level with its middle, from a place wholly on the sheet: the usual spot if it fits, else closer in to the figure (who steps aside to the left), then smaller (down to about 40%). The figure's pacing is kept to the room there is. | `src/stage/sheet.js`, `src/main.js` |
| **Perform.** The routine is drawn on a flat canvas in page coordinates. | `src/anim/show.js`, `glyphs.js` |
| **Put it on the paper.** A WebGL shader lays that canvas onto the page in the camera picture, in perspective. | `src/stage/compositor.js` |
| **Read a card.** Not the whole card: a corner index, the value with the suit mark right under it. Marks are dark details on something light, taken by their darkest colour channel so red ink counts like black. A solid mark (the suit) with another the right distance away (the value) is read from a close-up turned so the suit is below the value, which is also what tells a 6 from a 9. A reading needs both marks plainly red or plainly black and the same; the suit's shape to be a suit that way up, of that colour; and the value's shape, reduced to centre lines so a hairline 7 and a fat one are the same 7, to be one its readers are sure of. (The readers are small networks trained on values drawn in 46 typefaces and on freely licensed deck designs; one design is kept out of the training to test on.) Two different cards readable at once: nothing. The page wants the same card three looks running before it believes it. | `src/vision/card.js`, `cardglyphs.js`, `src/main.js` |
| **Stay smooth.** Looking for a figure, and reading its lines when it is woken, take a tenth of a second or more, so a worker does both on a copy of the frame's pixels while the camera picture carries on; the page itself only draws the camera until there is something to follow, and goes back to only that once the show is over. (No worker available: the same code runs on the page's thread, with the picture waiting meanwhile.) | `src/vision/look.worker.js`, `src/vision/frame.js`, `src/main.js` |

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

On that video the map is within about a pixel at the figure, and three to four pixels beside
it where the piece is torn (in a 640-pixel-wide frame).

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
shadow across its card, the first frame of a screen recording of the trick, and a small
figure on a pad of sticky notes (at a phone camera's 720×1280). `node
tools/bench/real.mjs` checks each; all are found, and `npm test` requires that. Add more
from any photo with `node tools/make-fixtures.mjs photo.jpg name x0,y0,x1,y1 …` (the
figure's box in the photo).

**With the tap.** `--tap` on either bench gives the detector a touch somewhere on the figure
(up to a quarter of its size off-centre), as the performer's last tap does. That lifts the
generated bench to **87–89% found** (felt tip and biro 93–97%, marker about 70%), with
another 5–8% found but loosely outlined.

Unprompted (which is what the corner's "figure ✓" shows), over two independent sets of 300: **64–67% found** (biro, felt tip
and pencil about two thirds; thick marker and figures under a tenth of the frame about
40%) and **none** of 150 figure-less frames mistaken for one. Of the figures found, 94–98% are
fully jointed (85% when tapped, where harder drawings get through). The first version of
the detector gave 45% found and 7% false alarms.

### Card bench

```bash
npm install --prefix /somewhere svg-cards cardsJS @heruka_urgyen/react-playing-cards
node tools/bench/card-faces.cjs /somewhere/node_modules /somewhere/faces    # draw every card of four designs
FACES=/somewhere/faces node tools/bench/cards.mjs 600
```

Frames of one card on a table, from four deck designs (one with jumbo indexes), small to
large, any way up, tilted, partly out of the picture or under a thumb, sharp or blurred, in
warm, cool, even or uneven light; and frames with no card. From a SINGLE frame, over 600:
**88% read right, 12% nothing, none wrong**; court cards 80%. The design kept out of training
reads 74% right, none wrong. No card in view (150 frames, and 330 frames of the stick-figure
test videos): never read as one. Two different cards in view: nothing in 86 of 100, and in
the other 14 the one card of the two that could be read. A four-colour deck: its green clubs
and blue diamonds are left unread. These are drawn cards, not photographs: see "Not yet
proven".

`tools/make-card-glyphs.cjs` retrains the readers (`tools/bench/card-shapes.mjs` gathers the
deck designs' indexes for it).

## Deploying

`.github/workflows/pages.yml` runs the tests and publishes to GitHub Pages on every push to
`main`. Enable it once: Settings → Pages → Source: **GitHub Actions**.

## Not yet proven

Everything above has been checked in desktop Chromium against a synthetic video. **Nothing
has been tried on a real phone, with a real pen on real paper.** Expect to tune:

- reading real playing cards: it has only met cards drawn from deck designs, never a
  photograph of a printed card — glare on a glossy face, a worn or bent card, a hand over
  half the index;
- speed on a phone (the per-frame work has only been timed on a desktop);
- lined or squared paper, pencil, very thick markers, strong shadows across the page;
- fast camera moves or the figure leaving the picture mid-routine (it holds the last
  position and picks up again if the figure comes back close to where it was);
- iOS Safari camera start-up.

## Credits

- Figure rigging: from `kafoosh/tiny` / `kafoosh/psychic-bassoon`.
- [jsfeat](https://github.com/inspirit/jsfeat) by Eugene Zatepyakin (MIT, `vendor/jsfeat.LICENSE`).
