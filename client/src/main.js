import { TICK_DT, POWER } from '../../shared/constants.js';
import { randomName, defaultSkin, SKIN_COLORS, HATS, colorHex, sanitizeProfile } from '../../shared/profile.js';
import { Game } from './game.js';
import { Renderer } from './render.js';
import { SocketTransport, LocalTransport, serverUrl, healthUrl } from './net.js';
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

// Offline-first flow:
//  1. Start a solo game instantly (works with no network at all).
//  2. Meanwhile, find the game server in the background (waking it if it's a
//     sleeping free-tier instance), retrying for as long as it takes.
//  3. When it answers: invite links (and games nobody has started playing)
//     switch online automatically; otherwise a "Play online" button appears.
//  4. If an online game loses its connection for good, drop back to solo and
//     go back to step 2.
let serverState = forceOffline ? 'none' : 'probing'; // probing | ready | none | online
let pending = null; // an online Game waiting for its 'welcome'
let probeTimer = null;
let probeDelay = 2000;
let wantOnline = !!roomCode; // set by invite links / the Play online button

function startSolo() {
  setGame(new Game(new LocalTransport(), profile, emitFor));
}

function setGame(g) {
  if (game && game !== g) game.transport.close();
  game = g;
  updateOnlineButton();
}

/** Each Game reports through this; only the active game drives the UI. */
function emitFor(type, data) {
  const g = this;
  if (g === pending) {
    if (type === 'welcome') {
      pending = null;
      clearTimeout(g.joinTimer);
      serverState = 'online';
      setGame(g);
    } else if (type === 'error') {
      pending = null;
      g.transport.close();
      serverState = 'ready';
      return onGameEvent(type, data);
    } else return;
  }
  if (g === game) onGameEvent(type, data);
}

async function probe() {
  clearTimeout(probeTimer);
  if (serverState !== 'probing') return;
  if (!navigator.onLine) return; // the 'online' event will call us again
  updateOnlineButton();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  let status = 0;
  try {
    status = (await fetch(healthUrl(), { cache: 'no-store', signal: ctl.signal })).status;
  } catch {
    status = 0;
  }
  clearTimeout(t);
  if (serverState !== 'probing') return;
  if (status >= 200 && status < 300) {
    probeDelay = 2000;
    serverState = 'ready';
    if (wantOnline || (game && game.team === 0 && !game.transport.online)) goOnline();
    else toast('Online play is ready! Tap 🌐 to join other players.');
    updateOnlineButton();
    return;
  }
  if (status === 404 && !import.meta.env.VITE_GAME_SERVER_URL) {
    serverState = 'none'; // static hosting with no game server configured
    updateOnlineButton();
    return;
  }
  // Unreachable or still waking up: keep trying, backing off to 30 s.
  probeTimer = setTimeout(probe, probeDelay);
  probeDelay = Math.min(30000, probeDelay * 1.5);
}

function goOnline() {
  if (pending || (game && game.transport.online && serverState === 'online')) return;
  wantOnline = true;
  const g = new Game(new SocketTransport(serverUrl(roomCode)), profile, null);
  g.emit = emitFor.bind(g);
  pending = g;
  if (!game || !game.you) setBanner(roomCode ? `Joining room ${roomCode}…` : 'Joining online game…');
  else toast(roomCode ? `Joining room ${roomCode}…` : 'Joining an online game…');
  g.transport.onclose = () => onSocketClosed(g);
  g.joinTimer = setTimeout(() => onSocketClosed(g), 8000);
  updateOnlineButton();
}

let lostAt = 0;
function onSocketClosed(g) {
  clearTimeout(g.joinTimer);
  g.transport.close();
  if (g === pending) {
    // Couldn't join: keep playing whatever we were playing and retry later.
    pending = null;
    serverState = 'probing';
    probeTimer = setTimeout(probe, probeDelay);
    updateOnlineButton();
    return;
  }
  if (g !== game) return;
  // The online game dropped. Try to rejoin the same room for a little while…
  if (!lostAt) lostAt = performance.now();
  if (performance.now() - lostAt < 10000) {
    setBanner('Reconnecting…');
    const r = new Game(new SocketTransport(serverUrl(roomCode)), profile, null);
    r.emit = (type, data) => {
      if (type === 'welcome') {
        lostAt = 0;
        serverState = 'online';
        setGame(r);
      }
      if (r === game) onGameEvent(type, data);
    };
    let retried = false;
    const retry = () => {
      if (retried || r === game) return;
      retried = true;
      r.transport.close();
      setTimeout(() => onSocketClosed(g), 1500);
    };
    r.transport.onclose = () => (r === game ? onSocketClosed(r) : retry());
    setTimeout(retry, 4000);
    return;
  }
  // …then fall back to solo and keep looking for the server.
  lostAt = 0;
  setBanner('');
  toast('Lost connection: playing solo. We\'ll get you back online when we can.');
  serverState = 'probing';
  startSolo();
  probeTimer = setTimeout(probe, 3000);
}

