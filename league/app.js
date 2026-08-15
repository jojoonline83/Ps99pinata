'use strict';

document.title = 'PS99 League Leaderboard [v1]';

const STORAGE_KEY  = 'ps99_league_v1';
const API_BASE     = 'https://ps99.biggamesapi.io/v1/leagues';
const CORS_PROXIES = [
    'https://corsproxy.io/?url=',
    'https://api.allorigins.win/raw?url=',
];

const PALETTE = [
    '#6366f1', '#ec4899', '#10b981', '#f59e0b',
    '#ef4444', '#06b6d4', '#8b5cf6', '#f97316',
    '#14b8a6', '#a855f7', '#84cc16', '#3b82f6',
];

let historyData = [];
let resolvedNamesCache = {};

let state = {
    mode: 'top',
    searchResults: [],
    total: 0,
    colorByName: {},
    nextColorIdx: 0,
};

let ui = {
    currentClanName: null,
    currentClanDetail: null,
    currentRank: undefined,
    livePointsAsOf: undefined,
};

function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}

function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) state = { ...state, ...JSON.parse(raw) };
    } catch (_) {}
}

function esc(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str ?? ''));
    return d.innerHTML;
}

function fmt(n) {
    return (Number(n) || 0).toLocaleString();
}

function colorFor(name) {
    const key = name.toLowerCase();
    if (!state.colorByName[key]) {
        state.colorByName[key] = PALETTE[state.nextColorIdx % PALETTE.length];
        state.nextColorIdx = (state.nextColorIdx + 1) % PALETTE.length;
    }
    return state.colorByName[key];
}

function latestSnapshot() {
    return historyData.length ? historyData[historyData.length - 1] : null;
}

function topLeagues() {
    return latestSnapshot()?.leagues || [];
}

function displayedLeagues() {
    return state.mode === 'search' ? state.searchResults : topLeagues();
}

let toastTimer = null;
function toast(msg, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function showLeaderboard() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('leaderboard-view').classList.add('active');
    renderLeaderboard();
}

function showLeagueDetail(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('clan-detail-view').classList.add('active');
    ui.currentClanName = name;
    ui.currentClanDetail = null;
    ui.currentRank = undefined;
    ui.livePointsAsOf = undefined;
    renderLeagueDetail();
    openLeagueDetail(name);
}

function openLeagueDetail(name) {
    const nameLower = name.toLowerCase();
    const fromSnapshot = topLeagues().find(c => c.Name.toLowerCase() === nameLower);

    if (fromSnapshot) {
        ui.currentClanDetail = fromSnapshot;
        const idx = topLeagues().indexOf(fromSnapshot);
        ui.currentRank = idx !== -1 ? idx + 1 : undefined;
        renderLeagueDetail();
        resolveRosterNames(fromSnapshot.roster, name);
        refreshLeagueDetailLive(name);
        return;
    }
    fetchLeagueDetailLive(name);
}

async function resolveRosterNames(roster, leagueName) {
    if (!roster || !roster.length) return;
    const unresolved = roster.filter(p => p.DisplayName === String(p.UserID)).map(p => p.UserID);
    if (!unresolved.length) return;
    const resolved = await resolveUsernames([...new Set(unresolved)]);
    let changed = 0;
    for (const p of roster) {
        if (p.DisplayName === String(p.UserID)) {
            const name = resolved[p.UserID] || resolved[String(p.UserID)];
            if (name) { p.DisplayName = name; changed++; }
        }
    }
    if (changed && ui.currentClanName === leagueName) renderLeagueDetail();
}

