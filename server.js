const express    = require('express');
const { WebSocketServer } = require('ws');
const http       = require('http');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3000;

// Serve static files (so the game works from Render URL too)
app.use(express.static(path.join(__dirname)));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ═══════════════════════════════════════════════════════════
//  GAME CONSTANTS  (must match client)
// ═══════════════════════════════════════════════════════════
const TILE       = 45;
const COLS       = 20;
const ROWS       = 14;
const CW         = COLS * TILE;   // 900
const CH         = ROWS * TILE;   // 630
const P_RADIUS   = 14;
const P_SPEED    = 2.8;
const B_SPEED    = 9;
const B_RADIUS   = 4;
const B_DAMAGE   = 14;
const MAX_HP     = 100;
const SHOOT_CD   = 420;  // ms
const WINS_NEEDED = 3;
const TICK_MS    = 33;   // ~30 TPS

const MAP = [
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,1,1,0,0,1],
  [1,0,1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1,0,1],
  [1,0,0,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0,0,1],
  [1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,1],
  [1,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,0,1],
  [1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,1],
  [1,0,0,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0,0,1],
  [1,0,1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1,0,1],
  [1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,1,1,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
];

// ═══════════════════════════════════════════════════════════
//  PHYSICS HELPERS
// ═══════════════════════════════════════════════════════════
function wallAt(x, y) {
    const c = Math.floor(x / TILE);
    const r = Math.floor(y / TILE);
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return true;
    return MAP[r][c] === 1;
}

function circleHitsWall(x, y, rad) {
    return [
        [x - rad, y],       [x + rad, y],
        [x, y - rad],       [x, y + rad],
        [x - rad*0.7, y - rad*0.7], [x + rad*0.7, y - rad*0.7],
        [x - rad*0.7, y + rad*0.7], [x + rad*0.7, y + rad*0.7],
    ].some(([px, py]) => wallAt(px, py));
}

// ═══════════════════════════════════════════════════════════
//  ROOM / STATE FACTORY
// ═══════════════════════════════════════════════════════════
let roomIdSeq  = 0;
let bulletIdSeq = 0;
let waitingWS  = null;
const rooms    = new Map();

function freshPlayerState(idx) {
    return {
        x:      idx === 0 ? 90  : 810,
        y:      idx === 0 ? 90  : 540,
        angle:  idx === 0 ? Math.PI * 0.25 : Math.PI * 1.25,
        health: MAX_HP,
        alive:  true,
        shootCD: 0,
    };
}

function freshRoundState(scores) {
    return {
        players: [freshPlayerState(0), freshPlayerState(1)],
        bullets: [],
        phase:   'countdown',   // countdown | playing | roundOver | gameOver
        countdown: 3,
        scores:  scores || [0, 0],
        roundWinner: null,
    };
}

function createRoom(ws0, ws1) {
    const id   = ++roomIdSeq;
    const room = {
        id,
        clients:  [ws0, ws1],
        inputs:   [{}, {}],
        state:    freshRoundState(),
        tickTimer: null,
        active:   true,
    };
    ws0.roomId = id;  ws0.playerIndex = 0;
    ws1.roomId = id;  ws1.playerIndex = 1;
    rooms.set(id, room);
    return room;
}

// ═══════════════════════════════════════════════════════════
//  BROADCAST
// ═══════════════════════════════════════════════════════════
function send(ws, obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
    const msg = JSON.stringify(obj);
    for (const ws of room.clients) {
        if (ws && ws.readyState === 1) ws.send(msg);
    }
}