function updateOnlineButton() {
  const btn = $('btn-online');
  if (!btn) return;
  const solo = !game || !game.transport.online;
  btn.classList.toggle('hidden', !(solo && serverState === 'ready' && !pending));
}

window.addEventListener('online', () => {
  if (serverState === 'probing') {
    probeDelay = 2000;
    probe();
  }
});

function connect() {
  startSolo();
  if (!forceOffline) probe();
}

// ---------------------------------------------------------------- events

function onGameEvent(type, data) {
  switch (type) {
    case 'welcome':
      setBanner('');
      $('hud').classList.remove('hidden');
      if (game.transport.online) {
        roomCode = data.room;
        const url = new URL(location.href);
        url.searchParams.set('room', data.room);
        history.replaceState(null, '', url);
      }
      $('room-code').textContent = game.transport.online ? data.room : 'SOLO';
      $('invite').disabled = !game.transport.online;
      $('invite').classList.toggle('hidden', !game.transport.online); // nothing to invite to in solo
      // The server may tweak an auto-assigned color to avoid duplicates.
      if (profile.skin.auto) {
        profile = { ...profile, skin: { ...data.profile.skin, auto: true } };
        saveProfile(profile);
      }
      break;
    case 'level':
      renderer.setMaze(game.maze, game.level, game.pellets);
      playLevelMusic();
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
      if (!data.mine) sfx.ghost(); // the eater already heard it instantly
      if (who && data.id !== game.you) toast(`${who.name} ate a ghost! +${data.pts}`);
      break;
    }
    case 'chomp':
      sfx.ghost();
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
      setBanner('');
      if (data.code === 'full') {
        showMessage('Room is full', `Room ${data.room} already has ${data.max} players.`, [
          ['Keep playing solo', () => {}],
          ['Join another game', () => goRoom('')],
        ]);
      } else {
        toast('The game server is busy right now: keep playing solo.');
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
  const ping = game.transport.online
    ? game.rtt != null
      ? `${Math.round(game.rtt)} ms`
      : '…'
    : serverState === 'probing'
      ? navigator.onLine
        ? 'solo · finding server…'
        : 'solo · offline'
      : 'solo';
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

$('btn-online').addEventListener('click', () => goOnline());
$('btn-sound').addEventListener('click', () => {
  unlockAudio();
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
    game?.setDirection(dir);
    $('hint').classList.add('off');
  },
  modalOpen,
);
// Browsers only allow audio after a user gesture; if that first gesture
// lands during READY, start the level tune right away.
let musicPlayedFor = -1;
function playLevelMusic() {
  if (!sfx.ready || !game.maze || game.phase !== 'ready' || musicPlayedFor === game.level) return;
  const left = game.phaseRemaining(performance.now());
  if (left < 0.6) return;
  musicPlayedFor = game.level;
  sfx.levelStart(game.level === 1 && left > 3.6);
}
function unlockAudio() {
  sfx.unlock();
  playLevelMusic();
}
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

// ------------------------------------------------------------------ loop

let last = performance.now();
let acc = 0;
function frame() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!game) {
    requestAnimationFrame(frame);
    return;
  }
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
  const lastSnap = game.snaps[game.snaps.length - 1];
  sfx.updateLoops({
    playing: game.phase === 'play' && !!game.maze && !game.isPaused(now),
    fright: game.fright > 0,
    eyes: game.ghostView.some((g) => g.mode === 4),
    progress: lastSnap && game.maze ? 1 - lastSnap.left / game.maze.pelletCount : 0,
  });
  requestAnimationFrame(frame);
}

connect();
requestAnimationFrame(frame);

// Installable PWA (Add to Home Screen) with offline solo play.
if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

// Handy for debugging in the console.
window.pcoop = { get game() { return game; }, renderer };
