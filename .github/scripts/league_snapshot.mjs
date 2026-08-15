import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const API_BASE            = 'https://ps99.biggamesapi.io/v1';
const LEAGUE_DIR          = 'league';
const HISTORY_FILE        = `${LEAGUE_DIR}/history.json`;
const RESOLVED_CACHE_FILE = `${LEAGUE_DIR}/resolved_names.json`;
const RETENTION_MS        = 95 * 60 * 1000;
const TOP_PAGES           = 5;
const PAGE_SIZE           = 100;
const DETAIL_CONCURRENCY  = 50;

/* ── helpers ─────────────────────────────────────────────────────── */

async function fetchJson(url, attempts = 2) {
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const json = await res.json();
                if (json.status === 'ok' && json.data !== undefined) return json.data;
                return json;
            }
        } catch (_) {}
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 300));
    }
    return null;
}

async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let idx = 0;
    async function worker() {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function asNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function isUnresolvedName(entry) {
    return entry.DisplayName === String(entry.UserID);
}

/* ── fetch leaderboard (pages 1-5 = top 500) ────────────────────── */

const startedAt = Date.now();

const pageResults = await Promise.all(
    Array.from({ length: TOP_PAGES }, (_, i) =>
        fetchJson(`${API_BASE}/leagues?page=${i + 1}&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`)
    )
);

const summaries = [];
for (const [idx, json] of pageResults.entries()) {
    if (!json) { console.log(`  page ${idx + 1}: no response`); continue; }
    const leagues = json.leagues ?? json.data?.leagues ?? json.data;
    if (!Array.isArray(leagues) || !leagues.length) {
        console.log(`  page ${idx + 1}: no leagues array (keys: ${Object.keys(json).join(', ')}, data type: ${typeof json.data}, data keys: ${json.data && typeof json.data === 'object' ? Object.keys(json.data).join(',') : 'n/a'})`);
        continue;
    }
    for (const raw of leagues) {
        summaries.push({
            Name:             raw.Name || 'Unknown',
            Level:            asNumber(raw.Level),
            Points:           asNumber(raw.Points),
            Members:          asNumber(raw.Members),
            MemberCapacity:   asNumber(raw.MemberCapacity),
            ContributorCount: asNumber(raw.ContributorCount),
            Owner:            raw.Owner || null,
            Icon:             raw.Icon || null,
            Created:          raw.Created || null,
        });
        if (summaries.length >= 500) break;
    }
    if (summaries.length >= 500) break;
}

if (!summaries.length) {
    console.error('No league data returned — skipping this snapshot.');
    process.exit(0);
}

const withPoints = summaries.filter(s => s.Points > 0);
console.log(`Fetched ${summaries.length} league summaries (${withPoints.length} with points). Fetching detail…`);

/* ── fetch detail for leagues with points ────────────────────────── */

function buildLeagueFromDetail(detail, summary) {
    const contributions = Array.isArray(detail.PointContributions) ? detail.PointContributions : [];
    const members       = Array.isArray(detail.Members) ? detail.Members : [];

    const roster = [];
    const seen   = new Set();

    // Start with contributors (already sorted by Points desc)
    for (const c of contributions) {
        const uid  = asNumber(c.UserID);
        if (uid <= 0 || seen.has(uid)) continue;
        seen.add(uid);
        roster.push({
            UserID:      uid,
            DisplayName: c.DisplayName != null ? String(c.DisplayName) : String(uid),
            Points:      asNumber(c.Points),
        });
    }

    // Add members who are not in contributions (0 points)
    for (const m of members) {
        const uid = asNumber(m.UserID);
        if (uid <= 0 || seen.has(uid)) continue;
        seen.add(uid);
        roster.push({
            UserID:      uid,
            DisplayName: m.DisplayName != null ? String(m.DisplayName) : String(uid),
            Points:      0,
        });
    }

    return {
        Name:   detail.Name || summary.Name,
        Points: summary.Points,
        Level:  summary.Level,
        Members: roster.length,
        roster,
    };
}

const DETAIL_DEADLINE = Date.now() + 120_000;
let detailDone   = 0;
let detailFailed = 0;

const detailedLeagues = await mapWithConcurrency(withPoints, DETAIL_CONCURRENCY, async summary => {
    if (Date.now() > DETAIL_DEADLINE) {
        detailFailed++;
        return { Name: summary.Name, Points: summary.Points, Level: summary.Level, Members: summary.Members, roster: [] };
    }
    const detail = await fetchJson(`${API_BASE}/leagues/${encodeURIComponent(summary.Name)}`);
    detailDone++;
    if (detailDone % 50 === 0) console.log(`  detail progress: ${detailDone}/${withPoints.length}`);

    if (!detail) {
        detailFailed++;
        return { Name: summary.Name, Points: summary.Points, Level: summary.Level, Members: summary.Members, roster: [] };
    }

    return buildLeagueFromDetail(detail, summary);
});
if (detailFailed) console.log(`  ${detailFailed} league detail(s) skipped or failed.`);

const zeroLeagues = summaries.filter(s => s.Points <= 0).map(s => ({
    Name: s.Name, Points: 0, Level: s.Level, Members: s.Members, roster: [],
}));
const leagues = [...detailedLeagues, ...zeroLeagues];

/* ── resolve Roblox usernames (edge-case fallback) ───────────────── */

async function resolveUsernames(userIds, deadlineMs = 60_000) {
    const map = {};
    const ROBLOX_URL = 'https://users.roblox.com/v1/users';
    const deadline = Date.now() + deadlineMs;
    const batches = [];
    for (let i = 0; i < userIds.length; i += 100) {
        const batch = userIds.slice(i, i + 100);
        if (batch.length) batches.push(batch);
    }

    let skipped = 0;
    async function resolveBatch(batch) {
        if (Date.now() > deadline) { skipped++; return false; }
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (Date.now() > deadline) { skipped++; return false; }
            try {
                const res = await fetch(ROBLOX_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userIds: batch, excludeBannedUsers: false }),
                    signal: AbortSignal.timeout(6000),
                });
                if (res.ok) {
                    const json = await res.json();
                    const data = json.data || [];
                    if (data.length > 0) {
                        data.forEach(u => { map[u.id] = u.displayName || u.name; });
                        return true;
                    }
                    await new Promise(r => setTimeout(r, 300 * attempt));
                } else if (res.status === 429) {
                    const retryAfter = Number(res.headers.get('retry-after')) || 0;
                    await new Promise(r => setTimeout(r, Math.max(retryAfter * 1000, 500 * attempt)));
                } else {
                    await new Promise(r => setTimeout(r, 200 * attempt));
                }
            } catch (_) {
                await new Promise(r => setTimeout(r, 300 * attempt));
            }
        }
        return false;
    }

    await mapWithConcurrency(batches, 10, resolveBatch);
    if (skipped) console.log(`resolveUsernames: ${skipped} batch(es) skipped (deadline).`);
    return map;
}

