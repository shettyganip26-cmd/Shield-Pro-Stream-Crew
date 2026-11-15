/**
 * ShieldPro Cross-City Cloud Crew Relay Worker + Durable Object Hub
 * - Zero Google OAuth / Zero friend sign-in (Room Code + PIN SHA-256 handshake)
 * - Serves both the mobile-responsive Web Desk Study Player AND wss:// room hub
 * - Ephemeral in-memory Durable Object rooms with auto-cleanup alarm
 */

const ROOM_IDLE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours max idle
const HOST_RECONNECT_GRACE_MS = 15 * 60 * 1000; // 15 min grace if host drops briefly
const PIN_LOCKOUT_MS = 30 * 1000;
const MAX_PIN_ATTEMPTS = 5;
const AI_VIEWER_COOLDOWN_MS = 15 * 1000;

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra,
  };
}

function sanitizeRoomCode(raw) {
  const clean = String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 16);
  return clean || "";
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text || ""));
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const clientIp =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Forwarded-For") ||
      "unknown";

    const sessionId = crypto.randomUUID();
    const meta = {
      id: sessionId,
      ip: clientIp,
      role: "pending", // "host" | "viewer" | "pending"
      verified: false,
      name: "Study Peer",
      mode: "synced",
      positionSec: 0,
      joinedAtMs: Date.now(),
    };
    this.sockets.set(server, meta);

    // Send non-sensitive connection status immediately (zero lecture metadata before PIN)
    this.safeSend(server, {
      type: "room_meta",
      roomCode: this.room ? this.room.roomCode : sanitizeRoomCode(url.pathname.split("/").pop()),
      pinRequired: this.room ? this.room.pinRequired : true,
      e2eeEnabled: this.room ? this.room.e2eeEnabled : false,
      hostOnline: Boolean(this.hostSocket),
      roomActive: Boolean(this.room),
    });

    server.addEventListener("message", async (event) => {
      await this.handleSocketMessage(server, meta, event.data);
    });

    server.addEventListener("close", () => {
      this.handleSocketClose(server, meta);
    });

    server.addEventListener("error", () => {
      this.handleSocketClose(server, meta);
    });

    await this.scheduleExpiryAlarm(ROOM_IDLE_TTL_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    if (!this.hostSocket && this.sockets.size === 0) {
      this.room = null;
      this.hostSecretHash = "";
      return;
    }
    if (!this.hostSocket && this.room && Date.now() - (this.room.lastHostSeenMs || 0) >= HOST_RECONNECT_GRACE_MS) {
      this.broadcastAll({
        type: "room_closed",
        reason: "Host offline timeout reached. Study room closed.",
      });
      for (const sock of this.sockets.keys()) {
        try { sock.close(1000, "Session expired"); } catch (_) {}
      }
      this.sockets.clear();
      this.room = null;
      this.hostSecretHash = "";
    }
  }

  async scheduleExpiryAlarm(delayMs) {
    try {
      await this.state.storage.setAlarm(Date.now() + delayMs);
    } catch (_) {}
  }

  safeSend(ws, obj) {
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(obj));
      }
    } catch (_) {}
  }

  broadcastVerified(obj, excludeSocket = null) {
    const raw = JSON.stringify(obj);
    for (const [sock, meta] of this.sockets.entries()) {
      if (sock === excludeSocket || !meta.verified) continue;
      try {
        if (sock.readyState === 1) sock.send(raw);
      } catch (_) {}
    }
  }

  broadcastAll(obj) {
    const raw = JSON.stringify(obj);
    for (const sock of this.sockets.keys()) {
      try {
        if (sock.readyState === 1) sock.send(raw);
      } catch (_) {}
    }
  }

  buildRoster() {
    const members = [];
    for (const [, meta] of this.sockets.entries()) {
      if (!meta.verified) continue;
      members.push({
        id: meta.id,
        name: meta.name,
        role: meta.role,
        mode: meta.mode,
        positionSec: meta.positionSec || 0,
        joinedAtMs: meta.joinedAtMs,
      });
    }
    return members;
  }

  broadcastRoster() {
    this.broadcastVerified({
      type: "roster",
      members: this.buildRoster(),
    });
  }

  async verifyHostSecret(providedSecret) {
    if (!providedSecret || !this.hostSecretHash) return false;
    const providedHash = await sha256Hex(providedSecret);
    return providedHash === this.hostSecretHash;
  }

  async handleSocketMessage(ws, meta, rawData) {
    let msg;
    try {
      msg = JSON.parse(String(rawData || "{}"));
    } catch (_) {
      return;
    }

    switch (msg.type) {
      case "ping": {
        this.safeSend(ws, { type: "pong", sentAtMs: msg.sentAtMs || Date.now() });
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
        const existingChats = this.room ? this.room.chatHistory : [];
        const incomingChats = Array.isArray(msg.chatHistory) ? msg.chatHistory : existingChats;

        this.room = {
          roomCode: sanitizeRoomCode(msg.roomCode),
          pinRequired: msg.pinRequired !== false,
          pinHash: String(msg.pinHash || ""),
          e2eeEnabled: Boolean(msg.e2eeEnabled && msg.pinRequired !== false),
          hostLeadSync: msg.hostLeadSync !== false,
          allowCrewAi: msg.allowCrewAi !== false,
          allowCrewNotes: msg.allowCrewNotes !== false,
          videoId: String(msg.videoId || ""),
          youtubeId: String(msg.youtubeId || ""),
          driveVideoUrl: String(msg.driveVideoUrl || ""),
          isLocal: Boolean(msg.isLocal),
          title: String(msg.title || "Live Study Room"),
          channelTitle: String(msg.channelTitle || "ShieldPro Study"),
          durationSec: Number(msg.durationSec || 0),
          positionSec: Number(msg.positionSec || 0),
          isPlaying: msg.isPlaying !== false,
          speed: Number(msg.speed || 1.0),
          sentAtMs: Number(msg.sentAtMs || Date.now()),
          chapters: Array.isArray(msg.chapters) ? msg.chapters : [],
          notesPayload: msg.notesPayload || null,
          chatHistory: incomingChats.slice(-45),
          lastHostSeenMs: Date.now(),
        };

        this.safeSend(ws, { type: "room_ready", roomCode: this.room.roomCode });

        // Notify waiting unverified sockets if room just booted
        for (const [sock, m] of this.sockets.entries()) {
          if (sock !== ws && !m.verified) {
            this.safeSend(sock, {
              type: "room_meta",
              roomCode: this.room.roomCode,
              pinRequired: this.room.pinRequired,
              e2eeEnabled: this.room.e2eeEnabled,
              hostOnline: true,
              roomActive: true,
            });
          }
        }

        // Push updated room state to already-verified crew viewers
        if (wasAlreadyInitialized) {
          this.broadcastVerified(this.buildSnapshotEnvelope(), ws);
        }
        this.broadcastRoster();
        await this.scheduleExpiryAlarm(ROOM_IDLE_TTL_MS);
        return;
      }

      case "join": {
        if (!this.room) {
          this.safeSend(ws, {
            type: "auth_error",
            message: "Host has not started this study room yet. Ask the host to launch Cross-City Crew.",
          });
          return;
        }

        const now = Date.now();
        const failInfo = this.pinFailures.get(meta.ip) || { count: 0, lockedUntil: 0 };
        if (failInfo.lockedUntil > now) {
          const waitSec = Math.ceil((failInfo.lockedUntil - now) / 1000);
          this.safeSend(ws, {
            type: "auth_error",
            locked: true,
            message: `Too many wrong PIN attempts. Retry in ${waitSec}s.`,
          });
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
              message: failInfo.lockedUntil > now
                ? "Too many wrong PIN attempts. Wait 30s."
                : "Incorrect Room PIN. Ask host for the 4-digit PIN.",
            });
            return;
          }
        }

        this.pinFailures.delete(meta.ip);
        meta.role = "viewer";
        meta.verified = true;
        meta.name = String(msg.displayName || "Study Peer").trim().slice(0, 28) || "Study Peer";
        meta.mode = this.room.hostLeadSync ? "synced" : "free";

        this.safeSend(ws, this.buildSnapshotEnvelope());
        this.broadcastRoster();
        return;
      }

      case "playback_sync": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        this.room.lastHostSeenMs = Date.now();
        this.room.positionSec = Number(msg.positionSec || 0);
        this.room.isPlaying = msg.isPlaying !== false;
        this.room.speed = Number(msg.speed || 1.0);
        this.room.sentAtMs = Number(msg.sentAtMs || Date.now());
        if (typeof msg.hostLeadSync === "boolean") {
          this.room.hostLeadSync = msg.hostLeadSync;
        }
        meta.positionSec = Math.floor(this.room.positionSec);

        this.broadcastVerified(
          {
            type: "playback_sync",
            videoId: this.room.videoId,
            positionSec: this.room.positionSec,
            isPlaying: this.room.isPlaying,
            speed: this.room.speed,
            forceSeek: Boolean(msg.forceSeek),
            sentAtMs: this.room.sentAtMs,
            hostLeadSync: this.room.hostLeadSync,
          },
          ws
        );
        return;
      }

      case "host_command": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        this.room.lastHostSeenMs = Date.now();
        if (msg.action === "pause") this.room.isPlaying = false;
        if (msg.action === "play") this.room.isPlaying = true;
        if (typeof msg.timestampSec === "number") this.room.positionSec = msg.timestampSec;
        if (typeof msg.speed === "number") this.room.speed = msg.speed;

        this.broadcastVerified(
          {
            type: "host_command",
            commandId: msg.commandId || Date.now(),
            action: msg.action,
            skipDeltaSec: msg.skipDeltaSec,
            timestampSec: msg.timestampSec,
            speed: msg.speed,
            note: msg.note,
            loopStartSec: msg.loopStartSec,
            loopEndSec: msg.loopEndSec,
            loopEnabled: msg.loopEnabled,
            layoutMode: msg.layoutMode,
            zoomScale: msg.zoomScale,
            pomodoroAction: msg.pomodoroAction,
            pomodoroMinutes: msg.pomodoroMinutes,
            pomodoroPhase: msg.pomodoroPhase,
            sentAtMs: Date.now(),
          },
          ws
        );
        return;
      }

      case "notes_sync": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        this.room.lastHostSeenMs = Date.now();
        this.room.notesPayload = msg.payload || null;
        this.broadcastVerified(
          {
            type: "notes_sync",
            payload: this.room.notesPayload,
          },
          ws
        );
        return;
      }

      case "note_add": {
        if (!this.room || !meta.verified) return;
        if (meta.role !== "host" && !this.room.allowCrewNotes) {
          this.safeSend(ws, { type: "notice", message: "Host has disabled remote note adding." });
          return;
        }
        // Deliver to Host Android app (and broadcast notice to others)
        if (this.hostSocket) {
          this.safeSend(this.hostSocket, {
            type: "note_add",
            senderId: meta.id,
            payload: msg.payload,
          });
        }
        this.broadcastVerified(
          {
            type: "note_live_item",
            payload: msg.payload,
          },
          this.hostSocket
        );
        return;
      }

      case "chat_broadcast": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        this.room.lastHostSeenMs = Date.now();
        if (msg.payload) {
          this.room.chatHistory.push(msg.payload);
          if (this.room.chatHistory.length > 45) {
            this.room.chatHistory.shift();
          }
          this.broadcastVerified(
            {
              type: "chat_message",
              payload: msg.payload,
            },
            ws
          );
        }
        return;
      }

      case "chat_post": {
        if (!this.room || !meta.verified || !msg.payload) return;
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

        this.room.chatHistory.push(msg.payload);
        if (this.room.chatHistory.length > 45) {
          this.room.chatHistory.shift();
        }

        // Send to Host Android phone (which runs MentorProAiEngine if taggedAi) and to all peers
        if (this.hostSocket && this.hostSocket !== ws) {
          this.safeSend(this.hostSocket, {
            type: "chat_post",
            senderId: meta.id,
            payload: msg.payload,
          });
        }
        this.broadcastVerified(
          {
            type: "chat_message",
            payload: msg.payload,
          },
          this.hostSocket
        );
        return;
      }

      case "ai_thinking": {
        if (!this.room || !(await this.verifyHostSecret(msg.hostSecret))) return;
        this.broadcastVerified({ type: "ai_thinking", thinking: Boolean(msg.thinking) }, ws);
        return;
      }

      case "viewer_status": {
        if (!meta.verified || meta.role !== "viewer") return;
        meta.mode = msg.mode === "free" ? "free" : "synced";
        if (typeof msg.positionSec === "number") {
          meta.positionSec = Math.max(0, Math.floor(msg.positionSec));
        }
        this.broadcastRoster();
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
      this.broadcastRoster();
    }
  }

  buildSnapshotEnvelope() {
    return {
      type: "room_snapshot",
      roomCode: this.room.roomCode,
      e2eeEnabled: this.room.e2eeEnabled,
      hostLeadSync: this.room.hostLeadSync,
      allowCrewAi: this.room.allowCrewAi,
      allowCrewNotes: this.room.allowCrewNotes,
      hostOnline: Boolean(this.hostSocket),
      videoId: this.room.videoId,
      youtubeId: this.room.youtubeId,
      driveVideoUrl: this.room.driveVideoUrl,
      isLocal: this.room.isLocal,
      title: this.room.title,
      channelTitle: this.room.channelTitle,
      durationSec: this.room.durationSec,
      positionSec: this.room.positionSec,
      isPlaying: this.room.isPlaying,
      speed: this.room.speed,
      sentAtMs: this.room.sentAtMs,
      chapters: this.room.chapters || [],
      notesPayload: this.room.notesPayload || null,
      chatHistory: this.room.chatHistory || [],
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
        JSON.stringify({
          ok: true,
          service: "ShieldPro Cloud Crew Relay",
          version: "1.0.0",
          timestamp: Date.now(),
        }),
        {
          status: 200,
          headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }),
        }
      );
    }

    if (path.startsWith("/ws/")) {
      const code = sanitizeRoomCode(path.slice(4));
      if (!code) {
        return new Response("Missing room code", { status: 400 });
      }
      const id = env.CREW_ROOMS.idFromName(code);
      const stub = env.CREW_ROOMS.get(id);
      return stub.fetch(request);
    }

    if (path.startsWith("/r/")) {
      const code = sanitizeRoomCode(path.slice(3));
      if (!code) {
        return Response.redirect(url.origin + "/", 302);
      }
      return new Response(renderWebDeskHtml(code), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    if (path === "/" || path === "") {
      return new Response(renderLobbyHtml(), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
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
<title>ShieldPro Crew Room • Join</title>
<style>
  :root { --bg: #090B0E; --card: #12151B; --border: #272D38; --gold: #E6C687; --goldHi: #F5E6BE; --txt: #EDEDED; --sub: #9BA3AF; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--txt); font-family: system-ui, -apple-system, sans-serif; min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .box { width: 100%; max-width: 400px; background: var(--card); border: 1px solid var(--gold); border-radius: 18px; padding: 28px 22px; text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.65); }
  h1 { font-size: 18px; color: var(--goldHi); margin: 10px 0 6px; }
  p { font-size: 13px; color: var(--sub); line-height: 1.5; margin-bottom: 18px; }
  input { width: 100%; background: #0E1117; border: 1px solid var(--border); border-radius: 10px; color: var(--goldHi); font-size: 18px; font-weight: 700; text-align: center; letter-spacing: 2px; padding: 12px; text-transform: uppercase; outline: none; margin-bottom: 12px; }
  input:focus { border-color: var(--gold); }
  button { width: 100%; background: linear-gradient(135deg, var(--gold), #D4AF6A); color: #120E06; font-weight: 800; font-size: 14px; border: none; border-radius: 10px; padding: 12px; cursor: pointer; }
</style>
</head>
<body>
  <div class="box">
    <div style="font-size:34px;">🛡️</div>
    <h1>SHIELDPRO CREW STUDY DESK</h1>
    <p>Enter your host's Study Room Code to join synced lectures, live notes, and Mentor Pro AI across any city.</p>
    <input id="codeInput" placeholder="SHLD-XXXX" maxlength="16" autocomplete="off">
    <button onclick="joinRoom()">Enter Study Room</button>
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
<title>${safeCode} • ShieldPro Crew Study Desk</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Patrick+Hand&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg-canvas: #090B0E; --bg-card: #12151B; --bg-surface: #181C24;
    --border-hairline: #272D38; --oro-champagne: #E6C687; --oro-highlight: #F5E6BE;
    --oro-glow: rgba(230, 198, 135, 0.22); --telemetry-sage: #4ADE80;
    --caliper-crimson: #EF4444; --text-primary: #EDEDED; --text-secondary: #9BA3AF;
    --text-muted: #6E7787; --radius-lg: 16px; --radius-md: 12px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; max-width: 100%; overflow-x: hidden; }
  body { background: var(--bg-canvas); color: var(--text-primary); font-family: 'Plus Jakarta Sans', system-ui, sans-serif; min-height: 100dvh; display: flex; flex-direction: column; }
  header { background: linear-gradient(180deg, #13171F 0%, #0D1016 100%); border-bottom: 1px solid var(--border-hairline); padding: 10px 18px; display: flex; align-items: center; justify-content: space-between; gap: 10px; position: sticky; top: 0; z-index: 40; }
  .brand-zone { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .shield-emblem { width: 34px; height: 34px; border-radius: 9px; background: linear-gradient(135deg, #2A2215, #14120B); border: 1px solid var(--oro-champagne); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .brand-title { font-size: 14px; font-weight: 800; color: var(--oro-highlight); }
  .brand-sub { font-size: 11px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; font-family: 'JetBrains Mono', monospace; }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--telemetry-sage); box-shadow: 0 0 8px var(--telemetry-sage); display: inline-block; }
  .header-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  .badge-chip { background: var(--bg-surface); border: 1px solid var(--border-hairline); padding: 5px 10px; border-radius: 999px; font-size: 11px; font-family: 'JetBrains Mono', monospace; color: var(--oro-champagne); }
  main { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 16px; padding: 16px 20px; width: 100%; max-width: 1740px; margin: 0 auto; min-width: 0; }
  .stage-column { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .video-container { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: var(--radius-lg); overflow: hidden; border: 1px solid var(--border-hairline); box-shadow: 0 20px 50px rgba(0,0,0,0.7); }
  #videoStage { position: relative; width: 100%; height: 100%; }
  #ytPlayerContainer, #ytPlayerContainer iframe, #driveIframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  .details-card { background: var(--bg-card); border: 1px solid var(--border-hairline); border-radius: var(--radius-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .lecture-channel { font-size: 12px; color: var(--oro-champagne); font-weight: 600; }
  .lecture-title { font-size: 16px; font-weight: 700; color: var(--text-primary); line-height: 1.35; }
  .roster-strip { display: flex; flex-wrap: wrap; gap: 6px; }
  .roster-chip { font-size: 10.5px; font-family: 'JetBrains Mono', monospace; background: var(--bg-surface); border: 1px solid var(--border-hairline); color: var(--text-secondary); padding: 3px 8px; border-radius: 999px; }
  .roster-chip.host { border-color: var(--oro-champagne); color: var(--oro-highlight); }
  .action-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .btn { background: var(--bg-surface); border: 1px solid var(--border-hairline); color: var(--text-primary); padding: 7px 12px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; min-height: 36px; }
  .btn-gold { background: linear-gradient(135deg, #E6C687, #D4AF6A); color: #120E06; border-color: var(--oro-highlight); font-weight: 700; }
  .chapters-strip { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; }
  .chip-btn { background: #141820; border: 1px solid var(--border-hairline); color: var(--text-secondary); font-size: 11px; padding: 5px 9px; border-radius: 8px; cursor: pointer; white-space: nowrap; flex-shrink: 0; }
  .sidebar-column { display: flex; flex-direction: column; min-height: 440px; min-width: 0; }
  .panel-card { background: var(--bg-card); border: 1px solid var(--border-hairline); border-radius: var(--radius-lg); display: flex; flex-direction: column; flex: 1; overflow: hidden; }
  .panel-tabs { display: grid; grid-template-columns: 1fr 1fr; background: #0E1117; border-bottom: 1px solid var(--border-hairline); }
  .tab-btn { background: transparent; border: none; color: var(--text-secondary); padding: 12px; font-size: 12.5px; font-weight: 700; cursor: pointer; border-bottom: 2px solid transparent; }
  .tab-btn.active { color: var(--oro-highlight); border-bottom-color: var(--oro-champagne); background: var(--bg-card); }
  .panel-tab-content { display: none; flex-direction: column; flex: 1; padding: 12px; gap: 10px; min-height: 0; }
  .panel-tab-content.active { display: flex; }
  .notes-list, .chat-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; max-height: 56vh; }
  .note-card { background: var(--bg-surface); border: 1px solid var(--border-hairline); border-left: 3px solid var(--oro-champagne); border-radius: 10px; padding: 9px 11px; cursor: pointer; }
  .note-time { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--oro-champagne); font-weight: 700; display: block; margin-bottom: 3px; }
  .note-body { font-size: 12.5px; color: var(--text-primary); line-height: 1.45; }
  .chat-msg-card { background: var(--bg-surface); border: 1px solid var(--border-hairline); border-radius: 12px; padding: 10px 12px; }
  .chat-msg-card.ai-msg { background: #FAF8F2; border: 1.5px solid #D4B475; color: #16181D; box-shadow: 0 6px 20px rgba(0,0,0,0.35); }
  .ai-msg .chat-text { color: #1E2430; font-size: 13px; line-height: 1.6; }
  body[data-ai-font="hand"] .ai-msg .chat-text { font-family: 'Patrick Hand', cursive; font-size: 15.5px; }
  .ai-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; padding-bottom: 5px; border-bottom: 1px dashed #D8C79B; }
  .chat-sender { font-size: 11px; font-weight: 800; color: var(--oro-champagne); }
  .ai-sender { color: #8A5A00; }
  .ai-ts-chip { background: #EEF4FF; color: #1D4ED8; border: 1px solid #BFDBFE; padding: 1px 6px; border-radius: 6px; font-family: 'JetBrains Mono', monospace; font-size: 11px; cursor: pointer; }
  .ai-table-wrap { overflow-x: auto; margin: 6px 0; }
  .ai-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .ai-table th { background: #EFE6D0; color: #16181D; text-align: left; padding: 5px 8px; border: 1px solid #D4C49B; }
  .ai-table td { padding: 5px 8px; border: 1px solid #E5DEC9; }
  textarea, input[type="text"], input[type="password"] { width: 100%; background: #0E1117; border: 1px solid var(--border-hairline); border-radius: 9px; color: var(--text-primary); padding: 9px 11px; font-family: inherit; font-size: 13px; outline: none; }
  textarea { resize: none; min-height: 54px; }
  #pinModal { position: fixed; inset: 0; background: rgba(7,9,12,0.94); z-index: 999; display: flex; align-items: center; justify-content: center; padding: 18px; backdrop-filter: blur(8px); }
  .pin-box { width: 100%; max-width: 380px; background: var(--bg-card); border: 1px solid var(--oro-champagne); border-radius: 18px; padding: 24px 20px; text-align: center; display: flex; flex-direction: column; gap: 10px; }
  .pin-input { font-size: 20px; letter-spacing: 6px; text-align: center; color: var(--oro-highlight); }
  #toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%) translateY(16px); background: rgba(18,21,27,0.96); border: 1px solid var(--oro-champagne); color: var(--oro-highlight); padding: 9px 16px; border-radius: 999px; font-size: 12px; font-weight: 700; opacity: 0; pointer-events: none; transition: all .22s ease; z-index: 800; }
  #toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }

  @media (max-width: 1060px) {
    main { grid-template-columns: 1fr; padding: 10px; gap: 12px; }
    header { padding: 8px 12px; flex-wrap: wrap; }
    .sidebar-column { min-height: 360px; }
    .notes-list, .chat-list { max-height: 44dvh; }
  }
  @media (max-width: 640px) {
    .video-container { border-radius: 10px; aspect-ratio: 16 / 9; }
    .action-toolbar .btn { padding: 6px 10px; font-size: 11px; }
  }
  @media (orientation: landscape) and (max-height: 540px) and (max-width: 960px) {
    header { padding: 5px 12px; }
    main { grid-template-columns: minmax(0, 1.35fr) minmax(240px, 0.9fr); gap: 10px; padding: 8px 10px; }
    .video-container { max-height: calc(100dvh - 108px); aspect-ratio: 16 / 9; }
    .notes-list, .chat-list { max-height: calc(100dvh - 230px); }
  }
</style>
</head>
<body data-ai-font="mono">
  <div id="pinModal">
    <div class="pin-box">
      <div style="font-size:32px;">🌍</div>
      <h2 style="font-size:16px;color:var(--oro-highlight);">SHIELDPRO CREW ROOM • ${safeCode}</h2>
      <p style="font-size:12px;color:var(--text-secondary);line-height:1.45;" id="pinModalSubtitle">Connecting to room hub…</p>
      <input type="text" id="nameInput" placeholder="Your name (e.g. Rahul)" maxlength="24">
      <input type="password" id="pinInput" class="pin-input" placeholder="••••" maxlength="8" inputmode="numeric">
      <button class="btn btn-gold" style="width:100%;justify-content:center;padding:11px;" onclick="submitJoin()">Unlock &amp; Join Study Desk</button>
      <div id="pinError" style="font-size:11.5px;color:#FCA5A5;display:none;"></div>
    </div>
  </div>

  <header>
    <div class="brand-zone">
      <div class="shield-emblem">🛡️</div>
      <div>
        <div class="brand-title">ShieldPro Crew • ${safeCode}</div>
        <div class="brand-sub">
          <span class="live-dot" id="liveDot"></span>
          <span id="syncStatusText">Connecting…</span>
        </div>
      </div>
    </div>
    <div class="header-meta">
      <button class="btn" id="modeToggleBtn" onclick="toggleStudyMode()" style="border-color:var(--oro-champagne);color:var(--oro-highlight);">🔒 Host-Lead Sync</button>
      <button class="btn btn-gold" id="catchUpBtn" onclick="snapToHost()" style="display:none;">⚡ Catch Up (00:00)</button>
      <div class="badge-chip" id="viewersBadge">1 ONLINE</div>
    </div>
  </header>

  <main>
    <div class="stage-column">
      <div class="video-container">
        <div id="videoStage">
          <div id="ytPlayerContainer"></div>
        </div>
      </div>
      <div class="details-card">
        <div class="lecture-channel" id="channelTitle">🎓 ShieldPro Cross-City Study</div>
        <h1 class="lecture-title" id="lectureTitle">Waiting for Host Dossier…</h1>
        <div class="roster-strip" id="rosterStrip"></div>
        <div class="chapters-strip" id="chaptersStrip"></div>
        <div class="action-toolbar">
          <button class="btn" onclick="localTogglePlay()" id="playPauseBtn">⏸ Pause</button>
          <button class="btn" onclick="localSkip(-10)">↺ -10s</button>
          <button class="btn" onclick="localSkip(10)">+10s ↻</button>
          <button class="btn" onclick="openExternalVideo()">▶ Open Directly</button>
          <button class="btn" onclick="toggleFullscreen()">⛶ Fullscreen</button>
        </div>
      </div>
    </div>

    <aside class="sidebar-column">
      <div class="panel-card">
        <div class="panel-tabs">
          <button class="tab-btn active" id="btnNotesTab" onclick="switchTab('notesTab')">📝 Shared Notes</button>
          <button class="tab-btn" id="btnChatTab" onclick="switchTab('chatTab')">💬 Crew Chat &amp; AI</button>
        </div>
        <div class="panel-tab-content active" id="notesTab">
          <div class="notes-list" id="notesContainer">
            <div style="font-size:12px;color:var(--text-muted);text-align:center;padding:18px;">Notes will appear once unlocked.</div>
          </div>
          <div id="noteInputWrap">
            <textarea id="noteInput" placeholder="Pin a timestamped note for the study room…"></textarea>
            <div style="display:flex;justify-content:flex-end;margin-top:6px;">
              <button class="btn btn-gold" onclick="sendNote()">💾 Pin Note</button>
            </div>
          </div>
        </div>
        <div class="panel-tab-content" id="chatTab">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
            <div style="display:flex;gap:4px;">
              <button class="btn" id="fontMonoBtn" onclick="setAiFont('mono')" style="padding:4px 8px;font-size:11px;">JetBrains</button>
              <button class="btn" id="fontHandBtn" onclick="setAiFont('hand')" style="padding:4px 8px;font-size:11px;">Patrick Hand</button>
            </div>
            <span id="aiThinkingBadge" style="display:none;font-size:11px;color:var(--oro-champagne);font-weight:700;">🤖 Host AI Thinking…</span>
          </div>
          <div class="chat-list" id="chatContainer"></div>
          <div>
            <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px;">
              <button class="btn" style="padding:4px 8px;font-size:10.5px;" onclick="quickAi('explain')">⚡ Explain Moment</button>
              <button class="btn" style="padding:4px 8px;font-size:10.5px;" onclick="quickAi('quiz')">🧠 3-Q Quiz</button>
            </div>
            <textarea id="chatInput" placeholder="Chat with crew or type @AI for Mentor Pro…"></textarea>
            <div style="display:flex;justify-content:space-between;margin-top:6px;">
              <button class="btn" id="aiTagBtn" onclick="toggleAiTag()">🤖 Ask @AI</button>
              <button class="btn btn-gold" onclick="sendChat()">🚀 Send</button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  </main>
  <div id="toast"></div>

<script>
const ROOM_CODE = "${safeCode}";
let ws = null;
let myName = "Study Peer";
let currentPin = "";
let pinRequired = true;
let e2eeEnabled = false;
let unlocked = false;
let hostLeadSync = true;
let studyMode = "synced";
let allowCrewAi = true;
let allowCrewNotes = true;
let isAiTagged = false;

let ytPlayer = null;
let ytReady = false;
let currentYtId = "";
let currentDriveUrl = "";
let lastHostPos = 0;
let lastHostPlaying = true;
let lastHostSpeed = 1.0;
let lastHostSentAt = Date.now();
let chatHistory = [];
let reconnectTimer = null;

function esc(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h > 0) return h + ":" + String(m).padStart(2,"0") + ":" + String(r).padStart(2,"0");
  return String(m).padStart(2,"0") + ":" + String(r).padStart(2,"0");
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.innerText = msg;
  t.classList.add("visible");
  setTimeout(() => t.classList.remove("visible"), 2800);
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function getAesKey() {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("shieldpro-e2ee:" + ROOM_CODE + ":" + currentPin.trim()));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptEnvelope(obj) {
  if (!e2eeEnabled || !pinRequired || !currentPin) return obj;
  const key = await getAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return { enc: true, iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ctBuf)) };
}

async function decryptEnvelope(env) {
  if (!env || env.enc !== true) return env;
  if (!currentPin) return null;
  try {
    const key = await getAesKey();
    const iv = b64ToBytes(env.iv);
    const ct = b64ToBytes(env.ct);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (_) {
    return null;
  }
}

function connectWs() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  ws = new WebSocket(proto + location.host + "/ws/" + encodeURIComponent(ROOM_CODE));

  ws.onopen = () => {
    document.getElementById("syncStatusText").innerText = unlocked ? "Connected • Cross-City Live" : "PIN Verification Ready";
    if (unlocked) submitJoin();
  };

  ws.onmessage = async (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (_) { return; }

    if (msg.type === "room_meta") {
      pinRequired = msg.pinRequired !== false;
      e2eeEnabled = Boolean(msg.e2eeEnabled);
      document.getElementById("pinInput").style.display = pinRequired ? "block" : "none";
      document.getElementById("pinModalSubtitle").innerText = msg.roomActive
        ? (pinRequired ? "Enter the 4-digit Room PIN shared by your host." : "Open room ready — enter your name to join.")
        : "Waiting for host to start the study room…";
    } else if (msg.type === "auth_error") {
      const errEl = document.getElementById("pinError");
      errEl.innerText = msg.message || "Invalid PIN";
      errEl.style.display = "block";
    } else if (msg.type === "room_snapshot") {
      unlocked = true;
      document.getElementById("pinModal").style.display = "none";
      await applyRoomSnapshot(msg);
    } else if (msg.type === "playback_sync") {
      lastHostPos = Number(msg.positionSec || 0);
      lastHostPlaying = msg.isPlaying !== false;
      lastHostSpeed = Number(msg.speed || 1.0);
      lastHostSentAt = Number(msg.sentAtMs || Date.now());
      hostLeadSync = msg.hostLeadSync !== false;
      applyDriftSync(Boolean(msg.forceSeek));
    } else if (msg.type === "host_command") {
      if (studyMode === "synced") applyHostCmd(msg);
    } else if (msg.type === "roster") {
      renderRoster(msg.members || []);
    } else if (msg.type === "notes_sync") {
      const plain = await decryptEnvelope(msg.payload);
      if (plain && Array.isArray(plain.notes)) renderNotes(plain.notes);
    } else if (msg.type === "note_live_item") {
      const plain = await decryptEnvelope(msg.payload);
      if (plain && plain.note) prependLiveNote(plain);
    } else if (msg.type === "chat_message") {
      const plain = await decryptEnvelope(msg.payload);
      if (plain && plain.text) {
        chatHistory.push(plain);
        renderChat();
      }
    } else if (msg.type === "ai_thinking") {
      document.getElementById("aiThinkingBadge").style.display = msg.thinking ? "inline" : "none";
    } else if (msg.type === "notice") {
      showToast(msg.message || "");
    } else if (msg.type === "host_status") {
      document.getElementById("syncStatusText").innerText = msg.online ? "Host Live" : "Host Reconnecting…";
    } else if (msg.type === "room_closed") {
      showToast(msg.reason || "Host ended session");
      document.getElementById("syncStatusText").innerText = "Session Ended";
    }
  };

  ws.onclose = () => {
    document.getElementById("syncStatusText").innerText = "Reconnecting…";
    reconnectTimer = setTimeout(connectWs, 2500);
  };
}

async function submitJoin() {
  const nameVal = (document.getElementById("nameInput").value || "").trim() || "Study Peer";
  myName = nameVal;
  try { localStorage.setItem("shieldpro_crew_name", myName); } catch (_) {}
  currentPin = (document.getElementById("pinInput").value || "").trim();
  const pinHash = pinRequired ? await sha256Hex(ROOM_CODE + ":" + currentPin) : "";
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "join", displayName: myName, pinHash }));
  }
}

async function applyRoomSnapshot(s) {
  e2eeEnabled = Boolean(s.e2eeEnabled);
  hostLeadSync = s.hostLeadSync !== false;
  allowCrewAi = s.allowCrewAi !== false;
  allowCrewNotes = s.allowCrewNotes !== false;
  document.getElementById("lectureTitle").innerText = s.title || "Live Study Session";
  document.getElementById("channelTitle").innerText = "🎓 " + (s.channelTitle || "ShieldPro Study");
  document.getElementById("syncStatusText").innerText = s.hostOnline ? "Connected • Cross-City Live" : "Host Reconnecting…";
  document.getElementById("noteInputWrap").style.display = allowCrewNotes ? "block" : "none";

  renderChapters(s.chapters || []);
  const notesPlain = await decryptEnvelope(s.notesPayload);
  renderNotes((notesPlain && notesPlain.notes) ? notesPlain.notes : []);

  const decodedChats = [];
  for (const rawC of (s.chatHistory || [])) {
    const dec = await decryptEnvelope(rawC);
    if (dec && dec.text) decodedChats.push(dec);
  }
  chatHistory = decodedChats;
  renderChat();

  lastHostPos = Number(s.positionSec || 0);
  lastHostPlaying = s.isPlaying !== false;
  lastHostSpeed = Number(s.speed || 1.0);
  lastHostSentAt = Number(s.sentAtMs || Date.now());
  loadMediaStage(s.youtubeId || "", s.driveVideoUrl || "", lastHostPos);
  updateModeUi();
}

function loadMediaStage(ytId, driveUrl, startSec) {
  const stage = document.getElementById("videoStage");
  if (driveUrl && driveUrl !== currentDriveUrl) {
    currentDriveUrl = driveUrl;
    currentYtId = "";
    if (ytPlayer && ytPlayer.destroy) { try { ytPlayer.destroy(); } catch (_) {} ytPlayer = null; }
    stage.innerHTML = '<iframe id="driveIframe" src="' + esc(driveUrl) + '" allow="autoplay; fullscreen" allowfullscreen></iframe>';
    return;
  }
  if (ytId && ytId !== currentYtId) {
    currentYtId = ytId;
    currentDriveUrl = "";
    stage.innerHTML = '<div id="ytPlayerContainer"></div>';
    if (window.YT && window.YT.Player) initYt(ytId, startSec);
  }
}

window.onYouTubeIframeAPIReady = function() {
  if (currentYtId && !ytPlayer) initYt(currentYtId, lastHostPos);
};

function initYt(vid, startSec) {
  ytReady = false;
  ytPlayer = new YT.Player("ytPlayerContainer", {
    width: "100%", height: "100%", videoId: vid,
    playerVars: { autoplay: 1, controls: 1, rel: 0, playsinline: 1, start: Math.max(0, Math.floor(startSec || 0)) },
    events: {
      onReady: () => {
        ytReady = true;
        if (lastHostSpeed && ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(lastHostSpeed);
        if (!lastHostPlaying && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
      },
      onError: () => {
        const c = document.getElementById("ytPlayerContainer");
        if (c) c.innerHTML = '<iframe style="position:absolute;inset:0;width:100%;height:100%;border:0;" src="https://www.youtube-nocookie.com/embed/' + encodeURIComponent(vid) + '?autoplay=1&playsinline=1&start=' + Math.floor(lastHostPos || 0) + '" allow="autoplay; fullscreen" allowfullscreen></iframe>';
      }
    }
  });
}

function getActiveTime() {
  if (ytPlayer && ytReady && ytPlayer.getCurrentTime) return Number(ytPlayer.getCurrentTime()) || 0;
  return lastHostPos;
}

function computeExpectedHostPos() {
  const elapsed = lastHostPlaying ? Math.min(8, Math.max(0, (Date.now() - lastHostSentAt) / 1000)) * (lastHostSpeed || 1) : 0;
  return Math.max(0, lastHostPos + elapsed);
}

function applyDriftSync(force) {
  const expected = computeExpectedHostPos();
  const catchBtn = document.getElementById("catchUpBtn");
  if (catchBtn) catchBtn.innerText = "⚡ Catch Up (" + fmtTime(expected) + ")";
  if (studyMode !== "synced" || !ytPlayer || !ytReady) return;

  if (ytPlayer.setPlaybackRate && Math.abs((ytPlayer.getPlaybackRate() || 1) - lastHostSpeed) > 0.04) {
    ytPlayer.setPlaybackRate(lastHostSpeed);
  }
  if (force || Math.abs(expected - getActiveTime()) > 1.8) {
    ytPlayer.seekTo(expected, true);
  }
  const st = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
  if (lastHostPlaying && st !== 1) ytPlayer.playVideo();
  if (!lastHostPlaying && st === 1) ytPlayer.pauseVideo();
}

function applyHostCmd(cmd) {
  if (!ytPlayer || !ytReady) return;
  if (cmd.action === "play") ytPlayer.playVideo();
  else if (cmd.action === "pause") ytPlayer.pauseVideo();
  else if (cmd.action === "seek" && cmd.timestampSec >= 0) ytPlayer.seekTo(cmd.timestampSec, true);
  else if (cmd.action === "speed" && cmd.speed) ytPlayer.setPlaybackRate(cmd.speed);
}

function toggleStudyMode() {
  studyMode = studyMode === "synced" ? "free" : "synced";
  updateModeUi();
  if (studyMode === "synced") snapToHost();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "viewer_status", mode: studyMode, positionSec: Math.floor(getActiveTime()) }));
  }
}

function updateModeUi() {
  const btn = document.getElementById("modeToggleBtn");
  const catchBtn = document.getElementById("catchUpBtn");
  btn.innerText = studyMode === "synced" ? "🔒 Host-Lead Sync" : "🎧 Free Note Mode";
  catchBtn.style.display = studyMode === "free" ? "inline-flex" : "none";
}

function snapToHost() {
  studyMode = "synced";
  updateModeUi();
  applyDriftSync(true);
  showToast("Synced to Host (" + fmtTime(computeExpectedHostPos()) + ")");
}

function localTogglePlay() {
  if (!ytPlayer || !ytReady) return;
  const playing = ytPlayer.getPlayerState() === 1;
  if (playing) { ytPlayer.pauseVideo(); document.getElementById("playPauseBtn").innerText = "▶ Play"; }
  else { ytPlayer.playVideo(); document.getElementById("playPauseBtn").innerText = "⏸ Pause"; }
}
function localSkip(delta) {
  if (ytPlayer && ytReady) ytPlayer.seekTo(Math.max(0, getActiveTime() + delta), true);
}
function localSeek(sec) {
  if (ytPlayer && ytReady) { ytPlayer.seekTo(Math.max(0, sec), true); ytPlayer.playVideo(); }
}
function openExternalVideo() {
  if (currentDriveUrl) window.open(currentDriveUrl, "_blank", "noopener");
  else if (currentYtId) window.open("https://www.youtube.com/watch?v=" + encodeURIComponent(currentYtId) + "&t=" + Math.floor(getActiveTime()) + "s", "_blank", "noopener");
}
function toggleFullscreen() {
  const el = document.querySelector(".video-container");
  if (!document.fullscreenElement) el?.requestFullscreen?.();
  else document.exitFullscreen?.();
}

function renderRoster(members) {
  document.getElementById("viewersBadge").innerText = members.length + " ONLINE";
  const strip = document.getElementById("rosterStrip");
  strip.innerHTML = members.map(m =>
    '<span class="roster-chip ' + (m.role === "host" ? "host" : "") + '">' +
    (m.role === "host" ? "👑 " : "🎧 ") + esc(m.name) +
    (m.role === "viewer" && m.mode === "free" ? " (Free)" : "") + "</span>"
  ).join("");
}

function renderChapters(chapters) {
  const el = document.getElementById("chaptersStrip");
  el.innerHTML = chapters.map(c =>
    '<button class="chip-btn" onclick="localSeek(' + Number(c.seconds || 0) + ')">' + esc(c.timeLabel) + " " + esc(c.title) + "</button>"
  ).join("");
}

function renderNotes(notes) {
  const el = document.getElementById("notesContainer");
  if (!notes || !notes.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:18px;">No notes pinned yet.</div>';
    return;
  }
  el.innerHTML = notes.map(n =>
    '<div class="note-card" onclick="localSeek(' + Number(n.seconds || 0) + ')"><span class="note-time">⏱ ' + esc(n.timeLabel || "Note") + '</span><div class="note-body">' + esc(n.text) + "</div></div>"
  ).join("");
}

function prependLiveNote(n) {
  const el = document.getElementById("notesContainer");
  const div = document.createElement("div");
  div.className = "note-card";
  div.onclick = () => localSeek(n.positionSec || 0);
  div.innerHTML = '<span class="note-time">⏱ ' + fmtTime(n.positionSec || 0) + '</span><div class="note-body">' + esc(n.senderName + ": " + n.note) + "</div>";
  el.prepend(div);
}

function formatAiText(raw) {
  let s = esc(raw).replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
  s = s.replace(/\\[(\\d{1,2}:\\d{2}(?::\\d{2})?)\\]/g, (_, ts) => {
    const parts = ts.split(":").map(Number);
    const sec = parts.length === 3 ? parts[0]*3600 + parts[1]*60 + parts[2] : parts[0]*60 + parts[1];
    return '<span class="ai-ts-chip" onclick="localSeek(' + sec + ')">[' + ts + "]</span>";
  });
  return s.replace(/\\n/g, "<br>");
}

function renderChat() {
  const el = document.getElementById("chatContainer");
  el.innerHTML = chatHistory.map(m => {
    const isAi = m.isAi === true;
    return '<div class="chat-msg-card ' + (isAi ? "ai-msg" : "") + '">' +
      '<div class="' + (isAi ? "ai-card-header" : "") + '"><span class="chat-sender ' + (isAi ? "ai-sender" : "") + '">' + esc(m.senderName) + "</span></div>" +
      '<div class="chat-text">' + (isAi ? formatAiText(m.text) : esc(m.text)) + "</div></div>";
  }).join("");
  el.scrollTop = el.scrollHeight;
}

async function sendNote() {
  if (!unlocked || !allowCrewNotes || !ws || ws.readyState !== 1) return;
  const ta = document.getElementById("noteInput");
  const txt = ta.value.trim();
  if (!txt) return;
  const pos = Math.floor(getActiveTime());
  const payload = await encryptEnvelope({ senderName: myName, note: txt, positionSec: pos });
  ws.send(JSON.stringify({ type: "note_add", payload }));
  prependLiveNote({ senderName: myName, note: txt, positionSec: pos });
  ta.value = "";
  showToast("Note pinned to host & crew");
}

function toggleAiTag() {
  isAiTagged = !isAiTagged;
  const btn = document.getElementById("aiTagBtn");
  btn.innerText = isAiTagged ? "🛡️ @AI Active" : "🤖 Ask @AI";
  btn.style.borderColor = isAiTagged ? "var(--telemetry-sage)" : "";
}

function quickAi(mode) {
  const ts = fmtTime(getActiveTime());
  document.getElementById("chatInput").value = mode === "explain"
    ? "@AI Explain the concept at [" + ts + "] clearly with intuition and key exam takeaways."
    : "@AI Give 3 high-yield exam MCQs covering up to [" + ts + "] with answers.";
  if (!isAiTagged) toggleAiTag();
  sendChat();
}

async function sendChat() {
  if (!unlocked || !ws || ws.readyState !== 1) return;
  const ta = document.getElementById("chatInput");
  const txt = ta.value.trim();
  if (!txt) return;
  const taggedAi = isAiTagged || /@ai|@mentor/i.test(txt);
  const pos = Math.floor(getActiveTime());
  const msgObj = { id: crypto.randomUUID(), senderName: myName, text: txt, timestamp: Date.now(), isAi: false, taggedAi, positionSec: pos };
  const payload = await encryptEnvelope(msgObj);
  ws.send(JSON.stringify({ type: "chat_post", taggedAi, payload }));
  chatHistory.push(msgObj);
  renderChat();
  ta.value = "";
  if (isAiTagged) toggleAiTag();
}

function switchTab(id) {
  document.querySelectorAll(".panel-tab-content").forEach(e => e.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(e => e.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  document.getElementById(id === "notesTab" ? "btnNotesTab" : "btnChatTab").classList.add("active");
}

function setAiFont(mode) {
  document.body.setAttribute("data-ai-font", mode === "hand" ? "hand" : "mono");
  try { localStorage.setItem("shieldpro_ai_font", mode); } catch (_) {}
}

(function init() {
  try {
    const savedName = localStorage.getItem("shieldpro_crew_name");
    if (savedName) document.getElementById("nameInput").value = savedName;
    const savedFont = localStorage.getItem("shieldpro_ai_font") || "mono";
    setAiFont(savedFont);
  } catch (_) {}
  connectWs();
})();
</script>
<script src="https://www.youtube.com/iframe_api"></script>
</body>
</html>`;
}
