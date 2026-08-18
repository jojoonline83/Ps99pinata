import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const API_BASE           = 'https://ps99.biggamesapi.io/api';
const HISTORY_FILE       = 'history.json';
const RESOLVED_CACHE_FILE = 'resolved_names.json';
const RETENTION_MS       = 95 * 60 * 1000;
const TOP_PAGES          = 10;
const PAGE_SIZE          = 50;
const DETAIL_CONCURRENCY = 50;

async function fetchJson(url, attempts = 2) {
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const json = await res.json();
                if (json.status === 'ok') return json;
            }
        } catch (_) {}
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 300));
    }
    return null;
}

const battleJson = await fetchJson(`${API_BASE}/activeClanBattle`);
const battleData = battleJson?.data?.configData;
if (!battleData || Date.now() / 1000 > battleData.FinishTime) {
    console.log('No active clan battle — skipping snapshot.');
    process.exit(0);
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

function firstDefined(...args) {
    for (const a of args) if (a !== undefined && a !== null) return a;
    return undefined;
}

function asNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function isUnresolvedName(entry) {
    return entry.DisplayName === String(entry.UserID);
}

function buildClanFromDetail(detail, summary) {
    const members = Array.isArray(detail.Members) ? detail.Members : [];
    const battles = detail.Battles || detail.battles || {};
    const battleKeys = Object.keys(battles);
    let battleData = battleKeys.length ? battles[battleKeys[battleKeys.length - 1]] : null;

    let contribRows = [];
    if (battleData) {
        contribRows = firstDefined(
            battleData.PointContributions, battleData.pointContributions,
            battleData.Contributions, battleData.contributions,
            battleData.Contribution, battleData.contribution
        ) || [];
        if (!Array.isArray(contribRows)) contribRows = [];
    }
    if (!contribRows.length) {
        const fb = firstDefined(
            detail.Contribution?.Battle, detail.contribution?.battle,
            detail.Contributions?.Battle, detail.contributions?.battle
        );
        if (Array.isArray(fb)) contribRows = fb;
    }

    const contribByUser = {};
    for (const c of contribRows) {
        const uid = asNumber(firstDefined(c.UserID, c.UserId, c.user_id, c.userId, c.id));
        const pts = asNumber(firstDefined(c.Points, c.points, c.TotalPoints, c.total_points, c.Score, c.score, c.Value, c.value));
        if (uid > 0) contribByUser[uid] = pts;
    }

    const roster = [];
    const seen = new Set();
    for (const m of members) {
        const uid = asNumber(firstDefined(m.UserID, m.UserId, m.user_id, m.userId, m.id));
        if (uid <= 0) continue;
        seen.add(uid);
        roster.push({ UserID: uid, DisplayName: String(uid), Points: contribByUser[uid] ?? 0 });
    }
    for (const [uidStr, pts] of Object.entries(contribByUser)) {
        const uid = Number(uidStr);
        if (!seen.has(uid) && uid > 0) {
            roster.push({ UserID: uid, DisplayName: String(uid), Points: pts });
        }
    }

    roster.sort((a, b) => b.Points - a.Points);

    return {
        Name: detail.Name || detail.name || summary.Name,
        Points: summary.Points,
        Members: roster.length,
        roster,
    };
}

async function resolveUsernames(userIds, deadlineMs = 240_000) {
    const map = {};
    const sent = new Set();
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
        for (let attempt = 1; attempt <= 2; attempt++) {
            if (Date.now() > deadline) { skipped++; return false; }
            try {
                const res = await fetch(ROBLOX_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userIds: batch, excludeBannedUsers: false }),
                    signal: AbortSignal.timeout(8000),
                });
                if (res.ok) {
                    const json = await res.json();
                    const data = json.data || [];
                    batch.forEach(uid => sent.add(uid));
                    data.forEach(u => { map[u.id] = u.displayName || u.name; });
                    return true;
                } else if (res.status === 429) {
                    const retryAfter = Number(res.headers.get('retry-after')) || 0;
                    await new Promise(r => setTimeout(r, Math.max(retryAfter * 1000, 800 * attempt)));
                } else {
                    await new Promise(r => setTimeout(r, 300 * attempt));
                }
            } catch (_) {
                await new Promise(r => setTimeout(r, 500 * attempt));
            }
        }
        return false;
    }

    await mapWithConcurrency(batches, 5, resolveBatch);
    if (skipped) console.log(`resolveUsernames: ${skipped} batch(es) skipped (deadline).`);

    let unresolvable = 0;
    for (const uid of sent) {
        if (!map[uid]) { map[uid] = String(uid); unresolvable++; }
    }
    if (unresolvable) console.log(`  ${unresolvable} user(s) marked unresolvable (Roblox returned no data).`);
    return map;
}

