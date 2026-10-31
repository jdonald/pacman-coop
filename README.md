# Pac-Man Co-op

Up to **4 players** chomp through classic-style mazes **together**, in a chunky 3D
angled view inspired by Pac-Man 256, with a camera that scrolls to follow you.

- Classic rules: eat every pellet to clear the level, avoid the ghosts, eat a
  power pellet to turn the tables. A power pellet eaten by **anyone** frightens
  the ghosts for **everyone**.
- **Infinite lives**: if you get caught, you respawn a couple of seconds later
  with a moment of invulnerability.
- **Instant join**: open the page and you're dropped into a public game with a
  silly name (e.g. *Wobbly Waffle*) and a random color and hat. Change both
  any time in ⚙︎ settings.
- **Invite friends**: click **Invite** to copy a link to your room, or use **＋**
  to start a private room.
- Controls: arrow keys / WASD, swipe on touch screens, or a gamepad.
- Offline fallback: if the game server can't be reached, the page runs the same
  game code in your browser so you can still play solo (`?offline` forces this).

## Running locally

```bash
npm install
```

```bash
npm run dev
```

This starts the game server on `:8080` and Vite on <http://localhost:5173>,
with the Vite dev server proxying `/ws` to the game server. Open the URL in two
browser windows to play co-op.

To try the netcode under realistic conditions, add artificial latency:

```bash
SIM_LAG_MS=40 SIM_JITTER_MS=15 npm run dev
```

Other scripts: `npm test` (maze validation, game rules, server integration),
`npm run build` (client into `dist/`), `npm start` (production server, which
also serves `dist/` if present).

## Architecture

```
client/   Vite + Three.js browser game (rendering, input, prediction, HUD)
server/   Node.js WebSocket server hosting game rooms (≤ 4 players each)
shared/   Game rules used by BOTH sides: mazes, grid movement, the Room simulation
```

### Netcode

The design favors smooth, lag-free control of your own Pac-Man and fair
collisions, which matters more in a co-op game than strict anti-cheat:

| Thing | Who's in charge | How it's shown |
| --- | --- | --- |
| Your own pac | **Your client** predicts it with zero input lag, using the same movement code as the server, and streams its position 30×/s | Immediately |
| Validation | **Server** checks every position update against your max speed (with slack for jitter) and the walls; if it's off, it sends a correction | — |
| Ghosts, pellets, power mode, levels, scores | **Server** (authoritative, 60 Hz simulation) | Snapshots 30×/s, interpolated ~100 ms behind for smoothness |
| Other players | Relayed by the server | Interpolated like ghosts; the pellets they eat disappear in sync with their (delayed) position |
| Pac ↔ ghost collisions | **Your client** checks against the ghosts *as you see them*; the server validates ghost-eating with a lag tolerance | "What you see is what you get": you never die to a ghost that wasn't on your screen |

At a cable connection within California (~10–40 ms to a server in San Jose),
this feels local. The [CI tests](test/room.test.js) run bots through two minutes
of play and check that honest clients are never corrected.

### Why not host the server on Vercel?

Vercel is great for the static client, but Vercel Functions are request/response
and can't act as a long-lived WebSocket server, and a game also needs a process
that keeps ticking the simulation 60 times a second. So:

- **Client → Vercel** (static build, global CDN).
- **Game server → Fly.io in `sjc` (San Jose)**: a tiny always-on-while-in-use
  Node process with first-class WebSocket support, close to California players.
  Render, Railway, or any VPS work too: the server is a plain Node app with a
  `Dockerfile`.

Rooms live in the server's memory, so run **one** server instance (plenty for
hundreds of concurrent players). Scaling out later would need routing each room
code to a fixed instance (e.g. Fly's `fly-replay` header).

## Deploying

### 1. Game server on Fly.io

```bash
fly auth login
```

```bash
fly launch --copy-config --no-deploy
```

```bash
fly deploy --ha=false
```

Then check `https://<your-app>.fly.dev/health`. That URL also serves the full
game (the Docker image includes the built client), so it is playable on its own.

Optional: lock the server down to your site with
`fly secrets set ALLOWED_ORIGINS=https://<your-vercel-domain>`.

### 2. Client on Vercel

1. Import this GitHub repo in Vercel. `vercel.json` already sets the build
   (`npm run build`, output `dist`).
2. In **Project → Settings → Environment Variables**, add
   `VITE_GAME_SERVER_URL = wss://<your-app>.fly.dev` (see `.env.example`).
3. Deploy. Anyone opening the Vercel URL is dropped straight into a game.

Until the server is deployed, the Vercel site still works in offline solo mode.

### Server environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP/WebSocket port |
| `ALLOWED_ORIGINS` | *(any)* | Comma-separated allowed browser origins |
| `MAX_ROOMS` | `500` | Cap on simultaneous rooms |
| `SIM_LAG_MS` / `SIM_JITTER_MS` | `0` | Artificial latency for testing |

## Adding a maze

Mazes live in [`shared/mazeData.js`](shared/mazeData.js) as the left half of a
28-column symmetric layout. `npm test` validates every maze (no dead ends, no
2×2 open areas, everything reachable, ghosts can get home).