// ═══════════════════════════════════════════════════════════
//  GAME TICK
// ═══════════════════════════════════════════════════════════
function tick(room) {
    const { state, inputs } = room;
    if (state.phase !== 'playing') return;

    for (let i = 0; i < 2; i++) {
        const p   = state.players[i];
        if (!p.alive) continue;
        const inp = inputs[i] || {};

        // Cooldown
        if (p.shootCD > 0) p.shootCD = Math.max(0, p.shootCD - TICK_MS);

        // Movement
        let mx = 0, my = 0;
        if (inp.up)    my -= 1;
        if (inp.down)  my += 1;
        if (inp.left)  mx -= 1;
        if (inp.right) mx += 1;

        if (mx !== 0 || my !== 0) {
            const len = Math.hypot(mx, my);
            mx /= len; my /= len;
            p.angle = Math.atan2(my, mx);
            const nx = p.x + mx * P_SPEED;
            const ny = p.y + my * P_SPEED;
            if (!circleHitsWall(nx, p.y, P_RADIUS)) p.x = nx;
            if (!circleHitsWall(p.x, ny, P_RADIUS)) p.y = ny;
        }

        // Shoot
        if (inp.shoot && p.shootCD <= 0) {
            const bx = p.x + Math.cos(p.angle) * (P_RADIUS + B_RADIUS + 1);
            const by = p.y + Math.sin(p.angle) * (P_RADIUS + B_RADIUS + 1);
            state.bullets.push({
                x: bx, y: by,
                vx: Math.cos(p.angle) * B_SPEED,
                vy: Math.sin(p.angle) * B_SPEED,
                owner: i,
                id: bulletIdSeq++,
            });
            p.shootCD = SHOOT_CD;
        }
    }

    // Bullets
    for (let i = state.bullets.length - 1; i >= 0; i--) {
        const b = state.bullets[i];
        b.x += b.vx;
        b.y += b.vy;

        if (b.x < 0 || b.x > CW || b.y < 0 || b.y > CH ||
            circleHitsWall(b.x, b.y, B_RADIUS)) {
            state.bullets.splice(i, 1);
            continue;
        }

        let hit = false;
        for (let j = 0; j < 2; j++) {
            if (b.owner === j) continue;
            const p = state.players[j];
            if (!p.alive) continue;
            if (Math.hypot(b.x - p.x, b.y - p.y) < P_RADIUS + B_RADIUS) {
                p.health -= B_DAMAGE;
                state.bullets.splice(i, 1);
                hit = true;
                if (p.health <= 0) {
                    p.health = 0;
                    p.alive  = false;
                    state.scores[b.owner]++;
                    state.roundWinner = b.owner;
                    if (state.scores[b.owner] >= WINS_NEEDED) {
                        state.phase = 'gameOver';
                        clearInterval(room.tickTimer);
                    } else {
                        state.phase = 'roundOver';
                        setTimeout(() => {
                            if (room.active) startCountdown(room);
                        }, 2000);
                    }
                }
                break;
            }
        }
        if (hit) continue;
    }
}

// ═══════════════════════════════════════════════════════════
//  COUNTDOWN → PLAYING
// ═══════════════════════════════════════════════════════════
function startCountdown(room) {
    // Merge scores from previous round into fresh state
    const scores = [...room.state.scores];
    room.state = freshRoundState(scores);
    room.inputs = [{}, {}];

    let n = 3;
    room.state.countdown = n;
    broadcast(room, { type: 'state', state: room.state });

    const iv = setInterval(() => {
        if (!room.active) { clearInterval(iv); return; }
        n--;
        if (n <= 0) {
            clearInterval(iv);
            room.state.phase     = 'playing';
            room.state.countdown = 0;
            broadcast(room, { type: 'state', state: room.state });
            // Start game loop
            room.tickTimer = setInterval(() => {
                if (!room.active) { clearInterval(room.tickTimer); return; }
                tick(room);
                broadcast(room, { type: 'state', state: room.state });
            }, TICK_MS);
        } else {
            room.state.countdown = n;
            broadcast(room, { type: 'state', state: room.state });
        }
    }, 1000);
}

// ═══════════════════════════════════════════════════════════
//  WEBSOCKET EVENTS
// ═══════════════════════════════════════════════════════════
wss.on('connection', (ws) => {

    if (waitingWS && waitingWS.readyState === 1) {
        // Pair up
        const room = createRoom(waitingWS, ws);
        waitingWS = null;

        send(room.clients[0], { type: 'start', playerIndex: 0 });
        send(room.clients[1], { type: 'start', playerIndex: 1 });
        startCountdown(room);

    } else {
        // Queue this player
        waitingWS = ws;
        send(ws, { type: 'waiting' });
    }

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'input' && ws.roomId != null) {
                const room = rooms.get(ws.roomId);
                if (room) room.inputs[ws.playerIndex] = msg.keys || {};
            }
        } catch (_) {}
    });

    ws.on('close', () => {
        if (waitingWS === ws) { waitingWS = null; return; }
        if (ws.roomId == null) return;

        const room = rooms.get(ws.roomId);
        if (!room) return;

        room.active = false;
        clearInterval(room.tickTimer);
        rooms.delete(ws.roomId);

        // Notify the other player
        for (const client of room.clients) {
            if (client && client !== ws && client.readyState === 1) {
                send(client, { type: 'opponentLeft' });
            }
        }
    });

    ws.on('error', () => ws.close());
});

// ═══════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════
server.listen(PORT, () => {
    console.log(`Duel Arena server running on port ${PORT}`);
});
