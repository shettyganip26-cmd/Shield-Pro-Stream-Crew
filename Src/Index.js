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
      return this.handleHttpRequest(request, url);
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

  async handleHttpRequest(request, url) {
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 1. Upload study resource file (POST /api/rooms/:roomCode/files)
    if (request.method === "POST" && (path.includes("/api/rooms/") || path.includes("/files"))) {
      if (!this.env.CREW_FILES) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: "R2 bucket binding 'CREW_FILES' not found. Add R2 bucket binding in Cloudflare Worker settings or share Google Drive links.",
          }),
          { status: 503, headers: corsHeaders({ "Content-Type": "application/json" }) }
        );
      }

      if (!this.room) {
        return new Response(
          JSON.stringify({ ok: false, error: "Study room is not active yet. Host must start the room first." }),
          { status: 404, headers: corsHeaders({ "Content-Type": "application/json" }) }
        );
      }

      // Verify authorization
      const hostSec = request.headers.get("X-Host-Secret") || "";
      const isHost = hostSec && (await this.verifyHostSecret(hostSec));
      if (!isHost && this.room.pinRequired) {
        const pin = String(request.headers.get("X-Room-Pin") || "").trim();
        const pinH = await sha256Hex(this.room.roomCode + ":" + pin);
        if (!pinH || pinH.toLowerCase() !== this.room.pinHash.toLowerCase()) {
          return new Response(
            JSON.stringify({ ok: false, error: "Invalid Room PIN or unauthorized upload." }),
            { status: 401, headers: corsHeaders({ "Content-Type": "application/json" }) }
          );
        }
      }

      let rawFileName = "study_resource.pdf";
      try {
        rawFileName = decodeURIComponent(request.headers.get("X-File-Name") || "study_resource.pdf");
      } catch (_) {
        rawFileName = request.headers.get("X-File-Name") || "study_resource.pdf";
      }
      const cleanMime = request.headers.get("Content-Type") || "application/pdf";
      let uploaderName = "";
      try {
        uploaderName = decodeURIComponent(request.headers.get("X-Uploader-Name") || "");
      } catch (_) {
        uploaderName = request.headers.get("X-Uploader-Name") || "";
      }
      if (!uploaderName) uploaderName = isHost ? "Host 🛡️" : "Study Peer";

      const buf = await request.arrayBuffer();
      if (buf.byteLength > 35 * 1024 * 1024) {
        return new Response(
          JSON.stringify({ ok: false, error: "File exceeds 35MB limit. Use Google Drive link for larger textbooks." }),
          { status: 413, headers: corsHeaders({ "Content-Type": "application/json" }) }
        );
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

      this.broadcastVerified({
        type: "resources_update",
        resources: this.room.resources,
      });

      return new Response(JSON.stringify({ ok: true, resource: item }), {
        status: 200,
        headers: corsHeaders({ "Content-Type": "application/json" }),
      });
    }

    // 2. Stream / Download study resource (GET /r/:roomCode/files/:fileId or /api/rooms/:roomCode/files/:fileId)
    if (request.method === "GET" && path.includes("/files/")) {
      if (!this.env.CREW_FILES) {
        return new Response("R2 storage not configured", { status: 503, headers: corsHeaders() });
      }
      const parts = path.split("/files/");
      const fileId = (parts[1] || "").split("?")[0].split("/")[0];
      const code = this.room ? this.room.roomCode : sanitizeRoomCode(parts[0].split("/").pop());
      if (!fileId || !code) {
        return new Response("Invalid file path", { status: 400, headers: corsHeaders() });
      }

      const list = await this.env.CREW_FILES.list({ prefix: `rooms/${code}/${fileId}/` });
      if (!list || !list.objects || list.objects.length === 0) {
        return new Response("Resource not found", { status: 404, headers: corsHeaders() });
      }

      const objKey = list.objects[0].key;
      const obj = await this.env.CREW_FILES.get(objKey);
      if (!obj) {
        return new Response("Resource not found", { status: 404, headers: corsHeaders() });
      }

      const fileName = obj.customMetadata?.originalName || objKey.split("/").pop() || "study_resource.pdf";
      const isDownload = url.searchParams.get("download") === "1";
      const headers = corsHeaders({
        "Content-Type": obj.httpMetadata?.contentType || "application/pdf",
        "Content-Disposition": isDownload
          ? `attachment; filename="${encodeURIComponent(fileName)}"`
          : `inline; filename="${encodeURIComponent(fileName)}"`,
        "Cache-Control": "public, max-age=3600",
      });
      return new Response(obj.body, { headers });
    }

    // 3. Delete study resource (DELETE /api/rooms/:roomCode/files/:fileId)
    if (request.method === "DELETE" && path.includes("/files/")) {
      const parts = path.split("/files/");
      const fileId = (parts[1] || "").split("?")[0].split("/")[0];
      const code = this.room ? this.room.roomCode : sanitizeRoomCode(parts[0].split("/").pop());
      if (this.env.CREW_FILES && fileId && code) {
        try {
          const list = await this.env.CREW_FILES.list({ prefix: `rooms/${code}/${fileId}/` });
          if (list && list.objects && list.objects.length > 0) {
            await this.env.CREW_FILES.delete(list.objects.map((o) => o.key));
          }
        } catch (_) {}
      }
      if (this.room && this.room.resources) {
        const idx = this.room.resources.findIndex((r) => r.id === fileId);
        if (idx >= 0) {
          this.room.resources.splice(idx, 1);
          this.broadcastVerified({
            type: "resources_update",
            resources: this.room.resources,
          });
        }
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: corsHeaders({ "Content-Type": "application/json" }),
      });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  }

  async cleanupRoomFiles() {
    if (!this.env.CREW_FILES || !this.room) return;
    try {
      const code = this.room.roomCode;
      const list = await this.env.CREW_FILES.list({ prefix: `rooms/${code}/` });
      if (list && list.objects && list.objects.length > 0) {
        const keys = list.objects.map((o) => o.key);
        await this.env.CREW_FILES.delete(keys);
      }
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
      this.broadcastAll({
        type: "room_closed",
        reason: "Host offline timeout reached. Study room closed.",
      });
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
          sentAtMs: Number(msg.sentAtMs || Date.now()),
          chapters: Array.isArray(msg.chapters) ? msg.chapters : [],
          notesPayload: msg.notesPayload || null,
          chatHistory: incomingChats.slice(-45),
          resources: Array.isArray(msg.resources) ? msg.resources : (this.room ? (this.room.resources || []) : []),
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
            this.room.pomodoroStartedAtMs = Date.now();
            if (msg.pomodoroPhase) this.room.pomodoroPhase = String(msg.pomodoroPhase);
          } else if (msg.pomodoroAction === "pause") {
            const elapsed = this.room.isPomodoroRunning && this.room.pomodoroStartedAtMs
              ? Math.floor((Date.now() - this.room.pomodoroStartedAtMs) / 1000) : 0;
            this.room.pomodoroRemainingSec = Math.max(0, (this.room.pomodoroRemainingSec || 0) - elapsed);
            this.room.isPomodoroRunning = false;
            this.room.pomodoroStartedAtMs = 0;
          } else if (msg.pomodoroAction === "reset" || msg.pomodoroAction === "stop") {
            this.room.isPomodoroRunning = false;
            this.room.pomodoroRemainingSec = 0;
            this.room.pomodoroStartedAtMs = 0;
          }
        }
        this.room.sentAtMs = Date.now();

        this.broadcastVerified(
          {
            type: "host_command",
            commandId: msg.commandId || Date.now(),
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
            sentAtMs: this.room.sentAtMs,
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

      case "doubt_ping": {
        if (!this.room || !meta.verified) return;
        const now = Date.now();
        if (now - (meta.lastDoubtPingMs || 0) < 10000) return;
        meta.lastDoubtPingMs = now;
        const payload = {
          type: "doubt_ping",
          senderName: meta.name,
          positionSec: Math.max(0, Math.floor(Number(msg.positionSec || 0))),
          ts: now,
        };
        if (this.hostSocket) this.safeSend(this.hostSocket, payload);
        this.broadcastVerified(payload, ws);
        return;
      }

      case "resource_add": {
        if (!this.room || !meta.verified) return;
        const resId = crypto.randomUUID().slice(0, 8);
        let rawUrl = String(msg.url || "").trim();
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
        this.broadcastVerified({
          type: "resources_update",
          resources: this.room.resources,
        });
        return;
      }

      case "resource_delete": {
        if (!this.room || !meta.verified) return;
        const resId = String(msg.resourceId || "");
        if (!resId || !this.room.resources) return;
        const idx = this.room.resources.findIndex((r) => r.id === resId);
        if (idx >= 0) {
          const target = this.room.resources[idx];
          if (!target.isDriveLink && this.env.CREW_FILES) {
            try {
              const list = await this.env.CREW_FILES.list({ prefix: `rooms/${this.room.roomCode}/${target.id}/` });
              if (list && list.objects && list.objects.length > 0) {
                await this.env.CREW_FILES.delete(list.objects.map((o) => o.key));
              }
            } catch (_) {}
          }
          this.room.resources.splice(idx, 1);
          this.broadcastVerified({
            type: "resources_update",
            resources: this.room.resources,
          });
        }
        return;
      }

      case "resource_focus": {
        if (!this.room || !meta.verified) return;
        const resId = String(msg.resourceId || "");
        const item = (this.room.resources || []).find((r) => r.id === resId);
        if (item) {
          this.broadcastVerified({
            type: "resource_focus",
            resource: item,
            focusedBy: meta.name,
          });
        }
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
        ? Math.max(0, Number(this.room.pomodoroRemainingSec || 0) - Math.floor((Date.now() - this.room.pomodoroStartedAtMs) / 1000))
        : Number(this.room.pomodoroRemainingSec || 0),
      pomodoroPhase: this.room.pomodoroPhase || "FOCUS",
      sentAtMs: this.room.sentAtMs,
      chapters: this.room.chapters || [],
      notesPayload: this.room.notesPayload || null,
      chatHistory: this.room.chatHistory || [],
      resources: this.room.resources || [],
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

    if (path.startsWith("/api/rooms/") || path.includes("/files/")) {
      const match = path.match(/(?:\/api\/rooms\/|\/r\/)([A-Za-z0-9-]+)\/files/);
      if (match && match[1]) {
        const code = sanitizeRoomCode(match[1]);
        const id = env.CREW_ROOMS.idFromName(code);
        const stub = env.CREW_ROOMS.get(id);
        return stub.fetch(request);
      }
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
  #videoStage { position: relative; width: 100%; height: 100%; transition: transform .2s ease; transform-origin: center center; }
  #ytPlayerContainer, #ytPlayerContainer iframe, #driveIframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  .video-hud-layer { position: absolute; inset: 0; pointer-events: none; z-index: 15; }
  .hud-pill { display: none; position: absolute; top: 10px; background: rgba(9,11,14,0.86); border: 1px solid var(--oro-champagne); color: var(--oro-highlight); font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 700; padding: 4px 9px; border-radius: 999px; backdrop-filter: blur(6px); }
  #zoomHudBadge { left: 10px; }
  #loopHudBadge { left: 90px; border-color: var(--telemetry-sage); color: #86EFAC; }
  #pomodoroHudBadge { right: 10px; border-color: #FCA5A5; color: #FECACA; }
  #laserPointerDot { display: none; position: absolute; width: 18px; height: 18px; border-radius: 50%; background: radial-gradient(circle, #FFF 0%, #EF4444 45%, rgba(239,68,68,0) 75%); box-shadow: 0 0 18px 6px rgba(239,68,68,0.82); transform: translate(-50%, -50%); transition: left .06s linear, top .06s linear; }
  body[data-layout="cinema"] main { grid-template-columns: 1fr; }
  body[data-layout="blackout"] .sidebar-column, body[data-layout="blackout"] .details-card { opacity: 0.2; transition: opacity .25s ease; }
  body[data-layout="blackout"] .sidebar-column:hover, body[data-layout="blackout"] .details-card:hover { opacity: 1; }
  /* 10-Foot Big Screen / Smart TV Mode */
  body[data-layout="tv"] main { grid-template-columns: minmax(0, 1.35fr) 460px; gap: 24px; padding: 22px 28px; max-width: 1920px; }
  body[data-layout="tv"] .lecture-title { font-size: 22px; font-weight: 800; line-height: 1.35; }
  body[data-layout="tv"] .lecture-channel { font-size: 13.5px; }
  body[data-layout="tv"] .brand-title { font-size: 16px; }
  body[data-layout="tv"] .brand-sub { font-size: 12.5px; }
  body[data-layout="tv"] .badge-chip, body[data-layout="tv"] .hud-pill { font-size: 13px; padding: 6px 14px; font-weight: 800; }
  body[data-layout="tv"] .btn { font-size: 13.5px; padding: 10px 18px; min-height: 44px; border-radius: 10px; }
  body[data-layout="tv"] .roster-chip { font-size: 12px; padding: 5px 12px; }
  body[data-layout="tv"] .tab-btn { font-size: 13.5px; padding: 14px 10px; }
  body[data-layout="tv"] .chat-text, body[data-layout="tv"] .note-body { font-size: 14.5px; line-height: 1.6; }
  body[data-layout="tv"] #laserPointerDot { width: 32px; height: 32px; box-shadow: 0 0 28px 10px rgba(239,68,68,0.95); }
  .details-card { background: var(--bg-card); border: 1px solid var(--border-hairline); border-radius: var(--radius-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .lecture-channel { font-size: 12px; color: var(--oro-champagne); font-weight: 600; }
  .lecture-title { font-size: 16px; font-weight: 700; color: var(--text-primary); line-height: 1.35; overflow-wrap: anywhere; }
  .roster-strip { display: flex; flex-wrap: wrap; gap: 6px; }
  .roster-chip { font-size: 10.5px; font-family: 'JetBrains Mono', monospace; background: var(--bg-surface); border: 1px solid var(--border-hairline); color: var(--text-secondary); padding: 3px 8px; border-radius: 999px; }
  .roster-chip.host { border-color: var(--oro-champagne); color: var(--oro-highlight); }
  .action-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .btn { background: var(--bg-surface); border: 1px solid var(--border-hairline); color: var(--text-primary); padding: 7px 12px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; min-height: 36px; transition: border-color .15s, background .15s; }
  .btn:hover { border-color: var(--oro-champagne); }
  .btn-gold { background: linear-gradient(135deg, #E6C687, #D4AF6A); color: #120E06; border-color: var(--oro-highlight); font-weight: 700; }
  .chapters-strip { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: thin; }
  .chip-btn { background: #141820; border: 1px solid var(--border-hairline); color: var(--text-secondary); font-size: 11px; padding: 5px 9px; border-radius: 8px; cursor: pointer; white-space: nowrap; flex-shrink: 0; }
  .sidebar-column { display: flex; flex-direction: column; min-height: 440px; min-width: 0; }
  .panel-card { background: var(--bg-card); border: 1px solid var(--border-hairline); border-radius: var(--radius-lg); display: flex; flex-direction: column; flex: 1; overflow: hidden; max-height: calc(100dvh - 100px); }
  .panel-tabs { display: grid; grid-template-columns: 1fr 1fr 1fr; background: #0E1117; border-bottom: 1px solid var(--border-hairline); }
  .tab-btn { background: transparent; border: none; color: var(--text-secondary); padding: 12px 6px; font-size: 11.5px; font-weight: 700; cursor: pointer; border-bottom: 2px solid transparent; display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
  .tab-btn.active { color: var(--oro-highlight); border-bottom-color: var(--oro-champagne); background: var(--bg-card); }
  .unread-badge { display: none; background: var(--telemetry-sage); color: #090B0E; font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 800; padding: 1px 6px; border-radius: 999px; }
  .unread-badge.visible { display: inline-block; }
  .res-card { background: var(--bg-surface); border: 1px solid var(--border-hairline); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; transition: border-color .18s, box-shadow .18s; }
  .res-card:hover { border-color: rgba(230, 198, 135, 0.5); }
  .res-card.pinned { border-color: var(--oro-champagne); box-shadow: 0 0 16px rgba(230,198,135,0.28); background: #1C1810; }
  .res-pin-badge { font-family: 'JetBrains Mono', monospace; font-size: 8.5px; font-weight: 800; color: var(--oro-highlight); background: rgba(230,198,135,0.16); border: 1px solid var(--oro-champagne); padding: 1px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 3px; align-self: flex-start; }
  .res-type-badge { font-size: 9px; font-family: 'JetBrains Mono', monospace; font-weight: 800; padding: 2px 5px; border-radius: 4px; align-self: flex-start; }
  .res-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .res-icon { font-size: 18px; flex-shrink: 0; }
  .res-title { font-size: 12px; font-weight: 700; color: var(--text-primary); word-break: break-word; line-height: 1.35; }
  .res-meta { font-size: 10px; color: var(--text-muted); font-family: 'JetBrains Mono', monospace; display: flex; gap: 6px; flex-wrap: wrap; }
  .res-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
  .panel-tab-content { display: none; flex-direction: column; flex: 1; padding: 12px; gap: 10px; min-height: 0; }
  .panel-tab-content.active { display: flex; }
  .chat-feed-wrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .notes-list, .chat-list { flex: 1; overflow-y: auto; overscroll-behavior: contain; scroll-behavior: smooth; display: flex; flex-direction: column; gap: 9px; padding-right: 2px; scrollbar-width: thin; scrollbar-color: #2D3545 transparent; }
  .notes-list::-webkit-scrollbar, .chat-list::-webkit-scrollbar { width: 5px; }
  .notes-list::-webkit-scrollbar-thumb, .chat-list::-webkit-scrollbar-thumb { background: #2D3545; border-radius: 999px; }
  #jumpLatestBtn { display: none; position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); background: var(--oro-champagne); color: #120E06; border: none; border-radius: 999px; padding: 6px 13px; font-size: 11px; font-weight: 800; cursor: pointer; box-shadow: 0 8px 20px rgba(0,0,0,0.55); z-index: 20; }
  #jumpLatestBtn.visible { display: inline-flex; align-items: center; gap: 5px; }
  .note-card { background: var(--bg-surface); border: 1px solid var(--border-hairline); border-left: 3px solid var(--oro-champagne); border-radius: 10px; padding: 9px 11px; cursor: pointer; }
  .note-time { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--oro-champagne); font-weight: 700; display: block; margin-bottom: 3px; }
  .note-body { font-size: 12.5px; color: var(--text-primary); line-height: 1.45; white-space: pre-wrap; }
  .chat-msg-row { display: flex; width: 100%; }
  .chat-msg-row.self { justify-content: flex-end; }
  .chat-msg-card { background: var(--bg-surface); border: 1px solid var(--border-hairline); border-radius: 14px; padding: 10px 12px; width: 100%; }
  .chat-msg-card.self-msg { max-width: 88%; background: #1E1A11; border-color: rgba(230, 198, 135, 0.55); border-bottom-right-radius: 4px; }
  .chat-msg-card.peer-msg { max-width: 90%; background: #161A22; border-color: #2A313E; border-bottom-left-radius: 4px; }
  .chat-msg-card.ai-msg { background: #FFFFFF; border: 1.5px solid #D9B773; border-left: 4px solid #0F766E; color: #141821; box-shadow: 0 8px 24px rgba(0,0,0,0.38); padding: 14px 16px; font-family: 'JetBrains Mono', ui-monospace, monospace; }
  body[data-ai-font="hand"] .chat-msg-card.ai-msg { font-family: 'Patrick Hand', cursive; font-size: 15.5px; }
  .chat-meta-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 5px; }
  .chat-sender { font-size: 11px; font-weight: 800; color: var(--oro-champagne); font-family: 'JetBrains Mono', monospace; }
  .chat-time { font-size: 9.5px; color: var(--text-muted); font-family: 'JetBrains Mono', monospace; }
  .chat-reply-btn { background: transparent; border: none; color: var(--text-secondary); cursor: pointer; font-size: 11px; padding: 2px 4px; }
  .chat-msg-card:not(.ai-msg) .chat-text { font-size: 13px; line-height: 1.5; color: #F3F4F6; white-space: pre-wrap; word-break: break-word; }
  .ai-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #E5E7EB; }
  .ai-sender { color: #0F5132; font-size: 11.5px; font-weight: 800; }
  .ai-verified-badge { font-family: 'JetBrains Mono', monospace; font-size: 9px; font-weight: 700; color: #0F766E; background: #ECFDF5; border: 1px solid #A7F3D0; padding: 2px 7px; border-radius: 999px; }
  .ai-msg .chat-text { color: #141821 !important; font-size: 12.6px; line-height: 1.62; word-break: break-word; }
  body[data-ai-font="hand"] .ai-msg .chat-text { font-size: 15.5px; line-height: 1.56; }
  .ai-h { font-weight: 800; color: #0B1220 !important; margin: 10px 0 5px; padding-left: 8px; border-left: 3px solid #D97706; font-size: 13.5px; line-height: 1.38; }
  .ai-p { margin: 5px 0; color: #141821 !important; }
  .ai-strong { font-weight: 800; color: #0B1220 !important; }
  .ai-em { font-style: italic; color: #0F766E !important; font-weight: 600; }
  .ai-inline-code { font-family: 'JetBrains Mono', monospace; font-size: 11.5px; background: #F1F5F9; color: #0F172A; border: 1px solid #CBD5E1; padding: 1px 5px; border-radius: 5px; }
  .ai-code-wrap { margin: 7px 0; border-radius: 8px; overflow: hidden; border: 1px solid #CBD5E1; }
  .ai-code-lang { background: #E2E8F0; color: #334155; font-family: 'JetBrains Mono', monospace; font-size: 9.5px; font-weight: 800; padding: 3px 10px; text-transform: uppercase; }
  .ai-code-block { background: #F8FAFC; padding: 10px; font-family: 'JetBrains Mono', monospace; font-size: 11.5px; color: #0F172A; overflow-x: auto; white-space: pre; }
  .ai-formula-box { background: #F8FAFC; border: 1px solid #CBD5E1; border-radius: 8px; padding: 8px 10px; margin: 6px 0; color: #B45309; font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 12px; }
  .ai-quote { background: #F0FDF4; border: 1px solid #BBF7D0; border-radius: 8px; padding: 8px 10px; margin: 6px 0; color: #14532D; }
  .ai-divider { border: 0; border-top: 1px solid #CBD5E1; margin: 8px 0; }
  .ai-li { display: flex; align-items: flex-start; gap: 7px; margin: 4px 0; }
  .ai-li.depth-1 { margin-left: 14px; }
  .ai-li.depth-2 { margin-left: 26px; }
  .ai-bullet-dot { color: #0F766E; font-weight: 900; flex-shrink: 0; }
  .ai-ol-row { display: flex; align-items: flex-start; gap: 8px; margin: 5px 0; }
  .ai-ol-num { background: #0F766E; color: #FFF; font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 800; padding: 1px 6px; border-radius: 5px; flex-shrink: 0; margin-top: 2px; }
  .ai-ts-chip { background: #ECFDF5; color: #0F766E; border: 1px solid #99F6E4; padding: 1px 6px; border-radius: 999px; font-family: 'JetBrains Mono', monospace; font-size: 10.5px; font-weight: 700; cursor: pointer; display: inline-block; }
  .ai-table-wrap { overflow-x: auto; margin: 6px 0; border-radius: 8px; border: 1px solid #CBD5E1; }
  .ai-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .ai-table th { background: #F1F5F9; color: #0F172A; text-align: left; padding: 6px 9px; border-bottom: 1px solid #CBD5E1; font-weight: 800; }
  .ai-table td { padding: 6px 9px; border-top: 1px solid #E2E8F0; color: #141821; }
  .ai-card-footer { display: flex; justify-content: flex-end; align-items: center; gap: 6px; margin-top: 9px; padding-top: 7px; border-top: 1px solid #E5E7EB; }
  .ai-card-action-btn { background: #F8FAFC; border: 1px solid #CBD5E1; color: #141821; font-family: 'JetBrains Mono', monospace; font-size: 10px; font-weight: 700; padding: 4px 8px; border-radius: 7px; cursor: pointer; }
  .slide-snap-card { position: relative; border-radius: 10px; overflow: hidden; border: 1px solid rgba(230,198,135,0.45); background: #0B0D11; margin: 6px 0; cursor: pointer; }
  .slide-snap-card img { display: block; width: 100%; max-height: 185px; object-fit: contain; background: #050608; }
  .slide-snap-badge { position: absolute; bottom: 6px; left: 6px; background: rgba(9,11,14,0.86); border: 1px solid var(--oro-champagne); color: var(--oro-highlight); font-family: 'JetBrains Mono', monospace; font-size: 9.5px; font-weight: 700; padding: 2px 7px; border-radius: 999px; }
  #slideLightboxModal { display: none; position: fixed; inset: 0; background: rgba(4,5,8,0.95); z-index: 995; align-items: center; justify-content: center; padding: 18px; backdrop-filter: blur(8px); flex-direction: column; gap: 10px; }
  #slideLightboxModal.open { display: flex; }
  #slideLightboxModal img { max-width: 96vw; max-height: 82dvh; border-radius: 12px; border: 1px solid var(--oro-champagne); object-fit: contain; }
  textarea, input[type="text"], input[type="password"] { width: 100%; background: #0E1117; border: 1px solid var(--border-hairline); border-radius: 9px; color: var(--text-primary); padding: 9px 11px; font-family: inherit; font-size: 13px; outline: none; }
  textarea { resize: none; min-height: 46px; }
  #pinModal { position: fixed; inset: 0; background: rgba(7,9,12,0.94); z-index: 999; display: flex; align-items: center; justify-content: center; padding: 18px; backdrop-filter: blur(8px); }
  .pin-box { width: 100%; max-width: 380px; background: var(--bg-card); border: 1px solid var(--oro-champagne); border-radius: 18px; padding: 24px 20px; text-align: center; display: flex; flex-direction: column; gap: 10px; }
  .pin-input { font-size: 20px; letter-spacing: 6px; text-align: center; color: var(--oro-highlight); }
  #toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%) translateY(16px); background: rgba(18,21,27,0.96); border: 1px solid var(--oro-champagne); color: var(--oro-highlight); padding: 9px 16px; border-radius: 999px; font-size: 12px; font-weight: 700; opacity: 0; pointer-events: none; transition: all .22s ease; z-index: 800; }
  #toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }

  /* Tablet Workstation (768px to 1180px landscape / portrait) */
  @media (min-width: 768px) and (max-width: 1180px) {
    main { grid-template-columns: minmax(0, 1.25fr) minmax(320px, 0.92fr); gap: 14px; padding: 14px 18px; max-width: 100%; }
    .panel-card { max-height: calc(100dvh - 84px); height: 100%; }
    .sidebar-column { height: 100%; }
  }
  @media (min-width: 768px) and (max-width: 1024px) and (orientation: portrait) {
    main { grid-template-columns: 1fr; gap: 14px; padding: 14px; }
    .panel-card { max-height: 560px; min-height: 420px; }
  }

  /* Smartphone Screens (max-width: 767px portrait & landscape) */
  @media (max-width: 767px) {
    main { grid-template-columns: 1fr; padding: 10px; gap: 12px; }
    header { padding: 8px 12px; flex-wrap: wrap; gap: 8px; }
    .brand-title { font-size: 13px; }
    .badge-chip { font-size: 10px; padding: 4px 8px; }
    .action-toolbar { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 6px; gap: 6px; scrollbar-width: none; }
    .action-toolbar::-webkit-scrollbar { display: none; }
    .action-toolbar .btn { flex-shrink: 0; min-height: 42px; padding: 8px 12px; font-size: 11.5px; }
    .sidebar-column { min-height: 380px; }
    .panel-card { max-height: 72dvh; border-radius: 14px; }
    .tab-btn { min-height: 44px; font-size: 12px; }
    input[type="text"], input[type="password"], textarea { font-size: 16px !important; }
    .video-container { border-radius: 12px; aspect-ratio: 16 / 9; }
  }

  @media (max-width: 480px) {
    .btn { min-height: 44px; }
    .header-meta { width: 100%; justify-content: space-between; }
  }

  @media (orientation: landscape) and (max-height: 540px) and (max-width: 960px) {
    header { padding: 5px 12px; }
    main { grid-template-columns: minmax(0, 1.35fr) minmax(250px, 0.95fr); gap: 10px; padding: 8px 10px; }
    .video-container { max-height: calc(100dvh - 90px); aspect-ratio: 16 / 9; }
    .panel-card { height: calc(100dvh - 58px); max-height: calc(100dvh - 58px); }
  }
</style>
</head>
<body data-ai-font="mono" data-layout="split">
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
      <div class="badge-chip" id="hostTelemetryPill">▶ 00:00 • 1.0x</div>
      <button class="btn" id="modeToggleBtn" onclick="toggleStudyMode()" style="border-color:var(--oro-champagne);color:var(--oro-highlight);">🔒 Host-Lead Sync</button>
      <button class="btn btn-gold" id="catchUpBtn" onclick="snapToHost()" style="display:none;">⚡ Catch Up (00:00)</button>
      <div class="badge-chip" id="viewersBadge">1 ONLINE</div>
    </div>
  </header>

  <main>
    <div class="stage-column">
      <div class="video-container" id="videoBox">
        <div id="videoStage">
          <div id="ytPlayerContainer"></div>
        </div>
        <div class="video-hud-layer">
          <div class="hud-pill" id="zoomHudBadge">🔍 1.0x</div>
          <div class="hud-pill" id="loopHudBadge">🔁 A–B LOOP</div>
          <div class="hud-pill" id="pomodoroHudBadge">⏱ FOCUS 25:00</div>
          <div id="laserPointerDot"></div>
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
          <button class="btn" id="doubtPingBtn" onclick="sendDoubtPing()">✋ Doubt</button>
          <button class="btn" id="layoutCycleBtn" onclick="cycleLayoutMode()">📐 Split Desk</button>
          <button class="btn" onclick="exportBrowserStudySheet()">📄 Export Sheet</button>
          <button class="btn" onclick="switchTab('resourcesTab')">📚 Resources</button>
          <button class="btn" onclick="openExternalVideo()">▶ Open Directly</button>
          <button class="btn" onclick="toggleFullscreen()">⛶ Fullscreen</button>
        </div>
      </div>
    </div>

    <aside class="sidebar-column">
      <div class="panel-card">
        <div class="panel-tabs">
          <button class="tab-btn active" id="btnNotesTab" onclick="switchTab('notesTab')">📝 Notes</button>
          <button class="tab-btn" id="btnChatTab" onclick="switchTab('chatTab')">💬 Chat &amp; AI <span class="unread-badge" id="chatUnreadBadge">0</span></button>
          <button class="tab-btn" id="btnResourcesTab" onclick="switchTab('resourcesTab')">📚 Resources <span class="unread-badge" id="resCountBadge" style="display:none;">0</span></button>
        </div>
        <div class="panel-tab-content active" id="notesTab">
          <div class="notes-list" id="notesContainer">
            <div style="font-size:12px;color:var(--text-muted);text-align:center;padding:18px;">Notes will appear once unlocked.</div>
          </div>
          <div id="noteInputWrap">
            <textarea id="noteInput" placeholder="Pin a timestamped note (Enter to save)…"></textarea>
            <div style="display:flex;justify-content:flex-end;margin-top:6px;">
              <button class="btn btn-gold" onclick="sendNote()">💾 Pin Note</button>
            </div>
          </div>
        </div>
        <div class="panel-tab-content" id="chatTab">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">
            <div style="display:flex;gap:4px;align-items:center;">
              <button class="btn" id="fontMonoBtn" onclick="setAiFont('mono')" style="padding:4px 8px;font-size:11px;min-height:28px;">JetBrains</button>
              <button class="btn" id="fontHandBtn" onclick="setAiFont('hand')" style="padding:4px 8px;font-size:11px;min-height:28px;">Patrick Hand</button>
            </div>
            <span id="aiThinkingBadge" style="display:none;font-size:11px;color:var(--oro-champagne);font-weight:700;">🤖 Host AI Thinking…</span>
          </div>
          <div class="chat-feed-wrap">
            <div class="chat-list" id="chatContainer"></div>
            <button id="jumpLatestBtn" onclick="jumpToLatestChat()">↓ New Messages</button>
          </div>
          <div>
            <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px;">
              <button class="btn" style="padding:4px 8px;font-size:10.5px;min-height:28px;" onclick="quickAi('explain')">⚡ Explain Moment</button>
              <button class="btn" style="padding:4px 8px;font-size:10.5px;min-height:28px;" onclick="quickAi('quiz')">🧠 3-Q Quiz</button>
            </div>
            <textarea id="chatInput" placeholder="Chat with crew or type @AI (Enter to send)…"></textarea>
            <div style="display:flex;justify-content:space-between;margin-top:6px;">
              <button class="btn" id="aiTagBtn" onclick="toggleAiTag()">🤖 Ask @AI</button>
              <button class="btn btn-gold" onclick="sendChat()">🚀 Send</button>
            </div>
          </div>
        </div>
        <div class="panel-tab-content" id="resourcesTab">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;">
            <span style="font-size:11px;font-weight:700;color:var(--oro-highlight);font-family:'JetBrains Mono',monospace;">SHARED STUDY MATERIALS</span>
            <div style="display:flex;gap:4px;">
              <button class="btn btn-gold" style="padding:4px 9px;font-size:11px;min-height:28px;" onclick="triggerResourceUpload()">⬆ Upload File</button>
              <button class="btn" style="padding:4px 9px;font-size:11px;min-height:28px;" onclick="toggleDriveLinkRow()">+ Drive Link</button>
            </div>
          </div>
          <input type="file" id="resFileInput" accept=".pdf,image/*,.doc,.docx,.txt" style="display:none;" onchange="handleBrowserFileUpload(this)">
          <div id="driveAddWrap" style="display:none;background:#141720;border:1px solid var(--border-hairline);border-radius:10px;padding:8px;margin-bottom:6px;">
            <input id="driveTitleInput" placeholder="Resource Title (e.g. Chapter 4 Practice Sheet)" style="width:100%;margin-bottom:6px;font-size:11.5px;padding:6px 8px;background:#0E1117;border:1px solid var(--border-hairline);border-radius:6px;color:var(--text-primary);outline:none;">
            <input id="driveUrlInput" placeholder="Google Drive or Web URL (drive.google.com/file/d/...)" style="width:100%;margin-bottom:6px;font-size:11.5px;padding:6px 8px;background:#0E1117;border:1px solid var(--border-hairline);border-radius:6px;color:var(--text-primary);outline:none;">
            <div style="display:flex;justify-content:flex-end;gap:6px;">
              <button class="btn" style="padding:3px 8px;font-size:11px;min-height:26px;" onclick="toggleDriveLinkRow()">Cancel</button>
              <button class="btn btn-gold" style="padding:3px 8px;font-size:11px;min-height:26px;" onclick="submitDriveLink()">Add Resource</button>
            </div>
          </div>
          <div id="resUploadProgress" style="display:none;background:#161D28;border:1px solid var(--oro-champagne);border-radius:8px;padding:8px;margin-bottom:6px;font-size:11px;">
            <div id="resUploadLabel" style="color:var(--oro-highlight);margin-bottom:4px;font-weight:700;">Uploading...</div>
            <div style="width:100%;background:#0D1016;border-radius:4px;height:6px;overflow:hidden;">
              <div id="resProgressBar" style="width:0%;height:100%;background:var(--oro-champagne);transition:width 0.2s;"></div>
            </div>
          </div>
          <div class="resources-list" id="resourcesContainer" style="overflow-y:auto;flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;padding-right:2px;scrollbar-width:thin;">
            <div style="font-size:12px;color:var(--text-muted);text-align:center;padding:18px;">No study resources shared yet.<br>Upload a PDF or paste a Google Drive link above.</div>
          </div>
        </div>
      </div>
    </aside>
  </main>
  <div id="resourceViewerModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;flex-direction:column;backdrop-filter:blur(6px);" onclick="closeResourceViewer()">
    <div style="display:flex;justify-content:space-between;align-items:center;background:#141720;border-bottom:1px solid var(--border-hairline);padding:10px 16px;gap:8px;" onclick="event.stopPropagation()">
      <div style="display:flex;align-items:center;gap:8px;min-width:0;">
        <span style="font-size:18px;" id="resViewerIcon">📄</span>
        <span id="resViewerTitle" style="font-weight:700;color:var(--oro-highlight);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Document</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <button class="btn" style="padding:4px 8px;font-size:11px;min-height:28px;" onclick="askAiAboutResource()">🤖 Ask @AI</button>
        <a id="resViewerExtLink" href="#" target="_blank" class="btn" style="padding:4px 8px;font-size:11px;min-height:28px;text-decoration:none;">↗ Open in Tab</a>
        <button class="btn btn-gold" style="padding:4px 10px;font-size:11px;min-height:28px;" onclick="closeResourceViewer()">✕ Close</button>
      </div>
    </div>
    <div style="flex:1;position:relative;background:#0A0C10;" onclick="event.stopPropagation()">
      <iframe id="resViewerFrame" src="" style="width:100%;height:100%;border:none;background:#0D1017;" allow="fullscreen"></iframe>
      <img id="resViewerImage" src="" alt="Resource Image" style="display:none;max-width:100%;max-height:100%;margin:auto;position:absolute;inset:0;object-fit:contain;">
    </div>
  </div>
  <div id="slideLightboxModal" onclick="closeSlideLightbox()">
    <img id="slideLightboxImg" src="" alt="Slide Preview" onclick="event.stopPropagation()">
    <button class="btn btn-gold" onclick="closeSlideLightbox()">✕ Close Slide View</button>
  </div>
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
let totalDurationSec = 0;
let lastHostPos = 0;
let lastHostPlaying = true;
let lastHostSpeed = 1.0;
let lastHostSentAt = Date.now();
let initialRemoteVolume = 100;
let initialRemoteMuted = false;
let latestNotesList = [];
let chatHistory = [];
let renderedChatRawTexts = [];
let reconnectTimer = null;
let pingTimer = null;
let activeTabId = "notesTab";
let unreadChatCount = 0;
let autoJoinAttempted = false;
let currentResources = [];
let currentOpenResourceId = "";
let activeFocusedResourceId = null;

let loopEnabled = false;
let loopStartSec = 0;
let loopEndSec = 0;
let loopInterval = null;
let pomodoroInterval = null;
let pomodoroRemSec = 0;
let currentLayout = "split";

function esc(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h > 0) return h + ":" + String(m).padStart(2,"0") + ":" + String(r).padStart(2,"0");
  return String(m).padStart(2,"0") + ":" + String(r).padStart(2,"0");
}

function fmtClock(ts) {
  try {
    const d = new Date(Number(ts) || Date.now());
    return String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
  } catch (_) { return ""; }
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
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  ws = new WebSocket(proto + location.host + "/ws/" + encodeURIComponent(ROOM_CODE));

  ws.onopen = () => {
    document.getElementById("syncStatusText").innerText = unlocked ? "Connected • Cross-City Live" : "PIN Verification Ready";
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "ping", sentAtMs: Date.now() }));
    }, 25000);
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
      if (!unlocked && msg.roomActive && !autoJoinAttempted) {
        const savedPin = sessionStorage.getItem("shieldpro_pin_" + ROOM_CODE) || "";
        const urlPin = new URLSearchParams(location.search).get("pin") || "";
        const tryPin = (urlPin || savedPin).trim();
        if (!pinRequired || tryPin) {
          if (tryPin) document.getElementById("pinInput").value = tryPin;
          autoJoinAttempted = true;
          submitJoin();
        }
      }
    } else if (msg.type === "auth_error") {
      try { sessionStorage.removeItem("shieldpro_pin_" + ROOM_CODE); } catch (_) {}
      document.getElementById("pinModal").style.display = "flex";
      const errEl = document.getElementById("pinError");
      errEl.innerText = msg.message || "Invalid PIN";
      errEl.style.display = "block";
    } else if (msg.type === "room_snapshot") {
      unlocked = true;
      try {
        if (currentPin) sessionStorage.setItem("shieldpro_pin_" + ROOM_CODE, currentPin);
        sessionStorage.setItem("shieldpro_name_" + ROOM_CODE, myName);
      } catch (_) {}
      document.getElementById("pinError").style.display = "none";
      document.getElementById("pinModal").style.display = "none";
      await applyRoomSnapshot(msg);
    } else if (msg.type === "playback_sync") {
      lastHostPos = Number(msg.positionSec || 0);
      lastHostPlaying = msg.isPlaying !== false;
      lastHostSpeed = Number(msg.speed || 1.0);
      lastHostSentAt = Number(msg.sentAtMs || Date.now());
      hostLeadSync = msg.hostLeadSync !== false;
      updateTelemetryPill();
      applyDriftSync(Boolean(msg.forceSeek));
    } else if (msg.type === "host_command") {
      if (studyMode === "synced") applyHostCmd(msg);
      updateTelemetryPill();
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
        if (!chatHistory.some(c => c.id && c.id === plain.id)) {
          chatHistory.push(plain);
          onIncomingChatMessage(plain);
        }
      }
    } else if (msg.type === "ai_thinking") {
      document.getElementById("aiThinkingBadge").style.display = msg.thinking ? "inline" : "none";
    } else if (msg.type === "doubt_ping") {
      showToast("✋ " + (msg.senderName || "Peer") + " flagged a doubt @ " + fmtTime(msg.positionSec || 0));
    } else if (msg.type === "resources_update") {
      currentResources = Array.isArray(msg.resources) ? msg.resources : [];
      renderResources(currentResources);
    } else if (msg.type === "resource_focus") {
      if (msg.resource) {
        activeFocusedResourceId = msg.resource.id;
        showToast("📌 " + (msg.focusedBy || "Host") + " pinned " + msg.resource.name);
        const badge = document.getElementById("resCountBadge");
        if (badge) { badge.innerText = "★"; badge.style.display = "inline-block"; }
        renderResources(currentResources);
      }
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
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    document.getElementById("syncStatusText").innerText = "Reconnecting…";
    reconnectTimer = setTimeout(connectWs, 2200);
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
  totalDurationSec = Number(s.durationSec || 0);
  initialRemoteVolume = Number(s.remoteVolume ?? 100);
  initialRemoteMuted = Boolean(s.isRemoteMuted);
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
  renderChat(true);

  currentResources = Array.isArray(s.resources) ? s.resources : [];
  renderResources(currentResources);

  lastHostPos = Number(s.positionSec || 0);
  lastHostPlaying = s.isPlaying !== false;
  lastHostSpeed = Number(s.speed || 1.0);
  lastHostSentAt = Number(s.sentAtMs || Date.now());
  updateTelemetryPill();
  loadMediaStage(s.youtubeId || "", s.driveVideoUrl || "", lastHostPos);
  updateLayoutMode(s.layoutMode || "split");
  updateStageZoom(Number(s.zoomScale ?? 1.0), Number(s.panX ?? 0), Number(s.panY ?? 0));
  updateLoopState(Boolean(s.isLoopEnabled), Number(s.loopPointASec ?? 0), Number(s.loopPointBSec ?? 0));
  updateLaserState(Boolean(s.isLaserActive), Number(s.laserXPercent ?? 50), Number(s.laserYPercent ?? 50));
  if (Number(s.pomodoroRemainingSec || 0) > 0) {
    handlePomodoroCmd(s.isPomodoroRunning ? "start" : "pause", 0, s.pomodoroPhase || "FOCUS", Number(s.pomodoroRemainingSec));
  }
  updateModeUi();
}

function loadMediaStage(ytId, driveUrl, startSec) {
  const stage = document.getElementById("videoStage");
  if (driveUrl && driveUrl !== currentDriveUrl) {
    currentDriveUrl = driveUrl;
    currentYtId = "";
    if (ytPlayer && ytPlayer.destroy) { try { ytPlayer.destroy(); } catch (_) {} ytPlayer = null; ytReady = false; }
    stage.innerHTML = '<iframe id="driveIframe" src="' + esc(driveUrl) + '" allow="autoplay; fullscreen" allowfullscreen></iframe>';
    return;
  }
  if (ytId && ytId !== currentYtId) {
    if (ytPlayer && ytReady && typeof ytPlayer.loadVideoById === "function" && !currentDriveUrl) {
      currentYtId = ytId;
      ytPlayer.loadVideoById({ videoId: ytId, startSeconds: Math.max(0, Math.floor(startSec || 0)) });
      return;
    }
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
        if (ytPlayer.setVolume) ytPlayer.setVolume(Math.max(0, Math.min(100, initialRemoteVolume)));
        if (initialRemoteMuted && ytPlayer.mute) ytPlayer.mute();
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

function updateTelemetryPill() {
  const pill = document.getElementById("hostTelemetryPill");
  if (!pill) return;
  const pos = computeExpectedHostPos();
  const spd = Number(lastHostSpeed || 1.0);
  const spdText = (Math.round(spd * 100) % 10 === 0 ? spd.toFixed(1) : spd.toFixed(2)) + "x";
  const durPart = totalDurationSec > 0 ? (" / " + fmtTime(totalDurationSec)) : "";
  pill.innerText = (lastHostPlaying ? "▶ " : "⏸ ") + fmtTime(pos) + durPart + " • " + spdText;
}

function applyDriftSync(force) {
  const expected = computeExpectedHostPos();
  const catchBtn = document.getElementById("catchUpBtn");
  if (catchBtn) catchBtn.innerText = "⚡ Catch Up (" + fmtTime(expected) + ")";
  const playBtn = document.getElementById("playPauseBtn");
  if (playBtn) playBtn.innerText = lastHostPlaying ? "⏸ Pause" : "▶ Play";
  if (studyMode !== "synced" || !ytPlayer || !ytReady) return;

  if (ytPlayer.setPlaybackRate && Math.abs((ytPlayer.getPlaybackRate() || 1) - lastHostSpeed) > 0.04) {
    ytPlayer.setPlaybackRate(lastHostSpeed);
  }
  if (force || Math.abs(expected - getActiveTime()) > 1.6) {
    ytPlayer.seekTo(expected, true);
  }
  const st = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1;
  if (lastHostPlaying && st !== 1) ytPlayer.playVideo();
  if (!lastHostPlaying && st === 1) ytPlayer.pauseVideo();
}

function updateLayoutMode(mode) {
  currentLayout = mode || "split";
  document.body.setAttribute("data-layout", currentLayout);
  const btn = document.getElementById("layoutCycleBtn");
  if (btn) {
    btn.innerText = currentLayout === "cinema" ? "🎬 Cinema" : (currentLayout === "blackout" ? "🌑 Focus" : (currentLayout === "tv" ? "📺 10-Foot TV" : "📐 Split Desk"));
  }
}

function cycleLayoutMode() {
  const next = currentLayout === "split" ? "cinema" : (currentLayout === "cinema" ? "blackout" : (currentLayout === "blackout" ? "tv" : "split"));
  updateLayoutMode(next);
  showToast("Switched to " + (next === "tv" ? "TV 10-Foot Big Screen Mode" : next.toUpperCase()));
}

function toggleAudioMute() {
  if (ytPlayer && typeof ytPlayer.isMuted === "function") {
    if (ytPlayer.isMuted()) {
      ytPlayer.unMute();
      showToast("🔊 Audio unmuted");
    } else {
      ytPlayer.mute();
      showToast("🔇 Audio muted");
    }
  }
}

function updateStageZoom(scale, panX, panY) {
  const st = document.getElementById("videoStage");
  const badge = document.getElementById("zoomHudBadge");
  const z = Math.max(1.0, Math.min(3.5, Number(scale || 1.0)));
  if (st) {
    st.style.transform = z <= 1.02 ? "none" : ("scale(" + z + ") translate(" + (panX || 0) + "%, " + (panY || 0) + "%)");
  }
  if (badge) {
    badge.style.display = z > 1.04 ? "block" : "none";
    badge.innerText = "🔍 " + z.toFixed(1) + "x";
  }
}

function updateLoopState(enabled, startSec, endSec) {
  loopEnabled = Boolean(enabled) && endSec > startSec;
  loopStartSec = Number(startSec || 0);
  loopEndSec = Number(endSec || 0);
  const badge = document.getElementById("loopHudBadge");
  if (badge) {
    badge.style.display = loopEnabled ? "block" : "none";
    badge.innerText = "🔁 " + fmtTime(loopStartSec) + "–" + fmtTime(loopEndSec);
  }
  if (loopInterval) { clearInterval(loopInterval); loopInterval = null; }
  if (loopEnabled) {
    loopInterval = setInterval(() => {
      if (!ytPlayer || !ytReady || !loopEnabled) return;
      const cur = getActiveTime();
      if (cur >= loopEndSec || cur < loopStartSec - 1) {
        ytPlayer.seekTo(loopStartSec, true);
      }
    }, 350);
  }
}

function updateLaserState(active, xPct, yPct) {
  const dot = document.getElementById("laserPointerDot");
  if (!dot) return;
  dot.style.display = active ? "block" : "none";
  dot.style.left = Math.max(2, Math.min(98, Number(xPct || 50))) + "%";
  dot.style.top = Math.max(2, Math.min(98, Number(yPct || 50))) + "%";
}

function handlePomodoroCmd(action, minutes, phase, exactSeconds) {
  const badge = document.getElementById("pomodoroHudBadge");
  if (pomodoroInterval) { clearInterval(pomodoroInterval); pomodoroInterval = null; }
  if (action === "reset" || action === "stop") {
    pomodoroRemSec = 0;
    if (badge) badge.style.display = "none";
    return;
  }
  if (action === "start") {
    pomodoroRemSec = typeof exactSeconds === "number" && exactSeconds > 0 ? Math.floor(exactSeconds) : Math.max(60, Number(minutes || 25) * 60);
    const label = (phase || "FOCUS").toUpperCase();
    const tick = () => {
      if (!badge) return;
      badge.style.display = "block";
      badge.innerText = "⏱ " + label + " " + fmtTime(pomodoroRemSec);
    };
    tick();
    pomodoroInterval = setInterval(() => {
      if (pomodoroRemSec > 0) {
        pomodoroRemSec -= 1;
        tick();
      } else {
        clearInterval(pomodoroInterval);
        pomodoroInterval = null;
        showToast("⏱ " + label + " block finished!");
      }
    }, 1000);
  } else if (action === "pause" && badge) {
    if (typeof exactSeconds === "number" && exactSeconds > 0) pomodoroRemSec = Math.floor(exactSeconds);
    badge.style.display = pomodoroRemSec > 0 ? "block" : "none";
    badge.innerText = "⏸ TIMER " + fmtTime(pomodoroRemSec);
  }
}

function applyHostCmd(cmd) {
  if (cmd.action === "layout" && cmd.layoutMode) {
    updateLayoutMode(cmd.layoutMode);
    return;
  }
  if (cmd.action === "fullscreen") {
    toggleFullscreen();
    return;
  }
  if (cmd.action === "zoom") {
    updateStageZoom(cmd.zoomScale, cmd.panX, cmd.panY);
    return;
  }
  if (cmd.action === "laser") {
    updateLaserState(cmd.laserActive, cmd.laserX, cmd.laserY);
    return;
  }
  if (cmd.action === "loop") {
    updateLoopState(cmd.loopEnabled, cmd.loopStartSec, cmd.loopEndSec);
    return;
  }
  if (cmd.action === "pomodoro") {
    handlePomodoroCmd(cmd.pomodoroAction, cmd.pomodoroMinutes, cmd.pomodoroPhase);
    return;
  }
  if (!ytPlayer || !ytReady) return;
  if (cmd.action === "play") {
    lastHostPlaying = true;
    ytPlayer.playVideo();
  } else if (cmd.action === "pause") {
    lastHostPlaying = false;
    ytPlayer.pauseVideo();
  } else if (cmd.action === "seek" && cmd.timestampSec >= 0) {
    lastHostPos = Number(cmd.timestampSec);
    lastHostSentAt = Date.now();
    ytPlayer.seekTo(cmd.timestampSec, true);
  } else if (cmd.action === "skip" && typeof cmd.skipDeltaSec === "number") {
    const target = Math.max(0, getActiveTime() + cmd.skipDeltaSec);
    lastHostPos = target;
    lastHostSentAt = Date.now();
    ytPlayer.seekTo(target, true);
  } else if (cmd.action === "speed" && cmd.speed) {
    lastHostSpeed = Number(cmd.speed);
    ytPlayer.setPlaybackRate(cmd.speed);
  } else if (cmd.action === "volume" && typeof cmd.volume === "number" && ytPlayer.setVolume) {
    ytPlayer.setVolume(Math.max(0, Math.min(100, cmd.volume)));
  } else if (cmd.action === "mute") {
    if (cmd.muted && ytPlayer.mute) ytPlayer.mute();
    else if (!cmd.muted && ytPlayer.unMute) ytPlayer.unMute();
  }
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
  latestNotesList = Array.isArray(notes) ? notes.slice() : [];
  const el = document.getElementById("notesContainer");
  if (!latestNotesList.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:18px;">No notes pinned yet.</div>';
    return;
  }
  el.innerHTML = latestNotesList.map(n =>
    '<div class="note-card" onclick="localSeek(' + Number(n.seconds || 0) + ')"><span class="note-time">⏱ ' + esc(n.timeLabel || "Note") + '</span><div class="note-body">' + esc(n.text) + "</div></div>"
  ).join("");
}

function prependLiveNote(n) {
  const el = document.getElementById("notesContainer");
  if (el.innerText.includes("No notes pinned yet.")) el.innerHTML = "";
  latestNotesList.unshift({ timeLabel: fmtTime(n.positionSec || 0), seconds: n.positionSec || 0, text: (n.senderName ? n.senderName + ": " : "") + n.note });
  const div = document.createElement("div");
  div.className = "note-card";
  div.onclick = () => localSeek(n.positionSec || 0);
  div.innerHTML = '<span class="note-time">⏱ ' + fmtTime(n.positionSec || 0) + '</span><div class="note-body">' + esc((n.senderName ? n.senderName + ": " : "") + n.note) + "</div>";
  el.prepend(div);
}

function cleanLatexMath(expr) {
  let s = String(expr || "").trim();
  for (let k = 0; k < 4; k++) {
    s = s.replace(/\\\\(?:text|textbf|mathbf|mathrm|mathit|operatorname)\\{([^{}]*)\\}/g, "$1");
    s = s.replace(/\\\\frac\\{([^{}]*)\\}\\{([^{}]*)\\}/g, "($1) / ($2)");
  }
  return s.replace(/\\\\times/g, "×").replace(/\\\\div/g, "÷").replace(/\\\\cdot/g, "·")
    .replace(/\\\\pm/g, "±").replace(/\\\\approx/g, "≈").replace(/\\\\neq/g, "≠")
    .replace(/\\\\leq/g, "≤").replace(/\\\\geq/g, "≥").replace(/\\\\Rightarrow/g, "⇒")
    .replace(/\\\\rightarrow/g, "→").replace(/\\\\leftarrow/g, "←").replace(/\\\\sum/g, "Σ")
    .replace(/\\\\Delta/g, "Δ").replace(/\\\\sqrt\\{([^{}]*)\\}/g, "√($1)")
    .replace(/\\\\(left|right)/g, "").replace(/\\\\([a-zA-Z]+)/g, "$1")
    .replace(/[{}]/g, "").replace(/\\s{2,}/g, " ").trim();
}

function formatInlineMarkdown(escaped) {
  let s = escaped.replace(/\\$([^$\\n]{1,180})\\$/g, (_, m) => cleanLatexMath(m));
  s = s.replace(/\`([^\`\\n]+)\`/g, '<code class="ai-inline-code">$1</code>');
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<span class="ai-strong">$1</span>');
  s = s.replace(/(^|[^\\w*])\\*([^\\s*][^*\\n]{0,140}?[^\\s*])\\*/g, '$1<span class="ai-em">$2</span>');
  s = s.replace(/\\[(\\d{1,2}:\\d{2}(?::\\d{2})?)\\]/g, (_, ts) => {
    const parts = ts.split(":").map(Number);
    const sec = parts.length === 3 ? parts[0]*3600 + parts[1]*60 + parts[2] : parts[0]*60 + parts[1];
    return '<span class="ai-ts-chip" onclick="localSeek(' + sec + ')">⏱ ' + ts + "</span>";
  });
  return s;
}

function splitPipeRow(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map(c => c.trim());
}

function isTableDivider(line) {
  const cells = splitPipeRow(line);
  return cells.length >= 2 && cells.every(c => /^:?-{2,}:?$/.test(c));
}

function renderTableHtml(tableLines) {
  const headers = splitPipeRow(tableLines[0]);
  const start = isTableDivider(tableLines[1]) ? 2 : 1;
  let html = '<div class="ai-table-wrap"><table class="ai-table"><thead><tr>' +
    headers.map(h => "<th>" + formatInlineMarkdown(esc(h)) + "</th>").join("") +
    "</tr></thead><tbody>";
  for (let r = start; r < tableLines.length; r++) {
    const row = splitPipeRow(tableLines[r]);
    html += "<tr>" + headers.map((_, ci) => "<td>" + formatInlineMarkdown(esc(row[ci] || "")) + "</td>").join("") + "</tr>";
  }
  return html + "</tbody></table></div>";
}

function formatAiMarkdown(raw) {
  let text = String(raw || "").replace(/\\r\\n/g, "\\n");
  const codeBlocks = [];
  text = text.replace(/\`\`\`([a-zA-Z0-9_-]*)[ \\t]*\\n?([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: (lang || "").trim(), code: esc(code.trimEnd()) });
    return "\\n@@CODE_" + idx + "@@\\n";
  });
  const mathBlocks = [];
  text = text.replace(/\\$\\$([\\s\\S]*?)\\$\\$/g, (_, m) => {
    const idx = mathBlocks.length;
    mathBlocks.push(esc(cleanLatexMath(m)));
    return "\\n@@MATH_" + idx + "@@\\n";
  });

  const lines = text.split("\\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const t = rawLine.trim();
    if (!t) continue;
    const cm = t.match(/^@@CODE_(\\d+)@@$/);
    if (cm) {
      const cb = codeBlocks[Number(cm[1])];
      out.push('<div class="ai-code-wrap">' + (cb.lang ? '<div class="ai-code-lang">' + esc(cb.lang) + "</div>" : "") + '<pre class="ai-code-block">' + cb.code + "</pre></div>");
      continue;
    }
    const mm = t.match(/^@@MATH_(\\d+)@@$/);
    if (mm) {
      out.push('<div class="ai-formula-box">' + mathBlocks[Number(mm[1])] + "</div>");
      continue;
    }
    if (t.includes("|") && (t.startsWith("|") || (i + 1 < lines.length && isTableDivider(lines[i + 1])))) {
      const tLines = [t];
      let j = i + 1;
      while (j < lines.length && lines[j].trim().includes("|")) { tLines.push(lines[j].trim()); j++; }
      if (tLines.length >= 2) { out.push(renderTableHtml(tLines)); i = j - 1; continue; }
    }
    if (/^(?:---+|___+|\\*\\*\\*+)$/.test(t)) { out.push('<hr class="ai-divider">'); continue; }
    const hm = t.match(/^#{1,6}\\s+(.+)$/);
    if (hm) { out.push('<div class="ai-h">' + formatInlineMarkdown(esc(hm[1].replace(/^\\*\\*(.*)\\*\\*$/, "$1"))) + "</div>"); continue; }
    const qm = t.match(/^>\\s*(.+)$/);
    if (qm) { out.push('<div class="ai-quote">' + formatInlineMarkdown(esc(qm[1])) + "</div>"); continue; }
    const bm = rawLine.match(/^(\\s*)[*\\-•]\\s+(.+)$/);
    if (bm) {
      const d = bm[1].length >= 4 ? "depth-2" : (bm[1].length >= 2 ? "depth-1" : "");
      out.push('<div class="ai-li ' + d + '"><span class="ai-bullet-dot">' + (bm[1].length >= 2 ? "◦" : "•") + "</span><span>" + formatInlineMarkdown(esc(bm[2])) + "</span></div>");
      continue;
    }
    const om = t.match(/^(\\d+)[.)]\\s+(.+)$/);
    if (om) {
      out.push('<div class="ai-ol-row"><span class="ai-ol-num">' + om[1] + "</span><span>" + formatInlineMarkdown(esc(om[2])) + "</span></div>");
      continue;
    }
    out.push('<div class="ai-p">' + formatInlineMarkdown(esc(t)) + "</div>");
  }
  return out.join("");
}

function updateUnreadUi() {
  const b = document.getElementById("chatUnreadBadge");
  const j = document.getElementById("jumpLatestBtn");
  if (b) {
    b.innerText = String(unreadChatCount);
    b.classList.toggle("visible", unreadChatCount > 0 && activeTabId !== "chatTab");
  }
  if (j && j.classList.contains("visible")) {
    j.innerText = unreadChatCount > 0 ? ("↓ " + unreadChatCount + " New Messages") : "↓ Jump to Latest";
  }
}

function onIncomingChatMessage(plain) {
  const el = document.getElementById("chatContainer");
  const nearBottom = !el || (el.scrollHeight - el.scrollTop - el.clientHeight <= 80);
  const isSelf = !plain.isAi && plain.senderName === myName;
  if (activeTabId !== "chatTab" || (!nearBottom && !isSelf)) {
    unreadChatCount += 1;
  }
  renderChat(nearBottom || isSelf);
  updateUnreadUi();
}

function jumpToLatestChat() {
  const el = document.getElementById("chatContainer");
  const btn = document.getElementById("jumpLatestBtn");
  unreadChatCount = 0;
  updateUnreadUi();
  if (btn) btn.classList.remove("visible");
  if (el) el.scrollTop = el.scrollHeight;
}

function quoteReply(sender) {
  const ta = document.getElementById("chatInput");
  if (!ta) return;
  const p = "@" + sender + " ";
  if (!ta.value.startsWith(p)) ta.value = p + ta.value;
  ta.focus();
}

function renderChat(scrollToEnd = false) {
  const el = document.getElementById("chatContainer");
  if (!el) return;
  const wasNearBottom = scrollToEnd || (el.scrollHeight - el.scrollTop - el.clientHeight <= 80);
  renderedChatRawTexts = chatHistory.map(m => String(m.text || ""));
  el.innerHTML = chatHistory.map((m, idx) => {
    const isAi = m.isAi === true;
    const ts = fmtClock(m.timestamp);
    if (isAi) {
      return '<div class="chat-msg-row"><div class="chat-msg-card ai-msg">' +
        '<div class="ai-card-header"><span class="chat-sender ai-sender">' + esc(m.senderName) + '</span><span class="ai-verified-badge">LECTURE SYNCED</span></div>' +
        '<div class="chat-text">' + formatAiMarkdown(m.text) + "</div>" +
        '<div class="ai-card-footer"><span class="chat-time" style="margin-right:auto;color:#64748B;">' + ts + "</span>" +
        '<button class="ai-card-action-btn" onclick="saveAiMessageAsNote(' + idx + ', this)">📌 Save to Notes</button>' +
        '<button class="ai-card-action-btn" onclick="copyAiMessage(' + idx + ', this)">📋 Copy</button></div>' +
        "</div></div>";
    }
    const isSelf = m.senderName === myName;
    const isHost = !isSelf && String(m.senderName || "").toLowerCase().startsWith("host");
    let slideHtml = "";
    if (m.slidePreviewUrl) {
      const safeImg = esc(m.slidePreviewUrl);
      const tsMatch = String(m.text || "").match(/\\[Slide Frame Attached\\s*@\\s*([^\\]]+)\\]/i);
      const badgeTxt = tsMatch ? ("📸 SLIDE @ " + esc(tsMatch[1])) : "📸 SLIDE SNAPSHOT";
      slideHtml = '<div class="slide-snap-card" onclick="openSlideLightbox(\\'' + safeImg + '\\')"><img src="' + safeImg + '" alt="Lecture Slide" loading="lazy"><span class="slide-snap-badge">' + badgeTxt + "</span></div>";
    }
    return '<div class="chat-msg-row ' + (isSelf ? "self" : "") + '">' +
      '<div class="chat-msg-card ' + (isSelf ? "self-msg" : "peer-msg") + '">' +
      '<div class="chat-meta-row"><span class="chat-sender">' + (isHost ? "👑 " : "") + esc(m.senderName) + (isSelf ? " (You)" : "") + '</span>' +
      '<div style="display:flex;align-items:center;gap:4px;"><span class="chat-time">' + ts + '</span><button class="chat-reply-btn" onclick="quoteReply(\\'' + esc(m.senderName).replace(/\'/g, "") + '\\')" title="Reply">↩</button></div></div>' +
      slideHtml +
      '<div class="chat-text">' + formatInlineMarkdown(esc(m.text)) + "</div>" +
      "</div></div>";
  }).join("");

  if (wasNearBottom) {
    el.scrollTop = el.scrollHeight;
    document.getElementById("jumpLatestBtn")?.classList.remove("visible");
    unreadChatCount = 0;
  } else {
    document.getElementById("jumpLatestBtn")?.classList.add("visible");
  }
  updateUnreadUi();
}

async function saveAiMessageAsNote(idx, btn) {
  if (!unlocked || !allowCrewNotes || !ws || ws.readyState !== 1) return;
  const raw = renderedChatRawTexts[idx];
  if (!raw) return;
  const pos = Math.floor(getActiveTime());
  const payload = await encryptEnvelope({ senderName: myName + " (AI Note)", note: raw, positionSec: pos });
  ws.send(JSON.stringify({ type: "note_add", payload }));
  prependLiveNote({ senderName: myName + " (AI Note)", note: raw, positionSec: pos });
  if (btn) { btn.innerText = "✓ Saved!"; setTimeout(() => { btn.innerText = "📌 Save to Notes"; }, 2400); }
  showToast("Saved AI insight to Lecture Notes");
}

function copyAiMessage(idx, btn) {
  const raw = renderedChatRawTexts[idx];
  if (!raw) return;
  navigator.clipboard?.writeText(raw).then(() => {
    if (btn) { btn.innerText = "✓ Copied"; setTimeout(() => { btn.innerText = "📋 Copy"; }, 2000); }
  }).catch(() => {});
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
  renderChat(true);
  ta.value = "";
  if (isAiTagged) toggleAiTag();
}

function switchTab(id) {
  activeTabId = id;
  document.querySelectorAll(".panel-tab-content").forEach(e => e.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(e => e.classList.remove("active"));
  document.getElementById(id)?.classList.add("active");
  const btnId = id === "notesTab" ? "btnNotesTab" : (id === "chatTab" ? "btnChatTab" : "btnResourcesTab");
  document.getElementById(btnId)?.classList.add("active");
  if (id === "chatTab") {
    unreadChatCount = 0;
    updateUnreadUi();
    setTimeout(() => {
      const el = document.getElementById("chatContainer");
      if (el) el.scrollTop = el.scrollHeight;
    }, 30);
  }
}

function renderResources(items) {
  const container = document.getElementById("resourcesContainer");
  const badge = document.getElementById("resCountBadge");
  if (badge) {
    badge.innerText = items.length;
    badge.style.display = items.length > 0 ? "inline-block" : "none";
  }
  if (!container) return;
  if (!items || items.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:24px 14px;background:var(--bg-surface);border:1px dashed var(--border-hairline);border-radius:10px;"><div style="font-size:26px;margin-bottom:6px;">📚</div><div style="font-weight:700;color:var(--text-primary);font-size:12.5px;">No Study Resources Attached Yet</div><div style="font-size:11px;color:var(--text-muted);margin-top:4px;line-height:1.4;">Upload lecture PDFs, syllabus notes, or paste Google Drive links above to read side-by-side with your study crew.</div></div>';
    return;
  }
  let html = "";
  for (const r of items) {
    const isDrive = Boolean(r.isDriveLink);
    const isImg = r.type && r.type.includes("image");
    const isPdf = r.type && r.type.includes("pdf");
    const sizeStr = r.size > 0 ? Math.round(r.size / 1024) + " KB" : (isDrive ? "Google Drive" : "");
    const uploader = r.uploaderName || "Crew";
    const isFocused = r.id === activeFocusedResourceId;
    const badgeLabel = isDrive ? "DRIVE" : (isImg ? "IMG" : (isPdf ? "PDF" : "DOC"));
    const badgeColor = isDrive ? "#2FD09E" : (isImg ? "#B8C0CC" : (isPdf ? "#FF6B6B" : "#F5DDA7"));
    const badgeBg = isDrive ? "#0F261C" : (isImg ? "#131F2E" : (isPdf ? "#281316" : "#241E12"));

    html += '<div class="res-card' + (isFocused ? ' pinned' : '') + '">';
    if (isFocused) {
      html += '  <div class="res-pin-badge">📌 PINNED STUDY FOCUS</div>';
    }
    html += '  <div class="res-top">';
    html += '    <span class="res-type-badge" style="background:' + badgeBg + ';border:1px solid ' + badgeColor + ';color:' + badgeColor + ';">' + badgeLabel + '</span>';
    html += '    <div style="flex:1;min-width:0;">';
    html += '      <div class="res-title">' + esc(r.name) + '</div>';
    html += '      <div class="res-meta">';
    if (sizeStr) html += '<span>' + sizeStr + '</span><span>•</span>';
    html += '<span>' + esc(uploader) + '</span>';
    html += '      </div>';
    html += '    </div>';
    html += '  </div>';
    html += '  <div class="res-actions">';
    html += '    <button class="btn btn-gold" style="padding:4px 9px;font-size:11px;min-height:28px;" data-id="' + esc(r.id) + '" onclick="openResourceViewer(this.dataset.id)">📖 Read / View</button>';
    if (r.url) {
      html += '    <a href="' + esc(r.url) + '" target="_blank" download class="btn" style="padding:4px 9px;font-size:11px;min-height:28px;text-decoration:none;">⬇ Download</a>';
      html += '    <button class="btn" style="padding:4px 8px;font-size:11px;min-height:28px;" data-url="' + esc(r.viewUrl || r.url) + '" onclick="copyResLink(this.dataset.url)">📋 Copy</button>';
    }
    html += '    <button class="btn" style="padding:4px 8px;font-size:11px;min-height:28px;" data-id="' + esc(r.id) + '" onclick="focusResource(this.dataset.id)">📌 Pin</button>';
    html += '    <button class="btn" style="padding:4px 8px;font-size:11px;min-height:28px;color:#FCA5A5;" data-id="' + esc(r.id) + '" onclick="deleteResource(this.dataset.id)">✕</button>';
    html += '  </div>';
    html += '</div>';
  }
  container.innerHTML = html;
}

function copyResLink(url) {
  if (!url) return;
  try {
    navigator.clipboard.writeText(url);
    showToast("Copied resource link to clipboard!");
  } catch (_) {
    showToast("Could not copy link");
  }
}

function openResourceViewer(resId) {
  const r = (currentResources || []).find((x) => x.id === resId);
  if (!r) return;
  currentOpenResourceId = resId;
  const modal = document.getElementById("resourceViewerModal");
  const title = document.getElementById("resViewerTitle");
  const icon = document.getElementById("resViewerIcon");
  const extLink = document.getElementById("resViewerExtLink");
  const iframe = document.getElementById("resViewerFrame");
  const img = document.getElementById("resViewerImage");

  title.innerText = r.name;
  extLink.href = r.viewUrl || r.url || "#";
  const isImage = r.type && r.type.includes("image");
  icon.innerText = r.isDriveLink ? "🌐" : (isImage ? "🖼️" : "📕");

  if (isImage) {
    iframe.style.display = "none";
    img.style.display = "block";
    img.src = r.viewUrl || r.url;
  } else {
    img.style.display = "none";
    iframe.style.display = "block";
    iframe.src = r.viewUrl || r.url;
  }
  modal.style.display = "flex";
}

function closeResourceViewer() {
  const modal = document.getElementById("resourceViewerModal");
  const iframe = document.getElementById("resViewerFrame");
  const img = document.getElementById("resViewerImage");
  if (iframe) iframe.src = "";
  if (img) img.src = "";
  if (modal) modal.style.display = "none";
  currentOpenResourceId = "";
}

function askAiAboutResource() {
  const r = (currentResources || []).find((x) => x.id === currentOpenResourceId);
  if (!r) return;
  closeResourceViewer();
  switchTab("chatTab");
  const input = document.getElementById("chatInput");
  input.value = "@AI regarding [" + r.name + "]: ";
  input.focus();
}

function toggleDriveLinkRow() {
  const wrap = document.getElementById("driveAddWrap");
  wrap.style.display = wrap.style.display === "none" ? "block" : "none";
}

function submitDriveLink() {
  const title = (document.getElementById("driveTitleInput").value || "").trim();
  const url = (document.getElementById("driveUrlInput").value || "").trim();
  if (!url) {
    showToast("Please enter a Google Drive link or URL");
    return;
  }
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: "resource_add",
      name: title || "Study Link",
      url: url,
      isDriveLink: true,
    }));
    document.getElementById("driveTitleInput").value = "";
    document.getElementById("driveUrlInput").value = "";
    toggleDriveLinkRow();
    showToast("Added study resource link!");
  }
}

function triggerResourceUpload() {
  const f = document.getElementById("resFileInput");
  if (f) f.click();
}

async function handleBrowserFileUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > 35 * 1024 * 1024) {
    showToast("File exceeds 35MB. Use Google Drive link for huge textbooks.");
    input.value = "";
    return;
  }
  const progWrap = document.getElementById("resUploadProgress");
  const progBar = document.getElementById("resProgressBar");
  const progLabel = document.getElementById("resUploadLabel");
  progWrap.style.display = "block";
  progBar.style.width = "20%";
  progLabel.innerText = "Uploading " + file.name + "...";

  try {
    const res = await fetch("/api/rooms/" + encodeURIComponent(ROOM_CODE) + "/files", {
      method: "POST",
      headers: {
        "X-Room-Pin": currentPin,
        "X-Uploader-Name": myName,
        "X-File-Name": encodeURIComponent(file.name),
        "Content-Type": file.type || "application/pdf",
      },
      body: file,
    });
    progBar.style.width = "80%";
    const json = await res.json();
    if (res.ok && json.ok) {
      progBar.style.width = "100%";
      progLabel.innerText = "Upload complete!";
      setTimeout(() => { progWrap.style.display = "none"; progBar.style.width = "0%"; }, 1200);
      showToast("Uploaded " + file.name);
    } else {
      progWrap.style.display = "none";
      showToast("Upload failed: " + (json.error || res.statusText));
    }
  } catch (e) {
    progWrap.style.display = "none";
    showToast("Upload network error: " + (e.message || "Failed"));
  } finally {
    input.value = "";
  }
}

function deleteResource(resId) {
  if (!confirm("Remove this study resource from the room?")) return;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "resource_delete", resourceId: resId }));
  }
}

function focusResource(resId) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "resource_focus", resourceId: resId }));
    showToast("Pinned resource for crew!");
  }
}

function setAiFont(mode) {
  document.body.setAttribute("data-ai-font", mode === "hand" ? "hand" : "mono");
  try { localStorage.setItem("shieldpro_ai_font", mode); } catch (_) {}
}

function openSlideLightbox(url) {
  const modal = document.getElementById("slideLightboxModal");
  const img = document.getElementById("slideLightboxImg");
  if (modal && img && url) {
    img.src = url;
    modal.classList.add("open");
  }
}

function closeSlideLightbox() {
  document.getElementById("slideLightboxModal")?.classList.remove("open");
}

async function sendDoubtPing() {
  if (!unlocked || !ws || ws.readyState !== 1) return;
  const pos = Math.floor(getActiveTime());
  ws.send(JSON.stringify({ type: "doubt_ping", positionSec: pos }));
  const text = "✋ [DOUBT FLAG @ " + fmtTime(pos) + "] Asked to pause & clarify this point.";
  const msgObj = { id: crypto.randomUUID(), senderName: myName, text, timestamp: Date.now(), isAi: false, taggedAi: false, positionSec: pos };
  const payload = await encryptEnvelope(msgObj);
  ws.send(JSON.stringify({ type: "chat_post", taggedAi: false, payload }));
  chatHistory.push(msgObj);
  renderChat(true);
  showToast("✋ Doubt alert sent to host & crew");
}

function exportBrowserStudySheet() {
  const title = document.getElementById("lectureTitle")?.innerText || "ShieldPro Study Session";
  const channel = document.getElementById("channelTitle")?.innerText || "ShieldPro";
  const lines = ["# 🛡️ " + title, "**Channel:** " + channel, "**Room:** " + ROOM_CODE, ""];
  lines.push("## 📝 Shared Timestamped Notes");
  if (latestNotesList.length) {
    latestNotesList.forEach(n => lines.push("- **[" + (n.timeLabel || "Note") + "]** " + (n.text || "")));
  } else {
    lines.push("_No notes saved in this session yet._");
  }
  lines.push("", "## 🤖 Crew Study Q&A & @AI Insights");
  const importantChats = chatHistory.filter(c => c.isAi || c.taggedAi || /\\[DOUBT FLAG/i.test(c.text || ""));
  if (importantChats.length) {
    importantChats.forEach(c => lines.push("### " + (c.senderName || "Member") + " (" + fmtClock(c.timestamp) + ")\\n" + (c.text || "") + "\\n"));
  } else {
    lines.push("_No @AI Q&As recorded yet._");
  }
  const blob = new Blob([lines.join("\\n")], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = ROOM_CODE + "-Study-Sheet.md";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  showToast("📄 Study Sheet downloaded!");
}

(function init() {
  try {
    const savedName = sessionStorage.getItem("shieldpro_name_" + ROOM_CODE) || localStorage.getItem("shieldpro_crew_name");
    if (savedName) document.getElementById("nameInput").value = savedName;
    const savedFont = localStorage.getItem("shieldpro_ai_font") || "mono";
    setAiFont(savedFont);
    const urlTv = new URLSearchParams(window.location.search).get("tv");
    const isTvAgent = /TV|SmartTV|Tizen|Web0S|BRAVIA|NetCast|Android TV|AppleTV/i.test(navigator.userAgent);
    if (urlTv === "1" || isTvAgent) {
      updateLayoutMode("tv");
    }
  } catch (_) {}
  document.getElementById("nameInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitJoin(); }
  });
  document.getElementById("pinInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitJoin(); }
  });
  document.getElementById("chatInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  document.getElementById("noteInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendNote(); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeSlideLightbox(); closeResourceViewer(); return; }
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea") return;
    if (e.key === "1") { e.preventDefault(); updateLayoutMode("split"); showToast("📐 Split Desk"); }
    else if (e.key === "2") { e.preventDefault(); updateLayoutMode("cinema"); showToast("🎬 Cinema View"); }
    else if (e.key === "3") { e.preventDefault(); updateLayoutMode("blackout"); showToast("🌑 Focus Blackout"); }
    else if (e.key === "4") { e.preventDefault(); updateLayoutMode("tv"); showToast("📺 10-Foot TV Mode"); }
    else if (e.key === "m" || e.key === "M") { e.preventDefault(); toggleAudioMute(); }
    else if (e.key === "d" || e.key === "D") { e.preventDefault(); sendDoubtPing(); }
    else if (e.key === "s" || e.key === "S") { e.preventDefault(); toggleStudyMode(); }
    else if (e.key === "n" || e.key === "N") { e.preventDefault(); switchTab("notesTab"); document.getElementById("noteInput")?.focus(); }
    else if (e.key === "c" || e.key === "C") { e.preventDefault(); switchTab("chatTab"); document.getElementById("chatInput")?.focus(); }
    else if (e.key === "r" || e.key === "R") { e.preventDefault(); switchTab("resourcesTab"); }
    else if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFullscreen(); }
    else if (studyMode === "free") {
      if (e.key === " " || e.key === "k" || e.key === "K") { e.preventDefault(); localTogglePlay(); }
      else if (e.key === "j" || e.key === "J") { e.preventDefault(); localSkip(-10); }
      else if (e.key === "l" || e.key === "L") { e.preventDefault(); localSkip(10); }
    }
  });
  document.getElementById("chatContainer")?.addEventListener("scroll", (e) => {
    const el = e.target;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
    if (near) {
      unreadChatCount = 0;
      document.getElementById("jumpLatestBtn")?.classList.remove("visible");
      updateUnreadUi();
    }
  });
  setInterval(() => { if (unlocked && lastHostPlaying) updateTelemetryPill(); }, 1000);
  connectWs();
})();
</script>
<script src="https://www.youtube.com/iframe_api"></script>
</body>
</html>`;
}
