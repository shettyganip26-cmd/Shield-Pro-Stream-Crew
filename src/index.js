/**
 * ShieldPro Cross-City Cloud Crew Relay Worker + Durable Object Hub (v2.0 Studio)
 * - Zero Google OAuth / Zero friend sign-in (Room Code + PIN SHA-256 handshake)
 * - Server-calibrated clock offset + atomic sync_pulse (zero-jitter smooth sync)
 * - In-page YouTube Search (/api/yt/search) + Student Request-to-Play Queue (Host Approval)
 * - Full Host Moderation (Mute Chat Only, Ban Completely from Room, Delete/Clear Messages)
 * - Study Room Governance (Focus Lock, Slow Mode, Lock Room, Pinned Notice, Pulse Poll, Doubt Queue, Floating Reactions)
 * - Obsidian & Champagne Studio Web Desk with locked 100dvh viewport & incremental zero-jitter chat DOM
 */

const ROOM_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const HOST_RECONNECT_GRACE_MS = 15 * 60 * 1000;
const PIN_LOCKOUT_MS = 30 * 1000;
const MAX_PIN_ATTEMPTS = 5;
const AI_VIEWER_COOLDOWN_MS = 15 * 1000;
const VIDEO_REQ_COOLDOWN_MS = 20 * 1000;
const REACTION_COOLDOWN_MS = 1500;
const YT_SEARCH_WINDOW_MS = 60 * 1000;
const YT_SEARCH_MAX_PER_MIN = 18;

const ytSearchRateMap = new Map(); // ip -> { count, windowStart }

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Host-Secret, X-Room-Pin, X-File-Name, X-Uploader-Name",
    ...extra,
  };
}

function sanitizeRoomCode(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 16);
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text || ""));
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function extractYouTubeId(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  const m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/);
  if (m && m[1]) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return "";
}

function parseDurationTextToSec(text) {
  const clean = String(text || "").trim();
  if (!clean || /live|shorts/i.test(clean)) return 0;
  const parts = clean.split(":").map((p) => parseInt(p.trim(), 10)).filter((n) => !Number.isNaN(n));
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

function formatDurationSec(sec) {
  const s = Math.max(0, Math.floor(Number(sec || 0)));
  if (!s) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}

function extractRunsText(obj) {
  if (!obj) return "";
  if (typeof obj.simpleText === "string" && obj.simpleText.trim()) return obj.simpleText.trim();
  if (Array.isArray(obj.runs)) return obj.runs.map((r) => r?.text || "").join("").trim();
  return "";
}

function parseYouTubeSearchPayload(root, maxResults = 12) {
  const results = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || results.length >= maxResults) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (results.length >= maxResults) break;
        walk(item);
      }
      return;
    }
    if (typeof node === "object") {
      if (node.videoRenderer && typeof node.videoRenderer === "object") {
        const vr = node.videoRenderer;
        const vid = String(vr.videoId || "").trim();
        if (vid.length === 11 && !seen.has(vid)) {
          seen.add(vid);
          const title = extractRunsText(vr.title) || "Untitled Video";
          const channelTitle = extractRunsText(vr.ownerText) || extractRunsText(vr.longBylineText) || "YouTube";
          const durationText = extractRunsText(vr.lengthText);
          const durationSec = parseDurationTextToSec(durationText);
          const viewsText = extractRunsText(vr.shortViewCountText) || extractRunsText(vr.viewCountText) || "";
          const thumbs = vr.thumbnail?.thumbnails;
          const thumbUrl = Array.isArray(thumbs) && thumbs.length > 0 && /^https?:\/\//i.test(thumbs[thumbs.length - 1]?.url || "")
            ? thumbs[thumbs.length - 1].url
            : `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
          results.push({
            videoId: vid,
            title,
            channelTitle,
            durationSec,
            durationText: durationText || formatDurationSec(durationSec),
            thumbnailUrl: thumbUrl,
            viewsText,
          });
        }
        return;
      }
      for (const key of Object.keys(node)) {
        if (results.length >= maxResults) break;
        walk(node[key]);
      }
    }
  };
  walk(root);
  return results;
}

function extractYtInitialDataFromHtml(html) {
  const markers = ["var ytInitialData = ", 'window["ytInitialData"] = ', "ytInitialData = "];
  for (const marker of markers) {
    const start = html.indexOf(marker);
    if (start < 0) continue;
    const jsonStart = html.indexOf("{", start + marker.length);
    if (jsonStart < 0) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = jsonStart; i < html.length; i++) {
      const c = html[i];
      if (esc) { esc = false; continue; }
      if (c === "\\" && inStr) { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(html.slice(jsonStart, i + 1)); } catch (_) { return null; }
          }
        }
      }
    }
  }
  return null;
}

async function handleYouTubeSearchApi(request, url) {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  const now = Date.now();
  if (ytSearchRateMap.size > 500) {
    for (const [k, v] of ytSearchRateMap.entries()) {
      if (now - v.windowStart > YT_SEARCH_WINDOW_MS * 2) ytSearchRateMap.delete(k);
    }
  }
  const rate = ytSearchRateMap.get(ip) || { count: 0, windowStart: now };
  if (now - rate.windowStart > YT_SEARCH_WINDOW_MS) {
    rate.count = 0;
    rate.windowStart = now;
  }
  rate.count += 1;
  ytSearchRateMap.set(ip, rate);
  if (rate.count > YT_SEARCH_MAX_PER_MIN) {
    return new Response(JSON.stringify({ ok: false, error: "Too many searches. Please wait a moment.", results: [] }), {
      status: 429,
      headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }),
    });
  }

  const query = String(url.searchParams.get("q") || "").trim().slice(0, 120);
  if (!query) {
    return new Response(JSON.stringify({ ok: true, query: "", results: [] }), {
      status: 200,
      headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }),
    });
  }

  // Fast path: pasted YouTube URL or 11-char ID -> YouTube oEmbed
  const directId = extractYouTubeId(query);
  if (directId) {
    let title = `YouTube Video (${directId})`;
    let channelTitle = "YouTube";
    let thumbnailUrl = `https://i.ytimg.com/vi/${directId}/hqdefault.jpg`;
    try {
      const oRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${directId}`)}&format=json`, {
        headers: { "User-Agent": "Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36" },
      });
      if (oRes.ok) {
        const oJson = await oRes.json();
        if (oJson.title) title = String(oJson.title).slice(0, 160);
        if (oJson.author_name) channelTitle = String(oJson.author_name).slice(0, 80);
        if (oJson.thumbnail_url && /^https?:\/\//i.test(oJson.thumbnail_url)) thumbnailUrl = oJson.thumbnail_url;
      }
    } catch (_) {}
    return new Response(JSON.stringify({
      ok: true,
      query,
      results: [{ videoId: directId, title, channelTitle, durationSec: 0, durationText: "", thumbnailUrl, viewsText: "Direct Link" }],
    }), {
      status: 200,
      headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }),
    });
  }

  let results = [];
  // Primary: YouTube Innertube JSON endpoint (fixed YouTube host, zero SSRF)
  try {
    const ytResp = await fetch("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://www.youtube.com",
        "Referer": "https://www.youtube.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({
        query,
        context: {
          client: { clientName: "WEB", clientVersion: "2.20250501.00.00", hl: "en", gl: "IN" },
        },
      }),
    });
    if (ytResp.ok) {
      const json = await ytResp.json();
      results = parseYouTubeSearchPayload(json, 12);
    }
  } catch (_) {}

  // Fallback: YouTube HTML ytInitialData
  if (results.length === 0) {
    try {
      const htmlResp = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          "Cookie": "CONSENT=YES+cb.20230531-07-p0.en+FX+999",
        },
      });
      if (htmlResp.ok) {
        const html = await htmlResp.text();
        const data = extractYtInitialDataFromHtml(html);
        if (data) results = parseYouTubeSearchPayload(data, 12);
      }
    } catch (_) {}
  }

  return new Response(JSON.stringify({ ok: true, query, results }), {
    status: 200,
    headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=120" }),
  });
}

function extractYouTubePlaylistId(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  const m = s.match(/[?&]list=([A-Za-z0-9_-]{2,80})/);
  if (m && m[1]) return m[1];
  if (/^(PL|UU|OLAK5uy_|FL|LL|WL|RD)[A-Za-z0-9_-]{2,76}$/.test(s)) return s;
  return null;
}

function parseYouTubePlaylistPayload(playlistId, json, maxTracks = 100) {
  let title = "";
  let author = "";
  const tracks = [];
  const seen = new Set();

  if (json?.metadata?.playlistMetadataRenderer?.title) {
    title = String(json.metadata.playlistMetadataRenderer.title).trim();
  }
  const hdr = json?.header?.playlistHeaderRenderer;
  if (hdr) {
    if (!title) title = extractRunsText(hdr.title);
    author = extractRunsText(hdr.ownerText);
  }

  function walk(node) {
    if (!node || tracks.length >= maxTracks) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (tracks.length >= maxTracks) break;
        walk(item);
      }
      return;
    }
    if (typeof node === "object") {
      if (!title) {
        const dyn = node?.pageHeaderViewModel?.title?.dynamicTextViewModel?.text?.content;
        if (dyn) title = String(dyn).trim();
      }
      const pvr = node.playlistVideoRenderer || node.playlistPanelVideoRenderer;
      if (pvr && typeof pvr === "object") {
        const playable = pvr.isPlayable !== false;
        const vid = String(pvr.videoId || "").trim();
        if (playable && /^[A-Za-z0-9_-]{11}$/.test(vid) && !seen.has(vid)) {
          const trackTitle = extractRunsText(pvr.title) || "Untitled Track";
          const low = trackTitle.toLowerCase();
          if (low !== "[deleted video]" && low !== "[private video]") {
            seen.add(vid);
            const ch = extractRunsText(pvr.shortBylineText) || extractRunsText(pvr.longBylineText) || author || "YouTube";
            const durText = pvr.lengthText?.simpleText || extractRunsText(pvr.lengthText) || "";
            const rawSec = Number(pvr.lengthSeconds || 0);
            const durSec = Number.isFinite(rawSec) && rawSec > 0 ? Math.floor(rawSec) : parseDurationTextToSec(durText);
            const thumbs = pvr.thumbnail?.thumbnails;
            const thumb = Array.isArray(thumbs) && thumbs.length > 0 && /^https?:\/\//i.test(thumbs[thumbs.length - 1]?.url || "")
              ? thumbs[thumbs.length - 1].url
              : `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
            tracks.push({
              videoId: vid,
              title: trackTitle.slice(0, 140),
              channelTitle: ch.slice(0, 80),
              durationSec: durSec,
              durationText: durText || formatDurationSec(durSec),
              thumbnailUrl: thumb,
            });
          }
          if (tracks.length >= maxTracks) return;
        }
      }
      for (const k of Object.keys(node)) {
        if (k === "playlistVideoRenderer" || k === "playlistPanelVideoRenderer") continue;
        walk(node[k]);
        if (tracks.length >= maxTracks) break;
      }
    }
  }

  walk(json);
  const totalDurationSec = tracks.reduce((acc, t) => acc + (Number(t.durationSec) || 0), 0);
  return {
    playlistId,
    title: (title || `YouTube Playlist (${tracks.length} tracks)`).slice(0, 140),
    author: (author || tracks[0]?.channelTitle || "YouTube").slice(0, 80),
    totalDurationSec,
    tracks,
  };
}

async function handleYouTubePlaylistApi(request, url) {
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  const now = Date.now();
  const rate = ytSearchRateMap.get(ip) || { count: 0, windowStart: now };
  if (now - rate.windowStart > YT_SEARCH_WINDOW_MS) {
    rate.count = 0;
    rate.windowStart = now;
  }
  rate.count += 1;
  ytSearchRateMap.set(ip, rate);
  if (rate.count > YT_SEARCH_MAX_PER_MIN) {
    return new Response(JSON.stringify({ ok: false, error: "Too many requests. Please wait a moment." }), {
      status: 429,
      headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }),
    });
  }

  const rawList = String(url.searchParams.get("list") || url.searchParams.get("url") || "").trim();
  const playlistId = extractYouTubePlaylistId(rawList);
  if (!playlistId) {
    return new Response(JSON.stringify({ ok: false, error: "Invalid YouTube playlist link or ID." }), {
      status: 400,
      headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }),
    });
  }

  const up = playlistId.toUpperCase();
  if (up === "WL" || up === "LL" || up === "LM") {
    return new Response(JSON.stringify({
      ok: false,
      error: "Watch Later / Liked Videos are private to your account. Create an Unlisted or Public YouTube playlist and share that link!",
    }), { status: 200, headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }) });
  }
  if (up.startsWith("RD")) {
    return new Response(JSON.stringify({
      ok: false,
      error: "YouTube Auto-Mixes (RD) are personalized per account and cannot be shared directly. Save it as an Unlisted or Public playlist on YouTube first.",
    }), { status: 200, headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }) });
  }

  let parsed = null;
  try {
    const browseId = playlistId.startsWith("VL") ? playlistId : `VL${playlistId}`;
    const ytResp = await fetch("https://www.youtube.com/youtubei/v1/browse?prettyPrint=false", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://www.youtube.com",
        "Referer": "https://www.youtube.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({
        browseId,
        context: { client: { clientName: "WEB", clientVersion: "2.20250501.00.00", hl: "en", gl: "IN" } },
      }),
    });
    if (ytResp.ok) {
      const json = await ytResp.json();
      parsed = parseYouTubePlaylistPayload(playlistId, json, 100);
    }
  } catch (_) {}

  if (!parsed || parsed.tracks.length === 0) {
    try {
      const htmlResp = await fetch(`https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          "Cookie": "CONSENT=YES+cb.20230531-07-p0.en+FX+999",
        },
      });
      if (htmlResp.ok) {
        const html = await htmlResp.text();
        const data = extractYtInitialDataFromHtml(html);
        if (data) parsed = parseYouTubePlaylistPayload(playlistId, data, 100);
      }
    } catch (_) {}
  }

  if (!parsed || parsed.tracks.length === 0) {
    return new Response(JSON.stringify({
      ok: false,
      error: "No playable tracks found. If this playlist is Private on YouTube, switch its visibility to Unlisted or Public and try again.",
    }), { status: 200, headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }) });
  }

  return new Response(JSON.stringify({ ok: true, playlist: parsed }), {
    status: 200,
    headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=180" }),
  });
}

