# Trouble in Wonderland — Readable Gothic Garden

## 1. Visual theme and atmosphere

A painted Victorian Wonderland tabletop, mildly isometric, eerie but inviting rather than blacked-out horror. Preserve the original painted Alice, Rabbit, Cat and Hatter PNG figures. Use a brighter moonlit garden: sage and slate foliage, warm porcelain stones, rose-red accents and candlelight. No gore, copied game assets, Ceride/linework ornament, decorative frames, monogram seals or divider-rule grids. Functional controls, focus indicators and board stones may have clear edges.

Reference actual Trouble boards through [Hasbro’s classic rules](https://instructions.hasbro.com/en-us/instruction/trouble-pop-o-matic-game) and [Trolls World Tour’s musical lands](https://instructions.hasbro.com/en-us/instruction/Trouble--DreamWorks-Trolls-World-Tour-Edition-Board-Game). Use four original area materials: blue garden gates, amber watches, plum mushrooms and sage teacups. Each ten-space region runs clockwise from its own marked exit to the stone before the next player’s exit. No copied commercial art or borrowed shortcut mechanics.

Use the existing plain-CSS interface and real application screenshots to assess the layout.

## 2. Color palette and roles

- Garden: mist sage #a6b4a0, slate teal #557a78, weathered ivory #e7ddbd; detailed but clearly lit PNG painting.
- HUD foundations: warm charcoal #252b2c and translucent dark teal #263b3b, with lighter readable material variation rather than near-black slabs.
- Main text: ivory #fff3d9 on dark surfaces, ink #263b3b on porcelain surfaces. Muted text must remain comfortably readable, not decorative low-contrast gray.
- Actions: antique crimson #9a4251 with ivory labels; hover/focus visibly brighter.
- Team identity remains blue, amber, plum and green, accompanied by named teams and painted figures. Numeric piece identities remain in HTML controls and the text summary only.
- Keyboard focus: strong warm amber outline with sufficient contrast. Error/status meaning also uses text, not colour alone.

## 3. Typography

Use installed system sans-serif for controls and body; Georgia/serif for compact story headings. No remote fonts.

- Body: 16–18 CSS px, line-height 1.45–1.6.
- Question: 20–24 CSS px desktop, at least 18 px mobile, generous answer spacing.
- Action labels: 16–18 px; targets at least 48 px high.
- Compact metadata: at least 13 CSS px, not tiny uppercase tracking.
- Upright canvas area labels use at least 14 CSS px when the board is wide enough. Omit these labels below 600px canvas width rather than letting overlapping plaques shrink the board; retain names/material descriptions in the accessible legend.

## 4. Components and interaction

- The board uses genuine PNG artwork and upright painted characters on a projected ground plane. Draw regional stones and safe areas first, the transparent painted tea-table foreground next, and selectable figures above it. No visible route, lane or piece numbers. Each team has four distinct final safe spots; omit center HOME labels. Keep a numbered HTML position summary. Cream frames and downward arrows identify selectable figures; brass frames, checkmarks and dashed rings identify the selected piece. A translucent dashed ghost previews its destination.
- Move through every traversed space with quick individual hops, not a single slide. Reduced motion settles positions immediately without rocking or tumbling. Wrong answers animate no movement and cause no captures.
- Keep Roll, the die, and the countdown in a permanent dock above the reserved turn body. Keep the dock visible when the action rail scrolls. A short clatter/tumble settles on the actual server-generated result. Do not delay the authoritative action or invent another final roll.
- Provide Enable sound and Test sound controls. After a trusted enable gesture, that browser hears human and bot dice, a pleasant note per step, and a springy capture boing. Report blocked audio. No remote samples or autoplay requirement.
- Keep character choice, chapter selection, teacher controls, reconnects, errors, focus, and keyboard alternatives functional. Students reserve a table place before choosing a character. Collapse secondary information rather than shrinking text. Allow piece changes until submission while retaining the same question and deadline; scores appear in the player list and teacher grid.
- Entry on 2/4/6 is blocked only by an own piece; opponents on the start are captured. Every entry earns another roll. A successful on-board six also earns another roll. Wrong answers leave pieces stationary and end the turn. Each human decision has 30 seconds, frozen by teacher pause.

## 5. Layout principles

Use a 4/8 px spacing rhythm. Optimize actual 1280×800, 1366×768 and 1920×1080 viewports; do not assume a huge monitor.

Desktop: compact header (roughly 52–60 px), board fills remaining viewport area, readable action/answer rail about 340–400 px wide. Avoid a tall stack of lobby/team/teacher panels forcing the action below the fold or creating a long empty page beside a short board. Board viewport must flex to available dimensions, not enforce a 600px minimum that overflows laptop height. Secondary teacher settings, rules and detailed team/position data can use native disclosure controls. Use internal scrolling only when a long question genuinely needs it; focused controls must not be obscured.

Mobile (390×844 and 360px wide): one compact header, full-width board and immediately reachable Roll/Continue controls. Expand the turn panel for questions while contracting the board into an overview; do not auto-scroll the reader’s page. Keep all four answer choices readable, normal-size and uncovered. Collapse secondary settings during play; keep join/Go exposed in the lobby. Compact overviews scale down figures and omit canvas labels instead of crushing the route beneath fixed-size plaques. Allow normal vertical scrolling for unusually long content or zoom; no horizontal document overflow. Short landscape uses side-by-side board/actions.

The isometric tilt must be mild enough not to sacrifice legibility: project the ground plane, keep characters/labels upright, fit the projected extents including figure height, and use consistent inverse/figure picking. Do not merely CSS-tilt the whole interface or skew text and portraits.

The host overview reuses a live board card for each independent table. Show table names, reservations, countdowns, current turns, dice, and character progress. Link each card to its full teacher view. Defaults and optional table creation belong above the grid. Keep automatic student grouping separate from teacher navigation. On phones, stack cards without horizontal overflow.

Classroom and GitHub QR panels use readable porcelain backgrounds, clear labels, intact quiet zones, and enlarge/close controls. Share the classroom queue URL. Do not show private browser identifiers.

## 6. Visual verification

Capture desktop and mobile screens from the running game. Verify real actions, not just a landing-screen screenshot.

Compare actual screens: readable teacher grid and scores; fixed Roll/die/countdown on a laptop; readable question and four answers on a phone; all seven local artworks loading; tea-table foreground above colored areas; four region textures; projected figure selection and translucent destinations; same-question piece switching without deadline extension; unnumbered canvas pieces; per-space forward hops; stationary wrong answers; reduced motion; audible shared dice, footsteps, and capture sound; decoded classroom/project QR codes; entry bonuses and own-piece blocking; four 80-point safe destinations; reconnect and automatic grouping. Verify real actions, not source-string copies.
