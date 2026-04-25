/**
 * ORBIS RELAY SERVER v2.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Deploy FREE on Railway → railway.app
 * 1. Upload this folder
 * 2. Set env var: OWNER_SECRET=ORBIS-OWNER-2024  (match your website)
 * 3. Railway gives you a URL like: https://orbis-xyz.up.railway.app
 * 4. Paste that URL into your website's Relay URL field
 * 5. Paste that URL into OrbisManager → Relay Url in Unity
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP endpoints (called by website):
 *   POST /api/register-app   → register a new App ID
 *   POST /api/validate-app   → Unity calls this to validate App ID
 *   GET  /api/apps           → owner lists all apps
 *   DELETE /api/apps/:id     → owner deletes an app
 *   GET  /ping               → health check
 *
 * WebSocket (Unity connects here for multiplayer):
 *   Same URL, same port — Railway handles both automatically
 * ─────────────────────────────────────────────────────────────────────────────
 */

const http      = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs        = require('fs');
const path      = require('path');

// ── CONFIG ─────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT         || 8080;
const OWNER_SECRET = process.env.OWNER_SECRET || 'ORBIS-OWNER-2024'; // MUST match website

// ── APP REGISTRY (persisted to disk so it survives Railway restarts) ────────
const DB_FILE   = path.join(__dirname, 'apps.json');
let appRegistry = {};   // { [appId]: { appId, appName, maxPlayers, createdAt } }

function loadDB() {
    try {
        if (fs.existsSync(DB_FILE))
            appRegistry = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        console.log(`[Orbis] Loaded ${Object.keys(appRegistry).length} apps from disk.`);
    } catch (e) { console.warn('[Orbis] No app DB found, starting fresh.'); }
}

function saveDB() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(appRegistry, null, 2)); }
    catch (e) { console.error('[Orbis] Could not save DB:', e.message); }
}

loadDB();

// ── ROOM STATE ──────────────────────────────────────────────────────────────
// rooms: Map<appId, Array<Room>>
// Room: { id, name, maxPlayers, players: Map<playerId, PlayerEntry>, itId }
const rooms = new Map();

function getRoom(appId, maxPlayers) {
    if (!rooms.has(appId)) rooms.set(appId, []);
    const list = rooms.get(appId);
    for (const r of list)
        if (r.players.size < r.maxPlayers) return r;
    // All full — auto create next
    const n    = list.length + 1;
    const room = { id:`room${n}`, name:`Room ${n}`, maxPlayers, players:new Map(), itId:null };
    list.push(room);
    log(appId, `Auto-created ${room.name}`);
    return room;
}

function getRoomList(appId) {
    return (rooms.get(appId) || []).map(r => ({
        id: r.id, name: r.name, playerCount: r.players.size, maxPlayers: r.maxPlayers
    }));
}

function leaveRoom(room, playerId, appId) {
    room.players.delete(playerId);
    broadcast(room, null, { type:'playerLeft', playerId });

    // Reassign IT if needed
    if (room.itId === playerId && room.players.size > 0) {
        const ids    = [...room.players.keys()];
        room.itId    = ids[Math.floor(Math.random() * ids.length)];
        room.players.get(room.itId).isIt = true;
        broadcastAll(room, { type:'tagged', newItId: room.itId, taggerId: null });
    }

    // Switch master client
    if (room.players.size > 0) {
        const newMaster = [...room.players.values()][0];
        newMaster.isMaster = true;
        newMaster.ws.send(JSON.stringify({ type:'masterSwitch', playerId: [...room.players.keys()][0] }));
        broadcastAll(room, { type:'masterSwitch', playerId: [...room.players.keys()][0] });
    }

    // Prune empty non-first rooms
    const list = rooms.get(appId) || [];
    if (room.players.size === 0 && room.id !== 'room1') {
        const idx = list.indexOf(room);
        if (idx > 0) { list.splice(idx, 1); log(appId, `Pruned empty ${room.name}`); }
    }
}

function serializePlayers(room, excludeId) {
    return [...room.players.entries()]
        .filter(([id]) => id !== excludeId)
        .map(([id, p]) => ({ id, nickName: p.name, isIt: p.isIt, isMaster: p.isMaster || false }));
}

