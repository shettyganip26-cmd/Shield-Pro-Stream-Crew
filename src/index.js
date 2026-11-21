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
    this.upNextQueue = []; // [{ id, videoId, title, channelTitle, durationSec, durationText, thumbnailUrl, addedByName, addedAtMs }]
    this.doubtQueue = []; // [{ id, senderId, senderName, positionSec, note, createdAtMs }]
    this.activePoll = null; // { id, question, active, createdAtMs, votes: Map<memberKey, choice> }
    this.lastRosterBroadcastMs = 0;
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
        const prevVideoId = this.room ? this.room.videoId : "";
        const incomingVideoId = String(msg.videoId || "");
        const videoChanged = wasAlreadyInitialized && prevVideoId !== incomingVideoId;
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

        if (wasAlreadyInitialized) {
          this.broadcastVerified(this.buildSnapshotEnvelope(), ws);
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
        this.room.positionSec = Number(msg.positionSec || 0);
        if (Number(msg.durationSec || 0) > 0) this.room.durationSec = Number(msg.durationSec);
        this.room.isPlaying = msg.isPlaying !== false;
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
        this.room.positionSec = Math.max(0, Number(msg.positionSec || 0));
        if (Number(msg.durationSec || 0) > 0) this.room.durationSec = Number(msg.durationSec);
        this.room.isPlaying = msg.isPlaying !== false;
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
        if (dur > 0 && (vid === this.room.videoId || vid === this.room.youtubeId)) {
          if (Math.abs((this.room.durationSec || 0) - dur) >= 2) {
            this.room.durationSec = dur;
            if (this.hostSocket) {
              this.safeSend(this.hostSocket, { type: "viewer_duration", videoId: this.room.videoId, durationSec: dur });
            }
          }
        }
        return;
      }

      case "host_command": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const now = Date.now();
        this.room.lastHostSeenMs = now;
        if (msg.action === "pause") this.room.isPlaying = false;
        if (msg.action === "play") this.room.isPlaying = true;
        if (typeof msg.timestampSec === "number" && msg.timestampSec >= 0) this.room.positionSec = msg.timestampSec;
        if (msg.action === "skip" && typeof msg.skipDeltaSec === "number") {
          this.room.positionSec = Math.max(0, (this.room.positionSec || 0) + msg.skipDeltaSec);
        }
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
            id: `req_${Date.now()}_${videoId}`,
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
          this.broadcastVerified(this.buildSnapshotEnvelope(), ws);
          this.broadcastVerified({ type: "notice", message: `Host approved & started: "${req.title}" (suggested by ${req.requestedByName})` });
        } else {
          this.upNextQueue.push({
            id: `q_${Date.now()}_${req.videoId}`,
            videoId: req.videoId,
            title: req.title,
            channelTitle: req.channelTitle,
            durationSec: req.durationSec,
            durationText: req.durationText,
            thumbnailUrl: req.thumbnailUrl,
            addedByName: `${req.requestedByName} (Approved)`,
            addedAtMs: Date.now(),
          });
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
        this.broadcastVerified(this.buildSnapshotEnvelope(), ws);
        return;
      }

      case "queue_add": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const videoId = extractYouTubeId(msg.videoId);
        if (!videoId) return;
        if (!this.upNextQueue.some((q) => q.videoId === videoId)) {
          this.upNextQueue.push({
            id: `q_${Date.now()}_${videoId}`,
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
        this.upNextQueue = this.upNextQueue.filter((q) => q.id !== msg.queueId);
        this.broadcastVerified({ type: "queue_update", queue: this.upNextQueue });
        return;
      }

      case "queue_play_next": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        const idx = msg.queueId ? this.upNextQueue.findIndex((q) => q.id === msg.queueId) : 0;
        if (idx < 0 || !this.upNextQueue[idx]) return;
        const [next] = this.upNextQueue.splice(idx, 1);
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
        this.broadcastVerified(this.buildSnapshotEnvelope(), ws);
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
        if (typeof msg.pinnedAnnouncement === "string") this.room.pinnedAnnouncement = msg.pinnedAnnouncement.trim().slice(0, 240);

        this.broadcastVerified({
          type: "room_governance",
          roomLocked: this.room.roomLocked,
          chatMutedAll: this.room.chatMutedAll,
          slowModeSec: this.room.slowModeSec,
          allowVideoRequests: this.room.allowVideoRequests,
          allowReactions: this.room.allowReactions,
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
      this.broadcastRoster(true);
    }
  }

  buildSnapshotEnvelope(forMeta = null) {
    const now = Date.now();
    const muteInfo = forMeta && forMeta.role !== "host" ? this.getMuteFor(forMeta) : null;
    // Project elapsed playback cleanly using server wall-clock so newcomers join at exact live second
    const elapsedSec = this.room.isPlaying && this.room.sentAtMs
      ? Math.min(8, Math.max(0, (now - this.room.sentAtMs) / 1000)) * Number(this.room.speed || 1)
      : 0;
    const livePos = Math.max(0, Math.round((Number(this.room.positionSec || 0) + elapsedSec) * 10) / 10);

    return {
      type: "room_snapshot",
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
        JSON.stringify({ ok: true, service: "ShieldPro Cloud Crew Relay Studio", version: "2.0.0", timestamp: Date.now() }),
        { status: 200, headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }) }
      );
    }

    if (request.method === "GET" && path === "/api/yt/search") {
      return handleYouTubeSearchApi(request, url);
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
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
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

  /* Locked Viewport App-Shell (ZERO page scroll jitter!) */
  .studio-shell {
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
  .title-block { min-width:0; }
  .room-title { font-size: 13.5px; font-weight: 700; color: var(--txt); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .room-sub { display:flex; align-items:center; gap:8px; font-size: 11px; color: var(--sub); margin-top: 1px; }
  .code-tag { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; color: var(--gold); letter-spacing: 0.5px; }

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
    background: #FBF9F4; color: #16181D; border: 1px solid rgba(230,198,135,0.65);
    box-shadow: 0 6px 20px rgba(0,0,0,0.22);
  }
  .msg-card.ai .msg-sender { color: #8A5A10; }
  .msg-card.ai .msg-time { color: #64748B; }
  .msg-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom: 4px; }
  .msg-sender { font-size: 11px; font-weight: 800; color: var(--gold); }
  .msg-time { font-size: 10px; color: var(--muted); }
  .msg-body { white-space: pre-wrap; }
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

  /* Mobile Portrait: Sticky 16:9 Video Top + Independent Scrolling Tabbed Bottom Workspace + Fixed Composer */
  @media (max-width: 959px) {
    .topbar { height: 48px; padding: 0 10px; }
    .room-title { font-size: 12.5px; }
    .workspace {
      display: flex;
      flex-direction: column;
      grid-template-columns: none;
    }
    .stage-col {
      flex: 0 0 auto;
      border-right: none;
      border-bottom: 1px solid var(--border);
    }
    .video-stage {
      flex: 0 0 auto;
      width: 100%;
      aspect-ratio: 16 / 9;
      max-height: 36dvh;
    }
    .side-panel {
      flex: 1 1 0;
      min-height: 0;
    }
    .stage-dock { padding: 6px 8px; }
    .dock-btn { padding: 5px 9px; font-size: 11.5px; }
  }
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
        </div>
        <div class="dock-group" id="reactionBar">
          <button class="react-mini" onclick="sendReaction('💡')" title="Aha moment">💡</button>
          <button class="react-mini" onclick="sendReaction('🔥')" title="Great point">🔥</button>
          <button class="react-mini" onclick="sendReaction('👏')" title="Well explained">👏</button>
          <button class="react-mini" onclick="sendReaction('❓')" title="Need clarity">❓</button>
        </div>
      </div>
    </section>

    <!-- Right Study Desk Panel -->
    <aside class="side-panel">
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
          <div class="composer-row" id="composerRow">
            <button class="ai-toggle-pill" id="aiTagBtn" onclick="toggleAiTag()" title="Tag Mentor Pro AI">@AI</button>
            <textarea class="chat-input" id="chatInput" rows="1" placeholder="Message study room..." maxlength="800"></textarea>
            <button class="send-btn" id="chatSendBtn" onclick="sendChat()" title="Send message">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </div>
      </div>

      <!-- TAB 2: YOUTUBE SEARCH & REQUEST QUEUE -->
      <div class="tab-pane" id="pane-queue">
        <div class="search-bar-box">
          <div class="search-row">
            <input class="studio-input" id="ytSearchInput" placeholder="Search YouTube or paste video link..." autocomplete="off">
            <button class="gold-btn" id="ytSearchBtn" onclick="runYouTubeSearch()">Search</button>
          </div>
          <input class="studio-input" id="ytRequestNote" placeholder="Optional note to Host (e.g. 'Great derivation of Gauss law')" maxlength="110" style="padding:7px 11px;font-size:12px;">
        </div>
        <div class="scroll-body" id="queueScroll">
          <div id="ytSearchResultsWrap" style="display:flex;flex-direction:column;gap:8px;"></div>
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
let tagAiNext = false;
let activeTab = 'chat';
let unreadChatCount = 0;
let unreadWhileScrolled = 0;
let myPollVote = '';
let currentPollId = '';

// Incremental Chat DOM State (Zero full-redraw jitter!)
const renderedChatIds = new Set();
const chatNodeById = new Map();
const typingPeers = new Map();

// Pomodoro State
let pomoInterval = null;
let pomoRemSec = 0;
let pomoPhase = 'FOCUS';

document.getElementById('nameField').value = displayName;
document.getElementById('pinField').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitJoin(); });
document.getElementById('ytSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runYouTubeSearch(); });
document.getElementById('noteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addLiveNote(); });

// Auto-expanding single-row chat input + Enter to send
const chatInputEl = document.getElementById('chatInput');
let typingTimeout = null;
chatInputEl.addEventListener('input', () => {
  chatInputEl.style.height = 'auto';
  chatInputEl.style.height = Math.min(92, chatInputEl.scrollHeight) + 'px';
  if (ws && ws.readyState === 1 && joined && !isSelfMuted && !chatMutedAll) {
    ws.send(JSON.stringify({ type: 'typing', isTyping: true }));
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'typing', isTyping: false }));
    }, 2200);
  }
});
chatInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// Mobile Virtual Keyboard Lock (prevents composer jumping behind keyboard!)
if (window.visualViewport) {
  const syncViewportHeight = () => {
    const shell = document.getElementById('studioShell');
    if (shell) shell.style.height = window.visualViewport.height + 'px';
  };
  window.visualViewport.addEventListener('resize', syncViewportHeight);
}

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