const startedAt = Date.now();

const pageResults = await Promise.all(
    Array.from({ length: TOP_PAGES }, (_, i) =>
        fetchJson(`${API_BASE}/clans?page=${i + 1}&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`)
    )
);
const summaries = [];
for (const json of pageResults) {
    const data = json?.data;
    if (!Array.isArray(data) || !data.length) continue;
    for (const raw of data) {
        summaries.push({
            Name: firstDefined(raw.Name, raw.name, raw.ClanName, raw.clanName) || 'Unknown',
            Points: asNumber(firstDefined(raw.Points, raw.points, raw.Score, raw.score, raw.Total, raw.total)),
            Members: asNumber(firstDefined(raw.Members, raw.members, raw.MemberCount, raw.memberCount)),
        });
        if (summaries.length >= 500) break;
    }
    if (summaries.length >= 500) break;
}

if (!summaries.length) {
    console.error('No clan data returned — skipping this snapshot.');
    process.exit(0);
}

const withPoints = summaries.filter(s => s.Points > 0);
console.log(`Fetched ${summaries.length} clan summaries (${withPoints.length} with points). Fetching detail…`);

const DETAIL_DEADLINE = Date.now() + 120_000;
let detailDone = 0;
let detailFailed = 0;

const detailedClans = await mapWithConcurrency(withPoints, DETAIL_CONCURRENCY, async summary => {
    if (Date.now() > DETAIL_DEADLINE) {
        detailFailed++;
        return { Name: summary.Name, Points: summary.Points, Members: summary.Members, roster: [] };
    }
    const detailJson = await fetchJson(`${API_BASE}/clan/${encodeURIComponent(summary.Name)}`);
    const detail = detailJson?.data;
    detailDone++;
    if (detailDone % 50 === 0) console.log(`  detail progress: ${detailDone}/${withPoints.length}`);

    if (!detail) {
        detailFailed++;
        return { Name: summary.Name, Points: summary.Points, Members: summary.Members, roster: [] };
    }

    return buildClanFromDetail(detail, summary);
});
if (detailFailed) console.log(`  ${detailFailed} clan detail(s) skipped or failed.`);

const zeroClans = summaries.filter(s => s.Points <= 0).map(s => ({
    Name: s.Name, Points: 0, Members: s.Members, roster: [],
}));
const clans = [...detailedClans, ...zeroClans];

let resolvedCache = {};
if (existsSync(RESOLVED_CACHE_FILE)) {
    try { resolvedCache = JSON.parse(readFileSync(RESOLVED_CACHE_FILE, 'utf8')); } catch (_) { resolvedCache = {}; }
}

const needsResolve = new Set();
clans.forEach(c => c.roster.forEach(p => {
    if (!isUnresolvedName(p)) return;
    if (resolvedCache[p.UserID]) { p.DisplayName = resolvedCache[p.UserID]; return; }
    needsResolve.add(p.UserID);
}));

if (needsResolve.size) {
    const resolved = await resolveUsernames([...needsResolve]);
    clans.forEach(c => c.roster.forEach(p => {
        if (isUnresolvedName(p) && resolved[p.UserID]) p.DisplayName = resolved[p.UserID];
    }));
    Object.assign(resolvedCache, resolved);
    console.log(`Resolved ${Object.keys(resolved).length}/${needsResolve.size} new display names (${Object.keys(resolvedCache).length} cached total).`);
}
writeFileSync(RESOLVED_CACHE_FILE, JSON.stringify(resolvedCache));

let history = [];
if (existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); } catch (_) { history = []; }
}

const now = Date.now();
history.push({ ts: now, clans });
history = history.filter(entry => now - entry.ts <= RETENTION_MS);

