const TEAMS = [
  { name: 'ALICE', color: '#85b5d0', dark: '#294d64' },
  { name: 'WHITE RABBIT', color: '#d7b575', dark: '#71532f' },
  { name: 'CHESHIRE CAT', color: '#ba99cf', dark: '#60426e' },
  { name: 'MAD HATTER', color: '#81b69a', dark: '#315d49' },
];
const REGIONS = [
  { name: 'Rabbit-Hole Garden', shade: '#b6cbd5' },
  { name: "White Rabbit's Court", shade: '#c3a16c' },
  { name: 'Cheshire Wood', shade: '#a28bad' },
  { name: 'Mad Tea Party', shade: '#a0bca4' },
];
const ARTWORK_URLS = [
  '/assets/wonderland-garden-v2.png',
  '/assets/alice-nightmare-v2.png',
  '/assets/rabbit-nightmare-v2.png',
  '/assets/cat-nightmare-v2.png',
  '/assets/hatter-nightmare-v2.png',
  '/assets/wonderland-region-stones-v2.png',
  '/assets/wonderland-table-foreground-v2.png',
];
let artwork;

// Share decoded artwork across board instances; never substitute procedural illustrations.
function loadArtwork() {
  if (!artwork) artwork = ARTWORK_URLS.map((url) => {
    const image = new Image();
    const asset = { image, url, status: 'loading', ready: null };
    asset.ready = new Promise((resolve) => {
      const settle = (status) => {
        asset.status = status;
        image.onload = image.onerror = null;
        resolve();
      };
      image.onload = () => settle(image.naturalWidth && image.naturalHeight ? 'ready' : 'failed');
      image.onerror = () => settle('failed');
      image.src = url;
    });
    return asset;
  });
  return artwork;
}

const TAU = Math.PI * 2;
const angle = (index) => -Math.PI * 3 / 4 + index * TAU / 40;
const radial = (a, r) => ({ x: 500 + Math.cos(a) * r, y: 500 + Math.sin(a) * r });