// WebCrypto SHA-256 & AES-256-GCM (byte-compatible with RoomPayloadCrypto.kt)
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
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
  const elapsed = lastHostPlaying ? Math.min(15, Math.max(0, (serverNow - lastHostServerMs) / 1000)) * lastHostSpeed : 0;
  return Math.max(0, lastHostPos + elapsed);
}

function mountOrSwitchYouTube(ytId, startSec, isPlaying, speed) {
  if (!ytId) return;
  document.getElementById('driveFrame').style.display = 'none';
  document.getElementById('ytPlayerMount').style.display = 'block';
  document.getElementById('stagePlaceholder').style.display = 'none';

  if (!ytApiReady || !window.YT || !YT.Player) return;
  if (!ytPlayer) {
    ytPlayer = new YT.Player('ytPlayerMount', {
      videoId: ytId,
      playerVars: { autoplay: isPlaying ? 1 : 0, controls: 1, modestbranding: 1, rel: 0, playsinline: 1, start: Math.floor(startSec || 0) },
      events: {
        onReady: (e) => {
          try {
            if (speed && e.target.setPlaybackRate) e.target.setPlaybackRate(speed);
            if (startSec > 2) e.target.seekTo(startSec, true);
            if (isPlaying) e.target.playVideo(); else e.target.pauseVideo();
          } catch (_) {}
        },
        onStateChange: (e) => {
          // 1 = PLAYING -> report real duration & apply deferred sync after buffering
          if (e.data === 1) {
            reportDetectedDurationIfNeeded();
            if (pendingSyncAfterBuffer) {
              const p = pendingSyncAfterBuffer;
              pendingSyncAfterBuffer = null;
              applySmoothSync(p.pos, p.playing, p.speed, p.opts);
            }
          }
        }
      }
    });
  } else if (activeYoutubeId !== ytId) {
    reportedDurationForVid = '';
    try {
      ytPlayer.loadVideoById({ videoId: ytId, startSeconds: Math.floor(startSec || 0) });
      if (!isPlaying) setTimeout(() => { try { ytPlayer.pauseVideo(); } catch(_){} }, 400);
    } catch (_) {}
  }
  activeYoutubeId = ytId;
}