function renderLeaderboard() {
    const badge = document.getElementById('event-status-badge');
    const snap = latestSnapshot();
    badge.innerHTML = snap
        ? `<span class="status-pill status-active">⚡ Updated ${new Date(snap.ts).toLocaleTimeString()}</span>`
        : '';

    const list = displayedLeagues();
    document.getElementById('leaderboard-heading').textContent =
        state.mode === 'search'
            ? `Search Results (${state.total} match${state.total === 1 ? '' : 'es'})`
            : 'Top Leagues';

    document.getElementById('clear-search-btn').style.display = state.mode === 'search' ? 'inline-block' : 'none';

    const tbody = document.getElementById('leaderboard-tbody');
    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--text-muted)">
          ${state.mode === 'search' ? 'No leagues matched your search.' : 'No data yet — hit <strong>🔄 Refresh</strong> to load.'}
        </td></tr>`;
        return;
    }

    tbody.innerHTML = list.map((c, idx) => {
        const color = colorFor(c.Name);
        const members = c.roster ? c.roster.length : (c.Members || 0);
        const level = c.Level || 0;
        return `
      <tr onclick="showLeagueDetail('${esc(c.Name).replace(/'/g, "\\'")}')" style="cursor:pointer">
        <td class="player-rank">${idx + 1}</td>
        <td class="player-name"><span class="st-team-dot" style="background:${color}"></span> ${esc(c.Name)}</td>
        <td>${level}</td>
        <td>${members}</td>
        <td class="player-points" style="color:${color}">${fmt(c.Points)}</td>
      </tr>`;
    }).join('');
}

function renderLeagueDetail() {
    const name = ui.currentClanName;
    const color = colorFor(name);
    document.getElementById('clan-detail-color-bar').style.background = color;
    document.getElementById('clan-detail-name').textContent = name;

    const rankEl = document.getElementById('cd-rank');
    if (ui.currentRank === undefined) {
        rankEl.textContent = 'Calculating…';
    } else if (ui.currentRank === null) {
        rankEl.textContent = 'Unknown';
    } else {
        rankEl.textContent = `#${fmt(ui.currentRank)}`;
    }

    const detail = ui.currentClanDetail;
    if (!detail) {
        document.getElementById('clan-detail-sub').textContent = 'Loading…';
        document.getElementById('cd-pts').textContent = '…';
        document.getElementById('cd-pts-asof').textContent = '';
        document.getElementById('cd-level').textContent = '…';
        document.getElementById('cd-roster').textContent = '…';
        ['cd-delta-10m', 'cd-delta-30m', 'cd-delta-1h'].forEach(id => {
            document.getElementById(id).textContent = '—';
            document.getElementById(`${id}-asof`).textContent = '';
        });
        document.getElementById('roster-delta-note').textContent = '';
        document.getElementById('roster-tbody').innerHTML =
            `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">Loading roster…</td></tr>`;
        return;
    }

    document.getElementById('clan-detail-sub').textContent = 'League Leaderboard';
    document.getElementById('cd-pts').textContent = fmt(detail.Points);
    document.getElementById('cd-level').textContent = detail.Level || 0;
    const rosterCount = detail.roster ? detail.roster.length : 0;
    const capacityStr = detail.MemberCapacity ? `${rosterCount} / ${detail.MemberCapacity}` : `${rosterCount}`;
    document.getElementById('cd-roster').textContent = capacityStr;
    document.getElementById('cd-pts-asof').textContent = ui.livePointsAsOf
        ? `🔴 Live as of ${new Date(ui.livePointsAsOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
        : (latestSnapshot() ? `Snapshot as of ${new Date(latestSnapshot().ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — refreshing…` : '');

    const snap10 = renderDeltaStat('cd-delta-10m', detail, 10 * 60_000, 11 * 60_000);
    const snap30 = renderDeltaStat('cd-delta-30m', detail, 30 * 60_000, 8  * 60_000);
    const snap1h = renderDeltaStat('cd-delta-1h',  detail, 60 * 60_000, 12 * 60_000);

    const noteParts = [
        snap10 && `Δ10m ${formatAsOf(snap10)}`,
        snap30 && `Δ30m ${formatAsOf(snap30)}`,
        snap1h && `Δ1Hr ${formatAsOf(snap1h)}`,
    ].filter(Boolean);
    document.getElementById('roster-delta-note').textContent = noteParts.length ? noteParts.join(' · ') : '';

    const tbody = document.getElementById('roster-tbody');
    const roster = detail.roster || [];
    const snapLeague = latestSnapshot() ? findLeagueInSnapshot(latestSnapshot(), detail.Name) : null;
    const snapRoster = snapLeague?.roster || [];
    const snapPointsById = {};
    snapRoster.forEach(sp => { snapPointsById[sp.UserID] = sp.Points; });
    tbody.innerHTML = roster.length
        ? roster.map((p, idx) => {
            const pts = snapPointsById[p.UserID] !== undefined ? snapPointsById[p.UserID] : p.Points;
            const d10 = playerDelta(detail, p.UserID, pts, 10 * 60_000, 11 * 60_000);
            const d30 = playerDelta(detail, p.UserID, pts, 30 * 60_000, 8  * 60_000);
            const d1h = playerDelta(detail, p.UserID, pts, 60 * 60_000, 12 * 60_000);
            return `
              <tr>
                <td class="player-rank">${idx + 1}</td>
                <td class="player-name">${esc(p.DisplayName)}</td>
                <td class="player-points" style="color:${color}">${fmt(p.Points)}</td>
                <td style="color:${d10.color}">${d10.text}</td>
                <td style="color:${d30.color}">${d30.text}</td>
                <td style="color:${d1h.color}">${d1h.text}</td>
              </tr>`;
          }).join('')
        : `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">No roster data.</td></tr>`;
}

async function apiFetch(url) {
    function unwrap(json) {
        return (json && json.status === 'ok' && json.data !== undefined) ? json.data : json;
    }
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) return unwrap(await res.json());
    } catch (_) {}
    for (const proxy of CORS_PROXIES) {
        try {
            const res = await fetch(proxy + encodeURIComponent(url), { signal: AbortSignal.timeout(20000) });
            if (res.ok) return unwrap(await res.json());
        } catch (_) {}
    }
    throw new Error('API unavailable');
}

