/**
 * VOID TEAM - 24/7 CLOUD WORKER & HISTORY API SERVER
 * ---------------------------------------------------
 * Runs 24/7 on Free Cloud (Render / Railway / Glitch / Render Web Service)
 * 1. Background worker polls live game server every 30s
 * 2. Deduplicates & stores in memory + persistent file
 * 3. Serves public JSON API at GET /history and /status for any browser or phone
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HISTORY_API_URL = "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";
const STORE_FILE = path.join(__dirname, 'history_store.json');
const POLL_INTERVAL_MS = 30000; // 30 seconds
const MAX_STORED_RECORDS = 5000;

let memoryHistory = [];
let lastPollTime = null;
let totalPolls = 0;
let failedPolls = 0;

// Read existing store
function loadLocalStore() {
    try {
        if (fs.existsSync(STORE_FILE)) {
            const raw = fs.readFileSync(STORE_FILE, 'utf8');
            const data = JSON.parse(raw);
            if (Array.isArray(data)) return data;
        }
    } catch (e) {
        console.warn('[Cloud Worker] Store load warning:', e.message);
    }
    return [];
}

// Save store
function saveLocalStore(data) {
    try {
        fs.writeFileSync(STORE_FILE, JSON.stringify(data), 'utf8');
    } catch (e) {
        console.error('[Cloud Worker] Store save error:', e.message);
    }
}

memoryHistory = loadLocalStore();

// Poller
async function fetchBatch() {
    const url = `${HISTORY_API_URL}?ts=${Date.now()}`;
    const headers = {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Origin': 'https://bdgwin.org',
        'Referer': 'https://bdgwin.org/',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    };

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const json = await res.json();

    let list = [];
    if (json.data && Array.isArray(json.data.list)) list = json.data.list;
    else if (json.data && Array.isArray(json.data.games)) list = json.data.games;
    else if (json.data && Array.isArray(json.data.issueList)) list = json.data.issueList;
    else if (Array.isArray(json.data)) list = json.data;
    else if (Array.isArray(json.list)) list = json.list;

    return list;
}

async function runCollectorCycle() {
    totalPolls++;
    try {
        const freshList = await fetchBatch();
        lastPollTime = new Date().toISOString();

        if (!Array.isArray(freshList) || freshList.length === 0) return;

        const seen = new Set();
        const merged = [];

        // 1. New incoming items
        for (const item of freshList) {
            const id = String(item.issueNumber || item.periodNumber || item.issue || '');
            if (id && !seen.has(id)) {
                seen.add(id);
                const num = parseInt(item.number !== undefined ? item.number : item.resultNumber, 10);
                merged.push({
                    issueNumber: id,
                    number: isNaN(num) ? 0 : num,
                    size: num >= 5 ? 'BIG' : 'SMALL',
                    color: item.color || item.colour || (num === 0 ? 'red,violet' : (num === 5 ? 'green,violet' : (num % 2 === 0 ? 'red' : 'green'))),
                    timestamp: item.openTime || item.time || Date.now()
                });
            }
        }

        // 2. Existing memory items
        for (const item of memoryHistory) {
            const id = String(item.issueNumber || item.periodNumber || item.issue || '');
            if (id && !seen.has(id)) {
                seen.add(id);
                merged.push(item);
            }
        }

        // 3. Sort descending
        merged.sort((a, b) => String(b.issueNumber).localeCompare(String(a.issueNumber), undefined, { numeric: true }));

        // 4. Cap
        memoryHistory = merged.slice(0, MAX_STORED_RECORDS);
        saveLocalStore(memoryHistory);

        console.log(`[Cloud Collector] [${new Date().toLocaleTimeString()}] Total rounds: ${memoryHistory.length} | Latest issue: ${memoryHistory[0] ? memoryHistory[0].issueNumber : 'N/A'}`);
    } catch (err) {
        failedPolls++;
        console.error(`[Cloud Collector Error] [${new Date().toLocaleTimeString()}]: ${err.message}`);
    }
}

// Start continuous background loop
runCollectorCycle();
setInterval(runCollectorCycle, POLL_INTERVAL_MS);

// Self-ping to prevent free tier spin-down on Render/Glitch (every 14 mins)
setInterval(() => {
    if (process.env.RENDER_EXTERNAL_URL) {
        fetch(`${process.env.RENDER_EXTERNAL_URL}/ping`).catch(() => {});
    }
}, 14 * 60 * 1000);

// HTTP Cloud API Server
const server = http.createServer((req, res) => {
    // CORS Headers so any web app / phone can fetch history
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    // Endpoint 1: Get Deep Stored History (e.g. /history?limit=1000)
    if (url.pathname === '/history' || url.pathname === '/history_store.json') {
        const limitParam = parseInt(url.searchParams.get('limit'), 10);
        const limit = !isNaN(limitParam) && limitParam > 0 ? limitParam : MAX_STORED_RECORDS;
        const slice = memoryHistory.slice(0, limit);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(slice));
        return;
    }

    // Endpoint 2: Health & Status
    if (url.pathname === '/status' || url.pathname === '/ping' || url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: "online",
            service: "Void Team 24/7 Wingo Cloud Collector",
            totalRoundsArchived: memoryHistory.length,
            latestIssue: memoryHistory[0] ? memoryHistory[0].issueNumber : null,
            latestResult: memoryHistory[0] ? `${memoryHistory[0].size} (${memoryHistory[0].number})` : null,
            lastPollTime: lastPollTime,
            uptimeSeconds: Math.floor(process.uptime()),
            totalPolls: totalPolls,
            failedPolls: failedPolls
        }, null, 2));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(` VOID TEAM 24/7 CLOUD COLLECTOR SERVER RUNNING`);
    console.log(` Port: ${PORT}`);
    console.log(` API Endpoint: http://localhost:${PORT}/history`);
    console.log(` Status Endpoint: http://localhost:${PORT}/status`);
    console.log(`====================================================`);
});
