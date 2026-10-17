# Trouble in Wonderland — Product Requirements

## Product

A painted, mildly isometric **2D Wonderland board game** for classroom browsers. The teacher runs a local Bun server. Students join through its LAN URL without accounts, room codes, or typed names. One server runs independent four-player tables and a live teacher overview.

Audience: ages 11–14 studying Lewis Carroll’s original *Alice’s Adventures in Wonderland*. Teachers select chapters already read. All code, artwork, questions, sound synthesis, and QR generation run locally during play.

## Automatic tables and identity

- A student browser reserves one of four places at the oldest eligible waiting table before choosing a character.
- A fifth student enters the next waiting table. Create one automatically when needed.
- Within each table, students choose Alice, White Rabbit, Cheshire Cat, or Mad Hatter. Enforce exclusive choices on the server.
- Start immediately when all four reserved students have chosen characters.
- Start the one-minute fill countdown when the first student reserves a place. At expiry, assign available characters to reserved students who have not chosen and fill unreserved places with bots. Do not start an entirely disconnected group.
- Keep an expired disconnected group’s reservations. New students must not take those places or skip their own character choice.
- Use a server-issued HttpOnly, SameSite cookie for browser identity, not a MAC address or player-visible token. Scope cookies to the server port.
- Restore the same table, character, turn, question, and board when that browser returns. A second tab shares its existing place.
- If the previous table no longer exists, return the student to the automatic queue.
- A disconnected player may be controlled by a bot after the reconnect grace period. The original browser can reclaim its character.

## Turn rules

1. Generate one six-sided die result on the server.
2. Entry is available on **2, 4, or 6** when a piece remains in the garden and no own piece occupies the start. An opponent on the start is captured.
3. Entry places a piece on that start, requires **no question**, and always earns another roll.
4. Select a legal on-board piece before revealing the question. Allow changing the selection until submission, without changing the question or restarting its deadline. Hovered and selected pieces show a translucent destination preview.
5. A correct answer moves only the final selected piece forward by the roll. A successful six earns another roll.
6. A wrong answer leaves all pieces stationary, captures nobody, and ends the turn even on a six.
7. Show the selected answer, correct answer, explanation, and result before Continue advances play.
8. If no legal action exists, show the reason and offer Continue without a question.
9. Give each human decision 30 seconds. Auto-roll after inactivity; randomly choose a legal action, piece, or answer at subsequent deadlines. Automatically Continue after its deadline. Teacher pause freezes remaining time; switching pieces does not extend it.

Bots use the same entry, movement, question, capture, and bonus rules. Their answers are imperfect. Pace bot actions and stop their timers while paused or finished.

## Board and safe spots

- Forty shared track stones with equal route lengths and four evenly spaced starts.
- Four distinct final safe spots per team, after the shared track. Landing exactly on any free safe spot parks that piece permanently.
- Reject moves beyond the fourth safe spot. Passing an occupied space is allowed, including a safe spot.
- No own-piece stacking. Marked starts follow the same opponent-capture rule as every other track stone.
- Landing on an opponent on any shared track stone returns that opponent to its garden.
- Each final safe piece scores 80 points regardless of which safe slot it occupies. Other pieces score relative track progress; garden pieces score zero. Derive scores from current positions, including captures.
- First team with all four pieces in its safe spots wins with 320 points. Bots can win.
- No center HOME label, common finish pile, or visible numeric route or piece labels on the canvas. Preserve exact piece identities and positions in HTML controls and the text board.
- Four visual regions: Rabbit-Hole Garden, White Rabbit’s Court, Cheshire Wood, and Mad Tea Party. Regional artwork does not change the rules.

## Teacher overview and LAN