writeFileSync(HISTORY_FILE, JSON.stringify(history));
const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Snapshot recorded: ${clans.length} clans with roster detail in ${elapsedSec}s, ${history.length} snapshots retained.`);

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';
const DISCORD_ROLE_ID = '967089828837597264';
const ALERT_STATE_FILE = 'alert_state.json';
const WATCH_PLAYERS = ['jojo8', 'javierplayz'];
const DC_WINDOWS = [
    { label: '10m', ms: 10 * 60_000, tol: 11 * 60_000 },
    { label: '30m', ms: 30 * 60_000, tol: 8  * 60_000 },
    { label: '60m', ms: 60 * 60_000, tol: 12 * 60_000 },
];

function findPlayerInSnapshot(snap, nameLower) {
    for (const c of snap.clans || []) {
        for (const p of c.roster || []) {
            if (String(p.DisplayName).toLowerCase() === nameLower) return { ...p, Clan: c.Name };
        }
    }
    return null;
}

function findSnapNear(hist, latest, msAgo, tolMs) {
    const target = latest.ts - msAgo;
    const minAge = msAgo / 2;
    let best = null, bestDiff = Infinity;
    for (const s of hist) {
        if (s === latest) continue;
        if (latest.ts - s.ts < minAge) continue;
        const d = Math.abs(s.ts - target);
        if (d < bestDiff) { bestDiff = d; best = s; }
    }
    return best && bestDiff <= tolMs ? best : null;
}

function fmtNum(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

async function sendDiscordEmbed(embed) {
    if (!DISCORD_WEBHOOK) { console.log('DISCORD_WEBHOOK not set — skipping alert.'); return; }
    try {
        const res = await fetch(DISCORD_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: `<@&${DISCORD_ROLE_ID}>`,
                embeds: [embed],
                allowed_mentions: { roles: [DISCORD_ROLE_ID] },
            }),
            signal: AbortSignal.timeout(10000),
        });
        console.log(`Discord embed sent (${res.status}): ${embed.title}`);
    } catch (e) {
        console.log(`Discord embed failed: ${e.message}`);
    }
}

if (history.length >= 2) {
    let alertState = {};
    if (existsSync(ALERT_STATE_FILE)) {
        try { alertState = JSON.parse(readFileSync(ALERT_STATE_FILE, 'utf8')); } catch (_) { alertState = {}; }
    }

    const latest = history[history.length - 1];
    const alerts = [];

    for (const name of WATCH_PLAYERS) {
        const nameLower = name.toLowerCase();
        const current = findPlayerInSnapshot(latest, nameLower);
        if (!current) continue;

        if (!alertState[nameLower]) alertState[nameLower] = {};

        for (const w of DC_WINDOWS) {
            const pastSnap = findSnapNear(history, latest, w.ms, w.tol);
            if (!pastSnap) continue;

            const past = findPlayerInSnapshot(pastSnap, nameLower);
            if (!past) continue;

            const delta = current.Points - past.Points;
            const key = w.label;

            if (delta === 0) {
                if (!alertState[nameLower][key]) {
                    alertState[nameLower][key] = true;
                    alerts.push({ name: current.DisplayName, window: w.label, points: current.Points, clan: current.Clan });
                }
            } else {
                alertState[nameLower][key] = false;
            }
        }
    }

    if (alerts.length) {
        const byPlayer = {};
        for (const a of alerts) {
            if (!byPlayer[a.name]) byPlayer[a.name] = { name: a.name, points: a.points, clan: a.clan, windows: [] };
            byPlayer[a.name].windows.push(a.window);
        }
        const pad = n => String(n).padStart(2, '0');
        const d = new Date();
        const dateStr = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
        const timeStr = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
        for (const player of Object.values(byPlayer)) {
            const embed = {
                title: `⚠️ ${player.name} — No Point Gain`,
                description: `**${player.name}** has **0 points gained** in the last **${player.windows[0]}**.`,
                color: 0xFF8C00,
                fields: [
                    { name: 'Current Points', value: fmtNum(player.points), inline: true },
                    { name: 'League', value: player.clan || 'Unknown', inline: true },
                    { name: 'Zero-gain Windows', value: player.windows.join(', '), inline: false },
                ],
                footer: { text: `PS99 Clan Battle Tracker | ${dateStr} ${timeStr}` },
            };
            await sendDiscordEmbed(embed);
        }
    }

    writeFileSync(ALERT_STATE_FILE, JSON.stringify(alertState));
}