// PNG artwork supplies the world and figures; HTML controls remain the accessible way to play.
export function createBoard(container, { onPieceSelect = () => {}, onStatus = () => {}, onStep = () => {}, onBump = () => {} } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    onStatus('The illustrated board is unavailable. All game controls remain available below.');
    return { update() {}, resetCamera() {}, setView() {}, dispose() {} };
  }
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', "Painted Wonderland board with forty unnumbered route stones: Rabbit-Hole Garden (blue garden gates, Alice), White Rabbit's Court (amber watches, White Rabbit), Cheshire Wood (plum mushrooms, Cheshire Cat), and Mad Tea Party (sage teacups, Mad Hatter). Diamonds mark protected starts; four distinct safe destinations per team sit beside the tea table. Space and piece numbers are available in the text board and HTML controls. Choose a glowing figure by clicking it or using its piece button; a double brass ring marks the piece locked for a question.");
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:pan-y;';
  container.appendChild(canvas);
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state = null, you = null, frame = 0, disposed = false, initialized = false;
  let width = 1, height = 1, scale = 1, offsetX = 0, offsetY = 0;
  let minimumFigureHeight = 52;
  let planeWidth = 1000, planeHeight = 1000;
  const pawns = [];
  const transitions = [];
  let activeTransition = null;
  const hopDuration = 125;
  for (let team = 0; team < 4; team++) for (let piece = 0; piece < 4; piece++) {
    const p = position(team, piece, -1);
    pawns.push({ team, piece, progress: -1, visualProgress: -1, ...p, from: p, to: p, start: 0, moving: false, sway: 0, bob: 0 });
  }
  const orderedPawns = pawns.slice();
  const assets = loadArtwork();
  function artworkChanged() {
    if (disposed) return;
    const failed = assets.filter((asset) => asset.status === 'failed');
    const pending = assets.filter((asset) => asset.status === 'loading').length;
    if (failed.length) {
      onStatus(`Artwork unavailable: ${failed.map((asset) => asset.url).join(', ')}.${pending ? ` ${pending} image${pending === 1 ? '' : 's'} still loading.` : ''} Use the HTML piece controls; no substitute illustrations are shown.`);
    } else if (pending) {
      onStatus(`Loading painted Wonderland artwork (${assets.length - pending}/${assets.length}). All HTML game controls remain available.`);
    } else {
      onStatus('Follow the garden path. Choose a glowing painted character or its piece button; a brass ring marks the piece locked for a question.');
    }
    requestRender();
  }
  for (const asset of assets) asset.ready.then(artworkChanged);
  function position(team, piece, code) {
    const a = angle(team * 10);
    if (code === -1 || !Number.isFinite(code)) {
      const center = radial(a, 427);
      return { x: center.x + (piece % 2 ? 36 : -36), y: center.y + (piece >= 2 ? 42 : -42) };
    }
    return code >= 40 ? radial(a + (code - 41.5) * 0.22, 252) : radial(angle(code), 335);
  }
  function route(from, to) {
    const waypoints = [];
    const step = to > from ? 1 : -1;
    // Entry and capture returns are single hops; shared movement uses relative progress.
    if (from < 0 || to < 0) return [to];
    for (let progress = from + step; step > 0 ? progress <= to : progress >= to; progress += step) waypoints.push(progress);
    return waypoints;
  }
  function waypoint(pawn, progress) {
    const code = progress < 0 || progress >= 40 ? progress : (pawn.team * 10 + progress) % 40;
    return position(pawn.team, pawn.piece, code);
  }
  function beginHop(walk, time) {
    const pawn = walk.pawn;
    pawn.from = { x: pawn.x, y: pawn.y };
    pawn.to = waypoint(pawn, walk.waypoints[walk.index]);
    pawn.start = time;
    pawn.moving = true;
  }
  function beginTransition(time) {
    if (activeTransition || !transitions.length) return;
    activeTransition = transitions.shift();
    for (const walk of activeTransition.walks) beginHop(walk, time);
  }
  function arrive(walk, notify = true) {
    const pawn = walk.pawn;
    pawn.x = pawn.to.x; pawn.y = pawn.to.y;
    pawn.visualProgress = walk.waypoints[walk.index++];
    pawn.moving = false; pawn.sway = 0; pawn.bob = 0;
    if (notify && walk.notifyStep) onStep(walk.direction);
  }
  function bump(transition) {
    if (transition.victims.length) onBump({
      teamIndex: transition.teamIndex,
      piece: transition.piece,
      captured: transition.victims.map(({ pawn }) => ({ teamIndex: pawn.team, piece: pawn.piece })),
    });
  }
  function advanceTransition(time) {
    beginTransition(time);
    if (!activeTransition) return false;
    const transition = activeTransition;
    for (const walk of transition.walks) {
      if (walk.index >= walk.waypoints.length) continue;
      const pawn = walk.pawn;
      const t = Math.min(1, Math.max(0, (time - pawn.start) / hopDuration));
      const ease = t * t * (3 - 2 * t);
      const retreat = walk.direction < 0;
      const stride = Math.sin(t * Math.PI);
      // Retreat recoils away from the next stone, then shuffles back with a low double hop.
      const travel = retreat ? ease - stride * 0.2 : ease;
      pawn.x = pawn.from.x + (pawn.to.x - pawn.from.x) * travel;
      pawn.y = pawn.from.y + (pawn.to.y - pawn.from.y) * travel;
      pawn.bob = retreat ? Math.abs(Math.sin(t * TAU)) * 3.5 : stride * 6;
      pawn.sway = Math.sin(t * TAU) * (retreat ? -0.11 : 0.06);
      if (t === 1) {
        arrive(walk);
        if (walk.index < walk.waypoints.length) beginHop(walk, time);
      }
    }
    if (transition.walks.every((walk) => walk.index === walk.waypoints.length)) {
      if (transition.victims.length) {
        // Keep victims on the landing stone until the attacker actually reaches it.
        bump(transition);
        transition.walks = transition.victims;
        transition.victims = [];
        for (const walk of transition.walks) beginHop(walk, time);
      } else {
        activeTransition = null;
        beginTransition(time);
      }
    }
    return !!activeTransition;
  }
  function finishReducedMotion() {
    if (activeTransition) transitions.unshift(activeTransition);
    activeTransition = null;
    let arrival = null;
    for (const transition of transitions) {
      for (const walk of transition.walks) {
        if (walk.index >= walk.waypoints.length) continue;
        walk.index = walk.waypoints.length - 1;
        walk.pawn.to = waypoint(walk.pawn, walk.waypoints[walk.index]);
        arrive(walk, false);
        if (walk.notifyStep) arrival = walk;
      }
      bump(transition);
      for (const walk of transition.victims) {
        walk.pawn.to = waypoint(walk.pawn, -1);
        arrive(walk, false);
      }
    }
    transitions.length = 0;
    // One gentle arrival at most, never a simultaneous burst of skipped footsteps.
    if (arrival) onStep(arrival.direction);
  }
  function requestRender() { if (!frame && !disposed) frame = requestAnimationFrame(draw); }
  function ellipse(x, y, rx, ry, color, rotation = 0) {
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rotation, 0, TAU); ctx.fillStyle = color; ctx.fill();
  }
  function roundRect(x, y, w, h, r, color, stroke = null, lineWidth = 1) {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fillStyle = color; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
  }
  function text(value, x, y, size, color, family = 'Georgia, serif', weight = 'bold') {
    ctx.font = `${weight} ${size}px ${family}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(value, x, y);
  }
  // Only the garden plane is transformed; figures and labels use CSS pixels.
  const projectPlane = (x, y) => ({ x: x - 500 + 0.14 * (y - 500), y: -0.08 * (x - 500) + 0.78 * (y - 500) });
  function project(x, y) {
    const p = projectPlane(x, y);
    return { x: offsetX + p.x * scale, y: offsetY + p.y * scale };
  }
  function groundTransform() {
    ctx.transform(scale, -0.08 * scale, 0.14 * scale, 0.78 * scale, offsetX - 570 * scale, offsetY - 350 * scale);
  }
  function stone(x, y, size, region, lineWidth = 2) {
    const team = TEAMS[region], atlas = assets[5];
    roundRect(x - size / 2, y - size / 2 + 7, size, size, 9, '#857a60', '#665f4e', 1);
    const glaze = ctx.createLinearGradient(x, y - size / 2, x, y + size / 2);
    glaze.addColorStop(0, team.color); glaze.addColorStop(1, REGIONS[region].shade);
    roundRect(x - size / 2, y - size / 2, size, size, 9, glaze);
    if (atlas.status === 'ready') {
      const image = atlas.image;
      const cellWidth = image.naturalWidth / 2, cellHeight = image.naturalHeight / 2;
      ctx.save(); ctx.clip();
      ctx.drawImage(image, region % 2 * cellWidth, Math.floor(region / 2) * cellHeight,
        cellWidth, cellHeight, x - size / 2, y - size / 2, size, size);
      ctx.restore();
    }
    ctx.strokeStyle = team.dark; ctx.lineWidth = lineWidth; ctx.stroke();
  }
  function drawPainting(asset) {
    const background = assets[0];
    if (asset.status !== 'ready' || background.status !== 'ready') return;
    const image = background.image;
    const factor = Math.max(planeWidth / image.naturalWidth, planeHeight / image.naturalHeight);
    const w = image.naturalWidth * factor, h = image.naturalHeight * factor;
    // Both paintings have the same full canvas; never fit the cutout independently.
    ctx.drawImage(asset.image, 500 - w / 2, 500 - h / 2, w, h);
  }
  function drawBoard() {
    drawPainting(assets[0]);
    // Team gardens remain distinct from the themed shared route and safe destinations.
    TEAMS.forEach((team, t) => {
      const center = radial(angle(t * 10), 427);
      const current = state?.phase === 'playing' && state.currentPlayer === t;
      roundRect(center.x - 83, center.y - 83, 166, 159, 20, '#e7ddbd80', current ? team.dark : `${team.dark}90`, current ? 4 : 2);
      for (let p = 0; p < 4; p++) {
        const home = position(t, p, -1);
        ellipse(home.x, home.y + 10, 23, 15, `${team.dark}80`);
        ctx.strokeStyle = '#f8edcd'; ctx.lineWidth = 2; ctx.stroke();
      }
      for (let lane = 0; lane < 4; lane++) {
        const p = position(t, 0, 40 + lane);
        stone(p.x, p.y, 38, t, 3);
      }
    });
    for (let i = 0; i < 40; i++) {
      const p = radial(angle(i), 335);
      const entry = i % 10 === 0 ? TEAMS[i / 10] : null;
      stone(p.x, p.y, 46, Math.floor((i + 5) / 10) % 4, entry ? 3 : 1.5);
      if (entry) {
        ellipse(p.x, p.y, 11, 11, '#fff1d9');
        text('◆', p.x, p.y, 18, entry.dark);
      }
    }
  }
  function teamLabelOffset(team, s) {
    return team < 2 ? -Math.max(52, 118 * s) - 36 * s - 18 : 36 * s + 35;
  }
  function drawLabels() {
    if (width >= 600) {
      const size = Math.max(14, Math.min(16, 18 * scale));
      TEAMS.forEach((team, t) => {
        const center = radial(angle(t * 10), 427);
        const p = project(center.x, center.y);
        p.y += teamLabelOffset(t, scale);
        ctx.font = `800 ${size}px system-ui, sans-serif`;
        const w = ctx.measureText(REGIONS[t].name).width + 16;
        roundRect(p.x - w / 2, p.y - 11, w, 23, 6, '#fff0dbef', team.dark, 1.5);
        text(REGIONS[t].name, p.x, p.y + 0.5, size, team.dark, 'system-ui, sans-serif', '800');
      });
    }
    if (assets[0].status !== 'ready') {
      roundRect(width / 2 - Math.min(165, width / 2 - 8), height / 2 - 30, Math.min(330, width - 16), 62, 10, '#263b3bf0');
      text(assets[0].status === 'failed' ? 'Painted garden unavailable' : 'Loading painted garden…', width / 2, height / 2 - 10, Math.min(17, width / 21), '#fff3d9');
      text('HTML game controls remain available', width / 2, height / 2 + 15, Math.min(13, width / 27), '#fff3d9', 'system-ui, sans-serif', '600');
    }
  }
  function figureBounds(pawn) {
    const asset = assets[pawn.team + 1];
    const p = project(pawn.x, pawn.y);
    const small = pawn.visualProgress >= 40;
    const maxW = Math.max(small ? 26 : 34, (small ? 58 : 86) * scale);
    const maxH = Math.max(small ? minimumFigureHeight * 0.65 : minimumFigureHeight, (small ? 78 : 118) * scale);
    const factor = asset.status === 'ready' ? Math.min(maxW / asset.image.naturalWidth, maxH / asset.image.naturalHeight) : 0;
    const w = asset.image.naturalWidth * factor || 0, h = asset.image.naturalHeight * factor || 0;
    const x = p.x, y = p.y + 9 * scale - pawn.bob * Math.max(0.65, scale);
    return { x, y, w, h };
  }
  function drawFigure(pawn, bounds, highlighted) {
    if (assets[pawn.team + 1].status !== 'ready') return;
    ctx.save();
    ctx.shadowColor = highlighted ? '#fff0bb' : '#334a4250';
    ctx.shadowBlur = highlighted ? 10 : 3;
    ctx.translate(bounds.x, bounds.y);
    ctx.rotate(pawn.sway);
    ctx.drawImage(assets[pawn.team + 1].image, -bounds.w / 2, -bounds.h, bounds.w, bounds.h);
    ctx.restore();
  }
  function legal(pawn) {
    return pawn.progress < 40 && state?.phase === 'playing' && !state.paused && state.awaiting === 'piece' && state.currentPlayer === you && pawn.team === you && state.players?.[you]?.connected && !state.players?.[you]?.isBot && state.legalPieces?.includes(pawn.piece);
  }
  function draw(time) {
    frame = 0; if (disposed) return;
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#a6b4a0'; ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.save(); groundTransform(); drawBoard(); drawPainting(assets[6]); ctx.restore();
    if (motion.matches) finishReducedMotion();
    const moving = advanceTransition(time);
    drawLabels();
    orderedPawns.sort((a, b) => -0.08 * (a.x - b.x) + 0.78 * (a.y - b.y));
    const selectedPawn = state?.phase === 'playing' && Number.isInteger(state.selectedPiece) &&
      (state.awaiting === 'answer' || state.awaiting === 'continue') ? pawns[state.currentPlayer * 4 + state.selectedPiece] : null;
    for (const pawn of orderedPawns) {
      const selected = pawn === selectedPawn;
      const selectable = legal(pawn);
      const team = TEAMS[pawn.team];
      const bounds = figureBounds(pawn);
      // Ground shadows and rings flatten with the plane; figures never do.
      ctx.save(); groundTransform();
      ellipse(pawn.x, pawn.y + 7, 26, 17, selectable || selected ? selected ? '#e7b45b90' : `${team.color}b0` : '#344b4245');
      if (selectable || selected) {
        ctx.strokeStyle = selected ? '#b96f21' : team.dark; ctx.lineWidth = 3 / Math.max(0.5, scale); ctx.stroke();
        ellipse(pawn.x, pawn.y + 7, 20, 12, '#fff4cc90');
        if (selected) { ctx.strokeStyle = '#a16623'; ctx.lineWidth = 2 / Math.max(0.5, scale); ctx.stroke(); }
      }
      ctx.restore();
      drawFigure(pawn, bounds, selectable || selected);
    }
    if (moving) requestRender();
  }
  // Fit actual ground and upright-figure extents, not a letterboxed 1000px square.
  const groundPoints = [], figurePoints = [], labelPoints = [];
  for (let t = 0; t < 4; t++) {
    const center = radial(angle(t * 10), 427);
    for (const dx of [-83, 83]) for (const dy of [-83, 76]) groundPoints.push(projectPlane(center.x + dx, center.y + dy));
    labelPoints.push(projectPlane(center.x, center.y));
    for (let piece = 0; piece < 4; piece++) {
      for (const code of [-1, 40, 41, 42, 43]) {
        const p = position(t, piece, code); figurePoints.push(projectPlane(p.x, p.y));
      }
    }
  }
  for (let i = 0; i < 40; i++) {
    const p = radial(angle(i), 335); figurePoints.push(projectPlane(p.x, p.y));
    for (const dx of [-24, 24]) for (const dy of [-24, 31]) groundPoints.push(projectPlane(p.x + dx, p.y + dy));
  }
  function sceneBounds(s) {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const include = (x, y) => { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); };
    for (const p of groundPoints) include(p.x * s, p.y * s);
    const w = Math.max(minimumFigureHeight * 0.66, 86 * s), h = Math.max(minimumFigureHeight, 118 * s);
    for (const p of figurePoints) {
      const swayPadding = h * 0.06 + 10;
      include(p.x * s - w / 2 - swayPadding, p.y * s + 9 * s - h - 4 * Math.max(0.65, s) - 10);
      include(p.x * s + w / 2 + swayPadding, p.y * s + 9 * s + w * 0.03 + 10);
    }
    if (width >= 600) {
      const size = Math.max(14, Math.min(16, 18 * s));
      ctx.font = `800 ${size}px system-ui, sans-serif`;
      labelPoints.forEach((p, t) => {
        const half = ctx.measureText(REGIONS[t].name).width / 2 + 8;
        const y = p.y * s + teamLabelOffset(t, s);
        include(p.x * s - half, y - 12); include(p.x * s + half, y + 13);
      });
    }
    return { left, top, right, bottom };
  }
  function resize() {
    const bounds = container.getBoundingClientRect(); width = Math.max(1, bounds.width); height = Math.max(1, bounds.height);
    minimumFigureHeight = height < 220 ? 18 : width < 600 ? 40 : 52;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
    let low = 0, high = Math.max(width, height) / 400;
    const padding = Math.min(12, width * 0.025, height * 0.025);
    for (let i = 0; i < 24; i++) {
      const s = (low + high) / 2, b = sceneBounds(s);
      if (b.right - b.left <= width - padding * 2 && b.bottom - b.top <= height - padding * 2) low = s; else high = s;
    }
    scale = Math.max(0.001, low);
    const b = sceneBounds(scale);
    offsetX = (width - b.right - b.left) / 2; offsetY = (height - b.bottom - b.top) / 2;
    // Inverse-project viewport corners so the painting covers every pixel.
    let extentX = 500, extentY = 500;
    for (const x of [0, width]) for (const y of [0, height]) {
      const px = (x - offsetX) / scale, py = (y - offsetY) / scale;
      extentX = Math.max(extentX, Math.abs((0.78 * px - 0.14 * py) / 0.7912));
      extentY = Math.max(extentY, Math.abs((py + 0.08 * px) / 0.7912));
    }
    planeWidth = extentX * 2 + 4; planeHeight = extentY * 2 + 4;
    requestRender();
  }
  function pick(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = (event.clientX - rect.left) * width / rect.width, y = (event.clientY - rect.top) * height / rect.height;
    // Ground rings win over overlapping silhouettes, including a shared stone.
    let nearest = null, distance = Infinity;
    for (const pawn of orderedPawns) {
      if (!legal(pawn)) continue;
      const foot = project(pawn.x, pawn.y + 7);
      const d = (x - foot.x) ** 2 + (y - foot.y) ** 2;
      if (d <= 18 ** 2 && d < distance) { nearest = pawn; distance = d; }
    }
    if (nearest) return nearest;
    for (let i = orderedPawns.length - 1; i >= 0; i--) {
      const pawn = orderedPawns[i];
      if (!legal(pawn)) continue;
      const b = figureBounds(pawn);
      // Undo just the walking sway; the canvas itself is never CSS-tilted.
      const dx = x - b.x, dy = y - b.y, cos = Math.cos(pawn.sway), sin = Math.sin(pawn.sway);
      const localX = dx * cos + dy * sin, localY = -dx * sin + dy * cos;
      if (b.w && localX >= -b.w / 2 && localX <= b.w / 2 && localY >= -b.h && localY <= 0) return pawn;
    }
    return null;
  }
  const click = (event) => { const pawn = pick(event); if (pawn) onPieceSelect(pawn.piece); };
  const hover = (event) => { canvas.style.cursor = pick(event) ? 'pointer' : 'default'; };
  canvas.addEventListener('click', click); canvas.addEventListener('pointermove', hover);
  const observer = new ResizeObserver(resize); observer.observe(container); resize();
  const motionChanged = () => requestRender(); motion.addEventListener('change', motionChanged);
  artworkChanged();
  return {
    update(nextState, nextYou, { animate = true } = {}) {
      if (disposed || !nextState) return;
      const snapshot = !initialized || !animate || nextState.phase === 'lobby';
      const changed = [];
      if (snapshot) { transitions.length = 0; activeTransition = null; }
      for (const pawn of pawns) {
        const progress = nextState.players?.[pawn.team]?.progress?.[pawn.piece] ?? -1;
        if (snapshot) {
          const p = waypoint(pawn, progress);
          pawn.x = p.x; pawn.y = p.y; pawn.to = p; pawn.from = p;
          pawn.visualProgress = progress; pawn.moving = false; pawn.sway = 0; pawn.bob = 0;
        } else if (progress !== pawn.progress) {
          changed.push({
            pawn, waypoints: route(pawn.progress, progress), index: 0,
            direction: progress >= 0 && pawn.progress >= 0 && progress < pawn.progress ? -1 : 1,
            notifyStep: progress >= 0,
          });
        }
        pawn.progress = progress;
      }
      state = nextState; you = Number.isInteger(nextYou) ? nextYou : null;
      if (changed.length) {
        const captured = nextState.lastFeedback?.captured ?? [];
        const victims = changed.filter(({ pawn }) => pawn.progress === -1 &&
          captured.some(({ teamIndex, piece }) => teamIndex === pawn.team && piece === pawn.piece));
        const walks = changed.filter((walk) => !victims.includes(walk));
        transitions.push({
          walks: walks.length ? walks : victims,
          victims: walks.length ? victims : [],
          teamIndex: nextState.currentPlayer,
          piece: nextState.lastFeedback?.piece,
        });
        if (motion.matches) finishReducedMotion();
        else beginTransition(performance.now());
      }
      initialized = true;
      requestRender();
    },
    resetCamera() { resize(); },
    setView() { resize(); },
    dispose() {
      disposed = true; if (frame) cancelAnimationFrame(frame); observer.disconnect();
      canvas.removeEventListener('click', click); canvas.removeEventListener('pointermove', hover);
      motion.removeEventListener('change', motionChanged); canvas.remove();
    },
  };
}
