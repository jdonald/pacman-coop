import { TICK_DT, POWER } from '../../shared/constants.js';
import { randomName, defaultSkin, SKIN_COLORS, HATS, colorHex, sanitizeProfile } from '../../shared/profile.js';
import { Game } from './game.js';
import { Renderer } from './render.js';
import { SocketTransport, LocalTransport, serverUrl } from './net.js';
import { setupInput } from './input.js';
import { Sfx } from './audio.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const renderer = new Renderer(canvas);
const sfx = new Sfx();

// ---------------------------------------------------------------- profile

function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem('pcoop.profile'));
    if (p && p.name) return p;
  } catch {
    /* ignore */
  }
  // First visit: a silly name and a random skin; change anytime in settings.
  const p = { name: randomName(), skin: { ...defaultSkin(), auto: true } };
  saveProfile(p);
  return p;
}
function saveProfile(p) {
  try {
    localStorage.setItem('pcoop.profile', JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
let profile = loadProfile();

// ------------------------------------------------------------- connection

const params = new URLSearchParams(location.search);
let roomCode = params.get('room') || '';
const forceOffline = params.has('offline');
let game = null;
let connectTimer = null;
let reconnectDelay = 1000;
let everConnected = false;

function connect() {
  clearTimeout(connectTimer);
  if (game) game.transport.close();
  let transport;
  if (forceOffline) {
    transport = new LocalTransport();
  } else {
    transport = new SocketTransport(serverUrl(roomCode));
    // Fall back to offline solo play if the server can't be reached at all.
    connectTimer = setTimeout(() => {
      if (!game.you && transport.ws.readyState !== WebSocket.OPEN) fallbackOffline();
    }, 6000);
    transport.onclose = () => {
      if (game?.transport !== transport) return;
      if (!game.you && !everConnected) return fallbackOffline();
      setBanner('Reconnecting…');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(8000, reconnectDelay * 1.6);
    };
  }
  startGame(transport);
}

function fallbackOffline() {
  clearTimeout(connectTimer);
  if (game && game.transport.online) game.transport.close();
  toast("Couldn't reach the game server — playing solo offline.");
  startGame(new LocalTransport());
}

function startGame(transport) {
  const oldClose = transport.onclose;
  game = new Game(transport, profile, onGameEvent);
  if (oldClose) transport.onclose = oldClose;
  setBanner(transport.online ? 'Connecting…' : '');
}

// ---------------------------------------------------------------- events

function onGameEvent(type, data) {
  switch (type) {
    case 'welcome':
      clearTimeout(connectTimer);
      everConnected = game.transport.online || everConnected;
      reconnectDelay = 1000;
      $('hud').classList.remove('hidden');
      if (game.transport.online) {
        roomCode = data.room;
        const url = new URL(location.href);
        url.searchParams.set('room', data.room);
        history.replaceState(null, '', url);
      }
      $('room-code').textContent = game.transport.online ? data.room : 'SOLO';
      $('invite').disabled = !game.transport.online;
      // The server may tweak an auto-assigned color to avoid duplicates.
      if (profile.skin.auto) {
        profile = { ...profile, skin: { ...data.profile.skin, auto: true } };
        saveProfile(profile);
      }
      break;
    case 'level':
      renderer.setMaze(game.maze, game.level, game.pellets);
      sfx.ready();
      break;
    case 'phase':
      break;
    case 'eat':
      sfx.eat();
      if (data.kind === POWER) sfx.power();
      break;
    case 'remoteEat':
      break;
    case 'power':
      sfx.power();
      break;
    case 'ghostEaten': {
      const who = game.roster.get(data.id);
      renderer.popup(String(data.pts), data.x, data.y, '#5ee6ff');
      sfx.ghost();
      if (who && data.id !== game.you) toast(`${who.name} ate a ghost! +${data.pts}`);
      break;
    }
    case 'chomp':
      break;
    case 'death':
      if (data.mine) sfx.death();
      else sfx.otherDeath();
      break;
    case 'clear':
      renderer.flashClear();
      sfx.clear();
      break;
    case 'join':
      toast(`${data.name} joined! 🎉`);
      sfx.join();
      break;
    case 'leave':
      toast(`${data.name} left`);
      break;
    case 'error':
      clearTimeout(connectTimer);
      game.transport.onclose = () => {};
      if (data.code === 'full') {
        showMessage('Room is full', `Room ${data.room} already has ${data.max} players.`, [
          ['Join another game', () => goRoom('')],
          ['Play solo', () => (location.href = '?offline')],
        ]);
      } else {
        showMessage('Server busy', 'The game server is at capacity right now.', [['Play solo', fallbackOffline]]);
      }
      break;
    default:
      break;
  }
}

function goRoom(code) {
  const url = new URL(location.href);
  url.search = code ? `?room=${code}` : '';
  location.href = url.toString();
}

// ------------------------------------------------------------------ HUD

let bannerText = null;
function setBanner(html) {
  if (html === bannerText) return;
  bannerText = html;
  const b = $('banner');
  if (html) {
    b.innerHTML = html;
    b.classList.remove('off');
  } else b.classList.add('off');
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3300);
}

let lastHud = '';
function updateHud(now) {
  if (!game.you || !game.maze) return;
  if (game.phase === 'ready') setBanner(`READY!<small>Level ${game.level}</small>`);
  else if (game.phase === 'clear') setBanner('LEVEL CLEAR!');
  else if (!game.me.alive && game.me.life) setBanner('<small>Respawning…</small>');
  else setBanner('');

  const players = [...game.roster.values()].sort((a, b) => a.slot - b.slot);
  const rows = players.map((p) => {
    const v = game.playerView.get(p.id);
    const dead = p.id === game.you ? !game.me.alive : v && !v.alive;
    return { ...p, score: game.scores.get(p.id) || 0, dead };
  });
  const lastSnap = game.snaps[game.snaps.length - 1];
  const left = lastSnap ? lastSnap.left : '';
  const ping = game.transport.online ? (game.rtt != null ? `${Math.round(game.rtt)} ms` : '…') : 'offline';
  const key = JSON.stringify([game.level, game.team, left, rows, ping]);
  if (key === lastHud) return;
  lastHud = key;
  $('level').textContent = game.level;
  $('team').textContent = game.team.toLocaleString();
  $('left').textContent = left;
  $('net').textContent = ping;
  const ul = $('players');
  ul.replaceChildren(
    ...rows.map((p) => {
      const li = document.createElement('li');
      if (p.id === game.you) li.classList.add('you');
      if (p.dead) li.classList.add('dead');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = dot.style.color = colorHex(p.skin.color);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.id === game.you ? `${p.name} (you)` : p.name;
      const pts = document.createElement('span');
      pts.className = 'pts';
      pts.textContent = p.score.toLocaleString();
      li.append(dot, name, pts);
      return li;
    }),
  );
  void now;
}

$('invite').addEventListener('click', async () => {
  const url = new URL(location.href);
  url.search = `?room=${roomCode}`;
  const link = url.toString();
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ title: 'Pac-Man Co-op', text: 'Come chomp with me!', url: link });
      return;
    }
    await navigator.clipboard.writeText(link);
    toast('Invite link copied — send it to a friend!');
  } catch {
    prompt('Share this link with friends:', link);
  }
});