- Default port **9276**, bound for LAN access. Print usable join addresses at startup.
- `http://localhost:9276/host` shows every table as a live board card without claiming a student place.
- Cards show table status, reservations, countdown, current turn, die, and character positions. Reuse board instances and decoded artwork.
- Open an individual table for its full board, chapter selection, early start, pause/resume, end, and reset controls.
- Save chapter defaults before the first automatic table is created. Existing tables keep their own settings.
- Allow optional teacher-created tables. Keep student grouping automatic.
- Allow closing only finished tables. Notify disconnected host views that a closed table is unavailable rather than reconnecting indefinitely.
- Keep dashboard actions pending until their own acknowledgement or error, not an unrelated game broadcast.
- Scope engine state, claims, questions, connections, fill timers, grace timers, and bot timers to the correct table. Actions in one table must not mutate another.
- Authorize teacher controls only from the host computer. Reject invalid origins, malformed actions, wrong-player commands, and stale versions.
- Provide classroom join links and themed, expandable, scannable QR codes. The student URL enters the shared automatic queue.
- Provide expandable GitHub project links and QR codes on teacher and player pages.
- Store game state in memory. Reconnect preserves it while the process runs. A server restart clears all tables and reservations.

## Question bank

- Exactly **500 source-grounded questions** across the complete original novel: 42 per chapter for chapters 1–8, 41 per chapter for chapters 9–12.
- Four plausible options, one defensible answer, chapter, brief explanation, and a short supporting source quotation.
- Distinct comprehension targets suitable for ages 11–14, including events, motives, inference, language, and the ending’s reflection. Avoid adaptation-specific facts and later-chapter spoilers.
- Select only configured chapters. Shuffle options and exhaust the eligible pool before repetition.
- Keep answer keys and source quotations off client snapshots before grading.
- Original source: [Project Gutenberg, ebook 11](https://www.gutenberg.org/ebooks/11). Check applicable edition and jurisdiction rights.

## Visuals, animation, sound, and access

- Original painted gothic Victorian Wonderland, eerie but inviting and classroom-appropriate. Brighter foliage, porcelain stones, and readable upright character PNGs. No gore, copied commercial assets, or decorative linework frames.
- Draw regional spaces first, the extracted transparent tea-table foreground above those areas, and selectable figures above the foreground.
- Animate movement through every traversed space with quick individual hops. Preserve correct projected hit testing and settled positions; wrong answers cause no movement.
- After an explicit local audio-enable gesture, hear every table event in that browser: pop/rattle for human or bot dice, a pleasant note per movement step, and a springy capture sound.
- Sound controls must report unavailable or blocked audio and include a test action. Never require autoplay or remote samples.
- Desktop: dominant board, readable current die, and visible turn actions. Mobile: compact overview during questions, readable prompt and four answer targets, no horizontal page overflow.
- Keyboard alternatives for character selection, roll, piece choice, answers, Continue, and teacher controls. Visible focus, semantic status messages, and a numbered text board.
- Respect reduced motion. Reconnects and fresh snapshots must not replay old animations or audio. Back/forward navigation must restore a working page.

## Acceptance

- Five separate browsers reserve the first four places at one table and the fifth at another, before character choice.
- Four chosen characters start immediately. A partial group starts with bots after the one-minute deadline.
- Returning browsers recover their place without exposing the private identifier. Closed-table returns enter the queue.
- Multiple live board cards update independently. Opening and controlling one table does not change another.
- Entry bonuses, own-piece blocking, opponent captures on every track stone, stationary wrong answers, changeable selection with one question/deadline, timed human decisions, immutable safe spots, 80-point safe pieces, overshoot rejection, and winning work for humans and bots.
- The complete 500-question bank loads, honors chapter settings, and does not leak grading data.
- Actual browser play verifies layering, projected selection, stepwise animation, shared audio, QR decoding, mobile layout, keyboard access, and reduced motion.
- Publish the project with a simple setup guide and real teacher, desktop, and mobile screenshots. Provide complete standalone Linux x64, Windows x64, and Apple Silicon/Intel macOS downloads, including a macOS `.command` launcher. Native extracted-package gameplay checks gate publication. Exclude secrets, runtime data, local capture files, and obsolete assets.
