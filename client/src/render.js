// Three.js renderer in the spirit of Pac-Man 256: an isometric (orthographic,
// no vanishing point) view tilted to the right, dark mazes with neon edges
// floating over a bright backdrop, and pixel-art characters as thick cutouts.

import * as THREE from 'three';
import { WALL, DOOR, PELLET, POWER, GHOST_COLORS, FRIGHT_FLASH_TIME } from '../../shared/constants.js';
import { colorHex } from '../../shared/profile.js';
import { GM } from './game.js';
import { pacGeometries, ghostGeometries, CHOMP_ANGLES, DEATH_FRAMES } from './voxel.js';

export const PALETTES = [
  { bg: '#1f63ff', cube: '#8fbaff', neon: '#2a3dff', top: '#0b0b24', floor: '#2b2b3e', pellet: '#ffffff' },
  { bg: '#ff4f9e', cube: '#ffc2dd', neon: '#ff1f86', top: '#1f0718', floor: '#3a2740', pellet: '#ffffff' },
  { bg: '#16b884', cube: '#a6f5da', neon: '#00d79a', top: '#062019', floor: '#243933', pellet: '#ffffff' },
  { bg: '#ff8f24', cube: '#ffd6a8', neon: '#ff5a00', top: '#231004', floor: '#3c2e24', pellet: '#ffffff' },
  { bg: '#8a4dff', cube: '#d2baff', neon: '#a35cff', top: '#130827', floor: '#2d2642', pellet: '#ffffff' },
];