$('btn-sound').addEventListener('click', () => {
  sfx.unlock();
  sfx.setMuted(!sfx.muted);
  $('btn-sound').textContent = sfx.muted ? '🔇' : '🔊';
});
$('btn-sound').textContent = sfx.muted ? '🔇' : '🔊';

$('btn-new').addEventListener('click', () => {
  showMessage('New private room?', 'Start a fresh room that only people with your invite link can join.', [
    ['Cancel', () => {}],
    [
      'Create',
      () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let c = '';
        for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
        goRoom(c);
      },
    ],
  ]);
});

function showMessage(title, body, actions) {
  $('message-title').textContent = title;
  $('message-body').textContent = body;
  const box = $('message-actions');
  box.replaceChildren(
    ...actions.map(([label, fn], i) => {
      const b = document.createElement('button');
      b.className = i === actions.length - 1 ? 'primary' : 'ghost-btn';
      b.textContent = label;
      b.onclick = () => {
        $('message').classList.add('hidden');
        fn();
      };
      return b;
    }),
  );
  $('message').classList.remove('hidden');
}

// ------------------------------------------------------------- settings

let draft = null;
function openSettings() {
  draft = { name: profile.name, skin: { color: profile.skin.color, hat: profile.skin.hat } };
  $('name').value = draft.name;
  renderSettings();
  $('settings').classList.remove('hidden');
}
function renderSettings() {
  $('colors').replaceChildren(
    ...SKIN_COLORS.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = c.label;
      b.style.background = c.hex;
      if (c.id === draft.skin.color) b.classList.add('on');
      b.onclick = () => {
        draft.skin.color = c.id;
        renderSettings();
      };
      return b;
    }),
  );
  $('hats').replaceChildren(
    ...HATS.map((h) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = h.label;
      if (h.id === draft.skin.hat) b.classList.add('on');
      b.onclick = () => {
        draft.skin.hat = h.id;
        renderSettings();
      };
      return b;
    }),
  );
}
$('btn-settings').addEventListener('click', openSettings);
$('reroll').addEventListener('click', () => ($('name').value = randomName()));
$('settings-cancel').addEventListener('click', () => $('settings').classList.add('hidden'));
$('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  draft.name = $('name').value;
  const clean = sanitizeProfile(draft);
  profile = { name: clean.name, skin: { ...clean.skin } }; // no longer auto
  saveProfile(profile);
  game.profile = profile;
  game.transport.send({ t: 'profile', ...profile });
  $('settings').classList.add('hidden');
});
const modalOpen = () => !$('settings').classList.contains('hidden');

// ---------------------------------------------------------------- input

const pollPads = setupInput(
  canvas,
  (dir) => {
    sfx.unlock();
    game.setDirection(dir);
    $('hint').classList.add('off');
  },
  modalOpen,
);
window.addEventListener('pointerdown', () => sfx.unlock(), { once: true });

// ------------------------------------------------------------------ loop

let last = performance.now();
let acc = 0;
function frame() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  pollPads();
  game.transport.update();
  game.frame(now);
  acc += dt;
  let steps = 0;
  while (acc >= TICK_DT && steps++ < 8) {
    game.fixedStep(performance.now());
    acc -= TICK_DT;
  }
  if (steps >= 8) acc = 0;
  renderer.render(game, acc / TICK_DT, now, dt);
  updateHud(now);
  requestAnimationFrame(frame);
}

connect();
requestAnimationFrame(frame);

// Handy for debugging in the console.
window.pcoop = { get game() { return game; }, renderer };