// ── HTTP SERVER ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url.split('?')[0];

    // ── Health check ──────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/ping') {
        return json(res, 200, { ok:true, apps: Object.keys(appRegistry).length, relay:'Orbis v2.0' });
    }

    // ── Register a new App ID (website → relay) ───────────────────────────
    // Called when a dev or owner creates a project on the website
    if (req.method === 'POST' && url === '/api/register-app') {
        return readBody(req, body => {
            if (body.ownerSecret !== OWNER_SECRET)
                return json(res, 403, { ok:false, error:'Wrong owner secret. Set OWNER_SECRET env var on Railway.' });

            const { appId, appName, maxPlayers, devEmail } = body;
            if (!appId || !appName)
                return json(res, 400, { ok:false, error:'Missing appId or appName' });
            if (!appId.startsWith('ORB-'))
                return json(res, 400, { ok:false, error:'Invalid App ID format. Must start with ORB-' });

            appRegistry[appId] = {
                appId, appName,
                maxPlayers: parseInt(maxPlayers) || 10,
                devEmail:   devEmail || '',
                createdAt:  new Date().toISOString()
            };
            saveDB();
            console.log(`[Orbis] Registered: ${appId} (${appName})`);
            json(res, 200, { ok:true, appId });
        });
    }

    // ── Validate App ID (Unity → relay on Connect) ────────────────────────
    if (req.method === 'POST' && url === '/api/validate-app') {
        return readBody(req, body => {
            const { appId } = body;
            if (!appId) return json(res, 400, { approved:false, reason:'Missing appId' });

            const app = appRegistry[appId];
            if (!app) return json(res, 404, {
                approved: false,
                reason:   `App ID '${appId}' is not registered. Create a project on the Orbis dashboard first.`
            });

            console.log(`[Orbis] Validated: ${appId} (${app.appName})`);
            json(res, 200, {
                approved:   true,
                appName:    app.appName,
                maxPlayers: app.maxPlayers
            });
        });
    }

    // ── List all apps (owner only) ────────────────────────────────────────
    if (req.method === 'GET' && url === '/api/apps') {
        const secret = (req.headers.authorization || '').replace('Bearer ', '');
        if (secret !== OWNER_SECRET) return json(res, 403, { error:'Unauthorized' });
        return json(res, 200, { apps: Object.values(appRegistry) });
    }

    // ── Delete an app (owner only) ────────────────────────────────────────
    if (req.method === 'DELETE' && url.startsWith('/api/apps/')) {
        const secret = (req.headers.authorization || '').replace('Bearer ', '');
        if (secret !== OWNER_SECRET) return json(res, 403, { error:'Unauthorized' });
        const appId = decodeURIComponent(url.replace('/api/apps/', ''));
        if (!appRegistry[appId]) return json(res, 404, { error:'Not found' });
        delete appRegistry[appId];
        saveDB();
        return json(res, 200, { ok:true });
    }

    json(res, 404, { error:'Not found' });
});