const WALL_H = 0.32;
const PITCH = THREE.MathUtils.degToRad(54); // camera elevation
const YAW = THREE.MathUtils.degToRad(20); // positive = world tilts to the right
const SPRITE_LEAN = PITCH * 0.72; // cutouts lean back toward the camera
const SPRITE_Y = 0.52;
const tmpObj = new THREE.Object3D();

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    // Orthographic = true isometric-style parallel projection.
    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
    this.camTarget = new THREE.Vector3(14, 0, 15);
    this.halfH = 9;

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x3a3a66, 1.5);
    this.scene.add(this.hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, 1.8));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -24;
    sc.right = 24;
    sc.top = 24;
    sc.bottom = -24;
    sc.near = 1;
    sc.far = 80;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target);

    this.mazeGroup = new THREE.Group();
    this.scene.add(this.mazeGroup);
    this.backdrop = makeBackdrop();
    this.scene.add(this.backdrop.mesh);
    this.pacs = new Map();
    this.ghosts = [];
    this.popups = [];
    this.lastPellets = null;
    this.clearFlash = 0;
    this.time = 0;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    // About 19 tiles of maze visible vertically; at least ~15 tiles across on phones.
    this.halfH = THREE.MathUtils.clamp(Math.max(8, 7.5 / aspect), 8, 17);
    const cam = this.camera;
    cam.top = this.halfH;
    cam.bottom = -this.halfH;
    cam.left = -this.halfH * aspect;
    cam.right = this.halfH * aspect;
    cam.updateProjectionMatrix();
  }

  // ----------------------------------------------------------------- maze

  setMaze(maze, level, pellets) {
    this.maze = maze;
    const pal = (this.palette = PALETTES[(level - 1) % PALETTES.length]);
    this.scene.background = new THREE.Color(pal.bg);
    this.backdrop.setColor(pal.cube, maze);
    for (const child of [...this.mazeGroup.children]) {
      this.mazeGroup.remove(child);
      child.geometry?.dispose();
    }
    const { w, h, cells } = maze;

    // The maze is a thick slab floating over the backdrop.
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.8, h),
      new THREE.MeshStandardMaterial({ color: pal.floor, roughness: 0.9 }),
    );
    slab.position.set((w - 1) / 2, -0.4, (h - 1) / 2);
    slab.receiveShadow = true;
    this.mazeGroup.add(slab);

    // Walls: dark raised blocks with neon edges along every corridor.
    this.wallMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
    const walls = new THREE.Mesh(buildWallGeometry(maze, pal, WALL_H), this.wallMat);
    walls.castShadow = walls.receiveShadow = true;
    this.neonMat = new THREE.MeshBasicMaterial({ color: pal.neon });
    const neon = new THREE.Mesh(buildNeonGeometry(maze, WALL_H), this.neonMat);
    this.mazeGroup.add(walls, neon);

    for (let i = 0; i < cells.length; i++) {
      if (cells[i] !== DOOR) continue;
      const door = new THREE.Mesh(
        new THREE.BoxGeometry(1, 0.08, 0.22),
        new THREE.MeshBasicMaterial({ color: '#ffb8e6' }),
      );
      door.position.set(i % w, WALL_H * 0.5, Math.floor(i / w));
      this.mazeGroup.add(door);
    }

    // Pellets: small white cubes. Power pellets: big chunky cubes that pulse.
    const pelletIdx = [];
    this.powerMeshes = new Map();
    const powerMat = new THREE.MeshStandardMaterial({ color: pal.pellet, emissive: pal.pellet, emissiveIntensity: 0.6 });
    const powerGeo = new THREE.BoxGeometry(0.38, 0.38, 0.38);
    for (let i = 0; i < pellets.length; i++) {
      if (maze.initialPellets[i] === PELLET) pelletIdx.push(i);
      else if (maze.initialPellets[i] === POWER) {
        const m = new THREE.Mesh(powerGeo, powerMat);
        m.position.set(i % w, 0.3, Math.floor(i / w));
        m.castShadow = true;
        this.mazeGroup.add(m);
        this.powerMeshes.set(i, m);
      }
    }
    const pelletMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.16, 0.16, 0.16),
      new THREE.MeshStandardMaterial({ color: pal.pellet, emissive: pal.pellet, emissiveIntensity: 0.5 }),
      pelletIdx.length,
    );
    this.pelletMesh = pelletMesh;
    this.pelletSlot = new Map();
    pelletIdx.forEach((cell, k) => {
      this.pelletSlot.set(cell, k);
      this.placePellet(k, cell, true);
    });
    pelletMesh.castShadow = true;
    this.mazeGroup.add(pelletMesh);
    this.lastPellets = new Uint8Array(maze.initialPellets);
    this.syncPellets(pellets);

    if (!this.ghosts.length) {
      for (let i = 0; i < 4; i++) {
        const g = makeGhost(GHOST_COLORS[i]);
        this.ghosts.push(g);
        this.scene.add(g.group);
      }
    }
  }

  placePellet(slot, cell, visible) {
    const m = this.maze;
    tmpObj.position.set(cell % m.w, 0.2, Math.floor(cell / m.w));
    tmpObj.rotation.set(0, 0, 0);
    tmpObj.scale.setScalar(visible ? 1 : 0);
    tmpObj.updateMatrix();
    this.pelletMesh.setMatrixAt(slot, tmpObj.matrix);
  }

  syncPellets(pellets) {
    if (!this.lastPellets) return;
    let dirty = false;
    for (let i = 0; i < pellets.length; i++) {
      if (pellets[i] === this.lastPellets[i]) continue;
      this.lastPellets[i] = pellets[i];
      const slot = this.pelletSlot.get(i);
      if (slot !== undefined) {
        this.placePellet(slot, i, !!pellets[i]);
        dirty = true;
      }
      const pm = this.powerMeshes.get(i);
      if (pm) pm.visible = !!pellets[i];
    }
    if (dirty) this.pelletMesh.instanceMatrix.needsUpdate = true;
  }

  // -------------------------------------------------------------- effects

  popup(text, x, y, color = '#ffffff') {
    const sprite = textSprite(text, { color, size: 64, stroke: '#000000' });
    sprite.position.set(x, 1.2, y);
    sprite.scale.multiplyScalar(0.7);
    this.scene.add(sprite);
    this.popups.push({ sprite, born: this.time });
  }

  flashClear() {
    this.clearFlash = 2.4;
  }

  // ---------------------------------------------------------------- frame

  render(game, alpha, now, dt) {
    this.time += dt;
    const t = this.time;
    this.backdrop.update(t);
    const maze = game.maze;
    if (!maze || !this.maze) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.syncPellets(game.pellets);

    // Power pellets blink like the arcade.
    const powerOn = Math.floor(t * 4) % 2 === 0;
    for (const [i, m] of this.powerMeshes) m.visible = !!game.pellets[i] && powerOn;
    // Level clear: neon edges flash white.
    if (this.clearFlash > 0) {
      this.clearFlash -= dt;
      const on = Math.floor(this.clearFlash * 6) % 2 === 0 && this.clearFlash > 0;
      this.neonMat.color.set(on ? '#ffffff' : this.palette.neon);
    }

    // --- pacs
    const seen = new Set();
    for (const [id, info] of game.roster) {
      seen.add(id);
      let pac = this.pacs.get(id);
      const skinKey = `${info.skin.color}/${info.skin.hat}/${info.name}`;
      if (!pac || pac.skinKey !== skinKey) {
        if (pac) this.scene.remove(pac.group);
        pac = makePac(colorHex(info.skin.color), info.skin.hat, info.name, id === game.you);
        pac.skinKey = skinKey;
        this.pacs.set(id, pac);
        this.scene.add(pac.group);
      }
      let x;
      let y;
      let face;
      let moving;
      let alive;
      let blinking;
      if (id === game.you) {
        [x, y] = game.myRenderPos(alpha);
        face = game.me.face;
        moving = game.me.moving;
        alive = game.me.alive;
        blinking = now < game.invulnUntil;
      } else {
        const v = game.playerView.get(id);
        if (!v) {
          pac.group.visible = false;
          continue;
        }
        ({ x, y, face, moving } = v);
        const da = game.deathAt.get(id);
        alive = da !== undefined ? now < da : v.alive;
        blinking = v.inv > 0;
      }
      pac.group.visible = true;
      pac.group.position.set(x, SPRITE_Y, y);

      const deathAt = game.deathAt.get(id);
      if (!alive && deathAt !== undefined) {
        // Classic death: turn to face up, then the mouth opens until it's gone.
        const k = Math.min(1, Math.max(0, (now - deathAt - 250) / 1100));
        pac.setFace(1);
        if (k >= 1) pac.group.visible = false;
        else pac.setDeath(Math.floor(k * DEATH_FRAMES));
        pac.label.visible = false;
      } else if (!alive) {
        pac.group.visible = false;
      } else {
        pac.label.visible = true;
        pac.setFace(face || 4);
        if (moving) pac.phase = (pac.phase || 0) + dt * 18;
        pac.setChomp(moving ? Math.floor(pac.phase) % CHOMP_ANGLES.length : 2);
        pac.group.visible = !blinking || Math.floor(t * 10) % 2 === 0;
      }
    }
    for (const [id, pac] of this.pacs) {
      if (!seen.has(id)) {
        this.scene.remove(pac.group);
        this.pacs.delete(id);
      }
    }

    // --- ghosts
    const flashing = game.fright > 0 && game.fright < FRIGHT_FLASH_TIME;
    const flashWhite = flashing && Math.floor(t * 6) % 2 === 0;
    const skirt = Math.floor(t * 8) % 2;
    for (let i = 0; i < this.ghosts.length; i++) {
      const g = this.ghosts[i];
      const v = game.ghostView[i];
      if (!v) {
        g.group.visible = false;
        continue;
      }
      g.group.visible = true;
      const bob = v.mode === GM.HOUSE ? Math.sin(t * 5 + i) * 0.12 : 0;
      g.group.position.set(v.x, SPRITE_Y + bob, v.y);
      g.setMode(v.mode, flashWhite, v.face, skirt);
    }

    // --- popups
    this.popups = this.popups.filter((p) => {
      const age = this.time - p.born;
      p.sprite.position.y = 1.2 + age * 1.2;
      p.sprite.material.opacity = Math.max(0, 1 - age);
      if (age > 1) {
        this.scene.remove(p.sprite);
        p.sprite.material.map.dispose();
        p.sprite.material.dispose();
        return false;
      }
      return true;
    });

    const [mx, my] = game.me.life ? game.myRenderPos(alpha) : [maze.w / 2, maze.h / 2];
    this.updateCamera(mx, my, dt);
    this.renderer.render(this.scene, this.camera);
  }

  updateCamera(px, py, dt) {
    const maze = this.maze;
    const cam = this.camera;
    const target = this.camTarget;
    // Ortho: visible ground extents are fixed by the frustum.
    const halfW = this.halfH * cam.right / cam.top;
    const halfDepth = this.halfH / Math.sin(PITCH);
    const clampAxis = (v, half, size) =>
      half * 2 >= size + 2 ? (size - 1) / 2 : THREE.MathUtils.clamp(v, half - 2.5, size - half + 1.5);
    const tx = clampAxis(px, halfW * 0.92, maze.w);
    const tz = clampAxis(py, halfDepth * 0.8, maze.h);
    if (Math.abs(tx - target.x) > maze.w / 2) target.x = tx; // tunnel wrap
    const k = 1 - Math.exp(-dt * 5);
    target.x += (tx - target.x) * k;
    target.z += (tz - target.z) * k;
    const d = 60;
    cam.position.set(
      target.x + Math.sin(YAW) * Math.cos(PITCH) * d,
      Math.sin(PITCH) * d,
      target.z + Math.cos(YAW) * Math.cos(PITCH) * d,
    );
    cam.lookAt(target.x, 0, target.z);
    this.sun.position.set(target.x - 10, 25, target.z + 6);
    this.sun.target.position.set(target.x, 0, target.z);
    this.backdrop.mesh.position.set(target.x, 0, target.z);
  }
}