export class CrewRoomDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
    this.hostSocket = null;
    this.hostSecretHash = "";
    this.sockets = new Map(); // socket -> sessionMeta
    this.pinFailures = new Map(); // clientIp -> { count, lockedUntil }
    this.aiCooldowns = new Map(); // senderId -> lastTimestamp
    this.bannedUsers = new Map(); // banId -> { id, name, ip, clientId, reason, blockedAtMs }
    this.mutedUsers = new Map(); // muteKey -> { id, name, ip, clientId, mutedUntilMs }
    this.videoRequests = []; // [{ id, videoId, title, channelTitle, durationSec, durationText, thumbnailUrl, requestedById, requestedByName, note, upvotes, upvoterIds, createdAtMs }]
    this.playlistRequests = []; // [{ id, playlistId, title, author, requestedById, requestedByName, note, totalDurationSec, tracks, createdAtMs }]
    this.upNextQueue = []; // [{ id, videoId, title, channelTitle, durationSec, durationText, thumbnailUrl, addedByName, addedAtMs }]
    this.doubtQueue = []; // [{ id, senderId, senderName, positionSec, note, createdAtMs }]
    this.activePoll = null; // { id, question, active, createdAtMs, votes: Map<memberKey, choice> }
    this.lastRosterBroadcastMs = 0;
    this.switchSeq = 0;
    this.lastAutoAdvanceMs = 0;
    this.privacyAlertCooldowns = new Map();
  }

  findBanFor(ip, clientId) {
    for (const entry of this.bannedUsers.values()) {
      if (ip && ip !== "unknown" && entry.ip === ip) return entry;
      if (clientId && entry.clientId && entry.clientId === clientId) return entry;
    }
    return null;
  }

  getMuteFor(meta) {
    const now = Date.now();
    for (const [k, entry] of this.mutedUsers.entries()) {
      if (entry.mutedUntilMs > 0 && entry.mutedUntilMs <= now) {
        this.mutedUsers.delete(k);
        continue;
      }
      if (entry.id === meta.id || (meta.ip && meta.ip !== "unknown" && entry.ip === meta.ip) || (meta.clientId && entry.clientId && entry.clientId === meta.clientId)) {
        return entry;
      }
    }
    return null;
  }

  sendModerationStateToHost() {
    if (!this.hostSocket) return;
    const now = Date.now();
    const muted = [];
    for (const [k, m] of this.mutedUsers.entries()) {
      if (m.mutedUntilMs > 0 && m.mutedUntilMs <= now) {
        this.mutedUsers.delete(k);
        continue;
      }
      muted.push({ id: m.id, name: m.name, mutedUntilMs: m.mutedUntilMs });
    }
    const banned = Array.from(this.bannedUsers.values()).map((b) => ({
      id: b.id,
      name: b.name,
      reason: b.reason,
      blockedAtMs: b.blockedAtMs,
    }));
    this.safeSend(this.hostSocket, { type: "moderation_state", banned, muted });
  }

  serializeRequests() {
    return this.videoRequests.map((r) => ({
      id: r.id,
      videoId: r.videoId,
      title: r.title,
      channelTitle: r.channelTitle,
      durationSec: r.durationSec,
      durationText: r.durationText,
      thumbnailUrl: r.thumbnailUrl,
      requestedById: r.requestedById,
      requestedByName: r.requestedByName,
      note: r.note,
      upvotes: r.upvotes,
      createdAtMs: r.createdAtMs,
    }));
  }

  serializePoll() {
    if (!this.activePoll || !this.activePoll.active) return null;
    let gotIt = 0, confused = 0, tooFast = 0;
    for (const v of this.activePoll.votes.values()) {
      if (v === "gotIt") gotIt++;
      else if (v === "confused") confused++;
      else if (v === "tooFast") tooFast++;
    }
    return {
      id: this.activePoll.id,
      question: this.activePoll.question,
      active: true,
      createdAtMs: this.activePoll.createdAtMs,
      gotIt,
      confused,
      tooFast,
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") {
      return this.handleHttpRequest(request, url);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const clientIp =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Forwarded-For") ||
      "unknown";

    const ban = this.findBanFor(clientIp, "");
    if (ban) {
      this.safeSend(server, { type: "kicked", reason: ban.reason || "Removed from room by Host." });
      try { server.close(4003, "Banned by Host"); } catch (_) {}
      return new Response(null, { status: 101, webSocket: client });
    }

    const sessionId = crypto.randomUUID();
    const meta = {
      id: sessionId,
      clientId: "",
      ip: clientIp,
      role: "pending",
      verified: false,
      name: "Study Peer",
      mode: "synced",
      positionSec: 0,
      syncHealth: "synced",
      driftSec: 0,
      isBuffering: false,
      joinedAtMs: Date.now(),
      lastChatAtMs: 0,
      lastReqAtMs: 0,
      lastReactionAtMs: 0,
      lastDoubtPingMs: 0,
    };
    this.sockets.set(server, meta);

    this.safeSend(server, {
      type: "room_meta",
      roomCode: this.room ? this.room.roomCode : sanitizeRoomCode(url.pathname.split("/").pop()),
      pinRequired: this.room ? this.room.pinRequired : true,
      e2eeEnabled: this.room ? this.room.e2eeEnabled : false,
      hostOnline: Boolean(this.hostSocket),
      roomActive: Boolean(this.room),
      roomLocked: Boolean(this.room && this.room.roomLocked),
      serverNowMs: Date.now(),
    });

    server.addEventListener("message", async (event) => {
      await this.handleSocketMessage(server, meta, event.data);
    });
    server.addEventListener("close", () => this.handleSocketClose(server, meta));
    server.addEventListener("error", () => this.handleSocketClose(server, meta));

    await this.scheduleExpiryAlarm(ROOM_IDLE_TTL_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleHttpRequest(request, url) {
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    const clientIp = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
    if (this.findBanFor(clientIp, "")) {
      return new Response(JSON.stringify({ ok: false, banned: true, error: "Removed from room by Host." }), {
        status: 403,
        headers: corsHeaders({ "Content-Type": "application/json" }),
      });
    }

    if (request.method === "POST" && (path.includes("/api/rooms/") || path.includes("/files"))) {
      if (!this.env.CREW_FILES) {
        return new Response(
          JSON.stringify({ ok: false, error: "R2 bucket binding 'CREW_FILES' not found. Add R2 binding or share Google Drive links." }),
          { status: 503, headers: corsHeaders({ "Content-Type": "application/json" }) }
        );
      }
      if (!this.room) {
        return new Response(
          JSON.stringify({ ok: false, error: "Study room is not active yet. Host must start the room first." }),
          { status: 404, headers: corsHeaders({ "Content-Type": "application/json" }) }
        );
      }

      const hostSec = request.headers.get("X-Host-Secret") || "";
      const isHost = hostSec && (await this.verifyHostSecret(hostSec));
      if (!isHost && this.room.pinRequired) {
        const pin = String(request.headers.get("X-Room-Pin") || "").trim();
        const pinH = await sha256Hex(this.room.roomCode + ":" + pin);
        if (!pinH || pinH.toLowerCase() !== this.room.pinHash.toLowerCase()) {
          return new Response(JSON.stringify({ ok: false, error: "Invalid Room PIN or unauthorized upload." }), {
            status: 401,
            headers: corsHeaders({ "Content-Type": "application/json" }),
          });
        }
      }

      let rawFileName = "study_resource.pdf";
      try { rawFileName = decodeURIComponent(request.headers.get("X-File-Name") || "study_resource.pdf"); }
      catch (_) { rawFileName = request.headers.get("X-File-Name") || "study_resource.pdf"; }
      const cleanMime = request.headers.get("Content-Type") || "application/pdf";
      let uploaderName = "";
      try { uploaderName = decodeURIComponent(request.headers.get("X-Uploader-Name") || ""); }
      catch (_) { uploaderName = request.headers.get("X-Uploader-Name") || ""; }
      if (!uploaderName) uploaderName = isHost ? "Host 🛡️" : "Study Peer";

      const buf = await request.arrayBuffer();
      if (buf.byteLength > 35 * 1024 * 1024) {
        return new Response(JSON.stringify({ ok: false, error: "File exceeds 35MB limit. Use Google Drive link for larger textbooks." }), {
          status: 413,
          headers: corsHeaders({ "Content-Type": "application/json" }),
        });
      }

      const fileId = crypto.randomUUID().slice(0, 8);
      const safeName = rawFileName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const r2Key = `rooms/${this.room.roomCode}/${fileId}/${safeName}`;

      await this.env.CREW_FILES.put(r2Key, buf, {
        httpMetadata: { contentType: cleanMime },
        customMetadata: { uploaderName, originalName: rawFileName },
      });

      const item = {
        id: fileId,
        name: rawFileName,
        size: buf.byteLength,
        type: cleanMime,
        url: `/r/${this.room.roomCode}/files/${fileId}?download=1`,
        viewUrl: `/r/${this.room.roomCode}/files/${fileId}`,
        uploadedAtMs: Date.now(),
        uploaderName,
        isDriveLink: false,
      };
      if (!this.room.resources) this.room.resources = [];
      this.room.resources.push(item);
      if (this.room.resources.length > 50) this.room.resources.shift();
      this.broadcastVerified({ type: "resources_update", resources: this.room.resources });
      return new Response(JSON.stringify({ ok: true, resource: item }), {
        status: 200,
        headers: corsHeaders({ "Content-Type": "application/json" }),
      });
    }

    if (request.method === "GET" && path.includes("/files/")) {
      if (!this.env.CREW_FILES) {
        return new Response("R2 storage not configured", { status: 503, headers: corsHeaders() });
      }
      const parts = path.split("/files/");
      const fileId = (parts[1] || "").split("?")[0].split("/")[0];
      const code = this.room ? this.room.roomCode : sanitizeRoomCode(parts[0].split("/").pop());
      if (!fileId || !code) return new Response("Invalid file path", { status: 400, headers: corsHeaders() });
      const list = await this.env.CREW_FILES.list({ prefix: `rooms/${code}/${fileId}/` });
      if (!list?.objects?.length) return new Response("Resource not found", { status: 404, headers: corsHeaders() });
      const objKey = list.objects[0].key;
      const obj = await this.env.CREW_FILES.get(objKey);
      if (!obj) return new Response("Resource not found", { status: 404, headers: corsHeaders() });
      const fileName = obj.customMetadata?.originalName || objKey.split("/").pop() || "study_resource.pdf";
      const isDownload = url.searchParams.get("download") === "1";
      return new Response(obj.body, {
        headers: corsHeaders({
          "Content-Type": obj.httpMetadata?.contentType || "application/pdf",
          "Content-Disposition": isDownload ? `attachment; filename="${encodeURIComponent(fileName)}"` : `inline; filename="${encodeURIComponent(fileName)}"`,
          "Cache-Control": "public, max-age=3600",
        }),
      });
    }

    if (request.method === "DELETE" && path.includes("/files/")) {
      const hostSec = request.headers.get("X-Host-Secret") || "";
      if (!(await this.verifyHostSecret(hostSec))) {
        return new Response(JSON.stringify({ ok: false, error: "Host authorization required" }), {
          status: 403,
          headers: corsHeaders({ "Content-Type": "application/json" }),
        });
      }
      const parts = path.split("/files/");
      const fileId = (parts[1] || "").split("?")[0].split("/")[0];
      const code = this.room ? this.room.roomCode : sanitizeRoomCode(parts[0].split("/").pop());
      if (this.env.CREW_FILES && fileId && code) {
        try {
          const list = await this.env.CREW_FILES.list({ prefix: `rooms/${code}/${fileId}/` });
          if (list?.objects?.length) await this.env.CREW_FILES.delete(list.objects.map((o) => o.key));
        } catch (_) {}
      }
      if (this.room?.resources) {
        const idx = this.room.resources.findIndex((r) => r.id === fileId);
        if (idx >= 0) {
          this.room.resources.splice(idx, 1);
          this.broadcastVerified({ type: "resources_update", resources: this.room.resources });
        }
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders({ "Content-Type": "application/json" }) });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  }

  async cleanupRoomFiles() {
    if (!this.env.CREW_FILES || !this.room) return;
    try {
      const list = await this.env.CREW_FILES.list({ prefix: `rooms/${this.room.roomCode}/` });
      if (list?.objects?.length) await this.env.CREW_FILES.delete(list.objects.map((o) => o.key));
    } catch (_) {}
  }

  async alarm() {
    if (!this.hostSocket && this.sockets.size === 0) {
      await this.cleanupRoomFiles();
      this.room = null;
      this.hostSecretHash = "";
      return;
    }
    if (!this.hostSocket && this.room && Date.now() - (this.room.lastHostSeenMs || 0) >= HOST_RECONNECT_GRACE_MS) {
      this.broadcastAll({ type: "room_closed", reason: "Host offline timeout reached. Study room closed." });
      for (const sock of this.sockets.keys()) {
        try { sock.close(1000, "Session expired"); } catch (_) {}
      }
      this.sockets.clear();
      await this.cleanupRoomFiles();
      this.room = null;
      this.hostSecretHash = "";
    }
  }

  async scheduleExpiryAlarm(delayMs) {
    try { await this.state.storage.setAlarm(Date.now() + delayMs); } catch (_) {}
  }

  safeSend(ws, obj) {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch (_) {}
  }

  broadcastVerified(obj, excludeSocket = null) {
    const raw = JSON.stringify(obj);
    for (const [sock, meta] of this.sockets.entries()) {
      if (sock === excludeSocket || !meta.verified) continue;
      try { if (sock.readyState === 1) sock.send(raw); } catch (_) {}
    }
  }

  broadcastAll(obj) {
    const raw = JSON.stringify(obj);
    for (const sock of this.sockets.keys()) {
      try { if (sock.readyState === 1) sock.send(raw); } catch (_) {}
    }
  }

  buildRoster() {
    const members = [];
    for (const [, meta] of this.sockets.entries()) {
      if (!meta.verified) continue;
      const muteInfo = meta.role === "host" ? null : this.getMuteFor(meta);
      members.push({
        id: meta.id,
        name: meta.name,
        role: meta.role,
        mode: meta.mode,
        positionSec: meta.positionSec || 0,
        joinedAtMs: meta.joinedAtMs,
        isMuted: Boolean(muteInfo),
        mutedUntilMs: muteInfo ? muteInfo.mutedUntilMs : 0,
        syncHealth: meta.syncHealth || meta.mode || "synced",
        driftSec: Number(meta.driftSec || 0),
        isBuffering: Boolean(meta.isBuffering),
      });
    }
    return members;
  }

  broadcastRoster(force = false) {
    const now = Date.now();
    if (!force && now - this.lastRosterBroadcastMs < 1500) return;
    this.lastRosterBroadcastMs = now;
    this.broadcastVerified({ type: "roster", members: this.buildRoster() });
  }

  async verifyHostSecret(providedSecret) {
    if (!providedSecret || !this.hostSecretHash) return false;
    const providedHash = await sha256Hex(providedSecret);
    return providedHash === this.hostSecretHash;
  }

  async handleSocketMessage(ws, meta, rawData) {
    let msg;
    try { msg = JSON.parse(String(rawData || "{}")); } catch (_) { return; }

    switch (msg.type) {
      case "ping": {
        this.safeSend(ws, { type: "pong", sentAtMs: msg.sentAtMs || Date.now(), serverNowMs: Date.now() });
        return;
      }

      case "room_init": {
        const incomingSecret = String(msg.hostSecret || "");
        if (!incomingSecret) {
          this.safeSend(ws, { type: "error", message: "Missing host authorization secret." });
          return;
        }
        const incomingHash = await sha256Hex(incomingSecret);
        if (this.hostSecretHash && this.hostSecretHash !== incomingHash && this.hostSocket) {
          this.safeSend(ws, { type: "error", message: "Another active host controls this room code." });
          return;
        }

        this.hostSecretHash = incomingHash;
        this.hostSocket = ws;
        meta.role = "host";
        meta.verified = true;
        meta.name = "Host";
        meta.mode = "synced";

        const wasAlreadyInitialized = Boolean(this.room);
        const isHostReconnect = wasAlreadyInitialized && Boolean(msg.isReconnect);
        if (isHostReconnect) {
          // Host reconnected after minimize/network drop: NEVER overwrite live server video/clock/queue!
          this.room.lastHostSeenMs = Date.now();
          this.safeSend(ws, { type: "room_ready", roomCode: this.room.roomCode, reconnected: true });
          this.safeSend(ws, this.buildSnapshotEnvelope(meta));
          this.sendModerationStateToHost();
          this.broadcastVerified({ type: "host_status", online: true, message: "Host reconnected." }, ws);
          this.broadcastRoster(true);
          await this.scheduleExpiryAlarm(ROOM_IDLE_TTL_MS);
          return;
        }

        const prevVideoId = this.room ? this.room.videoId : "";
        const incomingVideoId = String(msg.videoId || "");
        const videoChanged = wasAlreadyInitialized && prevVideoId !== incomingVideoId;
        if (!wasAlreadyInitialized) {
          // Fresh room session: guarantee zero leaked state from any previous room on this code
          this.videoRequests = [];
          this.playlistRequests = [];
          this.upNextQueue = [];
          this.doubtQueue = [];
          this.activePoll = null;
          this.mutedUsers.clear();
          this.bannedUsers.clear();
          this.aiCooldowns.clear();
          this.privacyAlertCooldowns.clear();
          this.switchSeq = 0;
          this.lastAutoAdvanceMs = 0;
        }
        const existingChats = this.room ? this.room.chatHistory : [];
        const incomingChats = Array.isArray(msg.chatHistory) && msg.chatHistory.length > 0 ? msg.chatHistory : existingChats;

        this.room = {
          roomCode: sanitizeRoomCode(msg.roomCode),
          pinRequired: msg.pinRequired !== false,
          pinHash: String(msg.pinHash || ""),
          e2eeEnabled: Boolean(msg.e2eeEnabled && msg.pinRequired !== false),
          hostLeadSync: msg.hostLeadSync !== false,
          allowCrewAi: msg.allowCrewAi !== false,
          allowCrewNotes: msg.allowCrewNotes !== false,
          roomLocked: Boolean(msg.roomLocked ?? (this.room ? this.room.roomLocked : false)),
          chatMutedAll: Boolean(msg.chatMutedAll ?? (this.room ? this.room.chatMutedAll : false)),
          slowModeSec: Number(msg.slowModeSec ?? (this.room ? this.room.slowModeSec : 0)),
          allowVideoRequests: msg.allowVideoRequests !== undefined ? Boolean(msg.allowVideoRequests) : (this.room ? this.room.allowVideoRequests : true),
          allowReactions: msg.allowReactions !== undefined ? Boolean(msg.allowReactions) : (this.room ? this.room.allowReactions : true),
          privacyShieldEnabled: msg.privacyShieldEnabled !== undefined ? Boolean(msg.privacyShieldEnabled) : (this.room ? Boolean(this.room.privacyShieldEnabled) : false),
          autoPlayQueue: msg.autoPlayQueue !== undefined ? Boolean(msg.autoPlayQueue) : (this.room ? (this.room.autoPlayQueue !== false) : true),
          pinnedAnnouncement: String(msg.pinnedAnnouncement ?? (this.room ? this.room.pinnedAnnouncement : "")).slice(0, 240),
          videoId: incomingVideoId,
          youtubeId: String(msg.youtubeId || ""),
          driveVideoUrl: String(msg.driveVideoUrl || ""),
          isLocal: Boolean(msg.isLocal),
          title: String(msg.title || "Live Study Room"),
          channelTitle: String(msg.channelTitle || "ShieldPro Study"),
          durationSec: Number(msg.durationSec || (videoChanged ? 0 : (this.room ? this.room.durationSec : 0))),
          positionSec: Number(msg.positionSec || 0),
          isPlaying: msg.isPlaying !== false,
          speed: Number(msg.speed || 1.0),
          layoutMode: String(msg.layoutMode || (this.room ? this.room.layoutMode : "split")),
          zoomScale: Number(msg.zoomScale ?? (this.room ? this.room.zoomScale : 1.0)),
          panX: Number(msg.panX ?? (this.room ? this.room.panX : 0)),
          panY: Number(msg.panY ?? (this.room ? this.room.panY : 0)),
          isLoopEnabled: Boolean(msg.isLoopEnabled ?? (this.room ? this.room.isLoopEnabled : false)),
          loopPointASec: Number(msg.loopPointASec ?? (this.room ? this.room.loopPointASec : 0)),
          loopPointBSec: Number(msg.loopPointBSec ?? (this.room ? this.room.loopPointBSec : 0)),
          isLaserActive: Boolean(msg.isLaserActive ?? (this.room ? this.room.isLaserActive : false)),
          laserXPercent: Number(msg.laserXPercent ?? (this.room ? this.room.laserXPercent : 50)),
          laserYPercent: Number(msg.laserYPercent ?? (this.room ? this.room.laserYPercent : 50)),
          remoteVolume: Number(msg.volume ?? (this.room ? this.room.remoteVolume : 100)),
          isRemoteMuted: Boolean(msg.muted ?? (this.room ? this.room.isRemoteMuted : false)),
          isPomodoroRunning: Boolean(msg.isPomodoroRunning ?? (this.room ? this.room.isPomodoroRunning : false)),
          pomodoroRemainingSec: Number(msg.pomodoroRemainingSec ?? (this.room ? this.room.pomodoroRemainingSec : 0)),
          pomodoroStartedAtMs: Number(msg.isPomodoroRunning ? Date.now() : (this.room ? (this.room.pomodoroStartedAtMs || 0) : 0)),
          pomodoroPhase: String(msg.pomodoroPhase || (this.room ? this.room.pomodoroPhase : "FOCUS")),
          sentAtMs: Date.now(),
          chapters: Array.isArray(msg.chapters) ? msg.chapters : [],
          notesPayload: msg.notesPayload || null,
          chatHistory: incomingChats.slice(-60),
          resources: Array.isArray(msg.resources) ? msg.resources : (this.room ? (this.room.resources || []) : []),
          lastHostSeenMs: Date.now(),
        };

        this.safeSend(ws, { type: "room_ready", roomCode: this.room.roomCode });
        this.sendModerationStateToHost();
        if (wasAlreadyInitialized) {
          this.broadcastVerified({ type: "host_status", online: true, message: "Host online." }, ws);
        }

        for (const [sock, m] of this.sockets.entries()) {
          if (sock !== ws && !m.verified) {
            this.safeSend(sock, {
              type: "room_meta",
              roomCode: this.room.roomCode,
              pinRequired: this.room.pinRequired,
              e2eeEnabled: this.room.e2eeEnabled,
              hostOnline: true,
              roomActive: true,
              roomLocked: this.room.roomLocked,
              serverNowMs: Date.now(),
            });
          }
        }

        if (wasAlreadyInitialized && videoChanged) {
          this.switchSeq++;
          this.broadcastVerified(this.buildVideoSwitchEnvelope(), ws);
        }
        this.broadcastRoster(true);
        await this.scheduleExpiryAlarm(ROOM_IDLE_TTL_MS);
        return;
      }

      case "join": {
        if (!this.room) {
          this.safeSend(ws, { type: "auth_error", message: "Host has not started this study room yet. Ask the host to launch Cross-City Crew." });
          return;
        }
        meta.clientId = String(msg.clientId || "").trim().slice(0, 64);
        const ban = this.findBanFor(meta.ip, meta.clientId);
        if (ban) {
          this.safeSend(ws, { type: "kicked", reason: ban.reason || "You were removed from this study room by the Host." });
          try { ws.close(4003, "Banned"); } catch (_) {}
          return;
        }
        if (this.room.roomLocked) {
          this.safeSend(ws, { type: "auth_error", message: "This study room is currently locked by the Host." });
          return;
        }

        const now = Date.now();
        const failInfo = this.pinFailures.get(meta.ip) || { count: 0, lockedUntil: 0 };
        if (failInfo.lockedUntil > now) {
          const waitSec = Math.ceil((failInfo.lockedUntil - now) / 1000);
          this.safeSend(ws, { type: "auth_error", locked: true, message: `Too many wrong PIN attempts. Retry in ${waitSec}s.` });
          return;
        }

        if (this.room.pinRequired) {
          const suppliedHash = String(msg.pinHash || "").toLowerCase();
          if (!suppliedHash || suppliedHash !== this.room.pinHash.toLowerCase()) {
            failInfo.count += 1;
            if (failInfo.count >= MAX_PIN_ATTEMPTS) {
              failInfo.lockedUntil = now + PIN_LOCKOUT_MS;
              failInfo.count = 0;
            }
            this.pinFailures.set(meta.ip, failInfo);
            this.safeSend(ws, {
              type: "auth_error",
              locked: failInfo.lockedUntil > now,
              message: failInfo.lockedUntil > now ? "Too many wrong PIN attempts. Wait 30s." : "Incorrect Room PIN. Ask host for the 4-digit PIN.",
            });
            return;
          }
        }

        this.pinFailures.delete(meta.ip);
        meta.role = "viewer";
        meta.verified = true;
        meta.name = String(msg.displayName || "Study Peer").trim().slice(0, 28) || "Study Peer";
        meta.mode = this.room.hostLeadSync ? "synced" : "free";

        const snap = this.buildSnapshotEnvelope(meta);
        this.safeSend(ws, snap);
        this.broadcastRoster(true);
        return;
      }

      case "playback_sync": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const now = Date.now();
        this.room.lastHostSeenMs = now;
        const incomingPos = Math.max(0, Number(msg.positionSec || 0));
        const incomingPlaying = msg.isPlaying !== false;
        const projectedNow = this.getLiveProjectedPosition(now);
        // Lifetime Anti-Zero-Reset Guard: never let a non-forced 0s tick reset an actively playing video!
        if (!msg.forceSeek && incomingPlaying && incomingPos <= 1 && projectedNow >= 3) {
          if (Number(msg.durationSec || 0) > 10) this.room.durationSec = Number(msg.durationSec);
          return;
        }
        this.room.positionSec = incomingPos;
        if (Number(msg.durationSec || 0) > 10) this.room.durationSec = Number(msg.durationSec);
        this.room.isPlaying = incomingPlaying;
        this.room.speed = Number(msg.speed || 1.0);
        this.room.sentAtMs = now;
        if (typeof msg.hostLeadSync === "boolean") this.room.hostLeadSync = msg.hostLeadSync;
        meta.positionSec = Math.floor(this.room.positionSec);

        this.broadcastVerified(
          {
            type: "playback_sync",
            videoId: this.room.videoId,
            positionSec: this.room.positionSec,
            durationSec: this.room.durationSec,
            isPlaying: this.room.isPlaying,
            speed: this.room.speed,
            forceSeek: Boolean(msg.forceSeek),
            sentAtMs: now,
            serverNowMs: now,
            hostLeadSync: this.room.hostLeadSync,
          },
          ws
        );
        return;
      }

      case "sync_pulse": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const now = Date.now();
        this.room.lastHostSeenMs = now;
        const incomingPos = Math.max(0, Number(msg.positionSec || 0));
        const incomingPlaying = msg.isPlaying !== false;
        const projectedNow = this.getLiveProjectedPosition(now);
        // Anti-Zero-Reset guard: if laggingOnly sync pulse sends 0-1s while room is already past 3s, keep projected live clock
        const resolvedPos = (msg.laggingOnly !== false && incomingPlaying && incomingPos <= 1 && projectedNow >= 3)
          ? projectedNow
          : incomingPos;
        this.room.positionSec = resolvedPos;
        if (Number(msg.durationSec || 0) > 10) this.room.durationSec = Number(msg.durationSec);
        this.room.isPlaying = incomingPlaying;
        this.room.speed = Number(msg.speed || 1.0);
        this.room.sentAtMs = now;
        meta.positionSec = Math.floor(this.room.positionSec);

        this.broadcastVerified(
          {
            type: "sync_pulse",
            syncId: msg.syncId || now,
            videoId: this.room.videoId,
            positionSec: this.room.positionSec,
            durationSec: this.room.durationSec,
            isPlaying: this.room.isPlaying,
            speed: this.room.speed,
            laggingOnly: msg.laggingOnly !== false,
            serverNowMs: now,
          },
          ws
        );
        return;
      }

      case "viewer_duration": {
        if (!this.room || !meta.verified) return;
        const dur = Math.floor(Number(msg.durationSec || 0));
        const vid = String(msg.videoId || "");
        // Reject tiny pre-roll ad durations (<=10s) unless current duration is still 0
        if (dur > 10 && (vid === this.room.videoId || vid === this.room.youtubeId)) {
          if (Math.abs((this.room.durationSec || 0) - dur) >= 2) {
            this.room.durationSec = dur;
            if (this.hostSocket) {
              this.safeSend(this.hostSocket, { type: "viewer_duration", videoId: this.room.videoId, durationSec: dur });
            }
            this.broadcastVerified({ type: "duration_sync", videoId: this.room.videoId, durationSec: dur }, this.hostSocket);
          }
        }
        return;
      }

      case "privacy_alert": {
        if (!this.room || !meta.verified || meta.role === "host" || !this.room.privacyShieldEnabled) return;
        const now = Date.now();
        const prev = this.privacyAlertCooldowns.get(meta.id) || 0;
        if (now - prev < 8000) return;
        this.privacyAlertCooldowns.set(meta.id, now);
        const reason = String(msg.reason || "Switched screen or triggered capture shortcut").slice(0, 90);
        if (this.hostSocket) {
          this.safeSend(this.hostSocket, {
            type: "privacy_alert",
            senderId: meta.id,
            senderName: meta.name,
            reason,
            atMs: now,
          });
        }
        return;
      }

      case "host_command": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const now = Date.now();
        this.room.lastHostSeenMs = now;
        // Snapshot live projected clock BEFORE mutating isPlaying/speed/skip so pause/skip NEVER revert to stale anchors!
        const projectedNow = this.getLiveProjectedPosition(now);
        const maxDur = Number(this.room.durationSec || 0);
        if (typeof msg.timestampSec === "number" && msg.timestampSec >= 0) {
          this.room.positionSec = maxDur > 0 ? Math.min(maxDur, msg.timestampSec) : msg.timestampSec;
        } else if (msg.action === "skip" && typeof msg.skipDeltaSec === "number") {
          const nextSkipPos = Math.max(0, projectedNow + msg.skipDeltaSec);
          this.room.positionSec = maxDur > 0 ? Math.min(maxDur, nextSkipPos) : nextSkipPos;
        } else if (msg.action === "pause" || msg.action === "play" || msg.action === "speed") {
          this.room.positionSec = projectedNow;
        }
        if (msg.action === "pause") this.room.isPlaying = false;
        if (msg.action === "play" || msg.action === "seek") this.room.isPlaying = true;
        if (typeof msg.speed === "number" && msg.speed > 0) this.room.speed = msg.speed;
        if (typeof msg.layoutMode === "string" && msg.layoutMode) this.room.layoutMode = msg.layoutMode;
        if (typeof msg.zoomScale === "number") this.room.zoomScale = msg.zoomScale;
        if (typeof msg.panX === "number") this.room.panX = msg.panX;
        if (typeof msg.panY === "number") this.room.panY = msg.panY;
        if (typeof msg.loopEnabled === "boolean") this.room.isLoopEnabled = msg.loopEnabled;
        if (typeof msg.loopStartSec === "number" && msg.loopStartSec >= 0) this.room.loopPointASec = msg.loopStartSec;
        if (typeof msg.loopEndSec === "number" && msg.loopEndSec >= 0) this.room.loopPointBSec = msg.loopEndSec;
        if (typeof msg.laserActive === "boolean") this.room.isLaserActive = msg.laserActive;
        if (typeof msg.laserX === "number") this.room.laserXPercent = msg.laserX;
        if (typeof msg.laserY === "number") this.room.laserYPercent = msg.laserY;
        if (typeof msg.volume === "number") this.room.remoteVolume = msg.volume;
        if (typeof msg.muted === "boolean") this.room.isRemoteMuted = msg.muted;
        if (msg.action === "pomodoro") {
          if (msg.pomodoroAction === "start") {
            this.room.isPomodoroRunning = true;
            this.room.pomodoroRemainingSec = Math.max(1, Number(msg.pomodoroMinutes || 25)) * 60;
            this.room.pomodoroStartedAtMs = now;
            if (msg.pomodoroPhase) this.room.pomodoroPhase = String(msg.pomodoroPhase);
          } else if (msg.pomodoroAction === "pause") {
            const elapsed = this.room.isPomodoroRunning && this.room.pomodoroStartedAtMs
              ? Math.floor((now - this.room.pomodoroStartedAtMs) / 1000) : 0;
            this.room.pomodoroRemainingSec = Math.max(0, (this.room.pomodoroRemainingSec || 0) - elapsed);
            this.room.isPomodoroRunning = false;
            this.room.pomodoroStartedAtMs = 0;
          } else if (msg.pomodoroAction === "reset" || msg.pomodoroAction === "stop") {
            this.room.isPomodoroRunning = false;
            this.room.pomodoroRemainingSec = 0;
            this.room.pomodoroStartedAtMs = 0;
          }
        }
        this.room.sentAtMs = now;

        this.broadcastVerified(
          {
            type: "host_command",
            commandId: msg.commandId || now,
            action: msg.action,
            skipDeltaSec: msg.skipDeltaSec,
            timestampSec: msg.timestampSec,
            resolvedPositionSec: this.room.positionSec,
            serverNowMs: now,
            speed: msg.speed,
            note: msg.note,
            volume: msg.volume,
            muted: msg.muted,
            loopStartSec: msg.loopStartSec,
            loopEndSec: msg.loopEndSec,
            loopEnabled: msg.loopEnabled,
            layoutMode: msg.layoutMode,
            zoomScale: msg.zoomScale,
            panX: msg.panX,
            panY: msg.panY,
            laserActive: msg.laserActive,
            laserX: msg.laserX,
            laserY: msg.laserY,
            pomodoroAction: msg.pomodoroAction,
            pomodoroMinutes: msg.pomodoroMinutes,
            pomodoroPhase: msg.pomodoroPhase,
            captureMode: msg.captureMode,
            sentAtMs: now,
            serverNowMs: now,
          },
          ws
        );
        return;
      }

      case "notes_sync": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        this.room.lastHostSeenMs = Date.now();
        this.room.notesPayload = msg.payload || null;
        this.broadcastVerified({ type: "notes_sync", payload: this.room.notesPayload }, ws);
        return;
      }

      case "note_add": {
        if (!this.room || !meta.verified) return;
        if (meta.role !== "host" && (!this.room.allowCrewNotes || this.getMuteFor(meta))) {
          this.safeSend(ws, { type: "notice", message: "Adding notes is currently restricted." });
          return;
        }
        if (this.hostSocket) {
          this.safeSend(this.hostSocket, { type: "note_add", senderId: meta.id, payload: msg.payload });
        }
        this.broadcastVerified({ type: "note_live_item", payload: msg.payload }, this.hostSocket);
        return;
      }

      case "chat_broadcast": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        this.room.lastHostSeenMs = Date.now();
        if (msg.payload) {
          const wrapped = { ...msg.payload, _senderId: "host", _msgId: msg.payload.id || crypto.randomUUID() };
          this.room.chatHistory.push(wrapped);
          if (this.room.chatHistory.length > 60) this.room.chatHistory.shift();
          this.broadcastVerified({ type: "chat_message", payload: msg.payload, senderId: "host", msgId: wrapped._msgId }, ws);
        }
        return;
      }

      case "chat_post": {
        if (!this.room || !meta.verified || !msg.payload) return;
        if (meta.role !== "host") {
          if (this.room.chatMutedAll) {
            this.safeSend(ws, { type: "notice", message: "Focus Lock active — Host temporarily paused room chat." });
            return;
          }
          const muteInfo = this.getMuteFor(meta);
          if (muteInfo) {
            this.safeSend(ws, { type: "mute_status", isMuted: true, mutedUntilMs: muteInfo.mutedUntilMs });
            this.safeSend(ws, { type: "notice", message: "You are muted from chat by Host." });
            return;
          }
          const now = Date.now();
          if (this.room.slowModeSec > 0 && now - (meta.lastChatAtMs || 0) < this.room.slowModeSec * 1000) {
            const waitSec = Math.ceil((this.room.slowModeSec * 1000 - (now - meta.lastChatAtMs)) / 1000);
            this.safeSend(ws, { type: "notice", message: `Slow mode active — wait ${waitSec}s.` });
            return;
          }
          meta.lastChatAtMs = now;
        }

        if (msg.taggedAi && meta.role !== "host") {
          if (!this.room.allowCrewAi) {
            this.safeSend(ws, { type: "notice", message: "Host has paused remote @AI questions." });
            return;
          }
          const now = Date.now();
          const lastAt = this.aiCooldowns.get(meta.id) || 0;
          if (now - lastAt < AI_VIEWER_COOLDOWN_MS) {
            const waitSec = Math.ceil((AI_VIEWER_COOLDOWN_MS - (now - lastAt)) / 1000);
            this.safeSend(ws, { type: "notice", message: `Please wait ${waitSec}s before another @AI query.` });
            return;
          }
          this.aiCooldowns.set(meta.id, now);
        }

        const msgId = String(msg.msgId || msg.payload.id || crypto.randomUUID());
        const wrapped = { ...msg.payload, _senderId: meta.id, _msgId: msgId };
        this.room.chatHistory.push(wrapped);
        if (this.room.chatHistory.length > 60) this.room.chatHistory.shift();

        if (this.hostSocket && this.hostSocket !== ws) {
          this.safeSend(this.hostSocket, { type: "chat_post", senderId: meta.id, msgId, payload: msg.payload });
        }
        this.broadcastVerified({ type: "chat_message", senderId: meta.id, msgId, payload: msg.payload }, this.hostSocket);
        return;
      }

      case "delete_chat": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const targetId = String(msg.messageId || "");
        if (!targetId) return;
        this.room.chatHistory = (this.room.chatHistory || []).filter((c) => c._msgId !== targetId && c.id !== targetId);
        this.broadcastVerified({ type: "chat_deleted", messageIds: [targetId] });
        return;
      }

      case "typing": {
        if (!this.room || !meta.verified || meta.role === "host") return;
        if (this.room.chatMutedAll || this.getMuteFor(meta)) return;
        this.broadcastVerified({ type: "typing", senderId: meta.id, senderName: meta.name, isTyping: Boolean(msg.isTyping) }, ws);
        return;
      }

      case "reaction": {
        if (!this.room || !meta.verified) return;
        if (meta.role !== "host" && (!this.room.allowReactions || this.room.chatMutedAll || this.getMuteFor(meta))) return;
        const now = Date.now();
        if (now - (meta.lastReactionAtMs || 0) < REACTION_COOLDOWN_MS) return;
        meta.lastReactionAtMs = now;
        const allowed = new Set(["💡", "🔥", "👏", "❓", "🎯", "⚡"]);
        const emoji = allowed.has(msg.emoji) ? msg.emoji : "💡";
        this.broadcastVerified({ type: "reaction", emoji, senderName: meta.name, atMs: now });
        return;
      }

      // ---------------------------------------------------------------------
      // Student Request-to-Play YouTube Queue & Host Approval / Direct Play
      // ---------------------------------------------------------------------
      case "video_request": {
        if (!this.room || !meta.verified) return;
        if (meta.role !== "host") {
          if (!this.room.allowVideoRequests) {
            this.safeSend(ws, { type: "notice", message: "Host has paused student video requests." });
            return;
          }
          if (this.getMuteFor(meta)) {
            this.safeSend(ws, { type: "notice", message: "Muted users cannot request videos." });
            return;
          }
          const now = Date.now();
          if (now - (meta.lastReqAtMs || 0) < VIDEO_REQ_COOLDOWN_MS) {
            const wait = Math.ceil((VIDEO_REQ_COOLDOWN_MS - (now - meta.lastReqAtMs)) / 1000);
            this.safeSend(ws, { type: "notice", message: `Please wait ${wait}s before requesting another video.` });
            return;
          }
          const myPending = this.videoRequests.filter((r) => r.requestedById === meta.id).length;
          if (myPending >= 2) {
            this.safeSend(ws, { type: "notice", message: "You already have 2 pending requests awaiting Host approval." });
            return;
          }
          meta.lastReqAtMs = now;
        }

        const videoId = extractYouTubeId(msg.videoId);
        if (!videoId) {
          this.safeSend(ws, { type: "notice", message: "Invalid YouTube video ID." });
          return;
        }
        if (this.room.youtubeId === videoId || this.room.videoId === videoId) {
          this.safeSend(ws, { type: "notice", message: "This video is already playing right now!" });
          return;
        }
        if (this.upNextQueue.some((q) => q.videoId === videoId)) {
          this.safeSend(ws, { type: "notice", message: "Already approved in the Up-Next Queue!" });
          return;
        }
        const existing = this.videoRequests.find((r) => r.videoId === videoId);
        if (existing) {
          if (!existing.upvoterIds.has(meta.id)) {
            existing.upvoterIds.add(meta.id);
            existing.upvotes = existing.upvoterIds.size;
            this.safeSend(ws, { type: "notice", message: `Upvoted "${existing.title}" (+1) — awaiting Host approval.` });
          } else {
            this.safeSend(ws, { type: "notice", message: "Already requested — awaiting Host approval." });
          }
        } else {
          const durSec = Math.max(0, Math.floor(Number(msg.durationSec || 0)));
          const reqItem = {
            id: `req_${crypto.randomUUID()}`,
            videoId,
            title: String(msg.title || "YouTube Video").trim().slice(0, 160) || "YouTube Video",
            channelTitle: String(msg.channelTitle || "YouTube").trim().slice(0, 80) || "YouTube",
            durationSec: durSec,
            durationText: String(msg.durationText || formatDurationSec(durSec)).slice(0, 16),
            thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            requestedById: meta.id,
            requestedByName: meta.name,
            note: String(msg.note || "").trim().slice(0, 120),
            upvotes: 1,
            upvoterIds: new Set([meta.id]),
            createdAtMs: Date.now(),
          };
          this.videoRequests.push(reqItem);
          if (this.videoRequests.length > 25) this.videoRequests.shift();
          this.safeSend(ws, { type: "notice", message: `Requested "${reqItem.title}" — sent to Host for approval!` });
        }
        this.broadcastVerified({ type: "video_requests_update", requests: this.serializeRequests() });
        return;
      }

      case "approve_video_request": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const idx = this.videoRequests.findIndex((r) => r.id === msg.requestId);
        if (idx < 0) return;
        const [req] = this.videoRequests.splice(idx, 1);
        if (msg.playNow) {
          this.switchSeq++;
          this.room.videoId = req.videoId;
          this.room.youtubeId = req.videoId;
          this.room.driveVideoUrl = "";
          this.room.isLocal = false;
          this.room.title = req.title;
          this.room.channelTitle = req.channelTitle;
          this.room.durationSec = req.durationSec || 0;
          this.room.positionSec = 0;
          this.room.isPlaying = true;
          this.room.sentAtMs = Date.now();
          this.broadcastVerified(this.buildVideoSwitchEnvelope(), ws);
          this.broadcastVerified({ type: "notice", message: `Host approved & started: "${req.title}" (suggested by ${req.requestedByName})` });
        } else {
          if (!this.upNextQueue.some((q) => q.videoId === req.videoId)) {
            this.upNextQueue.push({
              id: `q_${crypto.randomUUID()}`,
              videoId: req.videoId,
              title: req.title,
              channelTitle: req.channelTitle,
              durationSec: req.durationSec,
              durationText: req.durationText,
              thumbnailUrl: req.thumbnailUrl,
              addedByName: `${req.requestedByName} (Approved)`,
              addedAtMs: Date.now(),
            });
          }
          this.broadcastVerified({ type: "queue_update", queue: this.upNextQueue });
          this.broadcastVerified({ type: "notice", message: `Host added "${req.title}" to Up-Next Queue` });
        }
        this.broadcastVerified({ type: "video_requests_update", requests: this.serializeRequests() });
        return;
      }

      case "reject_video_request": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const idx = this.videoRequests.findIndex((r) => r.id === msg.requestId);
        if (idx < 0) return;
        const [req] = this.videoRequests.splice(idx, 1);
        for (const [sock, m] of this.sockets.entries()) {
          if (m.id === req.requestedById) {
            this.safeSend(sock, { type: "notice", message: `Host declined video request: "${req.title}"` });
          }
        }
        this.broadcastVerified({ type: "video_requests_update", requests: this.serializeRequests() });
        return;
      }

      case "play_youtube_direct": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const videoId = extractYouTubeId(msg.videoId);
        if (!videoId) return;
        this.switchSeq++;
        this.room.videoId = videoId;
        this.room.youtubeId = videoId;
        this.room.driveVideoUrl = "";
        this.room.isLocal = false;
        this.room.title = String(msg.title || "YouTube Video").slice(0, 160);
        this.room.channelTitle = String(msg.channelTitle || "YouTube").slice(0, 80);
        this.room.durationSec = Math.max(0, Math.floor(Number(msg.durationSec || 0)));
        this.room.positionSec = 0;
        this.room.isPlaying = true;
        this.room.sentAtMs = Date.now();
        this.broadcastVerified(this.buildVideoSwitchEnvelope(), ws);
        return;
      }

      case "queue_add": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const videoId = extractYouTubeId(msg.videoId);
        if (!videoId) return;
        if (!this.upNextQueue.some((q) => q.videoId === videoId)) {
          this.upNextQueue.push({
            id: `q_${crypto.randomUUID()}`,
            videoId,
            title: String(msg.title || "YouTube Video").slice(0, 160),
            channelTitle: String(msg.channelTitle || "YouTube").slice(0, 80),
            durationSec: Math.max(0, Math.floor(Number(msg.durationSec || 0))),
            durationText: String(msg.durationText || formatDurationSec(msg.durationSec)),
            thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            addedByName: String(msg.addedByName || "Host 🛡️").slice(0, 48),
            addedAtMs: Date.now(),
          });
          this.broadcastVerified({ type: "queue_update", queue: this.upNextQueue });
        }
        return;
      }

      case "queue_remove": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const targetId = String(msg.queueId || "").trim();
        if (!targetId) return;
        // Strict single-item index splice so removing 1 song can NEVER wipe the whole queue!
        const idx = this.upNextQueue.findIndex((q) => q.id === targetId);
        if (idx >= 0) {
          this.upNextQueue.splice(idx, 1);
          this.broadcastVerified({ type: "queue_update", queue: this.upNextQueue });
        }
        return;
      }

      case "queue_reorder": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const targetId = String(msg.queueId || "").trim();
        const dir = String(msg.direction || "");
        const idx = this.upNextQueue.findIndex((q) => q.id === targetId);
        if (idx < 0) return;
        const swapWith = dir === "up" ? idx - 1 : (dir === "down" ? idx + 1 : -1);
        if (swapWith >= 0 && swapWith < this.upNextQueue.length) {
          const tmp = this.upNextQueue[idx];
          this.upNextQueue[idx] = this.upNextQueue[swapWith];
          this.upNextQueue[swapWith] = tmp;
          this.broadcastVerified({ type: "queue_update", queue: this.upNextQueue });
        }
        return;
      }

      case "queue_clear": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        this.upNextQueue = [];
        this.broadcastVerified({ type: "queue_update", queue: this.upNextQueue });
        return;
      }

      case "queue_shuffle": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        for (let i = this.upNextQueue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = this.upNextQueue[i];
          this.upNextQueue[i] = this.upNextQueue[j];
          this.upNextQueue[j] = tmp;
        }
        this.broadcastVerified({ type: "queue_update", queue: this.upNextQueue });
        this.broadcastVerified({ type: "notice", message: "🔀 Up-Next queue shuffled by Host" });
        return;
      }

      case "queue_add_batch": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const rawTracks = Array.isArray(msg.tracks) ? msg.tracks : [];
        const cleanTracks = [];
        const existingVids = new Set(this.upNextQueue.map((q) => q.videoId));
        for (const t of rawTracks) {
          const vid = extractYouTubeId(t.videoId || "");
          if (!vid) continue;
          if (!msg.replaceQueue && existingVids.has(vid)) continue;
          existingVids.add(vid);
          cleanTracks.push({
            id: (crypto.randomUUID ? crypto.randomUUID() : `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
            videoId: vid,
            title: String(t.title || `YouTube (${vid})`).slice(0, 140),
            channelTitle: String(t.channelTitle || "YouTube").slice(0, 80),
            durationSec: Math.max(0, Math.floor(Number(t.durationSec || 0))),
            durationText: String(t.durationText || formatDurationSec(t.durationSec)),
            thumbnailUrl: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
            addedByName: String(msg.addedByName || "Host 🛡️").slice(0, 48),
            addedAtMs: Date.now(),
          });
          if (cleanTracks.length >= 100) break;
        }
        if (cleanTracks.length === 0) return;

        if (msg.replaceQueue) {
          this.upNextQueue = [];
        }
        this.room.autoPlayQueue = true;

        let firstTrack = null;
        if (msg.playFirst) {
          firstTrack = cleanTracks.shift();
        }
        for (const item of cleanTracks) {
          if (this.upNextQueue.length >= 100) break;
          this.upNextQueue.push(item);
        }
        this.broadcastVerified({ type: "queue_update", queue: this.upNextQueue });

        if (firstTrack) {
          this.switchSeq++;
          this.room.videoId = firstTrack.videoId;
          this.room.youtubeId = firstTrack.videoId;
          this.room.driveVideoUrl = "";
          this.room.isLocal = false;
          this.room.title = firstTrack.title;
          this.room.channelTitle = firstTrack.channelTitle;
          this.room.durationSec = firstTrack.durationSec || 0;
          this.room.positionSec = 0;
          this.room.isPlaying = true;
          this.room.sentAtMs = Date.now();
          this.broadcastVerified(this.buildVideoSwitchEnvelope());
          this.broadcastVerified({
            type: "notice",
            message: `🎶 Streaming Playlist (${cleanTracks.length + 1} tracks): "${firstTrack.title}"`,
          });
        } else {
          this.broadcastVerified({
            type: "notice",
            message: `🎶 Host added ${cleanTracks.length} playlist tracks to Up-Next`,
          });
        }
        return;
      }

      case "playlist_request": {
        if (!this.room || !meta.verified) return;
        if (meta.role !== "host") {
          if (!this.room.allowVideoRequests) {
            this.safeSend(ws, { type: "notice", message: "Host has disabled video requests." });
            return;
          }
          if (this.getMuteFor(meta)) {
            this.safeSend(ws, { type: "notice", message: "You are muted and cannot request playlists." });
            return;
          }
          const myPlCount = this.playlistRequests.filter((p) => p.requestedById === meta.id).length;
          if (myPlCount >= 3) {
            this.safeSend(ws, { type: "notice", message: "You already have 3 pending playlist requests." });
            return;
          }
        }
        const playlistId = String(msg.playlistId || "").trim().slice(0, 80);
        const rawTracks = Array.isArray(msg.tracks) ? msg.tracks : [];
        const tracks = [];
        const seen = new Set();
        for (const t of rawTracks) {
          const vid = extractYouTubeId(t.videoId || "");
          if (!vid || seen.has(vid)) continue;
          seen.add(vid);
          tracks.push({
            videoId: vid,
            title: String(t.title || `YouTube (${vid})`).slice(0, 140),
            channelTitle: String(t.channelTitle || "YouTube").slice(0, 80),
            durationSec: Math.max(0, Math.floor(Number(t.durationSec || 0))),
            durationText: String(t.durationText || formatDurationSec(t.durationSec)),
            thumbnailUrl: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          });
          if (tracks.length >= 100) break;
        }
        if (tracks.length === 0) return;
        if (playlistId && this.playlistRequests.some((p) => p.playlistId === playlistId)) {
          this.safeSend(ws, { type: "notice", message: "That playlist is already awaiting Host approval." });
          return;
        }
        const reqItem = {
          id: (crypto.randomUUID ? crypto.randomUUID() : `plr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
          playlistId: playlistId || `custom_${Date.now()}`,
          title: String(msg.title || `YouTube Playlist (${tracks.length} tracks)`).slice(0, 140),
          author: String(msg.author || "YouTube").slice(0, 80),
          requestedById: meta.id,
          requestedByName: meta.name,
          note: String(msg.note || "").trim().slice(0, 120),
          totalDurationSec: tracks.reduce((a, b) => a + (b.durationSec || 0), 0),
          tracks,
          createdAtMs: Date.now(),
        };
        this.playlistRequests.push(reqItem);
        if (this.playlistRequests.length > 10) this.playlistRequests.shift();
        this.broadcastVerified({ type: "playlist_requests_update", playlistRequests: this.playlistRequests });
        this.safeSend(ws, { type: "notice", message: `🎶 Playlist (${tracks.length} tracks) sent to Host for approval!` });
        return;
      }

      case "playlist_approve": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const idx = this.playlistRequests.findIndex((p) => p.id === msg.requestId);
        if (idx < 0) return;
        const [pl] = this.playlistRequests.splice(idx, 1);
        const allowedSet = Array.isArray(msg.selectedVideoIds) && msg.selectedVideoIds.length > 0
          ? new Set(msg.selectedVideoIds.map((v) => String(v)))
          : null;
        const chosen = pl.tracks.filter((t) => !allowedSet || allowedSet.has(t.videoId));
        this.broadcastVerified({ type: "playlist_requests_update", playlistRequests: this.playlistRequests });
        if (chosen.length === 0) return;

        this.room.autoPlayQueue = true;
        const existingVids = new Set(this.upNextQueue.map((q) => q.videoId));
        let playFirst = null;
        if (msg.playNow) {
          playFirst = chosen[0];
        }
        const toQueue = msg.playNow ? chosen.slice(1) : chosen;
        for (const t of toQueue) {
          if (this.upNextQueue.length >= 100) break;
          if (existingVids.has(t.videoId)) continue;
          existingVids.add(t.videoId);
          this.upNextQueue.push({
            id: (crypto.randomUUID ? crypto.randomUUID() : `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
            videoId: t.videoId,
            title: t.title,
            channelTitle: t.channelTitle,
            durationSec: t.durationSec || 0,
            durationText: t.durationText || formatDurationSec(t.durationSec),
            thumbnailUrl: t.thumbnailUrl,
            addedByName: pl.requestedByName,
            addedAtMs: Date.now(),
          });
        }
        this.broadcastVerified({ type: "queue_update", queue: this.upNextQueue });
        if (playFirst) {
          this.switchSeq++;
          this.room.videoId = playFirst.videoId;
          this.room.youtubeId = playFirst.videoId;
          this.room.driveVideoUrl = "";
          this.room.isLocal = false;
          this.room.title = playFirst.title;
          this.room.channelTitle = playFirst.channelTitle;
          this.room.durationSec = playFirst.durationSec || 0;
          this.room.positionSec = 0;
          this.room.isPlaying = true;
          this.room.sentAtMs = Date.now();
          this.broadcastVerified(this.buildVideoSwitchEnvelope());
          this.broadcastVerified({ type: "notice", message: `🎶 Playlist approved (${chosen.length} tracks) — Playing "${playFirst.title}"` });
        } else {
          this.broadcastVerified({ type: "notice", message: `🎶 Host queued playlist "${pl.title}" (${toQueue.length} tracks)` });
        }
        return;
      }

      case "playlist_reject": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const idx = this.playlistRequests.findIndex((p) => p.id === msg.requestId);
        if (idx < 0) return;
        this.playlistRequests.splice(idx, 1);
        this.broadcastVerified({ type: "playlist_requests_update", playlistRequests: this.playlistRequests });
        return;
      }

      case "queue_play_next": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const targetId = String(msg.queueId || "").trim();
        const idx = targetId ? this.upNextQueue.findIndex((q) => q.id === targetId) : 0;
        if (idx < 0 || !this.upNextQueue[idx]) return;
        const [next] = this.upNextQueue.splice(idx, 1);
        this.switchSeq++;
        this.room.videoId = next.videoId;
        this.room.youtubeId = next.videoId;
        this.room.driveVideoUrl = "";
        this.room.isLocal = false;
        this.room.title = next.title;
        this.room.channelTitle = next.channelTitle;
        this.room.durationSec = next.durationSec || 0;
        this.room.positionSec = 0;
        this.room.isPlaying = true;
        this.room.sentAtMs = Date.now();
        this.broadcastVerified({ type: "queue_update", queue: this.upNextQueue });
        this.broadcastVerified(this.buildVideoSwitchEnvelope(), ws);
        this.broadcastVerified({ type: "notice", message: `🎵 Now Playing: "${next.title}"` });
        return;
      }

      case "video_error": {
        // Anti-Stuck Playlist Watchdog: auto-skip restricted / unembeddable YouTube tracks (Error 100/101/150)
        if (!this.room || !meta.verified) return;
        if (this.room.autoPlayQueue === false || this.upNextQueue.length === 0) return;
        const errCode = Number(msg.errorCode || 0);
        if (errCode !== 100 && errCode !== 101 && errCode !== 150) return;
        const failedVid = String(msg.videoId || "").trim();
        if (failedVid && failedVid !== this.room.videoId && failedVid !== this.room.youtubeId) return;
        const now = Date.now();
        if (now - this.lastAutoAdvanceMs < 3500) return;
        this.lastAutoAdvanceMs = now;
        const skippedTitle = this.room.title || "Track";
        const [next] = this.upNextQueue.splice(0, 1);
        if (!next) return;
        this.switchSeq++;
        this.room.videoId = next.videoId;
        this.room.youtubeId = next.videoId;
        this.room.driveVideoUrl = "";
        this.room.isLocal = false;
        this.room.title = next.title;
        this.room.channelTitle = next.channelTitle;
        this.room.durationSec = next.durationSec || 0;
        this.room.positionSec = 0;
        this.room.isPlaying = true;
        this.room.sentAtMs = now;
        this.broadcastVerified({ type: "queue_update", queue: this.upNextQueue });
        this.broadcastVerified(this.buildVideoSwitchEnvelope());
        this.broadcastVerified({ type: "notice", message: `⏭️ Skipped restricted track "${skippedTitle}" → "${next.title}"` });
        return;
      }

      case "video_ended": {
        if (!this.room || !meta.verified) return;
        if (this.room.autoPlayQueue === false || this.upNextQueue.length === 0) return;
        const endedVid = String(msg.videoId || "").trim();
        if (endedVid && endedVid !== this.room.videoId && endedVid !== this.room.youtubeId) return;
        const reportedSeq = Number(msg.switchSeq || 0);
        if (reportedSeq > 0 && reportedSeq !== this.switchSeq) return;
        const now = Date.now();
        // Debounce 4s so simultaneous viewer+host ENDED reports can NEVER double-skip a track!
        if (now - this.lastAutoAdvanceMs < 4000) return;
        // Autonomous Cloud Auto-Advance: trust viewer ENDED if near track end OR Host has been minimized/silent > 8s!
        if (meta.role !== "host") {
          const estPos = this.getLiveProjectedPosition(now);
          const dur = Number(this.room.durationSec || 0);
          const hostQuiet = now - Number(this.room.lastHostSeenMs || 0) > 8000;
          if (dur > 15 && estPos < dur - 12 && !hostQuiet) return;
        }
        this.lastAutoAdvanceMs = now;
        const [next] = this.upNextQueue.splice(0, 1);
        if (!next) return;
        this.switchSeq++;
        this.room.videoId = next.videoId;
        this.room.youtubeId = next.videoId;
        this.room.driveVideoUrl = "";
        this.room.isLocal = false;
        this.room.title = next.title;
        this.room.channelTitle = next.channelTitle;
        this.room.durationSec = next.durationSec || 0;
        this.room.positionSec = 0;
        this.room.isPlaying = true;
        this.room.sentAtMs = now;
        this.broadcastVerified({ type: "queue_update", queue: this.upNextQueue });
        // Broadcast to ALL verified sockets INCLUDING Host so Android Monitor auto-advances in lockstep!
        this.broadcastVerified(this.buildVideoSwitchEnvelope());
        this.broadcastVerified({ type: "notice", message: `🎵 Up Next: "${next.title}"` });
        return;
      }

      // ---------------------------------------------------------------------
      // Host Moderation: Mute Chat Only, Ban Completely, Clear User Messages
      // ---------------------------------------------------------------------
      case "moderate_user": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const action = String(msg.action || "");
        const targetId = String(msg.targetId || "");
        if (!targetId) return;

        let targetSock = null;
        let targetMeta = null;
        for (const [sock, m] of this.sockets.entries()) {
          if (m.id === targetId && m.role !== "host") {
            targetSock = sock;
            targetMeta = m;
            break;
          }
        }

        if (action === "mute" && targetMeta) {
          const durMin = Math.max(0, Math.floor(Number(msg.durationMin || 0)));
          const untilMs = durMin > 0 ? Date.now() + durMin * 60 * 1000 : 0;
          this.mutedUsers.set(targetMeta.id, {
            id: targetMeta.id,
            name: targetMeta.name,
            ip: targetMeta.ip,
            clientId: targetMeta.clientId || "",
            mutedUntilMs: untilMs,
          });
          if (targetSock) {
            this.safeSend(targetSock, { type: "mute_status", isMuted: true, mutedUntilMs: untilMs });
          }
          this.broadcastRoster(true);
          this.sendModerationStateToHost();
        } else if (action === "unmute") {
          this.mutedUsers.delete(targetId);
          for (const [k, m] of this.mutedUsers.entries()) {
            if (m.id === targetId) this.mutedUsers.delete(k);
          }
          if (targetSock) {
            this.safeSend(targetSock, { type: "mute_status", isMuted: false, mutedUntilMs: 0 });
          }
          this.broadcastRoster(true);
          this.sendModerationStateToHost();
        } else if (action === "ban" && targetMeta) {
          const reason = String(msg.reason || "Removed from study room by Host").slice(0, 120);
          this.bannedUsers.set(targetMeta.id, {
            id: targetMeta.id,
            name: targetMeta.name,
            ip: targetMeta.ip,
            clientId: targetMeta.clientId || "",
            reason,
            blockedAtMs: Date.now(),
          });
          // Kick any sockets sharing that session/IP/clientId
          for (const [sock, m] of Array.from(this.sockets.entries())) {
            if (m.role === "host") continue;
            if (m.id === targetMeta.id || (targetMeta.ip !== "unknown" && m.ip === targetMeta.ip) || (targetMeta.clientId && m.clientId === targetMeta.clientId)) {
              this.safeSend(sock, { type: "kicked", reason });
              try { sock.close(4003, "Removed by Host"); } catch (_) {}
              this.sockets.delete(sock);
            }
          }
          this.broadcastRoster(true);
          this.sendModerationStateToHost();
        } else if (action === "unban") {
          this.bannedUsers.delete(targetId);
          this.sendModerationStateToHost();
        } else if (action === "clear_messages") {
          const removedIds = [];
          this.room.chatHistory = (this.room.chatHistory || []).filter((c) => {
            if (c._senderId === targetId) {
              if (c._msgId) removedIds.push(c._msgId);
              if (c.id) removedIds.push(c.id);
              return false;
            }
            return true;
          });
          if (removedIds.length > 0) {
            this.broadcastVerified({ type: "chat_deleted", messageIds: Array.from(new Set(removedIds)) });
          }
        }
        return;
      }

      // ---------------------------------------------------------------------
      // Room Governance, Polls & Structured Doubt Queue
      // ---------------------------------------------------------------------
      case "room_controls": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        if (typeof msg.roomLocked === "boolean") this.room.roomLocked = msg.roomLocked;
        if (typeof msg.chatMutedAll === "boolean") this.room.chatMutedAll = msg.chatMutedAll;
        if (typeof msg.slowModeSec === "number") this.room.slowModeSec = Math.max(0, Math.min(120, Math.floor(msg.slowModeSec)));
        if (typeof msg.allowVideoRequests === "boolean") this.room.allowVideoRequests = msg.allowVideoRequests;
        if (typeof msg.allowReactions === "boolean") this.room.allowReactions = msg.allowReactions;
        if (typeof msg.privacyShieldEnabled === "boolean") this.room.privacyShieldEnabled = msg.privacyShieldEnabled;
        if (typeof msg.autoPlayQueue === "boolean") this.room.autoPlayQueue = msg.autoPlayQueue;
        if (typeof msg.pinnedAnnouncement === "string") this.room.pinnedAnnouncement = msg.pinnedAnnouncement.trim().slice(0, 240);

        this.broadcastVerified({
          type: "room_governance",
          roomLocked: this.room.roomLocked,
          chatMutedAll: this.room.chatMutedAll,
          slowModeSec: this.room.slowModeSec,
          allowVideoRequests: this.room.allowVideoRequests,
          allowReactions: this.room.allowReactions,
          privacyShieldEnabled: Boolean(this.room.privacyShieldEnabled),
          autoPlayQueue: this.room.autoPlayQueue !== false,
          pinnedAnnouncement: this.room.pinnedAnnouncement,
        });
        return;
      }

      case "start_poll": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        this.activePoll = {
          id: String(msg.pollId || `poll_${Date.now()}`),
          question: String(msg.question || "Quick Check: How clear is this concept?").trim().slice(0, 160),
          active: true,
          createdAtMs: Date.now(),
          votes: new Map(),
        };
        this.broadcastVerified({ type: "poll_update", poll: this.serializePoll() });
        return;
      }

      case "poll_vote": {
        if (!this.room || !meta.verified || !this.activePoll || !this.activePoll.active) return;
        const choice = String(msg.choice || "");
        if (!["gotIt", "confused", "tooFast"].includes(choice)) return;
        this.activePoll.votes.set(meta.id, choice);
        this.broadcastVerified({ type: "poll_update", poll: this.serializePoll() });
        return;
      }

      case "close_poll": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        this.activePoll = null;
        this.broadcastVerified({ type: "poll_update", poll: null });
        return;
      }

      case "ai_thinking": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        this.broadcastVerified({ type: "ai_thinking", thinking: Boolean(msg.thinking) }, ws);
        return;
      }

      case "doubt_ping": {
        if (!this.room || !meta.verified) return;
        if (meta.role !== "host" && this.getMuteFor(meta)) return;
        const now = Date.now();
        if (now - (meta.lastDoubtPingMs || 0) < 10000) return;
        meta.lastDoubtPingMs = now;
        const posSec = Math.max(0, Math.floor(Number(msg.positionSec || 0)));
        const note = String(msg.note || "").trim().slice(0, 120);
        const item = { id: `dbt_${now}_${meta.id.slice(0, 6)}`, senderId: meta.id, senderName: meta.name, positionSec: posSec, note, createdAtMs: now };
        this.doubtQueue.push(item);
        if (this.doubtQueue.length > 30) this.doubtQueue.shift();
        const payload = { type: "doubt_ping", senderName: meta.name, positionSec: posSec, note, ts: now };
        if (this.hostSocket) this.safeSend(this.hostSocket, payload);
        this.broadcastVerified(payload, ws);
        this.broadcastVerified({ type: "doubt_queue_update", doubts: this.doubtQueue });
        return;
      }

      case "resolve_doubt": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        this.doubtQueue = this.doubtQueue.filter((d) => d.id !== msg.doubtId);
        this.broadcastVerified({ type: "doubt_queue_update", doubts: this.doubtQueue });
        return;
      }

      case "resource_add": {
        if (!this.room || !meta.verified) return;
        if (meta.role !== "host" && this.getMuteFor(meta)) return;
        const resId = crypto.randomUUID().slice(0, 8);
        let rawUrl = String(msg.url || "").trim();
        if (!/^https?:\/\//i.test(rawUrl)) return;
        let isDrive = Boolean(msg.isDriveLink) || rawUrl.includes("drive.google.com");
        if (isDrive) {
          const match = rawUrl.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/i) ||
            rawUrl.match(/\/d\/([a-zA-Z0-9_-]{10,})/i) ||
            rawUrl.match(/[?&]id=([a-zA-Z0-9_-]{10,})/i);
          if (match && match[1]) {
            rawUrl = `https://drive.google.com/file/d/${match[1]}/preview`;
            isDrive = true;
          }
        }
        const item = {
          id: resId,
          name: String(msg.name || "Study Resource").trim().slice(0, 100),
          size: Number(msg.size || 0),
          type: String(msg.type || (isDrive ? "application/pdf" : "application/octet-stream")),
          url: rawUrl,
          viewUrl: rawUrl,
          uploadedAtMs: Date.now(),
          uploaderName: meta.name || "Crew",
          isDriveLink: isDrive,
        };
        if (!this.room.resources) this.room.resources = [];
        this.room.resources.push(item);
        if (this.room.resources.length > 50) this.room.resources.shift();
        this.broadcastVerified({ type: "resources_update", resources: this.room.resources });
        return;
      }

      case "resource_delete": {
        if (!this.room || !meta.verified) return;
        if (meta.role !== "host" && !(await this.verifyHostSecret(msg.hostSecret))) return;
        const resId = String(msg.resourceId || "");
        if (!resId || !this.room.resources) return;
        const idx = this.room.resources.findIndex((r) => r.id === resId);
        if (idx >= 0) {
          const target = this.room.resources[idx];
          if (!target.isDriveLink && this.env.CREW_FILES) {
            try {
              const list = await this.env.CREW_FILES.list({ prefix: `rooms/${this.room.roomCode}/${target.id}/` });
              if (list?.objects?.length) await this.env.CREW_FILES.delete(list.objects.map((o) => o.key));
            } catch (_) {}
          }
          this.room.resources.splice(idx, 1);
          this.broadcastVerified({ type: "resources_update", resources: this.room.resources });
        }
        return;
      }

      case "resource_focus": {
        if (!this.room || !meta.verified) return;
        const resId = String(msg.resourceId || "");
        const item = (this.room.resources || []).find((r) => r.id === resId);
        if (item) this.broadcastVerified({ type: "resource_focus", resource: item, focusedBy: meta.name });
        return;
      }

      case "viewer_status": {
        if (!meta.verified || meta.role !== "viewer") return;
        meta.mode = msg.mode === "free" ? "free" : "synced";
        if (typeof msg.positionSec === "number") meta.positionSec = Math.max(0, Math.floor(msg.positionSec));
        if (typeof msg.syncHealth === "string") meta.syncHealth = msg.syncHealth.slice(0, 16);
        if (typeof msg.driftSec === "number") meta.driftSec = Math.round(msg.driftSec * 10) / 10;
        if (typeof msg.isBuffering === "boolean") meta.isBuffering = msg.isBuffering;
        this.broadcastRoster(false);
        return;
      }

      case "room_close": {
        if (!(await this.verifyHostSecret(msg.hostSecret))) return;
        this.broadcastAll({ type: "room_closed", reason: "Host ended the study session." });
        for (const sock of this.sockets.keys()) {
          if (sock !== ws) {
            try { sock.close(1000, "Room closed"); } catch (_) {}
          }
        }
        this.sockets.clear();
        this.hostSocket = null;
        await this.cleanupRoomFiles();
        this.room = null;
        this.hostSecretHash = "";
        this.videoRequests = [];
        this.upNextQueue = [];
        this.doubtQueue = [];
        this.activePoll = null;
        this.mutedUsers.clear();
        this.bannedUsers.clear();
        this.aiCooldowns.clear();
        this.privacyAlertCooldowns.clear();
        this.switchSeq = 0;
        return;
      }
    }
  }

  handleSocketClose(ws, meta) {
    this.sockets.delete(ws);
    if (ws === this.hostSocket) {
      this.hostSocket = null;
      if (this.room) {
        this.room.lastHostSeenMs = Date.now();
        this.broadcastVerified({
          type: "host_status",
          online: false,
          message: "Host signal briefly interrupted — room remains active for 15 minutes.",
        });
        this.scheduleExpiryAlarm(HOST_RECONNECT_GRACE_MS);
      }
    } else if (meta.verified) {
      // Immediately clear any active typing indicator for disconnected viewer
      this.broadcastVerified({ type: "typing", senderId: meta.id, senderName: meta.name, isTyping: false });
      this.broadcastRoster(true);
    }
  }

  getLiveProjectedPosition(now = Date.now()) {
    if (!this.room) return 0;
    const base = Number(this.room.positionSec || 0);
    const elapsedSec = this.room.isPlaying && this.room.sentAtMs
      ? Math.max(0, (now - this.room.sentAtMs) / 1000) * Number(this.room.speed || 1)
      : 0;
    const rawPos = Math.max(0, base + elapsedSec);
    const dur = Number(this.room.durationSec || 0);
    const clamped = dur > 0 ? Math.min(dur, rawPos) : rawPos;
    return Math.round(clamped * 10) / 10;
  }

  buildVideoSwitchEnvelope() {
    const now = Date.now();
    return {
      type: "video_switch",
      switchSeq: this.switchSeq,
      videoId: this.room.videoId,
      youtubeId: this.room.youtubeId,
      driveVideoUrl: this.room.driveVideoUrl || "",
      isLocal: Boolean(this.room.isLocal),
      title: this.room.title,
      channelTitle: this.room.channelTitle,
      durationSec: Number(this.room.durationSec || 0),
      positionSec: Number(this.room.positionSec || 0),
      isPlaying: this.room.isPlaying !== false,
      speed: Number(this.room.speed || 1.0),
      upNextQueue: this.upNextQueue,
      sentAtMs: now,
      serverNowMs: now,
    };
  }

  buildSnapshotEnvelope(forMeta = null) {
    const now = Date.now();
    const muteInfo = forMeta && forMeta.role !== "host" ? this.getMuteFor(forMeta) : null;
    const livePos = this.getLiveProjectedPosition(now);

    return {
      type: "room_snapshot",
      switchSeq: this.switchSeq,
      roomCode: this.room.roomCode,
      e2eeEnabled: this.room.e2eeEnabled,
      hostLeadSync: this.room.hostLeadSync,
      allowCrewAi: this.room.allowCrewAi,
      allowCrewNotes: this.room.allowCrewNotes,
      roomLocked: Boolean(this.room.roomLocked),
      chatMutedAll: Boolean(this.room.chatMutedAll),
      slowModeSec: Number(this.room.slowModeSec || 0),
      allowVideoRequests: this.room.allowVideoRequests !== false,
      allowReactions: this.room.allowReactions !== false,
      privacyShieldEnabled: Boolean(this.room.privacyShieldEnabled),
      autoPlayQueue: this.room.autoPlayQueue !== false,
      pinnedAnnouncement: this.room.pinnedAnnouncement || "",
      isSelfMuted: Boolean(muteInfo),
      selfMutedUntilMs: muteInfo ? muteInfo.mutedUntilMs : 0,
      hostOnline: Boolean(this.hostSocket),
      videoId: this.room.videoId,
      youtubeId: this.room.youtubeId,
      driveVideoUrl: this.room.driveVideoUrl,
      isLocal: this.room.isLocal,
      title: this.room.title,
      channelTitle: this.room.channelTitle,
      durationSec: this.room.durationSec,
      positionSec: livePos,
      isPlaying: this.room.isPlaying,
      speed: this.room.speed,
      layoutMode: this.room.layoutMode || "split",
      zoomScale: Number(this.room.zoomScale ?? 1.0),
      panX: Number(this.room.panX ?? 0),
      panY: Number(this.room.panY ?? 0),
      isLoopEnabled: Boolean(this.room.isLoopEnabled),
      loopPointASec: Number(this.room.loopPointASec ?? 0),
      loopPointBSec: Number(this.room.loopPointBSec ?? 0),
      isLaserActive: Boolean(this.room.isLaserActive),
      laserXPercent: Number(this.room.laserXPercent ?? 50),
      laserYPercent: Number(this.room.laserYPercent ?? 50),
      remoteVolume: Number(this.room.remoteVolume ?? 100),
      isRemoteMuted: Boolean(this.room.isRemoteMuted),
      isPomodoroRunning: Boolean(this.room.isPomodoroRunning),
      pomodoroRemainingSec: this.room.isPomodoroRunning && this.room.pomodoroStartedAtMs
        ? Math.max(0, Number(this.room.pomodoroRemainingSec || 0) - Math.floor((now - this.room.pomodoroStartedAtMs) / 1000))
        : Number(this.room.pomodoroRemainingSec || 0),
      pomodoroPhase: this.room.pomodoroPhase || "FOCUS",
      sentAtMs: now,
      serverNowMs: now,
      chapters: this.room.chapters || [],
      notesPayload: this.room.notesPayload || null,
      chatHistory: this.room.chatHistory || [],
      resources: this.room.resources || [],
      videoRequests: this.serializeRequests(),
      playlistRequests: this.playlistRequests,
      upNextQueue: this.upNextQueue,
      doubtQueue: this.doubtQueue,
      activePoll: this.serializePoll(),
    };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (path === "/health") {
      return new Response(
        JSON.stringify({ ok: true, service: "ShieldPro Cloud Crew Relay Studio", version: "2.1.0", timestamp: Date.now() }),
        { status: 200, headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }) }
      );
    }

    if (request.method === "GET" && path === "/api/yt/search") {
      return handleYouTubeSearchApi(request, url);
    }

    if (request.method === "GET" && path === "/api/yt/playlist") {
      return handleYouTubePlaylistApi(request, url);
    }

    if (path.startsWith("/ws/")) {
      const code = sanitizeRoomCode(path.slice(4));
      if (!code) return new Response("Missing room code", { status: 400 });
      const id = env.CREW_ROOMS.idFromName(code);
      return env.CREW_ROOMS.get(id).fetch(request);
    }

    if (path.startsWith("/api/rooms/") || path.includes("/files/")) {
      const match = path.match(/(?:\/api\/rooms\/|\/r\/)([A-Za-z0-9-]+)\/files/);
      if (match && match[1]) {
        const code = sanitizeRoomCode(match[1]);
        const id = env.CREW_ROOMS.idFromName(code);
        return env.CREW_ROOMS.get(id).fetch(request);
      }
    }

    if (path.startsWith("/r/")) {
      const code = sanitizeRoomCode(path.slice(3));
      if (!code) return Response.redirect(url.origin + "/", 302);
      return new Response(renderWebDeskHtml(code), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    if (path === "/" || path === "") {
      return new Response(renderLobbyHtml(), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

function renderLobbyHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover">
<title>ShieldPro Study Studio • Join Room</title>
<style>
  :root { --bg:#07090E; --surface:#10141D; --border:rgba(255,255,255,0.09); --gold:#E6C687; --goldHi:#F7E9C8; --txt:#F3F4F6; --sub:#94A3B8; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:radial-gradient(circle at 20% 0%, rgba(230,198,135,0.12), transparent 48%), var(--bg); color:var(--txt); font-family:Inter,system-ui,-apple-system,sans-serif; min-height:100dvh; display:flex; align-items:center; justify-content:center; padding:24px; }
  .card { width:100%; max-width:420px; background:var(--surface); border:1px solid rgba(230,198,135,0.28); border-radius:24px; padding:32px 26px; text-align:center; box-shadow:0 28px 70px rgba(0,0,0,0.65); }
  .emblem { width:56px; height:56px; border-radius:16px; margin:0 auto 16px; background:linear-gradient(135deg, rgba(230,198,135,0.22), rgba(230,198,135,0.05)); border:1px solid rgba(230,198,135,0.35); display:flex; align-items:center; justify-content:center; color:var(--goldHi); }
  h1 { font-size:20px; font-weight:800; letter-spacing:0.3px; color:var(--goldHi); margin-bottom:8px; }
  p { font-size:13.5px; color:var(--sub); line-height:1.55; margin-bottom:22px; }
  input { width:100%; background:#090C12; border:1px solid var(--border); border-radius:14px; color:var(--goldHi); font-size:19px; font-weight:800; text-align:center; letter-spacing:2.4px; padding:14px; text-transform:uppercase; outline:none; margin-bottom:14px; transition:border-color 0.2s; }
  input:focus { border-color:var(--gold); box-shadow:0 0 0 3px rgba(230,198,135,0.14); }
  button { width:100%; background:linear-gradient(135deg, var(--gold), #CCA55C); color:#120E06; font-weight:800; font-size:14.5px; border:none; border-radius:14px; padding:14px; cursor:pointer; transition:transform 0.12s, filter 0.15s; }
  button:hover { filter:brightness(1.06); }
  button:active { transform:scale(0.985); }
</style>
</head>
<body>
  <div class="card">
    <div class="emblem">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    </div>
    <h1>ShieldPro Study Studio</h1>
    <p>Enter your Host's Study Room Code to join synced lectures, live collaborative notes, YouTube queue, and Mentor Pro AI.</p>
    <input id="codeInput" placeholder="SHLD-XXXX" maxlength="16" autocomplete="off">
    <button onclick="joinRoom()">Enter Study Studio</button>
  </div>
  <script>
    function joinRoom() {
      const val = (document.getElementById('codeInput').value || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
      if (val) window.location.href = '/r/' + encodeURIComponent(val);
    }
    document.getElementById('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  </script>
</body>
</html>`;
}

function renderWebDeskHtml(roomCode) {
  const safeCode = sanitizeRoomCode(roomCode);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content">
<title>ShieldPro Studio • ${safeCode}</title>
<style>
  :root {
    --bg: #07090F;
    --surface: #0E121B;
    --surface2: #151B27;
    --surface3: #1C2333;
    --border: rgba(255,255,255,0.08);
    --borderHi: rgba(230,198,135,0.34);
    --gold: #E6C687;
    --goldHi: #F7E8C3;
    --goldSoft: rgba(230,198,135,0.13);
    --txt: #F3F5F9;
    --sub: #94A3B8;
    --muted: #64748B;
    --green: #34D399;
    --amber: #FBBF24;
    --red: #F87171;
    --violet: #A78BFA;
    --radius: 14px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body {
    height: 100%;
    width: 100%;
    overflow: hidden;
    background: var(--bg);
    color: var(--txt);
    font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  /* Locked Viewport App-Shell (ZERO page scroll jitter & ZERO black gap above mobile keyboard!) */
  .studio-shell {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 100%;
    height: 100dvh;
    width: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: radial-gradient(circle at 12% -10%, rgba(230,198,135,0.08), transparent 42%), var(--bg);
  }

  /* Glassmorphic Top Header */
  .topbar {
    flex-shrink: 0;
    height: 54px;
    padding: 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    background: rgba(14,18,27,0.88);
    backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--border);
    z-index: 30;
  }
  .brand-group { display:flex; align-items:center; gap:10px; min-width:0; flex:1; }
  .brand-mark {
    width: 32px; height: 32px; border-radius: 10px; flex-shrink: 0;
    background: linear-gradient(135deg, rgba(230,198,135,0.22), rgba(230,198,135,0.06));
    border: 1px solid var(--borderHi); color: var(--goldHi);
    display:flex; align-items:center; justify-content:center;
  }
  .title-block { min-width:0; flex:1; overflow:hidden; }
  .room-title { font-size: 13.5px; font-weight: 700; color: var(--txt); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .room-sub {
    display:flex; align-items:center; gap:6px; font-size: 11px; color: var(--sub); margin-top: 1px;
    flex-wrap: nowrap; white-space: nowrap; overflow: hidden;
  }
  .room-sub #channelMeta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .code-tag { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; color: var(--gold); letter-spacing: 0.4px; flex-shrink: 0; }

  .header-actions { display:flex; align-items:center; gap:6px; flex-shrink:0; }
  .pill {
    display:inline-flex; align-items:center; gap:5px; padding: 5px 10px; border-radius: 999px;
    font-size: 11.5px; font-weight: 700; border: 1px solid var(--border);
    background: var(--surface2); color: var(--txt); cursor: pointer; white-space: nowrap;
    transition: background 0.15s, border-color 0.15s;
  }
  .pill:hover { border-color: rgba(255,255,255,0.2); }
  .pill .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex-shrink:0; }
  .pill.sync-ok { border-color: rgba(52,211,153,0.3); color: #A7F3D0; background: rgba(52,211,153,0.1); }
  .pill.sync-warn { border-color: rgba(251,191,36,0.45); color: #FDE68A; background: rgba(251,191,36,0.14); }
  .pill.sync-warn .dot { background: var(--amber); }
  .pill.sync-free { border-color: rgba(167,139,250,0.4); color: #DDD6FE; background: rgba(167,139,250,0.12); }
  .pill.sync-free .dot { background: var(--violet); }
  .pill.pomo-pill { border-color: rgba(230,198,135,0.45); color: var(--goldHi); background: var(--goldSoft); display:none; }
  .pill.pomo-pill.show { display:inline-flex; }
  .icon-btn {
    width: 34px; height: 34px; border-radius: 10px; border: 1px solid var(--border);
    background: var(--surface2); color: var(--sub); cursor: pointer;
    display:inline-flex; align-items:center; justify-content:center;
    transition: all 0.15s;
  }
  .icon-btn:hover { color: var(--goldHi); border-color: var(--borderHi); background: var(--surface3); }
  .icon-btn.active { color: var(--goldHi); border-color: var(--gold); background: var(--goldSoft); }

  /* Main Workspace Split */
  .workspace {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 416px;
    overflow: hidden;
  }
  .workspace.cinema { grid-template-columns: minmax(0, 1fr) 0px; }
  .workspace.cinema .side-panel { display: none; }

  /* Left Stage Column */
  .stage-col {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: #04060A;
    border-right: 1px solid var(--border);
    position: relative;
  }
  .video-stage {
    flex: 1;
    min-height: 0;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #000;
    overflow: hidden;
  }
  .video-zoom-wrap {
    width: 100%; height: 100%; position: relative;
    transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  #ytPlayerMount, #driveFrame {
    width: 100%; height: 100%; border: none; display: block;
  }
  .stage-placeholder {
    position: absolute; inset: 0; display:flex; flex-direction:column; align-items:center; justify-content:center;
    text-align:center; padding: 24px; color: var(--sub); gap: 10px;
    background: radial-gradient(circle at center, #111827, #05070C);
  }
  .laser-dot {
    position:absolute; width:18px; height:18px; border-radius:50%;
    background: radial-gradient(circle, #FFF 0%, #FF3B30 45%, rgba(255,59,48,0) 75%);
    box-shadow: 0 0 18px 6px rgba(255,59,48,0.65);
    pointer-events:none; transform: translate(-50%, -50%); display:none; z-index: 25;
  }
  .blackout-cover {
    position:absolute; inset:0; background:#030406; z-index: 26;
    display:none; flex-direction:column; align-items:center; justify-content:center; gap:8px; color:var(--goldHi);
  }
  .blackout-cover.show { display:flex; }

  /* Floating Reactions Layer (quiet bottom-right of video) */
  .reaction-layer {
    position:absolute; right: 16px; bottom: 16px; width: 90px; height: 180px;
    pointer-events: none; overflow: hidden; z-index: 22;
  }
  .float-react {
    position: absolute; bottom: 0; font-size: 22px; opacity: 0;
    animation: floatUp 2.1s ease-out forwards;
    filter: drop-shadow(0 3px 8px rgba(0,0,0,0.6));
  }
  @keyframes floatUp {
    0% { transform: translateY(0) scale(0.7); opacity: 0; }
    15% { opacity: 1; transform: translateY(-18px) scale(1.1); }
    100% { transform: translateY(-150px) scale(0.95); opacity: 0; }
  }

  /* Pinned Resource Overlay */
  .resource-overlay {
    position:absolute; inset: 12px; background: rgba(11,15,23,0.97);
    border: 1px solid var(--borderHi); border-radius: 16px; z-index: 28;
    display:none; flex-direction:column; overflow:hidden; box-shadow: 0 24px 60px rgba(0,0,0,0.8);
  }
  .resource-overlay.show { display:flex; }
  .resource-overlay-head {
    padding: 10px 14px; display:flex; align-items:center; justify-content:space-between; gap:10px;
    background: var(--surface2); border-bottom: 1px solid var(--border); font-size: 13px; font-weight: 700;
  }
  .resource-overlay iframe { flex:1; width:100%; border:none; background:#fff; }

  /* Sleek Unified Stage Control Dock */
  .stage-dock {
    flex-shrink: 0;
    padding: 8px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .stage-dock::-webkit-scrollbar { display: none; }
  .dock-group { display:flex; align-items:center; gap:6px; flex-shrink:0; }
  .dock-btn {
    display:inline-flex; align-items:center; gap:6px; padding: 6px 11px; border-radius: 10px;
    border: 1px solid var(--border); background: var(--surface2); color: var(--txt);
    font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
    transition: all 0.15s;
  }
  .dock-btn:hover { border-color: var(--borderHi); color: var(--goldHi); }
  .dock-btn.gold { background: var(--goldSoft); border-color: var(--borderHi); color: var(--goldHi); }
  .dock-btn.active { background: rgba(167,139,250,0.16); border-color: rgba(167,139,250,0.45); color: #DDD6FE; }
  .react-mini {
    width: 30px; height: 30px; border-radius: 9px; border: 1px solid var(--border);
    background: var(--surface2); cursor:pointer; font-size: 14px;
    display:inline-flex; align-items:center; justify-content:center; transition: transform 0.12s;
  }
  .react-mini:hover { transform: translateY(-1px); border-color: var(--borderHi); }
  .time-readout { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--sub); padding: 0 6px; white-space: nowrap; }

  /* Right Study Panel (STRICT LOCKED FLEX COLUMN -> ZERO CHAT JITTER!) */
  .side-panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    background: var(--surface);
    overflow: hidden;
  }

  /* 5 Clean Tabs */
  .tab-bar {
    flex-shrink: 0;
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 4px;
    padding: 8px 10px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .tab-btn {
    position: relative;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
    padding: 7px 4px; border-radius: 10px; border: 1px solid transparent;
    background: transparent; color: var(--sub); font-size: 10.5px; font-weight: 700;
    cursor: pointer; transition: all 0.15s;
  }
  .tab-btn:hover { color: var(--txt); background: rgba(255,255,255,0.03); }
  .tab-btn.active { background: var(--goldSoft); border-color: var(--borderHi); color: var(--goldHi); }
  .tab-badge {
    position:absolute; top: 3px; right: 5px; min-width: 16px; height: 16px; padding: 0 4px;
    border-radius: 999px; background: var(--gold); color: #120E06; font-size: 9.5px; font-weight: 800;
    display:none; align-items:center; justify-content:center;
  }
  .tab-badge.show { display:inline-flex; }

  /* Pinned Announcement & Live Poll Banners (flex-shrink: 0) */
  .pinned-banner {
    flex-shrink: 0; display:none; align-items:center; gap:8px; padding: 8px 12px;
    background: linear-gradient(90deg, rgba(230,198,135,0.16), rgba(230,198,135,0.05));
    border-bottom: 1px solid rgba(230,198,135,0.28); font-size: 12px; color: var(--goldHi); line-height: 1.4;
  }
  .pinned-banner.show { display:flex; }

  .poll-card {
    flex-shrink: 0; display:none; flex-direction:column; gap:8px; padding: 10px 12px;
    background: rgba(167,139,250,0.09); border-bottom: 1px solid rgba(167,139,250,0.28);
  }
  .poll-card.show { display:flex; }
  .poll-q { font-size: 12.5px; font-weight: 700; color: #EDE9FE; }
  .poll-opts { display:grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .poll-btn {
    padding: 7px 6px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12);
    background: var(--surface2); color: var(--txt); font-size: 11px; font-weight: 700;
    cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:2px;
  }
  .poll-btn.voted { border-color: var(--gold); background: var(--goldSoft); color: var(--goldHi); }
  .poll-cnt { font-size: 10px; color: var(--sub); }

  /* Tab Panes */
  .tab-pane {
    flex: 1;
    min-height: 0;
    display: none;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }
  .tab-pane.active { display: flex; }

  /* Independent Scrollable Chat Container (overflow-anchor:none prevents scroll jumping!) */
  .scroll-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overflow-anchor: none;
    overscroll-behavior: contain;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .scroll-body::-webkit-scrollbar { width: 5px; }
  .scroll-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 99px; }

  /* Chat Bubbles */
  .msg-card {
    padding: 9px 12px; border-radius: 14px; background: var(--surface2);
    border: 1px solid var(--border); font-size: 13px; line-height: 1.5;
    word-break: break-word; max-width: 96%;
  }
  .msg-card.self { align-self: flex-end; background: rgba(230,198,135,0.12); border-color: rgba(230,198,135,0.3); }
  .msg-card.ai {
    align-self: stretch; max-width: 100%;
    background: #FBF9F4; color: #16181D; border: 1px solid rgba(230,198,135,0.68);
    box-shadow: 0 8px 24px rgba(0,0,0,0.24);
    font-family: "Inter", "Roboto", -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    padding: 12px 13px;
  }
  .msg-card.ai .msg-sender { color: #8A5A10; font-size: 11.5px; letter-spacing: 0.2px; }
  .msg-card.ai .msg-time { color: #64748B; }
  .msg-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom: 5px; }
  .msg-sender { font-size: 11px; font-weight: 800; color: var(--gold); }
  .msg-time { font-size: 10px; color: var(--muted); }
  .msg-body { white-space: pre-wrap; }
  .msg-card.ai .msg-body { white-space: normal; display: flex; flex-direction: column; gap: 7px; font-size: 13.2px; line-height: 1.56; color: #1E2430; }

  /* Elite Editorial AI Markdown & Dual-Mode Responsive Tables */
  .ai-h {
    font-size: 14px; font-weight: 800; color: #0F172A; margin-top: 4px; padding-bottom: 4px;
    border-bottom: 1.5px solid rgba(180,136,54,0.32); letter-spacing: -0.1px;
  }
  .ai-p { margin: 0; color: #1E293B; }
  .ai-p strong, .ai-li strong, .ai-td strong, .ai-rc-val strong { color: #0B1220; font-weight: 800; }
  .ai-em { color: #0F766E; font-style: italic; font-weight: 600; }
  .ai-code-inline {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
    background: #EFECE3; color: #7C2D12; padding: 1px 5px; border-radius: 5px; border: 1px solid #DFD7C4;
  }
  .ai-code-wrap { border-radius: 10px; overflow: hidden; border: 1px solid #D5D9E2; background: #0F172A; }
  .ai-code-lang { padding: 4px 10px; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.6px; background: #1E293B; color: #E6C687; }
  .ai-code-pre { padding: 10px 11px; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.5; color: #E2E8F0; margin: 0; }
  .ai-formula {
    padding: 9px 11px; border-radius: 9px; background: #F4EFE3; border: 1px solid #DECFA8;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 700; color: #7C2D12; overflow-x: auto;
  }
  .ai-quote {
    padding: 8px 11px; border-radius: 9px; background: #ECFDF5; border-left: 3px solid #0F766E;
    color: #134E4A; font-size: 12.6px;
  }
  .ai-li { display: flex; gap: 7px; align-items: flex-start; }
  .ai-li.depth-1 { padding-left: 14px; }
  .ai-li-dot { color: #0F766E; font-weight: 900; flex-shrink: 0; }
  .ai-li-num {
    min-width: 19px; height: 19px; border-radius: 6px; background: #0F766E; color: #fff;
    font-size: 10.5px; font-weight: 800; display:inline-flex; align-items:center; justify-content:center; flex-shrink: 0; margin-top: 2px;
  }
  .ai-hr { border: none; border-top: 1px solid #E2DCCB; margin: 3px 0; }
  .ai-ts-chip {
    display: inline-flex; align-items: center; gap: 3px; padding: 1px 7px; border-radius: 999px;
    background: #E6F7F4; border: 1px solid #99F6E4; color: #0F766E;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 800; cursor: pointer;
  }
  .ai-ts-chip:hover { background: #CCFBF1; }

  /* Dual-Mode Comparison Matrix (Cards on Small Phones + Sticky Table on Tablets/Desktops) */
  .ai-tbl-block {
    border: 1px solid #DFD6C0; border-radius: 12px; background: #FFFFFF; overflow: hidden;
    box-shadow: 0 2px 10px rgba(15,23,42,0.05); margin: 3px 0;
  }
  .ai-tbl-toolbar {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
    padding: 6px 9px; background: #F5F0E3; border-bottom: 1px solid #E5DCC6;
  }
  .ai-tbl-label { font-size: 10.5px; font-weight: 800; color: #785111; letter-spacing: 0.25px; text-transform: uppercase; }
  .ai-tbl-actions { display: flex; align-items: center; gap: 5px; }
  .ai-tbl-btn {
    padding: 3px 8px; border-radius: 7px; border: 1px solid #D4C5A1; background: #FFFDF8;
    color: #334155; font-size: 10.5px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
  }
  .ai-tbl-btn:hover { background: #EFE6D1; color: #0F172A; }

  /* Table Mode (Sticky Header + Sticky First Column + Smooth Swipe) */
  .ai-tbl-scroll { display: none; overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; }
  .ai-tbl-block.mode-table .ai-tbl-scroll { display: block; }
  .ai-tbl { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; line-height: 1.45; }
  .ai-tbl th {
    background: #1B2230; color: #F7E8C3; font-weight: 800; text-align: left;
    padding: 8px 10px; border-bottom: 1.5px solid #D4B46A; white-space: nowrap; font-size: 11.5px;
  }
  .ai-tbl td {
    padding: 8px 10px; border-bottom: 1px solid #E8E4D9; color: #1E293B; vertical-align: top; min-width: 120px;
  }
  .ai-tbl tbody tr:nth-child(even) td { background: #FAF8F2; }
  .ai-tbl tbody tr:last-child td { border-bottom: none; }
  .ai-tbl th:first-child, .ai-tbl td:first-child {
    position: sticky; left: 0; z-index: 2; font-weight: 800; min-width: 112px; max-width: 155px;
    border-right: 1px solid #E2D9C4;
  }
  .ai-tbl th:first-child { z-index: 3; background: #141925; }
  .ai-tbl td:first-child { background: #F7F3E9; color: #0F172A; }
  .ai-tbl tbody tr:nth-child(even) td:first-child { background: #F1ECE0; }

  /* Card Mode (Default on Small Smartphones <640px — ZERO Squished Columns!) */
  .ai-tbl-cards { display: none; padding: 8px; flex-direction: column; gap: 8px; background: #FAF7F0; }
  .ai-tbl-block.mode-cards .ai-tbl-cards { display: flex; }
  .ai-rc-card {
    background: #FFFFFF; border: 1px solid #E5DEC9; border-radius: 10px; overflow: hidden;
    box-shadow: 0 1px 4px rgba(15,23,42,0.04);
  }
  .ai-rc-head {
    padding: 7px 10px; background: #1B2230; color: #F7E8C3;
    font-size: 12px; font-weight: 800; letter-spacing: 0.1px;
  }
  .ai-rc-body { display: flex; flex-direction: column; }
  .ai-rc-row {
    padding: 7px 10px; border-bottom: 1px solid #EFEAE0; display: flex; flex-direction: column; gap: 2px;
  }
  .ai-rc-row:last-child { border-bottom: none; }
  .ai-rc-key { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.4px; color: #8A5A10; }
  .ai-rc-val { font-size: 12.4px; line-height: 1.48; color: #1E293B; }

  /* AI Card Footer Actions */
  .ai-card-foot {
    display: flex; align-items: center; justify-content: flex-end; gap: 6px;
    margin-top: 8px; padding-top: 7px; border-top: 1px solid #EAE2D0;
  }
  .ai-foot-btn {
    padding: 4px 9px; border-radius: 8px; border: 1px solid #D5CCB8; background: #FFFFFF;
    color: #334155; font-size: 11px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
  }
  .ai-foot-btn:hover { background: #F1E9D6; color: #0F172A; }

  /* Fullscreen Table Inspector Modal */
  .tbl-modal {
    position: fixed; inset: 0; z-index: 120; background: rgba(7,9,15,0.92); backdrop-filter: blur(12px);
    display: none; flex-direction: column; padding: 14px;
  }
  .tbl-modal.show { display: flex; }
  .tbl-modal-card {
    flex: 1; min-height: 0; display: flex; flex-direction: column; background: #FBF9F4;
    border: 1.5px solid var(--gold); border-radius: 16px; overflow: hidden;
  }
  .tbl-modal-head {
    flex-shrink: 0; padding: 10px 14px; background: #141925; color: #F7E8C3;
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
  }
  .tbl-modal-body { flex: 1; min-height: 0; overflow: auto; -webkit-overflow-scrolling: touch; padding: 12px; }
  .tbl-modal-body .ai-tbl-scroll { display: block !important; }
  .tbl-modal-body .ai-tbl-cards { display: none !important; }
  .tbl-modal-body .ai-tbl-toolbar { display: none !important; }

  .msg-slide {
    margin-top: 8px; width: 100%; aspect-ratio: 16 / 9; object-fit: cover;
    border-radius: 10px; border: 1px solid var(--border); background: #0B0E14; display:block;
  }

  .new-msg-pill {
    position: absolute; left: 50%; bottom: 72px; transform: translateX(-50%);
    background: var(--gold); color: #120E06; font-size: 11.5px; font-weight: 800;
    padding: 6px 14px; border-radius: 999px; border: none; cursor: pointer;
    box-shadow: 0 8px 24px rgba(0,0,0,0.55); display:none; z-index: 15;
  }
  .new-msg-pill.show { display:inline-flex; align-items:center; gap:5px; }

  .typing-bar {
    flex-shrink: 0; min-height: 20px; padding: 2px 14px; font-size: 11px; color: var(--gold);
    display:none; align-items:center; gap:6px; background: rgba(14,18,27,0.9);
  }
  .typing-bar.show { display:flex; }

  /* Fixed-Bottom Zero-Jitter Composer */
  .composer-wrap {
    flex-shrink: 0;
    padding: 10px 10px calc(10px + env(safe-area-inset-bottom));
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  .mute-lock-banner {
    display:none; align-items:center; justify-content:center; gap:8px;
    padding: 11px 14px; border-radius: 12px;
    background: rgba(248,113,113,0.12); border: 1px solid rgba(248,113,113,0.35);
    color: #FECACA; font-size: 12.5px; font-weight: 700; text-align:center;
  }
  .mute-lock-banner.show { display:flex; }
  .composer-row {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 6px 6px 6px 10px;
    transition: border-color 0.15s;
  }
  .composer-row:focus-within { border-color: var(--gold); }
  .ai-toggle-pill {
    flex-shrink: 0; height: 34px; padding: 0 9px; border-radius: 10px;
    border: 1px solid var(--border); background: var(--surface3); color: var(--sub);
    font-size: 11.5px; font-weight: 800; cursor: pointer;
    display:inline-flex; align-items:center; gap:4px;
  }
  .ai-toggle-pill.active { background: var(--goldSoft); border-color: var(--gold); color: var(--goldHi); }
  .chat-input {
    flex: 1; min-width: 0; max-height: 92px; min-height: 34px; resize: none;
    background: transparent; border: none; outline: none; color: var(--txt);
    font-family: inherit; font-size: 13.5px; line-height: 1.4; padding: 7px 4px;
  }
  .send-btn {
    flex-shrink: 0; width: 38px; height: 36px; border-radius: 11px; border: none;
    background: linear-gradient(135deg, var(--gold), #C9A052); color: #120E06;
    cursor: pointer; display:inline-flex; align-items:center; justify-content:center;
    transition: transform 0.12s;
  }
  .send-btn:active { transform: scale(0.94); }

  /* Search & Queue Tab */
  .search-bar-box {
    flex-shrink: 0; padding: 10px 12px; border-bottom: 1px solid var(--border);
    display:flex; flex-direction:column; gap:8px; background: var(--surface);
  }
  .search-row { display:flex; gap:6px; }
  .studio-input {
    flex: 1; min-width: 0; background: var(--surface2); border: 1px solid var(--border);
    border-radius: 11px; color: var(--txt); font-size: 13px; padding: 9px 12px; outline: none;
  }
  .studio-input:focus { border-color: var(--gold); }
  .gold-btn {
    padding: 0 14px; border-radius: 11px; border: none; font-weight: 800; font-size: 12.5px;
    background: linear-gradient(135deg, var(--gold), #CAA255); color: #120E06; cursor: pointer;
    white-space: nowrap;
  }
  .section-label {
    font-size: 10.5px; font-weight: 800; letter-spacing: 0.7px; text-transform: uppercase;
    color: var(--gold); margin: 4px 0 2px; display:flex; align-items:center; justify-content:space-between;
  }
  .yt-card {
    display:flex; gap: 10px; padding: 9px; border-radius: 13px;
    background: var(--surface2); border: 1px solid var(--border); align-items: center;
  }
  .yt-thumb-wrap { position:relative; width: 96px; aspect-ratio: 16/9; flex-shrink:0; border-radius: 8px; overflow:hidden; background:#000; }
  .yt-thumb-wrap img { width:100%; height:100%; object-fit:cover; display:block; }
  .yt-dur {
    position:absolute; right:4px; bottom:4px; background:rgba(0,0,0,0.82); color:#fff;
    font-size: 9.5px; font-weight: 700; padding: 1px 5px; border-radius: 4px;
  }
  .yt-meta { flex:1; min-width:0; }
  .yt-title { font-size: 12.5px; font-weight: 700; color: var(--txt); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; line-height:1.3; }
  .yt-sub { font-size: 11px; color: var(--sub); margin-top: 3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .yt-req-btn {
    margin-top: 6px; padding: 5px 10px; border-radius: 8px; border: 1px solid var(--borderHi);
    background: var(--goldSoft); color: var(--goldHi); font-size: 11px; font-weight: 700; cursor:pointer;
  }
  .yt-req-btn:hover { background: var(--gold); color: #120E06; }

  /* Generic Item Cards (Notes, Files, Crew, Doubts) */
  .list-card {
    padding: 10px 12px; border-radius: 12px; background: var(--surface2);
    border: 1px solid var(--border); display:flex; flex-direction:column; gap:4px;
  }
  .list-card-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .badge-mini {
    font-size: 10px; font-weight: 800; padding: 2px 7px; border-radius: 999px;
    background: var(--surface3); color: var(--sub); border: 1px solid var(--border);
  }
  .badge-mini.ok { background: rgba(52,211,153,0.14); color: #6EE7B7; border-color: rgba(52,211,153,0.35); }
  .badge-mini.warn { background: rgba(251,191,36,0.14); color: #FDE68A; border-color: rgba(251,191,36,0.35); }
  .badge-mini.bad { background: rgba(248,113,113,0.14); color: #FCA5A5; border-color: rgba(248,113,113,0.35); }
  .badge-mini.gold { background: var(--goldSoft); color: var(--goldHi); border-color: var(--borderHi); }

  /* Modals (PIN Gate & Kicked/Blocked Screen) */
  .overlay-screen {
    position: fixed; inset: 0; z-index: 100;
    background: radial-gradient(circle at 25% 15%, rgba(230,198,135,0.12), transparent 45%), rgba(7,9,15,0.96);
    backdrop-filter: blur(18px);
    display: flex; align-items: center; justify-content: center; padding: 20px;
  }
  .overlay-screen.hidden { display: none; }
  .gate-card {
    width: 100%; max-width: 400px; background: var(--surface); border: 1px solid var(--borderHi);
    border-radius: 22px; padding: 28px 24px; text-align: center; box-shadow: 0 28px 80px rgba(0,0,0,0.75);
  }
  .gate-card h2 { font-size: 19px; font-weight: 800; color: var(--goldHi); margin: 10px 0 6px; }
  .gate-card p { font-size: 13px; color: var(--sub); line-height: 1.5; margin-bottom: 18px; }
  .gate-field {
    width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 12px;
    color: var(--txt); padding: 12px 14px; font-size: 14px; outline: none; margin-bottom: 10px;
  }
  .gate-field:focus { border-color: var(--gold); }
  .gate-err { color: var(--red); font-size: 12px; min-height: 18px; margin-bottom: 8px; }

  .toast {
    position: fixed; top: 64px; left: 50%; transform: translateX(-50%);
    background: rgba(15,20,30,0.95); border: 1px solid var(--borderHi); color: var(--goldHi);
    padding: 8px 16px; border-radius: 999px; font-size: 12.5px; font-weight: 700;
    box-shadow: 0 10px 30px rgba(0,0,0,0.55); z-index: 90; opacity: 0; pointer-events: none;
    transition: opacity 0.2s; max-width: 92vw; text-align: center;
  }
  .toast.show { opacity: 1; }

  /* Ensure smooth touch scrolling & swipe-to-reply across all tablet/mobile browsers */
  .scroll-body {
    touch-action: pan-y;
    overscroll-behavior: contain;
  }

  /* Tablet Landscape (721px–1080px): keep sleek side-by-side Studio split instead of cramping vertically */
  @media (min-width: 721px) and (max-width: 1080px) and (orientation: landscape) {
    .workspace {
      grid-template-columns: minmax(0, 1fr) 340px;
    }
  }

  /* Mobile & Tablet Portrait: Full-width edge-to-edge 16:9 Video Top + Independent Scrolling Tabbed Bottom Workspace */
  .kb-video-btn { display: none; }
  @media (max-width: 959px) and (orientation: portrait), (max-width: 720px) {
    .topbar { height: 48px; padding: 0 10px; }
    .room-title { font-size: 12.5px; }
    .workspace {
      display: flex;
      flex-direction: column;
      grid-template-columns: none;
    }
    .stage-col {
      flex: 0 0 auto;
      width: 100%;
      border-right: none;
      border-bottom: 1px solid var(--border);
    }
    .video-stage {
      flex: 0 0 auto;
      width: 100%;
      aspect-ratio: 16 / 9;
      max-height: 44dvh;
      transition: max-height 0.18s ease, height 0.18s ease;
    }
    .side-panel {
      flex: 1 1 0;
      min-height: 0;
    }
    .stage-dock { padding: 5px 8px; }
    .dock-btn { padding: 5px 8px; font-size: 11px; }
    .kb-video-btn { display: inline-flex; }

    /* Smart Keyboard-Open Compact Mode (ONLY active while a text input is focused!) */
    .studio-shell.kb-open .topbar { display: none; }
    .studio-shell.kb-open .video-stage { aspect-ratio: auto; height: 92px; max-height: 92px; }
    .studio-shell.kb-open.kb-hide-video .video-stage { height: 0; max-height: 0; overflow: hidden; }
    .studio-shell.kb-open .composer-wrap { padding: 7px 8px; }
    .studio-shell.kb-open .tab-btn { padding: 6px 2px; font-size: 9.5px; }
  }

  /* Unmute Floating Pill (only if mobile browser blocks unmuted autoplay on track switch) */
  .unmute-pill {
    position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);
    z-index: 24; display: none; align-items: center; gap: 6px;
    padding: 8px 16px; border-radius: 999px; border: 1.5px solid var(--gold);
    background: rgba(12,15,24,0.92); color: var(--goldHi); font-size: 12px; font-weight: 800;
    cursor: pointer; box-shadow: 0 10px 28px rgba(0,0,0,0.65); backdrop-filter: blur(8px);
  }
  .unmute-pill.show { display: inline-flex; }

  /* Reconnecting Pill */
  .pill.sync-reconn { background: rgba(248,113,113,0.16); border-color: rgba(248,113,113,0.5); color: #FCA5A5; }
  .pill.sync-reconn .dot { background: #F87171; }

  /* Chat Privacy Shield (Host-controlled Watermark + Blur Curtain + Anti-Select + Anti-Print) */
  .side-panel { position: relative; }
  body.privacy-shield-on #pane-chat,
  body.privacy-shield-on #pane-notes {
    -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
  }
  .privacy-watermark {
    position: absolute; inset: 46px 0 0 0; z-index: 8; pointer-events: none;
    opacity: 0; transition: opacity 0.2s; background-repeat: repeat; background-size: 260px 150px;
  }
  body.privacy-shield-on .privacy-watermark { opacity: 1; }
  .privacy-curtain {
    position: absolute; inset: 0; z-index: 45; display: none;
    flex-direction: column; align-items: center; justify-content: center; gap: 8px;
    background: rgba(7,9,15,0.92); backdrop-filter: blur(22px);
    color: var(--goldHi); text-align: center; padding: 20px;
  }
  .privacy-curtain.show { display: flex; }
  @media print {
    body.privacy-shield-on * { display: none !important; visibility: hidden !important; }
  }

  /* WhatsApp-style Swipe-to-Reply & Quote Bubbles */
  .msg-swipe-wrap {
    position: relative; display: flex; align-items: center; touch-action: pan-y;
  }
  .msg-swipe-wrap .msg-card {
    flex: 1; min-width: 0; position: relative; transition: transform 0.16s cubic-bezier(0.22, 1, 0.36, 1);
    will-change: transform;
  }
  .msg-swipe-wrap.swiping .msg-card { transition: none; }
  .swipe-reply-ind {
    position: absolute; left: 6px; top: 50%; transform: translateY(-50%) scale(0.6);
    width: 30px; height: 30px; border-radius: 50%;
    background: var(--goldSoft); border: 1px solid var(--gold); color: var(--goldHi);
    display: flex; align-items: center; justify-content: center; font-size: 14px;
    opacity: 0; pointer-events: none; transition: opacity 0.12s, transform 0.12s;
  }
  .msg-reply-quick {
    opacity: 0; border: 1px solid var(--border); background: var(--surface3); color: var(--goldHi);
    border-radius: 7px; padding: 2px 6px; font-size: 10px; font-weight: 700; cursor: pointer;
    margin-left: 6px; transition: opacity 0.14s, background 0.14s;
  }
  .msg-card:hover .msg-reply-quick, .msg-card:focus-within .msg-reply-quick { opacity: 1; }
  .msg-reply-quick:hover { background: var(--goldSoft); border-color: var(--gold); }
  .msg-quote-box {
    margin: 2px 0 6px; padding: 5px 8px; border-radius: 8px;
    background: rgba(230,198,135,0.09); border-left: 3px solid var(--gold);
    cursor: pointer; transition: background 0.14s;
  }
  .msg-card.ai .msg-quote-box { background: rgba(15,23,42,0.06); border-left-color: #B48A3E; }
  .msg-quote-box:hover { background: rgba(230,198,135,0.18); }
  .msg-quote-sender { font-size: 10.5px; font-weight: 800; color: var(--goldHi); line-height: 1.25; }
  .msg-card.ai .msg-quote-sender { color: #8A6520; }
  .msg-quote-text {
    font-size: 11.5px; color: var(--sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    margin-top: 1px;
  }
  .msg-card.highlight-flash {
    animation: msgFlashPulse 1.35s ease;
  }
  @keyframes msgFlashPulse {
    0% { box-shadow: 0 0 0 0 rgba(230,198,135,0.85); border-color: var(--gold); }
    35% { box-shadow: 0 0 0 6px rgba(230,198,135,0.28); border-color: var(--goldHi); }
    100% { box-shadow: 0 0 0 0 rgba(230,198,135,0); }
  }
  .msg-card.jumbo-emoji .msg-body {
    font-size: 30px; line-height: 1.25; letter-spacing: 2px; padding: 2px 0;
  }

  /* Active Reply Composer Bar */
  .reply-composer-bar {
    display: none; align-items: center; gap: 8px; margin-bottom: 6px;
    padding: 6px 10px; border-radius: 11px;
    background: rgba(230,198,135,0.10); border: 1px solid var(--borderHi);
    border-left: 3px solid var(--gold);
  }
  .reply-composer-bar.show { display: flex; }
  .reply-composer-meta { flex: 1; min-width: 0; }
  .reply-composer-who { font-size: 11px; font-weight: 800; color: var(--goldHi); }
  .reply-composer-snip {
    font-size: 11.5px; color: var(--sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .reply-cancel-btn {
    width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--border);
    background: var(--surface3); color: var(--txt); cursor: pointer; font-size: 12px;
    display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  }

  /* Categorized Premium Emoji Picker Drawer */
  .emoji-toggle-btn {
    flex-shrink: 0; width: 34px; height: 34px; border-radius: 10px;
    border: 1px solid var(--border); background: var(--surface3); color: var(--txt);
    font-size: 17px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
    transition: border-color 0.14s, background 0.14s;
  }
  .emoji-toggle-btn.active { background: var(--goldSoft); border-color: var(--gold); }
  .emoji-drawer {
    display: none; flex-direction: column; gap: 6px; margin-bottom: 7px;
    padding: 8px; border-radius: 14px; background: var(--surface2);
    border: 1px solid var(--borderHi); box-shadow: 0 -8px 24px rgba(0,0,0,0.45);
  }
  .emoji-drawer.show { display: flex; }
  .emoji-cats {
    display: flex; gap: 4px; overflow-x: auto; padding-bottom: 4px; border-bottom: 1px solid var(--border);
  }
  .emoji-cat-btn {
    padding: 4px 8px; border-radius: 8px; border: 1px solid transparent; background: transparent;
    color: var(--sub); font-size: 11px; font-weight: 700; cursor: pointer; white-space: nowrap;
  }
  .emoji-cat-btn.active { background: var(--goldSoft); border-color: var(--borderHi); color: var(--goldHi); }
  .emoji-grid {
    display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px;
    max-height: 152px; overflow-y: auto; -webkit-overflow-scrolling: touch;
  }
  .emoji-cell {
    height: 34px; border-radius: 8px; border: none; background: transparent;
    font-size: 20px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: background 0.1s, transform 0.1s;
  }
  .emoji-cell:hover, .emoji-cell:active { background: rgba(230,198,135,0.16); transform: scale(1.14); }
</style>
</head>
<body>
<div class="studio-shell" id="studioShell">
  <header class="topbar">
    <div class="brand-group">
      <div class="brand-mark">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      </div>
      <div class="title-block">
        <div class="room-title" id="videoTitle">Connecting to Study Studio...</div>
        <div class="room-sub">
          <span class="code-tag">${safeCode}</span>
          <span id="channelMeta">Waiting for Host</span>
          <span id="e2eeBadge" style="display:none;color:#34D399;font-weight:700;">• E2EE</span>
          <span id="privacyBadge" style="display:none;color:#E6C687;font-weight:800;">• 🛡️ Private</span>
        </div>
      </div>
    </div>
    <div class="header-actions">
      <div class="pill pomo-pill" id="pomoPill"><span id="pomoText">25:00</span></div>
      <button class="pill sync-ok" id="syncHealthPill" onclick="catchUpToHost()" title="Sync status — click to align smoothly with Host">
        <span class="dot"></span>
        <span id="syncHealthText">Synced</span>
      </button>
      <button class="icon-btn" id="cinemaBtn" onclick="toggleCinema()" title="Cinema Focus Mode">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v16"/></svg>
      </button>
    </div>
  </header>

  <main class="workspace" id="workspace">
    <!-- Stage Column -->
    <section class="stage-col">
      <div class="video-stage" id="videoStage">
        <div class="video-zoom-wrap" id="videoZoomWrap">
          <div id="ytPlayerMount"></div>
          <iframe id="driveFrame" style="display:none;" allow="autoplay; fullscreen"></iframe>
        </div>
        <button class="unmute-pill" id="unmuteAutoplayBtn" onclick="unmuteAutoplayNow()">🔊 Tap for Sound</button>
        <div class="stage-placeholder" id="stagePlaceholder">
          <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#E6C687" stroke-width="1.6"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <div style="font-size:14px;font-weight:700;color:#F3F5F9;" id="placeholderMsg">Waiting for Host Lecture...</div>
          <div style="font-size:12px;color:#94A3B8;max-width:300px;">Playback stays smoothly calibrated with your Host across cities.</div>
        </div>
        <div class="laser-dot" id="laserDot"></div>
        <div class="blackout-cover" id="blackoutCover">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <div style="font-weight:800;font-size:16px;">Deep Recall Blackout</div>
          <div style="font-size:12px;color:#94A3B8;">Host paused display for active recall</div>
        </div>
        <div class="reaction-layer" id="reactionLayer"></div>
        <div class="resource-overlay" id="resourceOverlay">
          <div class="resource-overlay-head">
            <span id="resourceOverlayTitle">Shared Resource</span>
            <button class="dock-btn" onclick="closeResourceOverlay()">Close</button>
          </div>
          <iframe id="resourceOverlayFrame"></iframe>
        </div>
      </div>

      <!-- Unified Stage Control Dock -->
      <div class="stage-dock">
        <div class="dock-group">
          <button class="dock-btn gold" id="modeToggleBtn" onclick="toggleSyncMode()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
            <span id="modeToggleLabel">Synced</span>
          </button>
          <button class="dock-btn" onclick="raiseDoubtHand()">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v6"/><path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>
            <span>Doubt</span>
          </button>
          <span class="time-readout" id="stageTimeLabel">0:00 / --:--</span>
          <button class="dock-btn" id="stageUpNextPill" style="display:none;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" onclick="switchTab('queue')" title="Open Up-Next Queue">⏭ Up Next</button>
        </div>
        <div class="dock-group" id="reactionBar">
          <button class="dock-btn kb-video-btn" id="kbVideoToggleBtn" onclick="toggleKbVideo()" title="Toggle video while typing">📺 Video</button>
          <button class="react-mini" onclick="sendReaction('💡')" title="Aha moment">💡</button>
          <button class="react-mini" onclick="sendReaction('🔥')" title="Great point">🔥</button>
          <button class="react-mini" onclick="sendReaction('👏')" title="Well explained">👏</button>
          <button class="react-mini" onclick="sendReaction('❓')" title="Need clarity">❓</button>
        </div>
      </div>
    </section>

    <!-- Right Study Desk Panel -->
    <aside class="side-panel" id="sidePanel">
      <div class="privacy-watermark" id="privacyWatermark" aria-hidden="true"></div>
      <div class="privacy-curtain" id="privacyCurtain">
        <div style="font-size:28px;">🛡️</div>
        <div style="font-size:15px;font-weight:800;">Chat Privacy Shield Active</div>
        <div style="font-size:12px;color:#94A3B8;max-width:260px;">Chat is hidden while you switch windows or trigger screen capture. Tap anywhere to resume.</div>
      </div>
      <nav class="tab-bar">
        <button class="tab-btn active" data-tab="chat" onclick="switchTab('chat')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span>Chat</span>
          <span class="tab-badge" id="chatBadge">0</span>
        </button>
        <button class="tab-btn" data-tab="queue" onclick="switchTab('queue')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <span>Search</span>
          <span class="tab-badge" id="queueBadge">0</span>
        </button>
        <button class="tab-btn" data-tab="notes" onclick="switchTab('notes')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span>Notes</span>
        </button>
        <button class="tab-btn" data-tab="files" onclick="switchTab('files')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span>Files</span>
        </button>
        <button class="tab-btn" data-tab="crew" onclick="switchTab('crew')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <span id="crewTabLabel">Crew</span>
        </button>
      </nav>

      <!-- Pinned Announcement Banner -->
      <div class="pinned-banner" id="pinnedBanner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="flex-shrink:0;"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
        <span id="pinnedText"></span>
      </div>

      <!-- 1-Tap Quick Pulse Poll Card -->
      <div class="poll-card" id="pollCard">
        <div class="poll-q" id="pollQuestion">Quick Check</div>
        <div class="poll-opts">
          <button class="poll-btn" id="pollOptGotIt" onclick="votePoll('gotIt')"><span>✅ Got it</span><span class="poll-cnt" id="pollCntGotIt">0</span></button>
          <button class="poll-btn" id="pollOptConfused" onclick="votePoll('confused')"><span>🤔 Confused</span><span class="poll-cnt" id="pollCntConfused">0</span></button>
          <button class="poll-btn" id="pollOptTooFast" onclick="votePoll('tooFast')"><span>🐢 Too fast</span><span class="poll-cnt" id="pollCntTooFast">0</span></button>
        </div>
      </div>

      <!-- TAB 1: CHAT & AI -->
      <div class="tab-pane active" id="pane-chat">
        <div class="scroll-body" id="chatList"></div>
        <button class="new-msg-pill" id="newMsgPill" onclick="scrollChatToBottom(true)">↓ New Messages</button>
        <div class="typing-bar" id="typingBar"></div>
        <div class="composer-wrap">
          <div class="mute-lock-banner" id="muteLockBanner">🔇 Chat is currently muted by Host</div>
          <div class="reply-composer-bar" id="replyComposerBar">
            <div class="reply-composer-meta">
              <div class="reply-composer-who" id="replyComposerWho">Replying to...</div>
              <div class="reply-composer-snip" id="replyComposerSnip"></div>
            </div>
            <button type="button" class="reply-cancel-btn" onclick="cancelReply()" title="Cancel reply">✕</button>
          </div>
          <div class="emoji-drawer" id="emojiDrawer">
            <div class="emoji-cats" id="emojiCats"></div>
            <div class="emoji-grid" id="emojiGrid"></div>
          </div>
          <div class="composer-row" id="composerRow">
            <button type="button" class="emoji-toggle-btn" id="emojiToggleBtn" onclick="toggleEmojiDrawer()" title="Emoji packs">😊</button>
            <button type="button" class="ai-toggle-pill" id="aiTagBtn" onclick="toggleAiTag()" title="Tag Mentor Pro AI">@AI</button>
            <textarea class="chat-input" id="chatInput" rows="1" placeholder="Message study room..." maxlength="800"></textarea>
            <button type="button" class="send-btn" id="chatSendBtn" onclick="sendChat()" title="Send message">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </div>
      </div>

      <!-- TAB 2: YOUTUBE SEARCH & REQUEST QUEUE -->
      <div class="tab-pane" id="pane-queue">
        <div class="search-bar-box">
          <div class="search-row">
            <input class="studio-input" id="ytSearchInput" placeholder="Search YouTube or paste video / playlist link..." autocomplete="off">
            <button class="gold-btn" id="ytSearchBtn" onclick="runYouTubeSearch()">Search</button>
          </div>
          <input class="studio-input" id="ytRequestNote" placeholder="Optional note to Host (e.g. 'Great derivation of Gauss law')" maxlength="110" style="padding:7px 11px;font-size:12px;">
        </div>
        <div class="scroll-body" id="queueScroll">
          <div id="ytSearchResultsWrap" style="display:flex;flex-direction:column;gap:8px;"></div>
          <div id="pendingPlaylistsWrap" style="display:flex;flex-direction:column;gap:8px;"></div>
          <div class="section-label"><span>Pending Requests (Host Approval)</span><span id="reqCountLabel">0</span></div>
          <div id="pendingRequestsWrap" style="display:flex;flex-direction:column;gap:8px;">
            <div style="font-size:12px;color:var(--muted);">Search any YouTube lecture above and tap Request to Play. Host must approve before it streams.</div>
          </div>
          <div class="section-label" style="margin-top:8px;"><span>Approved Up-Next Queue</span><span id="upNextCountLabel">0</span></div>
          <div id="upNextWrap" style="display:flex;flex-direction:column;gap:8px;">
            <div style="font-size:12px;color:var(--muted);">No videos queued yet.</div>
          </div>
        </div>
      </div>

      <!-- TAB 3: NOTES & CHAPTERS -->
      <div class="tab-pane" id="pane-notes">
        <div class="scroll-body" id="notesList"></div>
        <div class="composer-wrap">
          <div class="composer-row">
            <input class="chat-input" id="noteInput" placeholder="Add timestamped lecture note..." style="min-height:34px;padding:6px 4px;">
            <button class="send-btn" onclick="addLiveNote()" title="Save Note">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </div>
        </div>
      </div>

      <!-- TAB 4: SHARED STUDY FILES -->
      <div class="tab-pane" id="pane-files">
        <div class="search-bar-box">
          <div class="search-row">
            <input class="studio-input" id="driveLinkInput" placeholder="Paste Google Drive PDF/slide link...">
            <button class="gold-btn" onclick="shareDriveLink()">Add</button>
          </div>
          <label class="dock-btn" style="justify-content:center;">
            <span>Upload PDF / Notes (Max 35MB)</span>
            <input type="file" id="fileUploadInput" style="display:none;" onchange="uploadStudyFile(this)">
          </label>
        </div>
        <div class="scroll-body" id="filesList"></div>
      </div>

      <!-- TAB 5: LIVE CREW & DOUBT QUEUE -->
      <div class="tab-pane" id="pane-crew">
        <div class="scroll-body">
          <div class="section-label"><span>Live Study Crew</span><span id="crewOnlineCnt">0</span></div>
          <div id="crewList" style="display:flex;flex-direction:column;gap:8px;"></div>
          <div class="section-label" style="margin-top:10px;"><span>Raised Hands / Doubt Queue</span><span id="doubtCnt">0</span></div>
          <div id="doubtList" style="display:flex;flex-direction:column;gap:8px;">
            <div style="font-size:12px;color:var(--muted);">No pending doubts.</div>
          </div>
        </div>
      </div>
    </aside>
  </main>
</div>

<!-- PIN Gate Modal -->
<div class="overlay-screen" id="pinGate">
  <div class="gate-card">
    <div class="brand-mark" style="width:52px;height:52px;border-radius:16px;margin:0 auto 12px;">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    </div>
    <h2>Join Studio ${safeCode}</h2>
    <p id="gateStatusMsg">Connecting to Cross-City Study Room...</p>
    <input class="gate-field" id="nameField" placeholder="Your Name (e.g. Rahul)" maxlength="28" autocomplete="name">
    <input class="gate-field" id="pinField" placeholder="4-Digit Room PIN" maxlength="8" inputmode="numeric" style="text-align:center;font-weight:800;letter-spacing:4px;">
    <div class="gate-err" id="gateError"></div>
    <button class="gold-btn" style="width:100%;padding:13px;font-size:14px;" id="joinBtn" onclick="submitJoin()">Unlock & Join Studio</button>
  </div>
</div>

<!-- Removed / Blocked Screen -->
<div class="overlay-screen hidden" id="kickedScreen">
  <div class="gate-card" style="border-color:rgba(248,113,113,0.4);">
    <div style="width:54px;height:54px;border-radius:16px;margin:0 auto 14px;background:rgba(248,113,113,0.14);color:#F87171;display:flex;align-items:center;justify-content:center;">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
    </div>
    <h2 style="color:#FCA5A5;">Removed from Study Room</h2>
    <p id="kickedReason">The Host has ended your access to this session.</p>
  </div>
</div>

<div class="toast" id="toast"></div>

<!-- Fullscreen Comparison Table Modal -->
<div class="tbl-modal" id="tableModal" onclick="if (event.target === this) closeTableModal();">
  <div class="tbl-modal-card">
    <div class="tbl-modal-head">
      <span style="font-size:13px;font-weight:800;letter-spacing:0.3px;">📊 Fullscreen Comparison Matrix</span>
      <button class="dock-btn gold" onclick="closeTableModal()">✕ Close</button>
    </div>
    <div class="tbl-modal-body" id="tableModalBody"></div>
  </div>
</div>

<script src="https://www.youtube.com/iframe_api"></script>
<script>
const ROOM_CODE = ${JSON.stringify(safeCode)};
const CLIENT_ID = (() => {
  try {
    let id = localStorage.getItem('sp_client_id');
    if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); localStorage.setItem('sp_client_id', id); }
    return id;
  } catch (_) { return String(Math.random()).slice(2); }
})();

let ws = null;
let reconnectTimer = null;
let pingTimer = null;
let permanentlyBlocked = false;
let joined = false;
let pendingJoinClick = false;
let currentPin = '';
let displayName = (() => { try { return localStorage.getItem('sp_name') || ''; } catch(_) { return ''; } })();
let e2eeEnabled = false;
let aesKeyPromise = null;
let serverClockOffsetMs = 0; // serverNow - localNow

// Player & Smooth Sync State
let ytApiReady = false;
let ytPlayer = null;
let activeVideoId = '';
let activeYoutubeId = '';
let activeDriveUrl = '';
let lastHostPos = 0;
let lastHostPlaying = true;
let lastHostSpeed = 1.0;
let lastHostServerMs = 0;
let lastHostDurationSec = 0;
let reportedDurationForVid = '';
let syncMode = 'synced'; // 'synced' | 'free'
let lastSeekAtMs = 0;
let lastSyncId = 0;
let pendingSyncAfterBuffer = null;
let softCatchupTimer = null;
let isCinema = false;

// Room Governance & Moderation State
let isSelfMuted = false;
let selfMutedUntilMs = 0;
let chatMutedAll = false;
let slowModeSec = 0;
let allowVideoRequests = true;
let allowReactions = true;
let allowCrewAi = true;
let allowCrewNotes = true;
let privacyShieldEnabled = false;
let autoPlayQueue = true;
let currentSwitchSeq = 0;
let lastReportedDur = 0;
let autoplayRetryTimers = [];
let mutedAutoplayFallback = false;
let tagAiNext = false;
let activeTab = 'chat';
let unreadChatCount = 0;
let unreadWhileScrolled = 0;
let myPollVote = '';
let currentPollId = '';
let activeReplyTarget = null; // { id, senderName, snippet, isAi }
let lastSentChatMs = 0;

// Incremental Chat DOM State (Zero full-redraw jitter!)
const renderedChatIds = new Set();
const chatNodeById = new Map();
const chatMetaById = new Map();
const typingPeers = new Map();
const typingExpiryTimers = new Map();

// Pomodoro State
let pomoInterval = null;
let pomoRemSec = 0;
let pomoPhase = 'FOCUS';

document.getElementById('nameField').value = displayName;
document.getElementById('pinField').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitJoin(); });
document.getElementById('ytSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runYouTubeSearch(); });
document.getElementById('noteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addLiveNote(); });

// Strict Chat-Only Typing Indicator (NEVER triggers on Video Search / Notes!)
const chatInputEl = document.getElementById('chatInput');
let typingTimeout = null;
let isCurrentlyEmittingTyping = false;
let lastTypingEmitMs = 0;

function stopTypingNow() {
  clearTimeout(typingTimeout);
  typingTimeout = null;
  if (isCurrentlyEmittingTyping) {
    isCurrentlyEmittingTyping = false;
    if (ws && ws.readyState === 1 && joined) {
      ws.send(JSON.stringify({ type: 'typing', isTyping: false }));
    }
  }
}

chatInputEl.addEventListener('input', () => {
  chatInputEl.style.height = 'auto';
  chatInputEl.style.height = Math.min(92, chatInputEl.scrollHeight) + 'px';
  const hasText = (chatInputEl.value || '').trim().length > 0;
  if (!hasText || activeTab !== 'chat' || document.activeElement !== chatInputEl) {
    stopTypingNow();
    return;
  }
  if (ws && ws.readyState === 1 && joined && !isSelfMuted && !chatMutedAll) {
    const now = Date.now();
    if (!isCurrentlyEmittingTyping || (now - lastTypingEmitMs) > 1400) {
      isCurrentlyEmittingTyping = true;
      lastTypingEmitMs = now;
      ws.send(JSON.stringify({ type: 'typing', isTyping: true }));
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(stopTypingNow, 2100);
  }
});
chatInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// Fullscreen-Safe & Orientation-Aware Virtual Keyboard Flush Lock (ZERO shrink-trap on Tablet/Mobile!)
let baselineViewportH = window.innerHeight || 0;
let lastOrientationKey = (window.innerWidth > window.innerHeight) ? 'L' : 'P';

function isTextInputFocused() {
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = (ae.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

function isFullscreenNow() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

function syncViewportHeight() {
  const shell = document.getElementById('studioShell');
  if (!shell) return;
  const vv = window.visualViewport;
  const vw = vv ? Math.round(vv.width) : window.innerWidth;
  const vh = vv ? Math.round(vv.height) : window.innerHeight;
  const vTop = vv ? Math.max(0, Math.round(vv.offsetTop)) : 0;

  const orientKey = vw > vh ? 'L' : 'P';
  if (orientKey !== lastOrientationKey) {
    lastOrientationKey = orientKey;
    baselineViewportH = vh;
  }

  const inputFocused = isTextInputFocused();
  const inFs = isFullscreenNow();

  // Whenever NO text input is focused (or exiting fullscreen), ALWAYS recalibrate baseline and clear kb-open!
  if (!inputFocused || inFs) {
    if (vh > 180) baselineViewportH = vh;
    shell.classList.remove('kb-open');
    shell.style.height = '';
    shell.style.top = '0px';
    if (window.scrollY !== 0) window.scrollTo(0, 0);
    return;
  }

  if (vh > baselineViewportH) baselineViewportH = vh;
  const isStacked = (vw < 960 && orientKey === 'P') || vw <= 720;
  const kbOpen = isStacked && baselineViewportH > 0 && vh < (baselineViewportH - 110);
  shell.classList.toggle('kb-open', kbOpen);
  if (kbOpen) {
    shell.style.height = vh + 'px';
    shell.style.top = vTop + 'px';
    if (window.scrollY !== 0) window.scrollTo(0, 0);
    if (activeTab === 'chat') scrollChatToBottom(true);
  } else {
    shell.style.height = '';
    shell.style.top = '0px';
  }
}

function recoverLayoutAfterFullscreenOrRotate() {
  const shell = document.getElementById('studioShell');
  if (shell) {
    shell.classList.remove('kb-open', 'kb-hide-video');
    shell.style.height = '';
    shell.style.top = '0px';
  }
  const btn = document.getElementById('kbVideoToggleBtn');
  if (btn) btn.textContent = '📺 Video';
  baselineViewportH = (window.visualViewport ? Math.round(window.visualViewport.height) : window.innerHeight) || 0;
  lastOrientationKey = (window.innerWidth > window.innerHeight) ? 'L' : 'P';
  window.scrollTo(0, 0);
  syncViewportHeight();
}

function toggleKbVideo() {
  const shell = document.getElementById('studioShell');
  if (!shell) return;
  const hidden = shell.classList.toggle('kb-hide-video');
  const btn = document.getElementById('kbVideoToggleBtn');
  if (btn) btn.textContent = hidden ? '📺 Show' : '📺 Hide';
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewportHeight);
  window.visualViewport.addEventListener('scroll', syncViewportHeight);
}
window.addEventListener('resize', syncViewportHeight);
window.addEventListener('orientationchange', () => {
  setTimeout(recoverLayoutAfterFullscreenOrRotate, 80);
  setTimeout(recoverLayoutAfterFullscreenOrRotate, 320);
});
['fullscreenchange', 'webkitfullscreenchange'].forEach((evt) => {
  document.addEventListener(evt, () => {
    setTimeout(recoverLayoutAfterFullscreenOrRotate, 80);
    setTimeout(recoverLayoutAfterFullscreenOrRotate, 320);
    setTimeout(recoverLayoutAfterFullscreenOrRotate, 600);
  });
});
['chatInput', 'ytSearchInput', 'ytRequestNote', 'noteInput'].forEach((inpId) => {
  const el = document.getElementById(inpId);
  if (!el) return;
  el.addEventListener('focus', () => {
    if (inpId === 'chatInput') closeEmojiDrawer();
    setTimeout(() => { syncViewportHeight(); if (activeTab === 'chat') scrollChatToBottom(true); }, 120);
    setTimeout(() => { syncViewportHeight(); if (activeTab === 'chat') scrollChatToBottom(true); }, 340);
  });
  el.addEventListener('blur', () => {
    if (inpId === 'chatInput') stopTypingNow();
    setTimeout(() => {
      if (!isTextInputFocused()) {
        const shell = document.getElementById('studioShell');
        if (shell) {
          shell.classList.remove('kb-open');
          shell.style.height = '';
          shell.style.top = '0px';
        }
      }
      syncViewportHeight();
    }, 140);
  });
});
syncViewportHeight();

// Chat Scroll Observer for "↓ New Messages" pill
const chatListEl = document.getElementById('chatList');
function isNearChatBottom() {
  return (chatListEl.scrollHeight - chatListEl.scrollTop - chatListEl.clientHeight) < 96;
}
chatListEl.addEventListener('scroll', () => {
  if (isNearChatBottom()) {
    unreadWhileScrolled = 0;
    document.getElementById('newMsgPill').classList.remove('show');
  }
});
function scrollChatToBottom(force) {
  if (force || isNearChatBottom()) {
    chatListEl.scrollTop = chatListEl.scrollHeight;
    unreadWhileScrolled = 0;
    document.getElementById('newMsgPill').classList.remove('show');
  }
}

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function safeUrl(u) {
  const s = String(u || '').trim();
  if (/^https?:\\/\\//i.test(s) || s.startsWith('/')) return s;
  if (/^data:image\\/(png|jpeg|jpg|webp);base64,/i.test(s)) return s;
  return '';
}
function fmtSec(sec) {
  const s = Math.max(0, Math.floor(Number(sec || 0)));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? h + ':' + String(m).padStart(2,'0') + ':' + String(r).padStart(2,'0') : m + ':' + String(r).padStart(2,'0');
}
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// WebCrypto SHA-256 & AES-256-GCM (with pure-JS SHA-256 fallback for restricted WebViews)
async function sha256Hex(str) {
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const bytes = new TextEncoder().encode(str);
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];
  let H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(paddedLen - 4, bitLen >>> 0, false);
  const W = new Uint32Array(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = ((W[i-15] >>> 7) | (W[i-15] << 25)) ^ ((W[i-15] >>> 18) | (W[i-15] << 14)) ^ (W[i-15] >>> 3);
      const s1 = ((W[i-2] >>> 17) | (W[i-2] << 15)) ^ ((W[i-2] >>> 19) | (W[i-2] << 13)) ^ (W[i-2] >>> 10);
      W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H = [(H[0]+a)>>>0,(H[1]+b)>>>0,(H[2]+c)>>>0,(H[3]+d)>>>0,(H[4]+e)>>>0,(H[5]+f)>>>0,(H[6]+g)>>>0,(H[7]+h)>>>0];
  }
  return H.map((x) => x.toString(16).padStart(8, '0')).join('');
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
async function getAesKey() {
  if (!e2eeEnabled || !currentPin) return null;
  if (!aesKeyPromise) {
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('shieldpro-e2ee:' + ROOM_CODE + ':' + currentPin));
    aesKeyPromise = crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  return aesKeyPromise;
}
async function encryptPayload(obj) {
  const key = await getAesKey();
  if (!key) return obj;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return { enc: true, iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) };
}
async function decryptPayload(env) {
  if (!env || !env.enc) return env;
  const key = await getAesKey();
  if (!key) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(env.iv) }, key, b64ToBytes(env.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (_) { return null; }
}

// YouTube IFrame API & Smooth Sync Engine
window.onYouTubeIframeAPIReady = function() {
  ytApiReady = true;
  if (activeYoutubeId) mountOrSwitchYouTube(activeYoutubeId, lastHostPos, lastHostPlaying, lastHostSpeed);
};

function getEstimatedHostNowPos() {
  if (!lastHostServerMs) return lastHostPos;
  const serverNow = Date.now() + serverClockOffsetMs;
  const elapsed = lastHostPlaying ? Math.max(0, (serverNow - lastHostServerMs) / 1000) * lastHostSpeed : 0;
  const raw = Math.max(0, lastHostPos + elapsed);
  const liveDur = getVerifiedPlayerDuration();
  return liveDur > 0 ? Math.min(liveDur, raw) : raw;
}

function getVerifiedPlayerDuration() {
  try {
    if (ytPlayer && typeof ytPlayer.getDuration === 'function') {
      const d = Math.floor(ytPlayer.getDuration() || 0);
      const loadedId = ytPlayer.getVideoData ? (ytPlayer.getVideoData().video_id || '') : activeYoutubeId;
      if (d > 10 && (!loadedId || loadedId === activeYoutubeId)) return d;
    }
  } catch (_) {}
  return lastHostDurationSec > 0 ? lastHostDurationSec : 0;
}

function clearAutoplayRetries() {
  while (autoplayRetryTimers.length) clearTimeout(autoplayRetryTimers.pop());
}

function ensureAutoplayKick() {
  clearAutoplayRetries();
  if (!lastHostPlaying || !ytPlayer) return;
  [260, 750, 1450].forEach((ms, idx) => {
    autoplayRetryTimers.push(setTimeout(() => {
      if (!ytPlayer || !lastHostPlaying) return;
      try {
        const st = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
        if (st === 1 || st === 3) return; // already playing or buffering
        if (idx === 2 && st !== 1 && st !== 3) {
          // Mobile browser blocked unmuted autoplay: mute briefly so track starts seamlessly + show Tap for Sound pill
          if (ytPlayer.mute) ytPlayer.mute();
          mutedAutoplayFallback = true;
          const btn = document.getElementById('unmuteAutoplayBtn');
          if (btn) btn.classList.add('show');
        }
        if (ytPlayer.playVideo) ytPlayer.playVideo();
      } catch (_) {}
    }, ms));
  });
}

function unmuteAutoplayNow() {
  mutedAutoplayFallback = false;
  const btn = document.getElementById('unmuteAutoplayBtn');
  if (btn) btn.classList.remove('show');
  try {
    if (ytPlayer) {
      if (ytPlayer.unMute) ytPlayer.unMute();
      if (ytPlayer.setVolume) ytPlayer.setVolume(100);
      if (lastHostPlaying && ytPlayer.playVideo) ytPlayer.playVideo();
    }
  } catch (_) {}
}

function mountOrSwitchYouTube(ytId, startSec, isPlaying, speed, forceReload = false) {
  if (!ytId) return;
  document.getElementById('driveFrame').style.display = 'none';
  document.getElementById('ytPlayerMount').style.display = 'block';
  document.getElementById('stagePlaceholder').style.display = 'none';

  const isTrackChange = activeYoutubeId !== ytId || forceReload;
  if (isTrackChange) {
    reportedDurationForVid = '';
    lastReportedDur = 0;
    pendingSyncAfterBuffer = null;
  }
  activeYoutubeId = ytId;

  if (!ytApiReady || !window.YT || !YT.Player) return;
  if (!ytPlayer) {
    ytPlayer = new YT.Player('ytPlayerMount', {
      videoId: ytId,
      playerVars: { autoplay: isPlaying ? 1 : 0, controls: 1, modestbranding: 1, rel: 0, playsinline: 1, start: Math.floor(startSec || 0) },
      events: {
        onReady: (e) => {
          try {
            const targetRate = Number(lastHostSpeed || speed || 1.0);
            if (e.target.setPlaybackRate) e.target.setPlaybackRate(targetRate);
            const targetPos = getEstimatedHostNowPos();
            if (targetPos > 2) e.target.seekTo(targetPos, true);
            if (lastHostPlaying) {
              e.target.playVideo();
              ensureAutoplayKick();
            } else {
              e.target.pauseVideo();
            }
          } catch (_) {}
        },
        onStateChange: (e) => {
          // 1 = PLAYING -> report verified duration, enforce exact Host speed, apply deferred sync
          if (e.data === 1) {
            clearAutoplayRetries();
            if (!mutedAutoplayFallback) {
              const btn = document.getElementById('unmuteAutoplayBtn');
              if (btn) btn.classList.remove('show');
            }
            reportDetectedDurationIfNeeded();
            setTimeout(reportDetectedDurationIfNeeded, 1500);
            try {
              const targetRate = Number(lastHostSpeed || 1.0);
              const curRate = ytPlayer.getPlaybackRate ? Number(ytPlayer.getPlaybackRate()) : 1.0;
              if (ytPlayer.setPlaybackRate && Math.abs(curRate - targetRate) > 0.04) {
                ytPlayer.setPlaybackRate(targetRate);
              }
            } catch (_) {}
            if (pendingSyncAfterBuffer) {
              const p = pendingSyncAfterBuffer;
              pendingSyncAfterBuffer = null;
              applySmoothSync(p.pos, p.playing, p.speed, p.opts);
            }
          } else if ((e.data === 5 || e.data === -1) && lastHostPlaying) {
            // VIDEO CUED / UNSTARTED right after track switch -> kick seamless playback!
            try { ytPlayer.playVideo(); } catch (_) {}
            ensureAutoplayKick();
          } else if (e.data === 0) {
            // GENUINE ENDED -> notify server so Auto-Play Queue seamlessly advances even if Host app is minimized!
            try {
              const dur = getVerifiedPlayerDuration();
              const cur = ytPlayer.getCurrentTime ? Number(ytPlayer.getCurrentTime() || 0) : 0;
              if (autoPlayQueue && ws && ws.readyState === 1 && joined && (dur <= 0 || cur >= dur - 6)) {
                ws.send(JSON.stringify({ type: 'video_ended', videoId: activeVideoId || activeYoutubeId, switchSeq: currentSwitchSeq }));
              }
            } catch (_) {}
          }
        },
        onError: (e) => {
          const code = Number(e?.data || 0);
          if ((code === 100 || code === 101 || code === 150) && autoPlayQueue && ws && ws.readyState === 1 && joined) {
            showToast('⏭️ Restricted YouTube track — advancing to next queued track...');
            ws.send(JSON.stringify({ type: 'video_error', videoId: activeVideoId || activeYoutubeId, errorCode: code, switchSeq: currentSwitchSeq }));
          }
        }
      }
    });
  } else if (isTrackChange) {
    try {
      ytPlayer.loadVideoById({ videoId: ytId, startSeconds: Math.floor(startSec || 0) });
      const targetRate = Number(lastHostSpeed || speed || 1.0);
      if (ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(targetRate);
      if (isPlaying) {
        ytPlayer.playVideo();
        ensureAutoplayKick();
      } else {
        setTimeout(() => { try { ytPlayer.pauseVideo(); } catch(_){} }, 350);
      }
    } catch (_) {}
  }
}

function reportDetectedDurationIfNeeded() {
  if (!ytPlayer || typeof ytPlayer.getDuration !== 'function' || !activeVideoId) return;
  try {
    const st = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
    if (st !== 1 && st !== 2) return; // only trust real playing/paused content, never unstarted/ad buffer
    const dur = Math.floor(ytPlayer.getDuration() || 0);
    const loadedId = ytPlayer.getVideoData ? (ytPlayer.getVideoData().video_id || '') : activeYoutubeId;
    if (dur > 10 && (!loadedId || loadedId === activeYoutubeId)) {
      const changedSignificantly = Math.abs(dur - lastReportedDur) >= 2 || reportedDurationForVid !== activeYoutubeId;
      if (changedSignificantly) {
        reportedDurationForVid = activeYoutubeId;
        lastReportedDur = dur;
        lastHostDurationSec = dur;
        if (ws && ws.readyState === 1 && joined) {
          ws.send(JSON.stringify({ type: 'viewer_duration', videoId: activeVideoId, durationSec: dur }));
        }
      }
    }
  } catch (_) {}
}

function updateSyncHealthBadge(driftSec, isBuffering) {
  const pill = document.getElementById('syncHealthPill');
  const txt = document.getElementById('syncHealthText');
  pill.className = 'pill';
  if (syncMode === 'free') {
    pill.classList.add('sync-free');
    txt.textContent = 'Free Mode';
    return 'free';
  }
  if (isBuffering) {
    pill.classList.add('sync-warn');
    txt.textContent = 'Buffering...';
    return 'buffering';
  }
  const absD = Math.abs(driftSec);
  if (absD <= 1.4) {
    pill.classList.add('sync-ok');
    txt.textContent = 'Synced ±' + absD.toFixed(1) + 's';
    return 'synced';
  }
  pill.classList.add('sync-warn');
  txt.textContent = (driftSec > 0 ? 'Behind ' : 'Ahead ') + Math.round(absD) + 's • Sync';
  return 'lagging';
}

function applySmoothSync(hostPos, isPlaying, speed, opts = {}) {
  const { forceHard = false, laggingOnly = true, syncId = 0, initialJoin = false } = opts;
  if (syncId && syncId === lastSyncId) return;
  if (syncId) lastSyncId = syncId;
  if (syncMode !== 'synced' && !initialJoin) return;
  if (!ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;

  try {
    const state = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
    // Buffering guard: never double-seek a buffering player!
    if (state === 3 && !initialJoin) {
      pendingSyncAfterBuffer = { pos: hostPos, playing: isPlaying, speed, opts };
      updateSyncHealthBadge(0, true);
      return;
    }

    const cur = Number(ytPlayer.getCurrentTime() || 0);
    const drift = hostPos - cur; // positive = viewer behind
    const absDrift = Math.abs(drift);
    const now = Date.now();

    updateSyncHealthBadge(drift, false);

    // Sync play/pause cleanly
    if (isPlaying && state !== 1 && state !== 3) ytPlayer.playVideo();
    if (!isPlaying && state === 1) ytPlayer.pauseVideo();

    // Exact Host speed alignment (never use fractional nudges on YouTube, which snaps to 1.25x/1.5x!)
    const targetSpeed = Number(speed || lastHostSpeed || 1.0);
    if (ytPlayer.setPlaybackRate) {
      const curRate = ytPlayer.getPlaybackRate ? Number(ytPlayer.getPlaybackRate()) : 1.0;
      if (Math.abs(curRate - targetSpeed) > 0.04) ytPlayer.setPlaybackRate(targetSpeed);
    }

    // 1. Within smooth threshold -> ZERO seek!
    const noSeekLimit = forceHard ? 1.2 : 2.5;
    if (absDrift <= noSeekLimit && !initialJoin) return;

    // 2. Larger drift (>2.5s) or explicit hard resync -> single rate-limited seek (3s cooldown)
    if (!initialJoin && (now - lastSeekAtMs) < 3000) return;
    lastSeekAtMs = now;
    ytPlayer.seekTo(hostPos, true);
    if (ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(targetSpeed);
  } catch (_) {}
}

function catchUpToHost() {
  syncMode = 'synced';
  document.getElementById('modeToggleLabel').textContent = 'Synced';
  document.getElementById('modeToggleBtn').classList.add('gold');
  document.getElementById('modeToggleBtn').classList.remove('active');
  lastSeekAtMs = 0;
  applySmoothSync(getEstimatedHostNowPos(), lastHostPlaying, lastHostSpeed, { forceHard: true, laggingOnly: false });
  showToast('Aligned smoothly with Host');
}

function toggleSyncMode() {
  syncMode = syncMode === 'synced' ? 'free' : 'synced';
  const btn = document.getElementById('modeToggleBtn');
  const lbl = document.getElementById('modeToggleLabel');
  if (syncMode === 'synced') {
    lbl.textContent = 'Synced';
    btn.classList.add('gold'); btn.classList.remove('active');
    catchUpToHost();
  } else {
    lbl.textContent = 'Free Explore';
    btn.classList.remove('gold'); btn.classList.add('active');
    updateSyncHealthBadge(0, false);
    showToast('Free Mode — browse timestamps independently');
  }
  sendViewerTelemetry();
}

function sendViewerTelemetry() {
  if (!ws || ws.readyState !== 1 || !joined) return;
  let pos = lastHostPos, isBuf = false, drift = 0;
  try {
    if (ytPlayer && ytPlayer.getCurrentTime) {
      pos = ytPlayer.getCurrentTime() || 0;
      isBuf = ytPlayer.getPlayerState && ytPlayer.getPlayerState() === 3;
      drift = getEstimatedHostNowPos() - pos;
    }
  } catch (_) {}
  const health = updateSyncHealthBadge(drift, isBuf);
  ws.send(JSON.stringify({
    type: 'viewer_status',
    mode: syncMode,
    positionSec: Math.floor(pos),
    syncHealth: health,
    driftSec: Math.round(drift * 10) / 10,
    isBuffering: isBuf,
  }));
}

// Local 1s HUD clock + telemetry heartbeat
setInterval(() => {
  if (!joined) return;
  let pos = lastHostPos, dur = lastHostDurationSec;
  try {
    if (ytPlayer && ytPlayer.getCurrentTime) {
      pos = ytPlayer.getCurrentTime() || 0;
      const d = ytPlayer.getDuration ? ytPlayer.getDuration() : 0;
      if (d > 0) { dur = d; reportDetectedDurationIfNeeded(); }
    }
  } catch (_) {}
  document.getElementById('stageTimeLabel').textContent = fmtSec(pos) + ' / ' + (dur > 0 ? fmtSec(dur) : '--:--');
}, 1000);
setInterval(sendViewerTelemetry, 5000);

// WebSocket Connection & Clock Calibration
function connectWs() {
  if (permanentlyBlocked) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws/' + encodeURIComponent(ROOM_CODE));

  ws.onopen = () => {
    sendClockPing();
    clearInterval(pingTimer);
    pingTimer = setInterval(sendClockPing, 18000);
    if (joined || pendingJoinClick) {
      pendingJoinClick = false;
      sendJoinHandshake();
    }
  };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    await handleWsMessage(msg);
  };

  ws.onclose = (ev) => {
    clearInterval(pingTimer);
    typingPeers.clear();
    for (const tm of typingExpiryTimers.values()) clearTimeout(tm);
    typingExpiryTimers.clear();
    renderTypingBar();
    pendingSyncAfterBuffer = null;
    if (ev.code === 4003 || permanentlyBlocked) {
      showKickedScreen('You were removed from this study room by the Host.');
      return;
    }
    if (joined) {
      const pill = document.getElementById('syncHealthPill');
      const txt = document.getElementById('syncHealthText');
      if (pill && txt) {
        pill.className = 'pill sync-reconn';
        txt.textContent = 'Reconnecting...';
      }
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWs, 2200);
  };
}

function sendClockPing() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', sentAtMs: Date.now() }));
}

function showKickedScreen(reason) {
  permanentlyBlocked = true;
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  try { if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo(); } catch (_) {}
  try { if (ws) ws.close(); } catch (_) {}
  document.getElementById('pinGate').classList.add('hidden');
  document.getElementById('kickedReason').textContent = reason || 'Your access to this study room has ended.';
  document.getElementById('kickedScreen').classList.remove('hidden');
}

async function submitJoin() {
  const n = (document.getElementById('nameField').value || '').trim().slice(0, 28) || 'Study Peer';
  const p = (document.getElementById('pinField').value || '').trim();
  displayName = n;
  currentPin = p;
  aesKeyPromise = null;
  try { localStorage.setItem('sp_name', n); } catch (_) {}
  document.getElementById('gateError').textContent = '';
  await sendJoinHandshake();
}

async function sendJoinHandshake() {
  if (!ws || ws.readyState !== 1) {
    pendingJoinClick = true;
    document.getElementById('gateError').textContent = 'Connecting... joining automatically in a moment.';
    if (!ws || ws.readyState === 3) connectWs();
    return;
  }
  pendingJoinClick = false;
  const pinHash = currentPin ? await sha256Hex(ROOM_CODE + ':' + currentPin) : '';
  ws.send(JSON.stringify({ type: 'join', displayName: displayName || 'Study Peer', pinHash, clientId: CLIENT_ID }));
}

async function handleWsMessage(msg) {
  switch (msg.type) {
    case 'pong': {
      const now = Date.now();
      const rtt = Math.max(1, now - (msg.sentAtMs || now));
      if (msg.serverNowMs) {
        serverClockOffsetMs = msg.serverNowMs - (now - rtt / 2);
      }
      return;
    }

    case 'room_meta': {
      if (msg.serverNowMs) serverClockOffsetMs = msg.serverNowMs - Date.now();
      const pinField = document.getElementById('pinField');
      pinField.style.display = msg.pinRequired ? 'block' : 'none';
      const statusEl = document.getElementById('gateStatusMsg');
      if (msg.roomLocked) statusEl.textContent = 'Room is currently locked by Host.';
      else if (msg.roomActive) statusEl.textContent = msg.pinRequired ? 'Enter your name and the 4-digit Room PIN to join.' : 'Room is live! Enter your name to join.';
      else statusEl.textContent = 'Waiting for Host to start the study session...';
      return;
    }

    case 'auth_error': {
      document.getElementById('gateError').textContent = msg.message || 'Unable to join room.';
      return;
    }

    case 'kicked': {
      showKickedScreen(msg.reason || 'Removed from study room by Host.');
      return;
    }

    case 'room_closed': {
      showKickedScreen(msg.reason || 'Host ended the study session.');
      return;
    }

    case 'room_snapshot': {
      joined = true;
      document.getElementById('pinGate').classList.add('hidden');
      e2eeEnabled = Boolean(msg.e2eeEnabled);
      document.getElementById('e2eeBadge').style.display = e2eeEnabled ? 'inline' : 'none';
      allowCrewAi = msg.allowCrewAi !== false;
      allowCrewNotes = msg.allowCrewNotes !== false;
      isSelfMuted = Boolean(msg.isSelfMuted);
      selfMutedUntilMs = Number(msg.selfMutedUntilMs || 0);
      if (typeof msg.switchSeq === 'number') currentSwitchSeq = msg.switchSeq;
      applyGovernanceUi(msg);

      document.getElementById('videoTitle').textContent = msg.title || 'Live Study Room';
      document.getElementById('channelMeta').textContent = msg.channelTitle || 'ShieldPro Study';

      const prevVid = activeVideoId;
      activeVideoId = msg.videoId || '';
      lastHostPos = Number(msg.positionSec || 0);
      lastHostPlaying = msg.isPlaying !== false;
      lastHostSpeed = Number(msg.speed || 1.0);
      lastHostServerMs = Number(msg.serverNowMs || msg.sentAtMs || Date.now());
      lastHostDurationSec = Number(msg.durationSec || 0);

      if (msg.youtubeId) {
        mountOrSwitchYouTube(msg.youtubeId, lastHostPos, lastHostPlaying, lastHostSpeed, prevVid !== activeVideoId);
        if (prevVid && prevVid === activeVideoId) {
          applySmoothSync(lastHostPos, lastHostPlaying, lastHostSpeed, { forceHard: false, laggingOnly: true });
        } else {
          setTimeout(() => applySmoothSync(getEstimatedHostNowPos(), lastHostPlaying, lastHostSpeed, { initialJoin: true }), 800);
        }
      } else if (msg.driveVideoUrl && safeUrl(msg.driveVideoUrl)) {
        activeDriveUrl = msg.driveVideoUrl;
        document.getElementById('ytPlayerMount').style.display = 'none';
        const df = document.getElementById('driveFrame');
        df.src = safeUrl(msg.driveVideoUrl);
        df.style.display = 'block';
        document.getElementById('stagePlaceholder').style.display = 'none';
      }

      applyStageEffects(msg);
      renderNotesFromPayload(msg.notesPayload, msg.chapters || []);
      renderFilesList(msg.resources || []);
      renderVideoRequests(msg.videoRequests || []);
      renderPlaylistRequests(msg.playlistRequests || []);
      renderUpNextQueue(msg.upNextQueue || []);
      renderDoubtQueue(msg.doubtQueue || []);
      renderPoll(msg.activePoll || null);

      if (Array.isArray(msg.chatHistory)) {
        for (const item of msg.chatHistory) {
          const dec = await decryptPayload(item);
          if (dec) appendChatBubble(dec, false);
        }
        scrollChatToBottom(true);
      }
      return;
    }

    case 'video_switch': {
      // Lightweight atomic track switch: ZERO chat re-decrypt, ZERO Notes/Files/Queue flicker!
      if (typeof msg.switchSeq === 'number') {
        if (msg.switchSeq < currentSwitchSeq) return;
        currentSwitchSeq = msg.switchSeq;
      }
      document.getElementById('videoTitle').textContent = msg.title || 'Live Study Room';
      document.getElementById('channelMeta').textContent = msg.channelTitle || 'ShieldPro Study';
      activeVideoId = msg.videoId || '';
      lastHostPos = Number(msg.positionSec || 0);
      lastHostPlaying = msg.isPlaying !== false;
      lastHostSpeed = Number(msg.speed || 1.0);
      lastHostServerMs = Number(msg.serverNowMs || msg.sentAtMs || Date.now());
      lastHostDurationSec = Number(msg.durationSec || 0);
      reportedDurationForVid = '';
      lastReportedDur = 0;

      if (Array.isArray(msg.upNextQueue)) {
        renderUpNextQueue(msg.upNextQueue);
      }

      if (msg.youtubeId) {
        mountOrSwitchYouTube(msg.youtubeId, lastHostPos, lastHostPlaying, lastHostSpeed, true);
      } else if (msg.driveVideoUrl && safeUrl(msg.driveVideoUrl)) {
        activeDriveUrl = msg.driveVideoUrl;
        document.getElementById('ytPlayerMount').style.display = 'none';
        const df = document.getElementById('driveFrame');
        df.src = safeUrl(msg.driveVideoUrl);
        df.style.display = 'block';
        document.getElementById('stagePlaceholder').style.display = 'none';
      }
      return;
    }

    case 'duration_sync': {
      const d = Math.floor(Number(msg.durationSec || 0));
      if (d > 10 && (!msg.videoId || msg.videoId === activeVideoId || msg.videoId === activeYoutubeId)) {
        lastHostDurationSec = d;
      }
      return;
    }

    case 'host_status': {
      if (msg.online) {
        showToast('✅ Host is back online');
      } else {
        showToast('📡 Host momentarily offline — stream & chat stay live');
      }
      return;
    }

    case 'playback_sync': {
      if (msg.videoId && activeVideoId && msg.videoId !== activeVideoId && msg.videoId !== activeYoutubeId) return;
      lastHostPos = Number(msg.positionSec || 0);
      if (Number(msg.durationSec || 0) > 10) lastHostDurationSec = Number(msg.durationSec);
      lastHostPlaying = msg.isPlaying !== false;
      lastHostSpeed = Number(msg.speed || 1.0);
      lastHostServerMs = Number(msg.serverNowMs || msg.sentAtMs || Date.now());
      applySmoothSync(getEstimatedHostNowPos(), lastHostPlaying, lastHostSpeed, { forceHard: Boolean(msg.forceSeek), laggingOnly: true });
      return;
    }

    case 'sync_pulse': {
      if (msg.videoId && activeVideoId && msg.videoId !== activeVideoId && msg.videoId !== activeYoutubeId) return;
      lastHostPos = Number(msg.positionSec || 0);
      if (Number(msg.durationSec || 0) > 10) lastHostDurationSec = Number(msg.durationSec);
      lastHostPlaying = msg.isPlaying !== false;
      lastHostSpeed = Number(msg.speed || 1.0);
      lastHostServerMs = Number(msg.serverNowMs || Date.now());
      applySmoothSync(getEstimatedHostNowPos(), lastHostPlaying, lastHostSpeed, {
        forceHard: !msg.laggingOnly,
        laggingOnly: msg.laggingOnly !== false,
        syncId: msg.syncId || 0,
      });
      return;
    }

    case 'host_command': {
      if (msg.action === 'pause') {
        lastHostPos = typeof msg.resolvedPositionSec === 'number' ? msg.resolvedPositionSec : getEstimatedHostNowPos();
        lastHostServerMs = Number(msg.serverNowMs || Date.now());
        lastHostPlaying = false;
        clearAutoplayRetries();
        try { ytPlayer?.pauseVideo(); } catch(_){}
      }
      if (msg.action === 'play') {
        if (typeof msg.resolvedPositionSec === 'number') lastHostPos = msg.resolvedPositionSec;
        lastHostServerMs = Number(msg.serverNowMs || Date.now());
        lastHostPlaying = true;
        try { ytPlayer?.playVideo(); } catch(_){}
        ensureAutoplayKick();
      }
      if (msg.action === 'seek' && typeof msg.timestampSec === 'number') {
        lastHostPos = msg.timestampSec; lastHostServerMs = Number(msg.serverNowMs || Date.now());
        lastHostPlaying = true;
        applySmoothSync(msg.timestampSec, true, lastHostSpeed, { forceHard: true, laggingOnly: false });
      }
      if (msg.action === 'skip' && typeof msg.skipDeltaSec === 'number') {
        const cur = ytPlayer?.getCurrentTime ? ytPlayer.getCurrentTime() : getEstimatedHostNowPos();
        const target = typeof msg.resolvedPositionSec === 'number' ? msg.resolvedPositionSec : Math.max(0, cur + msg.skipDeltaSec);
        lastHostPos = target; lastHostServerMs = Number(msg.serverNowMs || Date.now());
        applySmoothSync(target, lastHostPlaying, lastHostSpeed, { forceHard: true, laggingOnly: false });
      }
      if (msg.action === 'speed' && msg.speed) { lastHostSpeed = msg.speed; try { ytPlayer?.setPlaybackRate(msg.speed); } catch(_){} }
      if (msg.action === 'volume' && typeof msg.volume === 'number') { try { ytPlayer?.setVolume(msg.volume); } catch(_){} }
      if (msg.action === 'mute' && typeof msg.muted === 'boolean') { try { msg.muted ? ytPlayer?.mute() : ytPlayer?.unMute(); } catch(_){} }
      if (msg.action === 'note' && msg.note) showToast(msg.note);
      applyStageEffects(msg);
      return;
    }

    case 'chat_message': {
      const dec = await decryptPayload(msg.payload);
      if (dec) {
        if (!dec.id && msg.msgId) dec.id = msg.msgId;
        appendChatBubble(dec, true);
      }
      return;
    }

    case 'chat_deleted': {
      const ids = Array.isArray(msg.messageIds) ? msg.messageIds : [];
      for (const id of ids) {
        const node = chatNodeById.get(id);
        if (node && node.parentNode) node.parentNode.removeChild(node);
        chatNodeById.delete(id);
        chatMetaById.delete(id);
        renderedChatIds.delete(id);
      }
      return;
    }

    case 'ai_thinking': {
      const bar = document.getElementById('typingBar');
      if (msg.thinking) {
        bar.textContent = '✨ Mentor Pro AI is analyzing this lecture...';
        bar.classList.add('show');
      } else {
        renderTypingBar();
      }
      return;
    }

    case 'typing': {
      const key = msg.senderId || msg.senderName || 'peer';
      clearTimeout(typingExpiryTimers.get(key));
      if (msg.isTyping) {
        typingPeers.set(key, msg.senderName || 'Peer');
        // 3.5s self-healing auto-expiry so typing NEVER gets stuck when switching to Search!
        typingExpiryTimers.set(key, setTimeout(() => {
          typingPeers.delete(key);
          typingExpiryTimers.delete(key);
          renderTypingBar();
        }, 3500));
      } else {
        typingPeers.delete(key);
        typingExpiryTimers.delete(key);
      }
      renderTypingBar();
      return;
    }

    case 'mute_status': {
      isSelfMuted = Boolean(msg.isMuted);
      selfMutedUntilMs = Number(msg.mutedUntilMs || 0);
      updateComposerLockUi();
      showToast(isSelfMuted ? '🔇 You have been muted from chat by Host' : '🔊 Host unmuted your chat');
      return;
    }

    case 'room_governance': {
      applyGovernanceUi(msg);
      return;
    }

    case 'video_requests_update': {
      renderVideoRequests(msg.requests || []);
      return;
    }

    case 'playlist_requests_update': {
      renderPlaylistRequests(msg.playlistRequests || []);
      return;
    }

    case 'queue_update': {
      renderUpNextQueue(msg.queue || []);
      return;
    }

    case 'doubt_queue_update': {
      renderDoubtQueue(msg.doubts || []);
      return;
    }

    case 'poll_update': {
      renderPoll(msg.poll || null);
      return;
    }

    case 'reaction': {
      spawnFloatingReaction(msg.emoji || '💡');
      return;
    }

    case 'notes_sync': {
      renderNotesFromPayload(msg.payload, null);
      return;
    }

    case 'note_live_item': {
      const dec = await decryptPayload(msg.payload);
      if (dec && dec.note) prependLiveNoteCard(dec.senderName || 'Crew', dec.note, dec.positionSec || 0);
      return;
    }

    case 'resources_update': {
      renderFilesList(msg.resources || []);
      return;
    }

    case 'resource_focus': {
      if (msg.resource) openResourceOverlay(msg.resource);
      return;
    }

    case 'roster': {
      renderCrewRoster(msg.members || []);
      return;
    }

    case 'notice': {
      if (msg.message) showToast(msg.message);
      return;
    }
  }
}

function applyGovernanceUi(g) {
  if (typeof g.chatMutedAll === 'boolean') chatMutedAll = g.chatMutedAll;
  if (typeof g.slowModeSec === 'number') slowModeSec = g.slowModeSec;
  if (typeof g.allowVideoRequests === 'boolean') allowVideoRequests = g.allowVideoRequests;
  if (typeof g.allowReactions === 'boolean') allowReactions = g.allowReactions;
  if (typeof g.autoPlayQueue === 'boolean') autoPlayQueue = g.autoPlayQueue;
  if (typeof g.privacyShieldEnabled === 'boolean') applyPrivacyShield(g.privacyShieldEnabled);

  const pinText = String(g.pinnedAnnouncement || '').trim();
  const pinEl = document.getElementById('pinnedBanner');
  if (pinText) {
    document.getElementById('pinnedText').textContent = pinText;
    pinEl.classList.add('show');
  } else {
    pinEl.classList.remove('show');
  }

  document.getElementById('reactionBar').style.display = (allowReactions && !chatMutedAll && !isSelfMuted) ? 'flex' : 'none';
  updateComposerLockUi();
}

// Multi-Layer Chat Privacy Shield (Dynamic Diagonal Watermark + Instant Blur Curtain + Capture Shortcut Alert)
let watermarkRefreshTimer = null;
function renderPrivacyWatermark() {
  const wm = document.getElementById('privacyWatermark');
  if (!wm) return;
  if (!privacyShieldEnabled) { wm.style.backgroundImage = 'none'; return; }
  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const label = (displayName || 'Peer').replace(/[<>&"']/g, '').slice(0, 18) + ' • ' + ROOM_CODE + ' • ' + hhmm;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="150">' +
    '<text x="130" y="78" fill="rgba(230,198,135,0.095)" font-family="sans-serif" font-size="11.5" font-weight="700" text-anchor="middle" transform="rotate(-24 130 78)">' +
    label + '</text></svg>';
  wm.style.backgroundImage = 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
}
function applyPrivacyShield(enabled) {
  const prev = privacyShieldEnabled;
  privacyShieldEnabled = Boolean(enabled);
  document.body.classList.toggle('privacy-shield-on', privacyShieldEnabled);
  const badge = document.getElementById('privacyBadge');
  if (badge) badge.style.display = privacyShieldEnabled ? 'inline' : 'none';
  clearInterval(watermarkRefreshTimer);
  if (privacyShieldEnabled) {
    renderPrivacyWatermark();
    watermarkRefreshTimer = setInterval(renderPrivacyWatermark, 60000);
    if (prev !== privacyShieldEnabled && joined) showToast('🛡️ Host enabled Chat Privacy Shield');
  } else {
    renderPrivacyWatermark();
    const curtain = document.getElementById('privacyCurtain');
    if (curtain) curtain.classList.remove('show');
    if (prev !== privacyShieldEnabled && joined) showToast('🔓 Chat Privacy Shield turned OFF');
  }
}
function triggerPrivacyCurtain(reason) {
  if (!privacyShieldEnabled || !joined) return;
  const curtain = document.getElementById('privacyCurtain');
  if (curtain) curtain.classList.add('show');
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'privacy_alert', reason }));
  }
}
document.getElementById('privacyCurtain').addEventListener('click', () => {
  document.getElementById('privacyCurtain').classList.remove('show');
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopTypingNow();
    triggerPrivacyCurtain('Switched tab or minimized window');
  }
});
window.addEventListener('blur', () => {
  if (!privacyShieldEnabled || !joined) return;
  setTimeout(() => {
    // Clicking inside the YouTube or Drive video iframe triggers window blur — never false-alert!
    if (document.activeElement && document.activeElement.tagName === 'IFRAME') return;
    if (privacyShieldEnabled && joined) triggerPrivacyCurtain('Window focus lost');
  }, 60);
});
document.addEventListener('keydown', (e) => {
  if (!privacyShieldEnabled || !joined) return;
  const k = String(e.key || '').toLowerCase();
  const isCaptureShortcut =
    k === 'printscreen' ||
    ((e.ctrlKey || e.metaKey) && e.shiftKey && ['s', '3', '4', '5'].includes(k)) ||
    ((e.ctrlKey || e.metaKey) && k === 'p');
  if (isCaptureShortcut) {
    e.preventDefault();
    triggerPrivacyCurtain('Pressed capture/print shortcut');
    showToast('🛡️ Chat Privacy Shield blocked capture shortcut');
  }
});
['contextmenu', 'copy', 'cut'].forEach((evt) => {
  document.getElementById('sidePanel').addEventListener(evt, (e) => {
    if (!privacyShieldEnabled) return;
    if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) return;
    e.preventDefault();
    showToast('🛡️ Copying is restricted by Chat Privacy Shield');
  });
});

function updateComposerLockUi() {
  const banner = document.getElementById('muteLockBanner');
  const row = document.getElementById('composerRow');
  if (isSelfMuted) {
    const minsLeft = selfMutedUntilMs > Date.now() ? Math.ceil((selfMutedUntilMs - Date.now()) / 60000) : 0;
    banner.textContent = minsLeft > 0
      ? '🔇 You are muted from chat by Host (' + minsLeft + 'm remaining)'
      : '🔇 You have been muted from chat by Host';
    banner.classList.add('show');
    row.style.display = 'none';
  } else if (chatMutedAll) {
    banner.textContent = '🔒 Lecture Focus Lock — Host temporarily muted room chat';
    banner.classList.add('show');
    row.style.display = 'none';
  } else {
    banner.classList.remove('show');
    row.style.display = 'flex';
    chatInputEl.placeholder = slowModeSec > 0 ? 'Message room (Slow mode: ' + slowModeSec + 's)...' : 'Message study room...';
  }
}

function applyStageEffects(st) {
  if (typeof st.zoomScale === 'number' || typeof st.panX === 'number' || typeof st.panY === 'number') {
    const z = Number(st.zoomScale || 1);
    const px = Number(st.panX || 0);
    const py = Number(st.panY || 0);
    document.getElementById('videoZoomWrap').style.transform = 'scale(' + z + ') translate(' + px + '%, ' + py + '%)';
  }
  if (typeof st.layoutMode === 'string') {
    document.getElementById('blackoutCover').classList.toggle('show', st.layoutMode === 'blackout');
    if (st.layoutMode === 'cinema') { isCinema = true; document.getElementById('workspace').classList.add('cinema'); }
    else if (st.layoutMode === 'split') { isCinema = false; document.getElementById('workspace').classList.remove('cinema'); }
  }
  if (typeof st.laserActive === 'boolean' || typeof st.isLaserActive === 'boolean') {
    const on = Boolean(st.laserActive ?? st.isLaserActive);
    const dot = document.getElementById('laserDot');
    dot.style.display = on ? 'block' : 'none';
    dot.style.left = (st.laserX ?? st.laserXPercent ?? 50) + '%';
    dot.style.top = (st.laserY ?? st.laserYPercent ?? 50) + '%';
  }
  if (st.pomodoroAction || typeof st.isPomodoroRunning === 'boolean') {
    const running = st.pomodoroAction === 'start' || Boolean(st.isPomodoroRunning);
    pomoPhase = st.pomodoroPhase || 'FOCUS';
    if (st.pomodoroAction === 'start') pomoRemSec = Math.max(1, Number(st.pomodoroMinutes || 25)) * 60;
    else if (typeof st.pomodoroRemainingSec === 'number') pomoRemSec = st.pomodoroRemainingSec;
    else if (st.pomodoroAction === 'reset' || st.pomodoroAction === 'stop') pomoRemSec = 0;

    clearInterval(pomoInterval);
    const pill = document.getElementById('pomoPill');
    if (running && pomoRemSec > 0) {
      pill.classList.add('show');
      document.getElementById('pomoText').textContent = pomoPhase + ' ' + fmtSec(pomoRemSec);
      pomoInterval = setInterval(() => {
        pomoRemSec = Math.max(0, pomoRemSec - 1);
        document.getElementById('pomoText').textContent = pomoPhase + ' ' + fmtSec(pomoRemSec);
        if (pomoRemSec <= 0) { clearInterval(pomoInterval); pill.classList.remove('show'); }
      }, 1000);
    } else if (pomoRemSec <= 0) {
      pill.classList.remove('show');
    }
  }
}

// Elite Editorial Markdown & Adaptive Comparison Matrix Engine (Cards on Phone + Sticky Table on Tablet/Desktop)
function parseTsSec(ts) {
  const parts = String(ts || '').split(':').map((n) => parseInt(n, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}
function jumpToTs(sec) {
  if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
    syncMode = 'free';
    document.getElementById('modeToggleLabel').textContent = 'Free Explore';
    document.getElementById('modeToggleBtn').classList.remove('gold');
    document.getElementById('modeToggleBtn').classList.add('active');
    try { ytPlayer.seekTo(sec, true); ytPlayer.playVideo(); } catch (_) {}
    showToast('⏱ Jumped to ' + fmtSec(sec));
  }
}
function cleanLatexWeb(expr) {
  return String(expr || '')
    .replace(/\\\\(?:text|textbf|mathbf|mathrm|mathit|operatorname)\\{([^{}]*)\\}/g, '$1')
    .replace(/\\\\frac\\{([^{}]*)\\}\\{([^{}]*)\\}/g, '($1) / ($2)')
    .replace(/\\\\times/g, '×').replace(/\\\\div/g, '÷').replace(/\\\\cdot/g, '·')
    .replace(/\\\\pm/g, '±').replace(/\\\\approx/g, '≈').replace(/\\\\neq/g, '≠')
    .replace(/\\\\leq/g, '≤').replace(/\\\\geq/g, '≥').replace(/\\\\rightarrow/g, '→')
    .replace(/\\\\Rightarrow/g, '⇒').replace(/\\\\sum/g, 'Σ').replace(/\\\\Delta/g, 'Δ')
    .replace(/\\\\left|\\\\right/g, '').replace(/[{}]/g, '').trim();
}
function renderInlineMd(raw) {
  let s = esc(raw || '');
  s = s.replace(/\\$([^$\\n]{1,180})\\$/g, (_, m) => '<span class="ai-code-inline">' + cleanLatexWeb(m) + '</span>');
  s = s.replace(/\\x60([^\\x60]+)\\x60/g, '<span class="ai-code-inline">$1</span>');
  s = s.replace(/\\*\\*([\\s\\S]+?)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\\*])\\*([^\\*\\n]+?)\\*/g, '$1<span class="ai-em">$2</span>');
  s = s.replace(/\\[(\\d{1,2}:\\d{2}(?::\\d{2})?)\\]/g, (_, ts) => {
    const sec = parseTsSec(ts);
    return '<button type="button" class="ai-ts-chip" onclick="jumpToTs(' + sec + ')">⏱ ' + ts + '</button>';
  });
  return s;
}
function splitMdPipeRow(line) {
  let t = String(line || '').trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}
function isMdTableDivider(line) {
  const cells = splitMdPipeRow(line);
  return cells.length >= 2 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}
let aiTableCounter = 0;
function renderAdaptiveMdTable(tableLines) {
  if (!tableLines || tableLines.length < 2) return '';
  const hasDiv = isMdTableDivider(tableLines[1]);
  const headers = splitMdPipeRow(tableLines[0]);
  const bodyStart = hasDiv ? 2 : 1;
  const rows = [];
  for (let r = bodyStart; r < tableLines.length; r++) {
    rows.push(splitMdPipeRow(tableLines[r]));
  }
  const tblId = 'aiTbl_' + (++aiTableCounter);
  const defaultMode = window.innerWidth < 640 ? 'mode-cards' : 'mode-table';
  const toggleText = defaultMode === 'mode-cards' ? '📊 Table' : '🃏 Cards';

  let tableHtml = '<div class="ai-tbl-scroll"><table class="ai-tbl"><thead><tr>';
  headers.forEach((h) => { tableHtml += '<th>' + renderInlineMd(h) + '</th>'; });
  tableHtml += '</tr></thead><tbody>';
  rows.forEach((cells) => {
    tableHtml += '<tr>';
    for (let c = 0; c < Math.max(headers.length, cells.length); c++) {
      tableHtml += '<td class="ai-td">' + renderInlineMd(cells[c] || '') + '</td>';
    }
    tableHtml += '</tr>';
  });
  tableHtml += '</tbody></table></div>';

  let cardsHtml = '<div class="ai-tbl-cards">';
  rows.forEach((cells) => {
    const titleVal = cells[0] || '';
    cardsHtml += '<div class="ai-rc-card">';
    if (titleVal) cardsHtml += '<div class="ai-rc-head">' + renderInlineMd(titleVal) + '</div>';
    cardsHtml += '<div class="ai-rc-body">';
    for (let c = 1; c < Math.max(headers.length, cells.length); c++) {
      const colLabel = headers[c] || ('Column ' + (c + 1));
      const val = cells[c] || '—';
      cardsHtml += '<div class="ai-rc-row"><div class="ai-rc-key">' + renderInlineMd(colLabel) + '</div><div class="ai-rc-val">' + renderInlineMd(val) + '</div></div>';
    }
    cardsHtml += '</div></div>';
  });
  cardsHtml += '</div>';

  return '<div class="ai-tbl-block ' + defaultMode + '" id="' + tblId + '">' +
    '<div class="ai-tbl-toolbar">' +
      '<span class="ai-tbl-label">📊 Comparison • ' + rows.length + ' rows</span>' +
      '<div class="ai-tbl-actions">' +
        '<button type="button" class="ai-tbl-btn" onclick="toggleAiTableMode(\\x27' + tblId + '\\x27, this)">' + toggleText + '</button>' +
        '<button type="button" class="ai-tbl-btn" onclick="openTableModal(\\x27' + tblId + '\\x27)">⤢ Expand</button>' +
      '</div>' +
    '</div>' +
    tableHtml + cardsHtml +
  '</div>';
}
function toggleAiTableMode(tblId, btn) {
  const el = document.getElementById(tblId);
  if (!el) return;
  const toTable = el.classList.contains('mode-cards');
  el.classList.toggle('mode-cards', !toTable);
  el.classList.toggle('mode-table', toTable);
  if (btn) btn.textContent = toTable ? '🃏 Cards' : '📊 Table';
}
function openTableModal(tblId) {
  const el = document.getElementById(tblId);
  const body = document.getElementById('tableModalBody');
  const modal = document.getElementById('tableModal');
  if (!el || !body || !modal) return;
  body.innerHTML = el.innerHTML;
  modal.classList.add('show');
}
function closeTableModal() {
  const modal = document.getElementById('tableModal');
  if (modal) modal.classList.remove('show');
}
function renderEliteMarkdown(rawText) {
  if (!rawText) return '';
  let norm = String(rawText).replace(/\\r\\n/g, '\\n').replace(/\\bNaN:NaN\\b|\\bNaN\\b/g, '0:00');
  const codeBlocks = [];
  norm = norm.replace(/\\x60\\x60\\x60([a-zA-Z0-9_-]*)[ \\t]*\\n?([\\s\\S]*?)\\x60\\x60\\x60/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: (lang || '').trim(), code: esc((code || '').trimEnd()) });
    return '\\n@@CODE_' + idx + '@@\\n';
  });
  const mathBlocks = [];
  norm = norm.replace(/\\$\\$([\\s\\S]*?)\\$\\$/g, (_, expr) => {
    const idx = mathBlocks.length;
    mathBlocks.push(esc(cleanLatexWeb(expr)));
    return '\\n@@MATH_' + idx + '@@\\n';
  });
  const lines = norm.split('\\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) continue;
    const cm = t.match(/^@@CODE_(\\d+)@@$/);
    if (cm) {
      const cb = codeBlocks[Number(cm[1])];
      if (cb) {
        out.push('<div class="ai-code-wrap">' + (cb.lang ? '<div class="ai-code-lang">' + esc(cb.lang) + '</div>' : '') + '<pre class="ai-code-pre">' + cb.code + '</pre></div>');
      }
      continue;
    }
    const mm = t.match(/^@@MATH_(\\d+)@@$/);
    if (mm) { out.push('<div class="ai-formula">' + (mathBlocks[Number(mm[1])] || '') + '</div>'); continue; }
    if (t.includes('|') && (t.startsWith('|') || (i + 1 < lines.length && isMdTableDivider(lines[i + 1])))) {
      const tLines = [t];
      let j = i + 1;
      while (j < lines.length) {
        const nt = lines[j].trim();
        if (!nt || !nt.includes('|')) break;
        tLines.push(nt);
        j++;
      }
      if (tLines.length >= 2) {
        out.push(renderAdaptiveMdTable(tLines));
        i = j - 1;
        continue;
      }
    }
    if (/^(?:---+|___+|\\*\\*\\*+)$/.test(t)) { out.push('<hr class="ai-hr">'); continue; }
    const hm = t.match(/^#{1,6}\\s+(.+)$/);
    if (hm) { out.push('<div class="ai-h">' + renderInlineMd(hm[1].replace(/^\\*\\*(.*)\\*\\*$/, '$1').trim()) + '</div>'); continue; }
    const qm = t.match(/^>\\s*(.+)$/);
    if (qm) { out.push('<div class="ai-quote">' + renderInlineMd(qm[1]) + '</div>'); continue; }
    const bm = raw.match(/^(\\s*)[*\\-•]\\s+(.+)$/);
    if (bm) {
      const depthCls = bm[1].length >= 2 ? ' depth-1' : '';
      const dot = bm[1].length >= 2 ? '◦' : '•';
      out.push('<div class="ai-li' + depthCls + '"><span class="ai-li-dot">' + dot + '</span><span>' + renderInlineMd(bm[2]) + '</span></div>');
      continue;
    }
    const om = t.match(/^(\\d+)[.)]\\s+(.+)$/);
    if (om) {
      out.push('<div class="ai-li"><span class="ai-li-num">' + esc(om[1]) + '</span><span>' + renderInlineMd(om[2]) + '</span></div>');
      continue;
    }
    out.push('<p class="ai-p">' + renderInlineMd(t) + '</p>');
  }
  return out.join('');
}
const aiRawTextById = new Map();
function copyAiCardText(id) {
  const txt = aiRawTextById.get(id) || '';
  if (!txt) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(() => showToast('📋 Copied Mentor AI answer')).catch(() => showToast('Copy failed'));
  } else {
    showToast('Clipboard unavailable');
  }
}
async function saveAiCardToNotes(id) {
  const txt = aiRawTextById.get(id) || '';
  if (!txt || !ws || ws.readyState !== 1 || !joined) return;
  if (!allowCrewNotes) { showToast('Host paused room notes.'); return; }
  const sec = Math.floor(ytPlayer?.getCurrentTime ? (ytPlayer.getCurrentTime() || 0) : getEstimatedHostNowPos());
  const summary = '[' + fmtSec(sec) + '] ✨ AI Note: ' + txt.replace(/[#*|\\x60]+/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 220);
  const payload = await encryptPayload({ note: summary, positionSec: sec, senderName: displayName || 'Study Peer', timestamp: Date.now() });
  ws.send(JSON.stringify({ type: 'note_add', payload }));
  showToast('📌 Saved to Room Notes');
}

// Categorized Premium Emoji Picker + Recent Memory
const EMOJI_PACKS = [
  { id: 'recent', label: '🕒', items: [] },
  { id: 'vibe', label: '🔥 Vibe', items: ['😂','😭','❤️','🔥','🙌','👏','😍','🤯','🥺','💀','💯','✨','👀','🫡','🤝','🥳','😎','🥹','🤩','🫶','💥','🎉','👑','💎'] },
  { id: 'study', label: '📚 Study', items: ['💡','🧠','📝','📌','✅','❌','⚡','🎯','📖','⏳','🏆','🤓','🤔','🙋','📊','🔍','🚀','💪','🎓','📚','🧾','🗂️','🔔','⭐'] },
  { id: 'music', label: '🎵 Music', items: ['🎵','🎶','🎧','🎤','🎸','🎹','🥁','💃','🕺','🌙','☕','🌧️','🔊','🎼','🫶','🎙️','📻','✨','🌆','💫','🔥','🌊','🎷','🎻'] },
  { id: 'hands', label: '👍 Hands', items: ['👍','👎','👌','✌️','🤞','🙏','💪','🤝','🤙','👋','🫶','🫰','👏','🙌','☝️','👉','🫡','✋','🤟','👊','🤜','🤛','🎉','💯'] },
  { id: 'mood', label: '🎭 Mood', items: ['😀','😅','🤣','😊','😉','😌','😏','😒','😤','😴','🫠','🤡','👻','😈','😇','🫣','🤭','🤫','😬','😮','😱','🥵','🥶','🤒'] }
];
let activeEmojiCat = 'vibe';
let recentEmojis = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem('sp_recent_emojis') || '[]');
    return Array.isArray(raw) ? raw.slice(0, 16) : [];
  } catch (_) { return []; }
})();

function renderEmojiPicker() {
  const catsEl = document.getElementById('emojiCats');
  const gridEl = document.getElementById('emojiGrid');
  if (!catsEl || !gridEl) return;
  EMOJI_PACKS[0].items = recentEmojis.length ? recentEmojis : ['🔥','😂','❤️','💡','🎵','👏','👍','🙌'];
  catsEl.innerHTML = EMOJI_PACKS.map((p) =>
    '<button type="button" class="emoji-cat-btn' + (p.id === activeEmojiCat ? ' active' : '') + '" onclick="selectEmojiCat(\\x27' + p.id + '\\x27)">' + p.label + '</button>'
  ).join('');
  const pack = EMOJI_PACKS.find((p) => p.id === activeEmojiCat) || EMOJI_PACKS[1];
  gridEl.innerHTML = pack.items.map((em) =>
    '<button type="button" class="emoji-cell" onclick="insertEmoji(\\x27' + em + '\\x27)">' + em + '</button>'
  ).join('');
}
function selectEmojiCat(catId) {
  activeEmojiCat = catId;
  renderEmojiPicker();
}
function toggleEmojiDrawer() {
  const drawer = document.getElementById('emojiDrawer');
  const btn = document.getElementById('emojiToggleBtn');
  if (!drawer) return;
  const open = !drawer.classList.contains('show');
  drawer.classList.toggle('show', open);
  if (btn) btn.classList.toggle('active', open);
  if (open) {
    renderEmojiPicker();
    chatInputEl.blur();
  }
}
function closeEmojiDrawer() {
  const drawer = document.getElementById('emojiDrawer');
  const btn = document.getElementById('emojiToggleBtn');
  if (drawer) drawer.classList.remove('show');
  if (btn) btn.classList.remove('active');
}
function insertEmoji(em) {
  const start = chatInputEl.selectionStart ?? chatInputEl.value.length;
  const end = chatInputEl.selectionEnd ?? chatInputEl.value.length;
  const v = chatInputEl.value || '';
  chatInputEl.value = v.slice(0, start) + em + v.slice(end);
  const pos = start + em.length;
  try { chatInputEl.setSelectionRange(pos, pos); } catch (_) {}
  chatInputEl.dispatchEvent(new Event('input'));
  recentEmojis = [em, ...recentEmojis.filter((x) => x !== em)].slice(0, 16);
  try { localStorage.setItem('sp_recent_emojis', JSON.stringify(recentEmojis)); } catch (_) {}
}
function isPureJumboEmoji(str) {
  const t = String(str || '').trim();
  if (!t || t.length > 16) return false;
  // Strip emoji/variation/ZWJ codepoints; if nothing remains and count <= 3 clusters -> jumbo!
  const stripped = t.replace(/[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}\\u{200D}\\s]/gu, '');
  if (stripped.length > 0) return false;
  const glyphs = Array.from(t.replace(/\\s+/g, ''));
  return glyphs.length >= 1 && glyphs.length <= 6;
}

// WhatsApp-style Swipe-to-Reply & Jump-to-Original Highlight
function startReplyTo(msgId) {
  const meta = chatMetaById.get(msgId);
  if (!meta) return;
  activeReplyTarget = {
    id: meta.id,
    senderName: meta.senderName || 'Study Peer',
    snippet: String(meta.text || '').replace(/\\s+/g, ' ').trim().slice(0, 110),
    isAi: Boolean(meta.isAi),
  };
  document.getElementById('replyComposerWho').textContent = 'Replying to ' + activeReplyTarget.senderName;
  document.getElementById('replyComposerSnip').textContent = activeReplyTarget.snippet || 'Message';
  document.getElementById('replyComposerBar').classList.add('show');
  chatInputEl.focus();
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch (_) {} }
}
function cancelReply() {
  activeReplyTarget = null;
  const bar = document.getElementById('replyComposerBar');
  if (bar) bar.classList.remove('show');
}
function jumpToMessage(msgId) {
  const wrap = chatNodeById.get(msgId);
  if (!wrap) { showToast('Original message is older than current window'); return; }
  const card = wrap.querySelector('.msg-card') || wrap;
  wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('highlight-flash');
  void card.offsetWidth;
  card.classList.add('highlight-flash');
}
function attachSwipeToReply(wrap, card, ind, msgId) {
  let sx = 0, sy = 0, dx = 0, locked = null, triggered = false;
  wrap.addEventListener('touchstart', (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    dx = 0; locked = null; triggered = false;
  }, { passive: true });
  wrap.addEventListener('touchmove', (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    const cx = e.touches[0].clientX - sx;
    const cy = e.touches[0].clientY - sy;
    if (locked === null) {
      if (Math.abs(cx) < 8 && Math.abs(cy) < 8) return;
      locked = (cx > 0 && Math.abs(cx) > Math.abs(cy) * 1.35) ? 'h' : 'v';
    }
    if (locked !== 'h') return;
    wrap.classList.add('swiping');
    dx = Math.max(0, Math.min(62, cx * 0.72));
    card.style.transform = 'translateX(' + dx + 'px)';
    const ratio = Math.min(1, dx / 44);
    ind.style.opacity = String(ratio);
    ind.style.transform = 'translateY(-50%) scale(' + (0.65 + ratio * 0.4) + ')';
    if (dx >= 44 && !triggered) {
      triggered = true;
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (_) {} }
    }
  }, { passive: true });
  const finish = () => {
    wrap.classList.remove('swiping');
    card.style.transform = '';
    ind.style.opacity = '0';
    ind.style.transform = 'translateY(-50%) scale(0.6)';
    if (triggered) startReplyTo(msgId);
    locked = null; dx = 0; triggered = false;
  };
  wrap.addEventListener('touchend', finish, { passive: true });
  wrap.addEventListener('touchcancel', finish, { passive: true });
}

// Incremental Zero-Jitter Chat DOM Append
function appendChatBubble(m, isLiveEvent) {
  const id = String(m.id || (m.senderName + ':' + m.timestamp + ':' + (m.text || '').slice(0, 16)));
  if (renderedChatIds.has(id)) return;
  renderedChatIds.add(id);
  chatMetaById.set(id, { id, senderName: m.senderName || 'Study Peer', text: m.text || '', isAi: Boolean(m.isAi) });

  const wasNearBottom = isNearChatBottom();
  const isSelf = !m.isAi && m.senderName === displayName;
  const isJumbo = !m.isAi && !m.slidePreviewUrl && isPureJumboEmoji(m.text);

  const wrap = document.createElement('div');
  wrap.className = 'msg-swipe-wrap';
  wrap.dataset.msgId = id;

  const ind = document.createElement('div');
  ind.className = 'swipe-reply-ind';
  ind.textContent = '↩';
  wrap.appendChild(ind);

  const card = document.createElement('div');
  card.className = 'msg-card' + (m.isAi ? ' ai' : (isSelf ? ' self' : '')) + (isJumbo ? ' jumbo-emoji' : '');
  card.dataset.msgId = id;

  const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const slideSafe = safeUrl(m.slidePreviewUrl);
  const slideHtml = slideSafe ? '<img class="msg-slide" src="' + esc(slideSafe) + '" alt="Lecture slide" loading="lazy">' : '';

  let quoteHtml = '';
  const rep = m.replyTo;
  if (rep && (rep.senderName || rep.snippet)) {
    const repId = String(rep.id || '');
    quoteHtml = '<div class="msg-quote-box" onclick="jumpToMessage(\\x27' + esc(repId) + '\\x27)">' +
      '<div class="msg-quote-sender">↩ ' + esc(rep.senderName || 'Message') + '</div>' +
      '<div class="msg-quote-text">' + esc(rep.snippet || '') + '</div>' +
    '</div>';
  }

  let bodyHtml;
  let footHtml = '';
  if (m.isAi) {
    aiRawTextById.set(id, String(m.text || ''));
    bodyHtml = renderEliteMarkdown(m.text || '');
    footHtml = '<div class="ai-card-foot">' +
      '<button type="button" class="ai-foot-btn" onclick="startReplyTo(\\x27' + esc(id) + '\\x27)">↩ Reply</button>' +
      '<button type="button" class="ai-foot-btn" onclick="saveAiCardToNotes(\\x27' + esc(id) + '\\x27)">📌 Save to Notes</button>' +
      '<button type="button" class="ai-foot-btn" onclick="copyAiCardText(\\x27' + esc(id) + '\\x27)">📋 Copy</button>' +
    '</div>';
  } else {
    bodyHtml = esc(m.text || '');
  }

  card.innerHTML =
    '<div class="msg-head">' +
      '<span class="msg-sender">' + esc(m.senderName || 'Study Peer') + '</span>' +
      '<span style="display:inline-flex;align-items:center;">' +
        '<span class="msg-time">' + esc(timeStr) + '</span>' +
        '<button type="button" class="msg-reply-quick" onclick="startReplyTo(\\x27' + esc(id) + '\\x27)" title="Reply">↩</button>' +
      '</span>' +
    '</div>' +
    quoteHtml +
    '<div class="msg-body">' + bodyHtml + '</div>' + slideHtml + footHtml;

  wrap.appendChild(card);
  attachSwipeToReply(wrap, card, ind, id);

  chatListEl.appendChild(wrap);
  chatNodeById.set(id, wrap);

  // Cap DOM to 140 messages smoothly
  while (chatListEl.children.length > 140) {
    const first = chatListEl.firstElementChild;
    if (first) {
      const fid = first.dataset.msgId;
      chatNodeById.delete(fid);
      chatMetaById.delete(fid);
      chatListEl.removeChild(first);
    }
  }

  if (isLiveEvent) {
    if (activeTab !== 'chat') {
      unreadChatCount++;
      const badge = document.getElementById('chatBadge');
      badge.textContent = String(unreadChatCount);
      badge.classList.add('show');
    }
    if (wasNearBottom || isSelf) {
      chatListEl.scrollTop = chatListEl.scrollHeight;
    } else {
      unreadWhileScrolled++;
      const pill = document.getElementById('newMsgPill');
      pill.textContent = '↓ ' + unreadWhileScrolled + ' New Message' + (unreadWhileScrolled > 1 ? 's' : '');
      pill.classList.add('show');
    }
  }
}

function renderTypingBar() {
  const bar = document.getElementById('typingBar');
  const names = Array.from(typingPeers.values()).slice(0, 2);
  if (names.length === 0) { bar.classList.remove('show'); return; }
  bar.textContent = names.join(', ') + (typingPeers.size > 2 ? ' & others' : '') + ' typing...';
  bar.classList.add('show');
}

function toggleAiTag() {
  tagAiNext = !tagAiNext;
  document.getElementById('aiTagBtn').classList.toggle('active', tagAiNext);
  chatInputEl.focus();
}

async function sendChat() {
  if (!ws || ws.readyState !== 1 || !joined) return;
  if (isSelfMuted || chatMutedAll) return;
  let text = (chatInputEl.value || '').trim();
  if (!text) return;
  if (slowModeSec > 0) {
    const waitMs = (slowModeSec * 1000) - (Date.now() - lastSentChatMs);
    if (waitMs > 0) {
      showToast('⏳ Slow mode active — wait ' + Math.ceil(waitMs / 1000) + 's');
      return;
    }
  }
  lastSentChatMs = Date.now();
  stopTypingNow();
  closeEmojiDrawer();
  const taggedAi = tagAiNext || /@ai\\b|@mentor\\b/i.test(text);
  if (tagAiNext && !/@ai\\b/i.test(text)) text = '@AI ' + text;

  const posSec = Math.floor((ytPlayer && ytPlayer.getCurrentTime) ? (ytPlayer.getCurrentTime() || 0) : lastHostPos);
  const msgObj = {
    id: crypto.randomUUID ? crypto.randomUUID() : ('m_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
    senderName: displayName || 'Study Peer',
    text,
    timestamp: Date.now(),
    isAi: false,
    taggedAi,
    positionSec: posSec,
  };
  if (activeReplyTarget) {
    msgObj.replyTo = {
      id: activeReplyTarget.id,
      senderName: activeReplyTarget.senderName,
      snippet: activeReplyTarget.snippet,
      isAi: activeReplyTarget.isAi,
    };
  }
  chatInputEl.value = '';
  chatInputEl.style.height = 'auto';
  tagAiNext = false;
  document.getElementById('aiTagBtn').classList.remove('active');
  cancelReply();

  appendChatBubble(msgObj, true);
  const payload = await encryptPayload(msgObj);
  ws.send(JSON.stringify({ type: 'chat_post', msgId: msgObj.id, taggedAi, payload }));
}

// In-Page YouTube Search, Playlist Import & Student Request-to-Play
let cachedVideoReqCount = 0;
let cachedPlaylistReqCount = 0;
function updateQueueTabBadge() {
  const totalQ = cachedVideoReqCount + cachedPlaylistReqCount;
  const badge = document.getElementById('queueBadge');
  if (badge) {
    badge.textContent = String(totalQ);
    badge.classList.toggle('show', totalQ > 0);
  }
  const lbl = document.getElementById('reqCountLabel');
  if (lbl) lbl.textContent = String(totalQ);
}

function detectClientPlaylistId(input) {
  const s = String(input || '').trim();
  const m = s.match(/[?&]list=([A-Za-z0-9_-]{2,80})/);
  if (m && m[1]) return m[1];
  if (/^(PL|UU|OLAK5uy_|FL|LL|WL|RD)[A-Za-z0-9_-]{2,76}$/.test(s)) return s;
  return null;
}

async function runYouTubeSearch() {
  const q = (document.getElementById('ytSearchInput').value || '').trim();
  if (!q) return;
  const wrap = document.getElementById('ytSearchResultsWrap');
  const plId = detectClientPlaylistId(q);
  if (plId) {
    wrap.innerHTML = '<div style="font-size:12px;color:var(--gold);padding:8px;">🎶 Loading YouTube Playlist tracks...</div>';
    try {
      const resp = await fetch('/api/yt/playlist?list=' + encodeURIComponent(plId));
      const data = await resp.json();
      if (!data.ok || !data.playlist || !Array.isArray(data.playlist.tracks) || data.playlist.tracks.length === 0) {
        wrap.innerHTML = '<div style="font-size:12px;color:#FCA5A5;padding:10px;border-radius:12px;background:rgba(248,113,113,0.09);border:1px solid rgba(248,113,113,0.3);">' + esc(data.error || 'Could not load playlist. Make sure it is Public or Unlisted on YouTube.') + '</div>';
        return;
      }
      const pl = data.playlist;
      const previewList = pl.tracks.slice(0, 6).map((t, i) =>
        '<div style="font-size:11px;color:#CBD5E1;display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05);">' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">#' + (i + 1) + ' ' + esc(t.title) + '</span>' +
        '<span style="color:var(--muted);flex-shrink:0;">' + esc(t.durationText || '') + '</span></div>'
      ).join('');
      const moreCount = Math.max(0, pl.tracks.length - 6);
      wrap.innerHTML = '';
      const card = document.createElement('div');
      card.className = 'list-card';
      card.style.borderColor = 'rgba(230,198,135,0.45)';
      card.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">' +
        '<span class="badge-mini gold">🎶 FULL PLAYLIST • ' + pl.tracks.length + ' TRACKS</span>' +
        (pl.totalDurationSec > 0 ? '<span style="font-size:11px;color:var(--muted);">' + esc(fmtSec(pl.totalDurationSec)) + '</span>' : '') +
        '</div>' +
        '<div style="font-size:13.5px;font-weight:800;color:var(--goldHi);margin-bottom:3px;">' + esc(pl.title) + '</div>' +
        '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;">By ' + esc(pl.author || 'YouTube') + '</div>' +
        '<div style="margin-bottom:8px;">' + previewList + (moreCount > 0 ? '<div style="font-size:11px;color:var(--gold);padding-top:4px;">+ ' + moreCount + ' more tracks included</div>' : '') + '</div>' +
        '<button class="gold-btn" style="width:100%;padding:9px 12px;font-size:12px;" id="reqFullPlaylistBtn">🎶 Request Full Playlist (' + pl.tracks.length + ' tracks) to Host</button>';
      card.querySelector('#reqFullPlaylistBtn').addEventListener('click', () => requestPlaylistToHost(pl));
      wrap.appendChild(card);
    } catch (_) {
      wrap.innerHTML = '<div style="font-size:12px;color:var(--red);padding:8px;">Playlist load failed. Check connection.</div>';
    }
    return;
  }

  wrap.innerHTML = '<div style="font-size:12px;color:var(--gold);padding:8px;">Searching YouTube...</div>';
  try {
    const resp = await fetch('/api/yt/search?q=' + encodeURIComponent(q));
    const data = await resp.json();
    const list = Array.isArray(data.results) ? data.results : [];
    if (list.length === 0) {
      wrap.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px;">No videos found. Try another keyword or paste a YouTube video or playlist link directly.</div>';
      return;
    }
    wrap.innerHTML = '';
    for (const item of list) {
      const card = document.createElement('div');
      card.className = 'yt-card';
      card.innerHTML =
        '<div class="yt-thumb-wrap"><img src="' + esc(safeUrl(item.thumbnailUrl)) + '" alt="" loading="lazy">' +
        (item.durationText ? '<span class="yt-dur">' + esc(item.durationText) + '</span>' : '') + '</div>' +
        '<div class="yt-meta"><div class="yt-title">' + esc(item.title) + '</div>' +
        '<div class="yt-sub">' + esc(item.channelTitle) + (item.viewsText ? ' • ' + esc(item.viewsText) : '') + '</div>' +
        '<button class="yt-req-btn">Request to Play (Host Approval)</button></div>';
      const reqBtn = card.querySelector('.yt-req-btn');
      reqBtn.addEventListener('click', () => requestVideoToHost(item, reqBtn));
      wrap.appendChild(card);
    }
  } catch (_) {
    wrap.innerHTML = '<div style="font-size:12px;color:var(--red);padding:8px;">Search failed. Check connection.</div>';
  }
}

function requestPlaylistToHost(pl) {
  if (!ws || ws.readyState !== 1 || !joined) return;
  if (!allowVideoRequests) { showToast('Host has paused video requests.'); return; }
  if (isSelfMuted) { showToast('Muted users cannot request playlists.'); return; }
  const note = (document.getElementById('ytRequestNote').value || '').trim();
  ws.send(JSON.stringify({
    type: 'playlist_request',
    playlistId: pl.playlistId,
    title: pl.title,
    author: pl.author || 'YouTube',
    tracks: pl.tracks,
    note,
  }));
  document.getElementById('ytRequestNote').value = '';
  document.getElementById('ytSearchInput').value = '';
  document.getElementById('ytSearchResultsWrap').innerHTML = '';
}

function requestVideoToHost(item, btnEl) {
  if (!ws || ws.readyState !== 1 || !joined) return;
  if (!allowVideoRequests) { showToast('Host has paused video requests.'); return; }
  if (isSelfMuted) { showToast('Muted users cannot request videos.'); return; }
  const note = (document.getElementById('ytRequestNote').value || '').trim();
  ws.send(JSON.stringify({
    type: 'video_request',
    videoId: item.videoId,
    title: item.title,
    channelTitle: item.channelTitle,
    durationSec: item.durationSec || 0,
    durationText: item.durationText || '',
    thumbnailUrl: item.thumbnailUrl,
    note,
  }));
  document.getElementById('ytRequestNote').value = '';
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = '✓ Sent to Host for Approval';
    btnEl.style.opacity = '0.75';
  }
}

function renderPlaylistRequests(playlists) {
  const wrap = document.getElementById('pendingPlaylistsWrap');
  const list = Array.isArray(playlists) ? playlists : [];
  cachedPlaylistReqCount = list.length;
  updateQueueTabBadge();
  if (!wrap) return;
  if (list.length === 0) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = list.map((p) =>
    '<div class="list-card" style="border-color:rgba(230,198,135,0.4);">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:4px;">' +
      '<span class="badge-mini gold">🎶 PLAYLIST REQUEST • ' + (p.tracks ? p.tracks.length : 0) + ' TRACKS</span>' +
      '<span style="font-size:10.5px;color:var(--muted);">Awaiting Host</span></div>' +
      '<div style="font-size:12.5px;font-weight:800;color:var(--goldHi);">' + esc(p.title) + '</div>' +
      '<div style="font-size:11px;color:var(--muted);margin-top:2px;">Requested by <strong style="color:var(--txt);">' + esc(p.requestedByName) + '</strong>' + (p.totalDurationSec > 0 ? ' • ' + esc(fmtSec(p.totalDurationSec)) : '') + '</div>' +
      (p.note ? '<div style="font-size:11px;color:#CBD5E1;margin-top:3px;">“' + esc(p.note) + '”</div>' : '') +
    '</div>'
  ).join('');
}

function renderVideoRequests(requests) {
  const wrap = document.getElementById('pendingRequestsWrap');
  cachedVideoReqCount = requests.length;
  updateQueueTabBadge();
  if (requests.length === 0) {
    wrap.innerHTML = cachedPlaylistReqCount > 0
      ? ''
      : '<div style="font-size:12px;color:var(--muted);">No pending requests. Search above or paste any YouTube video/playlist link to suggest to the Host.</div>';
    return;
  }
  wrap.innerHTML = requests.map((r) =>
    '<div class="yt-card">' +
      '<div class="yt-thumb-wrap" style="width:76px;"><img src="' + esc(safeUrl(r.thumbnailUrl)) + '" alt="">' +
      (r.durationText ? '<span class="yt-dur">' + esc(r.durationText) + '</span>' : '') + '</div>' +
      '<div class="yt-meta"><div class="yt-title">' + esc(r.title) + '</div>' +
      '<div class="yt-sub">Requested by <strong style="color:var(--goldHi)">' + esc(r.requestedByName) + '</strong> • ' + r.upvotes + ' vote' + (r.upvotes > 1 ? 's' : '') + '</div>' +
      (r.note ? '<div style="font-size:11px;color:#CBD5E1;margin-top:2px;">“' + esc(r.note) + '”</div>' : '') +
      '<span class="badge-mini gold" style="display:inline-block;margin-top:4px;">Awaiting Host Approval</span></div></div>'
  ).join('');
}

function renderUpNextQueue(queue) {
  const list = Array.isArray(queue) ? queue : [];
  const wrap = document.getElementById('upNextWrap');
  document.getElementById('upNextCountLabel').textContent = String(list.length);
  const upNextPill = document.getElementById('stageUpNextPill');
  if (upNextPill) {
    if (list.length > 0) {
      upNextPill.style.display = 'inline-flex';
      upNextPill.textContent = '⏭ Next (' + list.length + '): ' + list[0].title;
    } else {
      upNextPill.style.display = 'none';
    }
  }
  if (list.length === 0) {
    wrap.innerHTML = '<div style="font-size:12px;color:var(--muted);">No videos queued yet.</div>';
    return;
  }
  wrap.innerHTML = list.map((q, i) =>
    '<div class="yt-card">' +
      '<div class="yt-thumb-wrap" style="width:76px;"><img src="' + esc(safeUrl(q.thumbnailUrl)) + '" alt="">' +
      (q.durationText ? '<span class="yt-dur">' + esc(q.durationText) + '</span>' : '') + '</div>' +
      '<div class="yt-meta"><div class="yt-title">#' + (i + 1) + ' ' + esc(q.title) + '</div>' +
      '<div class="yt-sub">Added by ' + esc(q.addedByName) + '</div></div></div>'
  ).join('');
}

// Notes, Files, Crew, Doubts, Poll, Reactions
async function renderNotesFromPayload(payload, chapters) {
  const list = document.getElementById('notesList');
  const dec = await decryptPayload(payload);
  const notes = (dec && Array.isArray(dec.notes)) ? dec.notes : [];
  let html = '';
  if (Array.isArray(chapters) && chapters.length > 0) {
    html += '<div class="section-label"><span>Lecture Chapters</span><span>' + chapters.length + '</span></div>';
    html += chapters.map((c) =>
      '<div class="list-card" style="cursor:pointer;" onclick="jumpLocal(' + Number(c.seconds || 0) + ')">' +
      '<div class="list-card-row"><span class="badge-mini gold">' + esc(c.timeLabel || fmtSec(c.seconds)) + '</span><span style="font-size:12.5px;flex:1;">' + esc(c.title) + '</span></div></div>'
    ).join('');
  }
  html += '<div class="section-label" style="margin-top:6px;"><span>Synced Lecture Notes</span><span>' + notes.length + '</span></div>';
  if (notes.length === 0) {
    html += '<div style="font-size:12px;color:var(--muted);">No notes yet. Add a timestamped insight below.</div>';
  } else {
    html += notes.map((n) =>
      '<div class="list-card" style="cursor:pointer;" onclick="jumpLocal(' + Number(n.seconds || 0) + ')">' +
      '<div style="font-size:12.5px;line-height:1.45;">' + esc(n.text) + '</div></div>'
    ).join('');
  }
  list.innerHTML = html;
}

function prependLiveNoteCard(sender, text, posSec) {
  const list = document.getElementById('notesList');
  const el = document.createElement('div');
  el.className = 'list-card';
  el.innerHTML = '<div style="font-size:12.5px;line-height:1.45;"><strong style="color:var(--gold);">[' + esc(fmtSec(posSec)) + '] ' + esc(sender) + ':</strong> ' + esc(text) + '</div>';
  list.appendChild(el);
}

async function addLiveNote() {
  if (!ws || ws.readyState !== 1 || !joined) return;
  const inp = document.getElementById('noteInput');
  const note = (inp.value || '').trim();
  if (!note) return;
  const posSec = Math.floor((ytPlayer && ytPlayer.getCurrentTime) ? (ytPlayer.getCurrentTime() || 0) : lastHostPos);
  inp.value = '';
  const payload = await encryptPayload({ note, senderName: displayName || 'Crew', positionSec: posSec });
  ws.send(JSON.stringify({ type: 'note_add', payload }));
  prependLiveNoteCard(displayName || 'You', note, posSec);
  showToast('Note saved to study desk');
}

function jumpLocal(sec) {
  if (syncMode === 'synced') toggleSyncMode();
  try { ytPlayer?.seekTo(sec, true); } catch (_) {}
}

function renderFilesList(files) {
  const el = document.getElementById('filesList');
  if (!files.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--muted);">No shared PDFs or slides yet. Upload a study sheet or paste a Google Drive link above.</div>';
    return;
  }
  el.innerHTML = files.map((f) => {
    const viewHref = safeUrl(f.viewUrl || f.url);
    return '<div class="list-card"><div class="list-card-row"><strong style="font-size:12.5px;word-break:break-word;">' + esc(f.name) + '</strong><span class="badge-mini">' + (f.isDriveLink ? 'Drive' : Math.max(1, Math.round((f.size || 0)/1024)) + ' KB') + '</span></div>' +
      '<div class="list-card-row" style="margin-top:4px;"><span style="font-size:11px;color:var(--sub);">By ' + esc(f.uploaderName || 'Crew') + '</span>' +
      (viewHref ? '<a href="' + esc(viewHref) + '" target="_blank" rel="noopener" class="dock-btn" style="padding:4px 9px;font-size:11px;text-decoration:none;">Open</a>' : '') + '</div></div>';
  }).join('');
}

function openResourceOverlay(res) {
  const u = safeUrl(res.viewUrl || res.url);
  if (!u) return;
  document.getElementById('resourceOverlayTitle').textContent = res.name || 'Focused Study Resource';
  document.getElementById('resourceOverlayFrame').src = u;
  document.getElementById('resourceOverlay').classList.add('show');
}
function closeResourceOverlay() {
  document.getElementById('resourceOverlay').classList.remove('show');
  document.getElementById('resourceOverlayFrame').src = 'about:blank';
}

function shareDriveLink() {
  const inp = document.getElementById('driveLinkInput');
  const u = (inp.value || '').trim();
  if (!u || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'resource_add', name: 'Shared Drive Resource', url: u, isDriveLink: u.includes('drive.google.com') }));
  inp.value = '';
  showToast('Shared link with room');
}

async function uploadStudyFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 35 * 1024 * 1024) { showToast('Max 35MB. Use a Drive link for larger files.'); return; }
  showToast('Uploading ' + file.name + '...');
  try {
    const resp = await fetch('/api/rooms/' + encodeURIComponent(ROOM_CODE) + '/files', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/pdf',
        'X-File-Name': encodeURIComponent(file.name),
        'X-Uploader-Name': encodeURIComponent(displayName || 'Crew'),
        'X-Room-Pin': currentPin || '',
      },
      body: file,
    });
    const j = await resp.json();
    showToast(j.ok ? 'Uploaded ' + file.name : (j.error || 'Upload failed'));
  } catch (_) { showToast('Upload failed'); }
  input.value = '';
}

function renderCrewRoster(members) {
  document.getElementById('crewOnlineCnt').textContent = String(members.length);
  document.getElementById('crewTabLabel').textContent = 'Crew (' + members.length + ')';
  const el = document.getElementById('crewList');
  el.innerHTML = members.map((m) => {
    const statusClass = m.isMuted ? 'bad' : (m.syncHealth === 'lagging' || m.isBuffering ? 'warn' : (m.role === 'host' ? 'gold' : 'ok'));
    const statusLabel = m.role === 'host' ? 'HOST' : (m.isMuted ? 'MUTED' : (m.isBuffering ? 'BUFFERING' : (m.mode === 'free' ? 'FREE' : (m.syncHealth === 'lagging' ? 'LAGGING' : 'SYNCED'))));
    return '<div class="list-card"><div class="list-card-row"><strong style="font-size:13px;">' + esc(m.name) + '</strong><span class="badge-mini ' + statusClass + '">' + statusLabel + '</span></div>' +
      '<div style="font-size:11px;color:var(--sub);">At ' + fmtSec(m.positionSec) + '</div></div>';
  }).join('');
}

function renderDoubtQueue(doubts) {
  document.getElementById('doubtCnt').textContent = String(doubts.length);
  const el = document.getElementById('doubtList');
  if (!doubts.length) { el.innerHTML = '<div style="font-size:12px;color:var(--muted);">No pending doubts.</div>'; return; }
  el.innerHTML = doubts.map((d) =>
    '<div class="list-card"><div class="list-card-row"><strong style="font-size:12.5px;">✋ ' + esc(d.senderName) + '</strong><span class="badge-mini gold">' + fmtSec(d.positionSec) + '</span></div>' +
    (d.note ? '<div style="font-size:11.5px;color:var(--sub);">' + esc(d.note) + '</div>' : '') + '</div>'
  ).join('');
}

function raiseDoubtHand() {
  if (!ws || ws.readyState !== 1 || !joined) return;
  if (isSelfMuted) { showToast('Muted users cannot raise hand.'); return; }
  const pos = Math.floor((ytPlayer && ytPlayer.getCurrentTime) ? (ytPlayer.getCurrentTime() || 0) : lastHostPos);
  ws.send(JSON.stringify({ type: 'doubt_ping', positionSec: pos }));
  showToast('✋ Raised hand at ' + fmtSec(pos));
}

function renderPoll(poll) {
  const card = document.getElementById('pollCard');
  if (!poll || !poll.active) { card.classList.remove('show'); currentPollId = ''; myPollVote = ''; return; }
  if (currentPollId !== poll.id) { currentPollId = poll.id; myPollVote = ''; }
  document.getElementById('pollQuestion').textContent = '📊 ' + poll.question;
  document.getElementById('pollCntGotIt').textContent = String(poll.gotIt || 0);
  document.getElementById('pollCntConfused').textContent = String(poll.confused || 0);
  document.getElementById('pollCntTooFast').textContent = String(poll.tooFast || 0);
  document.getElementById('pollOptGotIt').classList.toggle('voted', myPollVote === 'gotIt');
  document.getElementById('pollOptConfused').classList.toggle('voted', myPollVote === 'confused');
  document.getElementById('pollOptTooFast').classList.toggle('voted', myPollVote === 'tooFast');
  card.classList.add('show');
}

function votePoll(choice) {
  if (!ws || ws.readyState !== 1 || !joined) return;
  myPollVote = choice;
  ws.send(JSON.stringify({ type: 'poll_vote', choice }));
  document.getElementById('pollOptGotIt').classList.toggle('voted', choice === 'gotIt');
  document.getElementById('pollOptConfused').classList.toggle('voted', choice === 'confused');
  document.getElementById('pollOptTooFast').classList.toggle('voted', choice === 'tooFast');
}

function sendReaction(emoji) {
  if (!ws || ws.readyState !== 1 || !joined || !allowReactions || chatMutedAll || isSelfMuted) return;
  ws.send(JSON.stringify({ type: 'reaction', emoji }));
}

function spawnFloatingReaction(emoji) {
  const layer = document.getElementById('reactionLayer');
  const el = document.createElement('div');
  el.className = 'float-react';
  el.textContent = emoji;
  el.style.right = (10 + Math.random() * 52) + 'px';
  layer.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2200);
}

function switchTab(tabName) {
  if (activeTab === 'chat' && tabName !== 'chat') {
    stopTypingNow();
    closeEmojiDrawer();
  }
  activeTab = tabName;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
  document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + tabName));
  if (tabName === 'chat') {
    unreadChatCount = 0;
    document.getElementById('chatBadge').classList.remove('show');
    scrollChatToBottom(true);
  }
}

function toggleCinema() {
  isCinema = !isCinema;
  document.getElementById('workspace').classList.toggle('cinema', isCinema);
  document.getElementById('cinemaBtn').classList.toggle('active', isCinema);
}

connectWs();
</script>
</body>
</html>`;
}
