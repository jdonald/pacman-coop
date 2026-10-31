# Pac-Man Co-op

Up to **4 players** chomp through classic-style mazes **together**, in an
isometric 3D view inspired by Pac-Man 256, with a camera that scrolls to follow you.

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

### Look & sound

- Orthographic (true isometric-style, no vanishing point) camera, tilted to the
  right, following your pac across dark neon-edged mazes that float over a
  bright backdrop of drifting cubes.
- Characters are pixel-art sprites built from little cubes (cutouts with
  thickness), with chomp, skirt-wiggle, frightened and death animations.
- All audio is synthesized with WebAudio: an original 8-bit level-start tune,
  waka-waka chomps, a ghost siren that speeds up as the maze empties, the
  frightened warble, eyes-retreat whine, ghost-eaten blip, death spiral and a
  level-clear fanfare.

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

On a cable connection within California (~10–40 ms to a server in San Jose or
Oregon), this feels local. The [CI tests](test/room.test.js) run bots through two minutes
of play and check that honest clients are never corrected.

### Hosting

Real-time multiplayer needs a long-running server that holds WebSocket
connections and ticks the game 60×/s, which purely static hosts (GitHub Pages,
Vercel's static hosting) can't do. The game server is a plain Node app with a
`Dockerfile`, and **it also serves the client**, so one service is enough.

| Option | Cost | Notes |
| --- | --- | --- |
| **Render free web service** (`render.yaml`, Oregon) | Free | Sleeps after 15 idle minutes; first visitor waits ~1 min while it wakes (the game shows "Waking up the game server…"). |
| **Fly.io** (`fly.toml`, San Jose) | ~$2/month for one small machine, less if it auto-stops | No free tier for new accounts; lowest latency for California; wakes in a second or two. |
| Any VPS / Railway / etc. | varies | `npm ci && npm run build && npm start` |

Optionally keep a **GitHub Pages** URL for the client: the
[`pages.yml`](.github/workflows/pages.yml) workflow publishes it on every push
to `main`, pointed at your game server.

Rooms live in the server's memory, so run **one** server instance (plenty for
hundreds of concurrent players).

## Deploying

### Option A: one service on Render (free)

1. On [render.com](https://render.com), choose **New → Blueprint** and pick this
   repo. It reads `render.yaml` (free plan, Oregon region).
2. Open `https://<service>.onrender.com`. That's the whole game.

### Option B: one service on Fly.io (lowest latency)

```bash
fly auth login
```

```bash
fly launch --copy-config --no-deploy
```

```bash
fly deploy --ha=false
```

Then open `https://<app>.fly.dev`.

### Optional: client on GitHub Pages

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables**: add
   `GAME_SERVER_URL` = `wss://<your-server-host>` (Render or Fly URL with
   `wss://`).
3. Push to `main` (or run the workflow manually). Without the variable, the
   Pages site still works as offline solo play.

Optional hardening: set `ALLOWED_ORIGINS=https://<you>.github.io` on the server.

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