// ------------------------------------------------------------------ maze

function isWallAt(maze, x, y) {
  return x >= 0 && y >= 0 && x < maze.w && y < maze.h && maze.cells[y * maze.w + x] === WALL;
}

function buildWallGeometry(maze, pal, H) {
  const { w, h } = maze;
  const pos = [];
  const nor = [];
  const col = [];
  const top = new THREE.Color(pal.top);
  const side = new THREE.Color(pal.neon).multiplyScalar(0.8);
  const quad = (a, b, c, d, n, k) => {
    for (const v of [a, b, c, a, c, d]) {
      pos.push(...v);
      nor.push(...n);
      col.push(k.r, k.g, k.b);
    }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isWallAt(maze, x, y)) continue;
      const x0 = x - 0.5;
      const x1 = x + 0.5;
      const z0 = y - 0.5;
      const z1 = y + 0.5;
      quad([x0, H, z1], [x1, H, z1], [x1, H, z0], [x0, H, z0], [0, 1, 0], top);
      if (!isWallAt(maze, x, y + 1)) quad([x0, 0, z1], [x1, 0, z1], [x1, H, z1], [x0, H, z1], [0, 0, 1], side);
      if (!isWallAt(maze, x, y - 1)) quad([x1, 0, z0], [x0, 0, z0], [x0, H, z0], [x1, H, z0], [0, 0, -1], side);
      if (!isWallAt(maze, x + 1, y)) quad([x1, 0, z1], [x1, 0, z0], [x1, H, z0], [x1, H, z1], [1, 0, 0], side);
      if (!isWallAt(maze, x - 1, y)) quad([x0, 0, z0], [x0, 0, z1], [x0, H, z1], [x0, H, z0], [-1, 0, 0], side);
    }
  }
  return makeGeo(pos, nor, col);
}