async function loadHistory() {
    const [histRes, namesRes] = await Promise.all([
        fetch(`history.json?t=${Date.now()}`, { signal: AbortSignal.timeout(30000) }),
        fetch(`resolved_names.json?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) }).catch(() => null),
    ]);
    if (namesRes && namesRes.ok) {
        try { resolvedNamesCache = await namesRes.json(); } catch (_) {}
    }
    if (histRes.ok) {
        historyData = await histRes.json();
        for (const snap of historyData) {
            for (const league of (snap.leagues || [])) {
                for (const p of (league.roster || [])) {
                    if (p.DisplayName === String(p.UserID)) {
                        const cached = resolvedNamesCache[p.UserID] || resolvedNamesCache[String(p.UserID)];
                        if (cached) p.DisplayName = cached;
                    }
                }
            }
        }
    }
}

function hasRosterData(entry) {
    return entry.leagues.length === 0 || entry.leagues[0].roster !== undefined;
}

function findSnapshotNear(msAgo, toleranceMs) {
    if (historyData.length < 2) return null;
    const latest = historyData[historyData.length - 1];
    const targetTs = latest.ts - msAgo;
    const minAgeMs = msAgo / 2;
    let best = null, bestDiff = Infinity;
    for (const entry of historyData) {
        if (entry === latest) continue;
        if (!hasRosterData(entry)) continue;
        if (latest.ts - entry.ts < minAgeMs) continue;
        const diff = Math.abs(entry.ts - targetTs);
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
    }
    return best && bestDiff <= toleranceMs ? best : null;
}

function findLeagueInSnapshot(snap, leagueName) {
    return snap.leagues.find(c => c.Name.toLowerCase() === leagueName.toLowerCase());
}

function formatAsOf(snap) {
    return snap ? `as of ${new Date(snap.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
}

function renderDeltaStat(elId, detail, windowMs, toleranceMs) {
    const el = document.getElementById(elId);
    const asOfEl = document.getElementById(`${elId}-asof`);
    const snap = findSnapshotNear(windowMs, toleranceMs);
    if (!snap) {
        el.textContent = '—'; el.title = 'Not enough snapshot history yet';
        if (asOfEl) asOfEl.textContent = '';
        return null;
    }

    const entry = findLeagueInSnapshot(snap, detail.Name);
    if (!entry) {
        el.textContent = '—'; el.title = 'League was outside tracking at that time';
        if (asOfEl) asOfEl.textContent = '';
        return null;
    }

    const latest = latestSnapshot();
    const latestLeague = latest ? findLeagueInSnapshot(latest, detail.Name) : null;
    const currentPoints = latestLeague ? latestLeague.Points : detail.Points;
    const ageMin = Math.round((latest.ts - snap.ts) / 60000);
    const delta  = currentPoints - entry.Points;
    const sign   = delta >= 0 ? '+' : '−';
    el.textContent = `${sign}${fmt(Math.abs(delta))}`;
    el.title       = `From snapshot ${ageMin}m ago`;
    el.style.color = delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--danger)' : '');
    if (asOfEl) asOfEl.textContent = `${ageMin}m ago`;
    return snap;
}

function playerDelta(detail, userId, currentPoints, windowMs, toleranceMs) {
    const snap = findSnapshotNear(windowMs, toleranceMs);
    if (!snap) return { text: '—', color: '' };

    const league = findLeagueInSnapshot(snap, detail.Name);
    const past = league?.roster?.find(p => p.UserID === userId)?.Points;
    if (past === undefined) return { text: '—', color: '' };

    const delta = currentPoints - past;
    const sign  = delta >= 0 ? '+' : '−';
    return {
        text: `${sign}${fmt(Math.abs(delta))}`,
        color: delta > 0 ? 'var(--success)' : (delta < 0 ? 'var(--danger)' : ''),
    };
}

async function refreshAll({ silent = false } = {}) {
    const btn = document.getElementById('refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading…'; }

    try {
        await loadHistory();
        if (state.mode === 'top') renderLeaderboard();
        if (ui.currentClanName) {
            const stillTracked = topLeagues().find(c => c.Name.toLowerCase() === ui.currentClanName.toLowerCase());
            if (stillTracked) {
                ui.currentClanDetail = stillTracked;
                const idx = topLeagues().indexOf(stillTracked);
                if (idx !== -1) {
                    ui.currentRank = idx + 1;
                    renderLeagueDetail();
                }
            }
        }
        if (!silent) toast(`Loaded ${fmt(topLeagues().length)} leagues`, 'success');
    } catch (err) {
        if (!silent) toast(err.message || 'Failed to refresh', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
    }
}

async function searchLeagues() {
    const input = document.getElementById('search-clan-name');
    const query = (input?.value || '').trim();
    if (!query) { toast('Enter a league name', 'error'); return; }

    const btn = document.getElementById('search-clan-btn');
    const setStatus = (msg, type = '') => {
        const el = document.getElementById('search-status');
        el.className = `import-status ${type}`;
        el.innerHTML = type === 'loading' ? `<span class="spinner"></span>${msg}` : msg;
    };

    btn.disabled = true;
    setStatus(`Searching for "${esc(query)}"…`, 'loading');

    try {
        const raw = await apiFetch(`${API_BASE}/${encodeURIComponent(query)}`);
        if (!raw || !raw.Name) throw new Error('League not found');

        const detail = await buildLiveDetail(raw);
        state.searchResults = [detail];
        state.mode = 'search';
        state.total = 1;
        save();
        renderLeaderboard();
        setStatus(`✅ Found league "${esc(detail.Name)}".`, 'success');
    } catch (err) {
        try {
            const queryLower = query.toLowerCase();
            const matches = topLeagues().filter(c => c.Name.toLowerCase().includes(queryLower));
            if (matches.length) {
                state.searchResults = matches;
                state.mode = 'search';
                state.total = matches.length;
                save();
                renderLeaderboard();
                setStatus(`✅ Found ${matches.length} league(s) matching "${esc(query)}" in leaderboard.`, 'success');
            } else {
                setStatus(`❌ League "${esc(query)}" not found.`, 'error');
            }
        } catch (_) {
            setStatus(`❌ ${err.message}`, 'error');
        }
    } finally {
        btn.disabled = false;
    }
}

function clearSearch() {
    document.getElementById('search-clan-name').value = '';
    document.getElementById('search-status').innerHTML = '';
    if (state.mode === 'search') {
        state.mode = 'top';
        renderLeaderboard();
    }
}

async function resolveUsernames(userIds) {
    if (!userIds.length) return {};
    const map = {};

    for (let i = 0; i < userIds.length; i += 100) {
        const batch = userIds.slice(i, i + 100).map(Number).filter(id => id > 0);
        if (!batch.length) continue;
        const body = JSON.stringify({ userIds: batch, excludeBannedUsers: false });
        const headers = { 'Content-Type': 'application/json' };
        let parsed = null;
        try {
            const res = await fetch('https://users.roproxy.com/v1/users', { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
            if (res.ok) parsed = await res.json();
        } catch (_) {}
        if (parsed && parsed.data && parsed.data.length) {
            parsed.data.forEach(u => {
                const n = u.displayName || u.name;
                map[u.id] = n; map[String(u.id)] = n;
            });
        }
    }

    if (Object.keys(map).length > 0) return map;

    const remaining = userIds.map(Number).filter(id => id > 0 && !map[id]).slice(0, 200);
    if (!remaining.length) return map;
    let idx = 0;
    async function worker() {
        while (idx < remaining.length) {
            const uid = remaining[idx++];
            for (const makeFn of [
                u => ({ url: `https://api.allorigins.win/get?url=${encodeURIComponent(`https://users.roblox.com/v1/users/${u}`)}`, wrap: true }),
                u => ({ url: `https://corsproxy.io/?url=${encodeURIComponent(`https://users.roblox.com/v1/users/${u}`)}`, wrap: false }),
            ]) {
                try {
                    const { url, wrap } = makeFn(uid);
                    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
                    if (!res.ok) continue;
                    const data = wrap ? JSON.parse((await res.json()).contents) : await res.json();
                    const n = data.displayName || data.name;
                    if (n) { map[uid] = n; map[String(uid)] = n; break; }
                } catch (_) {}
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(10, remaining.length) }, () => worker()));
    return map;
}

function isUnresolvedName(entity) {
    return !!(entity && entity.UserID && entity.DisplayName === String(entity.UserID));
}

function getResolvedNamesCache() {
    return Promise.resolve(resolvedNamesCache);
}

async function buildLiveDetail(raw) {
    const contribs = Array.isArray(raw.PointContributions) ? raw.PointContributions : [];
    const members = Array.isArray(raw.Members) ? raw.Members : [];

    const cache = await getResolvedNamesCache();

    // Build roster from contributions
    const roster = [];
    const seen = new Set();
    for (const c of contribs) {
        const uid = Number(c.UserID);
        if (uid <= 0 || seen.has(uid)) continue;
        seen.add(uid);
        let displayName = c.DisplayName || String(uid);
        if (displayName === String(uid)) {
            const cached = cache[uid] || cache[String(uid)];
            if (cached) displayName = cached;
        }
        roster.push({ UserID: uid, DisplayName: displayName, Points: c.Points || 0 });
    }
    // Add members not in contributions with 0 points
    for (const m of members) {
        const uid = Number(m.UserID);
        if (uid <= 0 || seen.has(uid)) continue;
        seen.add(uid);
        let displayName = m.DisplayName || String(uid);
        if (displayName === String(uid)) {
            const cached = cache[uid] || cache[String(uid)];
            if (cached) displayName = cached;
        }
        roster.push({ UserID: uid, DisplayName: displayName, Points: 0 });
    }
    // Add owner if not already included
    if (raw.Owner && raw.Owner.UserID) {
        const ownerUid = Number(raw.Owner.UserID);
        if (ownerUid > 0 && !seen.has(ownerUid)) {
            let displayName = raw.Owner.DisplayName || String(ownerUid);
            if (displayName === String(ownerUid)) {
                const cached = cache[ownerUid] || cache[String(ownerUid)];
                if (cached) displayName = cached;
            }
            roster.push({ UserID: ownerUid, DisplayName: displayName, Points: 0 });
        }
    }

    // Resolve any remaining numeric-only display names
    const needsResolve = roster.filter(p => p.DisplayName === String(p.UserID)).map(p => p.UserID);
    if (needsResolve.length) {
        const resolved = await resolveUsernames([...new Set(needsResolve)]);
        roster.forEach(p => {
            if (p.DisplayName === String(p.UserID) && (resolved[p.UserID] || resolved[String(p.UserID)])) {
                p.DisplayName = resolved[p.UserID] || resolved[String(p.UserID)];
            }
        });
    }

    roster.sort((a, b) => b.Points - a.Points);

    return {
        Name: raw.Name || 'Unknown',
        Level: raw.Level || 0,
        Points: raw.Points || roster.reduce((s, p) => s + p.Points, 0),
        Members: roster.length,
        MemberCapacity: raw.MemberCapacity || 0,
        roster,
    };
}

async function fetchLeagueDetailLive(name) {
    try {
        const raw = await apiFetch(`${API_BASE}/${encodeURIComponent(name)}`);
        const detail = await buildLiveDetail(raw);
        detail.Name = name;

        ui.currentClanDetail = detail;
        if (ui.currentClanName === name) {
            ui.livePointsAsOf = Date.now();
            const idx = topLeagues().findIndex(c => c.Name.toLowerCase() === name.toLowerCase());
            ui.currentRank = idx !== -1 ? idx + 1 : null;
            renderLeagueDetail();
        }
    } catch (err) {
        toast(err.message, 'error');
        document.getElementById('clan-detail-sub').textContent = 'Failed to load league detail.';
    }
}

async function refreshLeagueDetailLive(name) {
    try {
        const raw = await apiFetch(`${API_BASE}/${encodeURIComponent(name)}`);
        if (ui.currentClanName !== name) return;
        const detail = await buildLiveDetail(raw);
        if (ui.currentClanName !== name) return;
        detail.Name = name;
        ui.currentClanDetail = detail;
        ui.livePointsAsOf = Date.now();
        renderLeagueDetail();
    } catch (_) {}
}

document.getElementById('clan-back-btn').addEventListener('click', showLeaderboard);
document.getElementById('refresh-btn').addEventListener('click', () => refreshAll({ silent: false }));
document.getElementById('search-clan-btn').addEventListener('click', searchLeagues);
document.getElementById('clear-search-btn').addEventListener('click', clearSearch);
document.getElementById('search-clan-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); searchLeagues(); }
});

setInterval(() => refreshAll({ silent: true }), 10 * 60_000);

load();
renderLeaderboard();
refreshAll({ silent: false });