// ── WEBSOCKET ───────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    let playerId   = null;
    let playerName = '';
    let appId      = null;
    let room       = null;

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {

            // ── HANDSHAKE — sent by Unity right after WS opens ────────────
            case 'handshake': {
                appId = msg.appId;
                if (!appRegistry[appId]) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: `App ID '${appId}' is not registered. Create a project on the Orbis dashboard.`
                    }));
                    ws.close();
                    return;
                }
                playerId   = uuidv4().replace(/-/g, '').slice(0, 10);
                playerName = (msg.nickName || 'Gorilla' + Math.floor(Math.random() * 9999)).slice(0, 32);
                log(appId, `${playerName} connected`);
                ws.send(JSON.stringify({ type:'handshakeOk', playerId }));
                break;
            }

            // ── JOIN OR CREATE ROOM ───────────────────────────────────────
            case 'joinOrCreate':
            case 'joinRoom':
            case 'createRoom': {
                if (!playerId) return wsError(ws, 'Send handshake first.');
                if (room) { leaveRoom(room, playerId, appId); room = null; }

                const app = appRegistry[appId];
                const max = msg.maxPlayers || app?.maxPlayers || 10;

                if (msg.type === 'createRoom') {
                    const list = rooms.get(appId) || [];
                    rooms.set(appId, list);
                    const n = list.length + 1;
                    room = { id:`room${n}`, name: msg.roomName || `Room ${n}`, maxPlayers:max, players:new Map(), itId:null };
                    list.push(room);
                } else if (msg.type === 'joinRoom') {
                    const list = rooms.get(appId) || [];
                    room = list.find(r => r.name === msg.roomName);
                    if (!room) return ws.send(JSON.stringify({ type:'joinFailed', message:`Room '${msg.roomName}' not found.` }));
                    if (room.players.size >= room.maxPlayers) return ws.send(JSON.stringify({ type:'joinFailed', message:'Room is full.' }));
                } else {
                    // joinOrCreate — server picks best room automatically
                    room = getRoom(appId, max);
                }

                const isMaster = room.players.size === 0;
                if (isMaster) room.itId = playerId;

                room.players.set(playerId, { ws, name:playerName, isIt:room.itId===playerId, isMaster });

                ws.send(JSON.stringify({
                    type:     'joinedRoom',
                    playerId,
                    roomName: room.name,
                    isMaster,
                    isIt:     room.itId === playerId,
                    players:  serializePlayers(room, playerId)
                }));

                broadcast(room, playerId, {
                    type:     'playerJoined',
                    playerId,
                    nickName: playerName,
                    isIt:     false,
                    isMaster: false
                });

                log(appId, `${playerName} → ${room.name} [${room.players.size}/${room.maxPlayers}]`);
                break;
            }

            // ── LEAVE ROOM ────────────────────────────────────────────────
            case 'leaveRoom': {
                if (room) { leaveRoom(room, playerId, appId); room = null; }
                break;
            }

            // ── STATE SYNC ────────────────────────────────────────────────
            case 'state': {
                if (!room) return;
                broadcast(room, playerId, { type:'state', playerId, data:msg.data });
                break;
            }

            // ── CHAT ──────────────────────────────────────────────────────
            case 'chat': {
                if (!room) return;
                broadcastAll(room, {
                    type:      'chat',
                    playerId,
                    nickName:  playerName,
                    text:      (msg.text || '').slice(0, 200),
                    timestamp: Date.now()
                });
                break;
            }

            // ── TAG ───────────────────────────────────────────────────────
            case 'tag': {
                if (!room || room.itId !== playerId) return;
                if (!room.players.has(msg.targetId)) return;
                room.players.get(room.itId).isIt = false;
                room.itId = msg.targetId;
                room.players.get(room.itId).isIt = true;
                broadcastAll(room, { type:'tagged', newItId:room.itId, taggerId:playerId });
                log(appId, `Tag: ${playerId} → ${room.itId}`);
                break;
            }

            // ── GET ROOMS ─────────────────────────────────────────────────
            case 'getRooms': {
                ws.send(JSON.stringify({ type:'roomList', rooms: getRoomList(appId) }));
                break;
            }

            // ── PING ──────────────────────────────────────────────────────
            case 'ping': {
                ws.send(JSON.stringify({ type:'pong', t:Date.now() }));
                break;
            }
        }
    });

    ws.on('close', () => {
        if (room && playerId) leaveRoom(room, playerId, appId);
        if (playerName) log(appId||'?', `${playerName} disconnected`);
    });

    ws.on('error', e => console.error('[Orbis] WS error:', e.message));
});

// ── KEEP-ALIVE PING ─────────────────────────────────────────────────────────
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) { ws.terminate(); return; }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// ── HELPERS ─────────────────────────────────────────────────────────────────
function broadcast(room, excludeId, msg) {
    const data = JSON.stringify(msg);
    for (const [id, p] of room.players)
        if (id !== excludeId && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
}

function broadcastAll(room, msg) {
    const data = JSON.stringify(msg);
    for (const [, p] of room.players)
        if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
}

function json(res, code, body) {
    res.writeHead(code, { 'Content-Type':'application/json' });
    res.end(JSON.stringify(body));
}

function readBody(req, cb) {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
        try { cb(JSON.parse(body)); } catch { cb({}); }
    });
}

function wsError(ws, msg) {
    ws.send(JSON.stringify({ type:'error', message:msg }));
}

function log(appId, msg) {
    console.log(`[Orbis] [${appId||'?'}] ${msg}`);
}

server.listen(PORT, () => {
    console.log(`\n✦ Orbis Relay Server v2.0`);
    console.log(`  HTTP  → http://localhost:${PORT}`);
    console.log(`  WS    → ws://localhost:${PORT}`);
    console.log(`  Apps  → ${Object.keys(appRegistry).length} registered`);
    console.log(`\n  Deploy: https://railway.app\n`);
});