/** Glowing strips along the top edges of walls wherever they meet a corridor. */
function buildNeonGeometry(maze, H) {
  const { w, h } = maze;
  const pos = [];
  const nor = [];
  const B = 0.17; // band width
  const y = H + 0.003;
  const rect = (ax, az, bx, bz) => {
    for (const v of [[ax, y, bz], [bx, y, bz], [bx, y, az], [ax, y, bz], [bx, y, az], [ax, y, az]]) {
      pos.push(...v);
      nor.push(0, 1, 0);
    }
  };
  const wall = (x, yy) => isWallAt(maze, x, yy) || yy < 0 || yy >= h || x < 0 || x >= w;
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      if (!isWallAt(maze, tx, ty)) continue;
      const x0 = tx - 0.5;
      const x1 = tx + 0.5;
      const z0 = ty - 0.5;
      const z1 = ty + 0.5;
      const n = !wall(tx, ty - 1);
      const s = !wall(tx, ty + 1);
      const e = !wall(tx + 1, ty);
      const wv = !wall(tx - 1, ty);
      if (n) rect(x0, z0, x1, z0 + B);
      if (s) rect(x0, z1 - B, x1, z1);
      if (e) rect(x1 - B, z0, x1, z1);
      if (wv) rect(x0, z0, x0 + B, z1);
      // Inner corners where only the diagonal neighbor is open.
      if (!n && !e && !wall(tx + 1, ty - 1)) rect(x1 - B, z0, x1, z0 + B);
      if (!n && !wv && !wall(tx - 1, ty - 1)) rect(x0, z0, x0 + B, z0 + B);
      if (!s && !e && !wall(tx + 1, ty + 1)) rect(x1 - B, z1 - B, x1, z1);
      if (!s && !wv && !wall(tx - 1, ty + 1)) rect(x0, z1 - B, x0 + B, z1);
    }
  }
  return makeGeo(pos, nor, null);
}

function makeGeo(pos, nor, col) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  if (col) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

