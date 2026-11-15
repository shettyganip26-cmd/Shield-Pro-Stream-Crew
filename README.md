# ShieldPro Cross-City Cloud Crew Relay

Single-deploy edge WebSocket relay + responsive Web Desk player (zero Google OAuth verification, zero friend sign-in, free-tier ready).

## Option 1 — Deploy in 2 Minutes with Wrangler CLI (Recommended)
1. Create a free Cloudflare account (no credit card needed for Workers Free + SQLite-backed Durable Objects).
2. From `relay/cloud-crew-worker/`:
   ```bash
   npx wrangler login
   npx wrangler deploy
   ```
3. Copy the printed URL (e.g. `https://shieldpro-cloud-crew-relay.<your-subdomain>.workers.dev`).
4. Paste it into **ShieldPro -> Stream Cockpit -> Cross-City Crew -> Relay URL** and tap **Test Relay**.

## Option 2 — Deploy via Cloudflare Web Dashboard (Zero CLI)
1. Go to **Workers & Pages -> Create -> Create Worker**.
2. Paste `src/index.js` into the Worker editor and click **Deploy**.
3. Open **Settings -> Bindings -> Add Durable Object Binding**:
   - Variable name: `CREW_ROOMS`
   - Durable Object class: `CrewRoomDurableObject`
4. Copy your `*.workers.dev` URL into ShieldPro.

## Endpoints
- `GET /health` -> JSON health & latency probe
- `GET /` -> Room code join page
- `GET /r/:roomCode` -> Responsive Web Desk Study Player (Mobile Portrait/Landscape + Desktop)
- `GET /ws/:roomCode` -> Authenticated `wss://` WebSocket room hub