function reportDetectedDurationIfNeeded() {
  if (!ytPlayer || typeof ytPlayer.getDuration !== 'function' || !activeVideoId) return;
  try {
    const dur = Math.floor(ytPlayer.getDuration() || 0);
    const loadedId = ytPlayer.getVideoData ? (ytPlayer.getVideoData().video_id || '') : activeYoutubeId;
    if (dur > 0 && loadedId === activeYoutubeId && reportedDurationForVid !== activeYoutubeId) {
      reportedDurationForVid = activeYoutubeId;
      lastHostDurationSec = dur;
      if (ws && ws.readyState === 1 && joined) {
        ws.send(JSON.stringify({ type: 'viewer_duration', videoId: activeVideoId, durationSec: dur }));
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

    // Smooth rate alignment
    if (!softCatchupTimer && speed && ytPlayer.setPlaybackRate) {
      const curRate = ytPlayer.getPlaybackRate ? ytPlayer.getPlaybackRate() : 1;
      if (Math.abs(curRate - speed) > 0.04) ytPlayer.setPlaybackRate(speed);
    }

    // 1. Within smooth threshold -> ZERO seek!
    const noSeekLimit = forceHard ? 1.2 : 2.5;
    if (absDrift <= noSeekLimit && !initialJoin) return;

    // 2. Gentle drift (1.2s..3.0s) while playing -> soft playback-rate catch-up instead of harsh seek!
    if (isPlaying && laggingOnly && !initialJoin && absDrift > noSeekLimit && absDrift <= 3.0) {
      const nudge = drift > 0 ? Math.min(2.0, speed + 0.08) : Math.max(0.5, speed - 0.08);
      if (ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(nudge);
      clearTimeout(softCatchupTimer);
      softCatchupTimer = setTimeout(() => {
        softCatchupTimer = null;
        try { if (ytPlayer && ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(lastHostSpeed); } catch (_) {}
      }, Math.min(4500, Math.round(absDrift * 1500)));
      return;
    }

    // 3. Larger drift (>3.0s) or explicit hard resync -> single rate-limited seek (3s cooldown)
    if (!initialJoin && (now - lastSeekAtMs) < 3000) return;
    lastSeekAtMs = now;
    clearTimeout(softCatchupTimer);
    softCatchupTimer = null;
    ytPlayer.seekTo(hostPos, true);
    if (speed && ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(speed);
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
    if (joined) sendJoinHandshake();
  };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    await handleWsMessage(msg);
  };

  ws.onclose = (ev) => {
    clearInterval(pingTimer);
    if (ev.code === 4003 || permanentlyBlocked) {
      showKickedScreen('You were removed from this study room by the Host.');
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWs, 2500);
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
    document.getElementById('gateError').textContent = 'Connecting... try again in a second.';
    return;
  }
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
        mountOrSwitchYouTube(msg.youtubeId, lastHostPos, lastHostPlaying, lastHostSpeed);
        if (prevVid && prevVid === activeVideoId) {
          applySmoothSync(lastHostPos, lastHostPlaying, lastHostSpeed, { forceHard: false, laggingOnly: true });
        } else {
          setTimeout(() => applySmoothSync(getEstimatedHostNowPos(), lastHostPlaying, lastHostSpeed, { initialJoin: true }), 750);
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

    case 'playback_sync': {
      lastHostPos = Number(msg.positionSec || 0);
      if (Number(msg.durationSec || 0) > 0) lastHostDurationSec = Number(msg.durationSec);
      lastHostPlaying = msg.isPlaying !== false;
      lastHostSpeed = Number(msg.speed || 1.0);
      lastHostServerMs = Number(msg.serverNowMs || msg.sentAtMs || Date.now());
      applySmoothSync(getEstimatedHostNowPos(), lastHostPlaying, lastHostSpeed, { forceHard: Boolean(msg.forceSeek), laggingOnly: true });
      return;
    }

    case 'sync_pulse': {
      lastHostPos = Number(msg.positionSec || 0);
      if (Number(msg.durationSec || 0) > 0) lastHostDurationSec = Number(msg.durationSec);
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
      if (msg.action === 'pause') { lastHostPlaying = false; try { ytPlayer?.pauseVideo(); } catch(_){} }
      if (msg.action === 'play') { lastHostPlaying = true; try { ytPlayer?.playVideo(); } catch(_){} }
      if (msg.action === 'seek' && typeof msg.timestampSec === 'number') {
        lastHostPos = msg.timestampSec; lastHostServerMs = Number(msg.serverNowMs || Date.now());
        applySmoothSync(msg.timestampSec, true, lastHostSpeed, { forceHard: true, laggingOnly: false });
      }
      if (msg.action === 'skip' && typeof msg.skipDeltaSec === 'number') {
        const cur = ytPlayer?.getCurrentTime ? ytPlayer.getCurrentTime() : lastHostPos;
        const target = Math.max(0, cur + msg.skipDeltaSec);
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
      if (msg.isTyping) typingPeers.set(msg.senderId || msg.senderName, msg.senderName || 'Peer');
      else typingPeers.delete(msg.senderId || msg.senderName);
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

// Incremental Zero-Jitter Chat DOM Append
function appendChatBubble(m, isLiveEvent) {
  const id = String(m.id || (m.senderName + ':' + m.timestamp + ':' + (m.text || '').slice(0, 16)));
  if (renderedChatIds.has(id)) return;
  renderedChatIds.add(id);

  const wasNearBottom = isNearChatBottom();
  const isSelf = !m.isAi && m.senderName === displayName;
  const card = document.createElement('div');
  card.className = 'msg-card' + (m.isAi ? ' ai' : (isSelf ? ' self' : ''));
  card.dataset.msgId = id;

  const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const slideSafe = safeUrl(m.slidePreviewUrl);
  const slideHtml = slideSafe ? '<img class="msg-slide" src="' + esc(slideSafe) + '" alt="Lecture slide" loading="lazy">' : '';

  card.innerHTML =
    '<div class="msg-head"><span class="msg-sender">' + esc(m.senderName || 'Study Peer') + '</span><span class="msg-time">' + esc(timeStr) + '</span></div>' +
    '<div class="msg-body">' + esc(m.text || '') + '</div>' + slideHtml;

  chatListEl.appendChild(card);
  chatNodeById.set(id, card);

  // Cap DOM to 140 messages smoothly
  while (chatListEl.children.length > 140) {
    const first = chatListEl.firstElementChild;
    if (first) {
      const fid = first.dataset.msgId;
      chatNodeById.delete(fid);
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
  chatInputEl.value = '';
  chatInputEl.style.height = 'auto';
  tagAiNext = false;
  document.getElementById('aiTagBtn').classList.remove('active');

  appendChatBubble(msgObj, true);
  const payload = await encryptPayload(msgObj);
  ws.send(JSON.stringify({ type: 'chat_post', msgId: msgObj.id, taggedAi, payload }));
}

// In-Page YouTube Search & Student Request-to-Play
async function runYouTubeSearch() {
  const q = (document.getElementById('ytSearchInput').value || '').trim();
  if (!q) return;
  const wrap = document.getElementById('ytSearchResultsWrap');
  wrap.innerHTML = '<div style="font-size:12px;color:var(--gold);padding:8px;">Searching YouTube...</div>';
  try {
    const resp = await fetch('/api/yt/search?q=' + encodeURIComponent(q));
    const data = await resp.json();
    const list = Array.isArray(data.results) ? data.results : [];
    if (list.length === 0) {
      wrap.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px;">No videos found. Try another keyword or paste a YouTube link directly.</div>';
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
      card.querySelector('.yt-req-btn').addEventListener('click', () => requestVideoToHost(item));
      wrap.appendChild(card);
    }
  } catch (_) {
    wrap.innerHTML = '<div style="font-size:12px;color:var(--red);padding:8px;">Search failed. Check connection.</div>';
  }
}

function requestVideoToHost(item) {
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
}

function renderVideoRequests(requests) {
  const wrap = document.getElementById('pendingRequestsWrap');
  document.getElementById('reqCountLabel').textContent = String(requests.length);
  const badge = document.getElementById('queueBadge');
  const totalQ = requests.length;
  badge.textContent = String(totalQ);
  badge.classList.toggle('show', totalQ > 0);
  if (requests.length === 0) {
    wrap.innerHTML = '<div style="font-size:12px;color:var(--muted);">No pending requests. Search above to suggest a lecture to the Host.</div>';
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
  const wrap = document.getElementById('upNextWrap');
  document.getElementById('upNextCountLabel').textContent = String(queue.length);
  if (queue.length === 0) {
    wrap.innerHTML = '<div style="font-size:12px;color:var(--muted);">No videos queued yet.</div>';
    return;
  }
  wrap.innerHTML = queue.map((q, i) =>
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