/** Translucent cubes drifting below the maze. */
function makeBackdrop() {
  const N = 160;
  const mat = new THREE.MeshBasicMaterial({ color: '#8fbaff', transparent: true, opacity: 0.32, depthWrite: false });
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, N);
  mesh.frustumCulled = false;
  const cubes = [];
  for (let i = 0; i < N; i++) {
    cubes.push({
      x: (Math.random() - 0.5) * 90,
      z: (Math.random() - 0.5) * 90,
      y: -3 - Math.random() * 14,
      s: 0.5 + Math.random() * 1.5,
      p: Math.random() * Math.PI * 2,
      r: Math.random() * Math.PI,
    });
  }
  return {
    mesh,
    setColor(c) {
      mat.color.set(c);
    },
    update(t) {
      cubes.forEach((c, i) => {
        tmpObj.position.set(c.x, c.y + Math.sin(t * 0.6 + c.p) * 0.6, c.z);
        tmpObj.rotation.set(0, c.r + t * 0.05, 0);
        tmpObj.scale.setScalar(c.s);
        tmpObj.updateMatrix();
        mesh.setMatrixAt(i, tmpObj.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

// --------------------------------------------------------------- sprites

export function textSprite(text, { color = '#fff', size = 40, stroke = 'rgba(0,0,0,0.85)', bg = null } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `800 ${size}px "Baloo 2", "Trebuchet MS", system-ui, sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + size;
  const h = Math.ceil(size * 1.5);
  c.width = w;
  c.height = h;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (bg) {
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(2, 4, w - 4, h - 8, h / 2 - 4);
    ctx.fill();
  }
  ctx.lineWidth = size / 6;
  ctx.strokeStyle = stroke;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, w / 2, h / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const s = new THREE.Sprite(mat);
  const scale = 0.36;
  s.scale.set((w / h) * scale, scale, 1);
  s.renderOrder = 10;
  return s;
}

/** A group that keeps its children facing the camera, leaning back a bit. */
function cutoutGroup() {
  const group = new THREE.Group();
  const lean = new THREE.Group();
  lean.rotation.order = 'YXZ';
  lean.rotation.y = YAW;
  lean.rotation.x = -SPRITE_LEAN;
  group.add(lean);
  return { group, lean };
}

function makePac(color, hat, name, isYou) {
  const { group, lean } = cutoutGroup();
  const spin = new THREE.Group();
  lean.add(spin);
  const geos = pacGeometries(color, hat);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 });
  const mesh = new THREE.Mesh(geos.chomp[0], mat);
  mesh.castShadow = true;
  spin.add(mesh);

  const label = textSprite(name, { color: isYou ? '#ffffff' : color, size: 40, bg: isYou ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.25)' });
  label.position.set(0, 0.95, 0);
  group.add(label);

  return {
    group,
    label,
    setFace(face) {
      // Sprite art faces right; mirror for left, rotate for up/down.
      spin.scale.x = face === 4 ? -1 : 1;
      spin.rotation.z = face === 1 ? Math.PI / 2 : face === 3 ? -Math.PI / 2 : 0;
    },
    setChomp(i) {
      mesh.geometry = geos.chomp[i];
    },
    setDeath(i) {
      mesh.geometry = geos.death[Math.min(i, geos.death.length - 1)];
    },
  };
}

function makeGhost(color) {
  const { group, lean } = cutoutGroup();
  const geos = ghostGeometries();
  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, color, roughness: 0.5 });
  const body = new THREE.Mesh(geos.body[0], bodyMat);
  body.castShadow = true;
  const eyeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4 });
  const eyes = new THREE.Mesh(geos.eyes[0], eyeMat);
  const scaredMat = new THREE.MeshStandardMaterial({ vertexColors: true, color: '#ffc8a0', roughness: 0.5 });
  const scared = new THREE.Mesh(geos.scared, scaredMat);
  lean.add(body, eyes, scared);
  const base = new THREE.Color(color);
  const blue = new THREE.Color('#2233ff');
  const white = new THREE.Color('#f4f4ff');
  return {
    group,
    setMode(mode, flashWhite, face, skirt) {
      const fright = mode === GM.FRIGHT;
      body.visible = mode !== GM.EATEN;
      body.geometry = geos.body[skirt];
      eyes.visible = !fright;
      eyes.geometry = geos.eyes[face || 0];
      scared.visible = fright;
      bodyMat.color.copy(fright ? (flashWhite ? white : blue) : base);
      scaredMat.color.set(fright && flashWhite ? '#ff2244' : '#ffc8a0');
    },
  };
}