/* ── resolved names cache ────────────────────────────────────────── */

if (!existsSync(LEAGUE_DIR)) mkdirSync(LEAGUE_DIR, { recursive: true });

let resolvedCache = {};
if (existsSync(RESOLVED_CACHE_FILE)) {
    try { resolvedCache = JSON.parse(readFileSync(RESOLVED_CACHE_FILE, 'utf8')); } catch (_) { resolvedCache = {}; }
}

// The v1 API already provides DisplayName for members and contributors.
// We only need resolution when DisplayName equals the numeric UserID string.
const needsResolve = new Set();
leagues.forEach(l => l.roster.forEach(p => {
    if (!isUnresolvedName(p)) return;
    if (resolvedCache[p.UserID]) { p.DisplayName = resolvedCache[p.UserID]; return; }
    needsResolve.add(p.UserID);
}));

if (needsResolve.size) {
    const resolved = await resolveUsernames([...needsResolve]);
    leagues.forEach(l => l.roster.forEach(p => {
        if (isUnresolvedName(p) && resolved[p.UserID]) p.DisplayName = resolved[p.UserID];
    }));
    Object.assign(resolvedCache, resolved);
    console.log(`Resolved ${Object.keys(resolved).length}/${needsResolve.size} new display names (${Object.keys(resolvedCache).length} cached total).`);
}
writeFileSync(RESOLVED_CACHE_FILE, JSON.stringify(resolvedCache));

/* ── persist history ─────────────────────────────────────────────── */

let history = [];
if (existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); } catch (_) { history = []; }
}

const now = Date.now();
history.push({ ts: now, leagues });
history = history.filter(entry => now - entry.ts <= RETENTION_MS);

writeFileSync(HISTORY_FILE, JSON.stringify(history));
const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Snapshot recorded: ${leagues.length} leagues with roster detail in ${elapsedSec}s, ${history.length} snapshots retained.`);
