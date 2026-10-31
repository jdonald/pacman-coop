// Three.js renderer: chunky, brightly lit 3D mazes viewed from an angled
// camera that follows your pac (scrolling view).

import * as THREE from 'three';
import { WALL, DOOR, PELLET, POWER, GHOST_COLORS, FRIGHT_FLASH_TIME } from '../../shared/constants.js';
import { colorHex } from '../../shared/profile.js';
import { GM } from './game.js';

export const PALETTES = [
  { bg: '#0b0a26', floor: '#17143d', floor2: '#1b1847', wall: '#2f5dff', top: '#5f8dff', pellet: '#fff3c4' },
  { bg: '#1a0724', floor: '#2a0d38', floor2: '#311043', wall: '#f0388f', top: '#ff7cbc', pellet: '#ffffff' },
  { bg: '#03201e', floor: '#0a2d2a', floor2: '#0d3532', wall: '#12b58b', top: '#4fe3b8', pellet: '#fffbd6' },
  { bg: '#211002', floor: '#341b07', floor2: '#3d200a', wall: '#f2781a', top: '#ffab5e', pellet: '#ffffff' },
  { bg: '#10061f', floor: '#1e0d36', floor2: '#24113f', wall: '#8a4dff', top: '#b88cff', pellet: '#fff6c9' },
];

const WALL_H = 0.6;
const PITCH_DEG = 60;
const DIR_ANGLE = [0, Math.PI, Math.PI / 2, 0, -Math.PI / 2]; // rotation.y per direction
const tmpObj = new THREE.Object3D();

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 200);
    this.camTarget = new THREE.Vector3(14, 0, 15);
    this.camDist = 20;

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x2a2a55, 1.25);
    this.scene.add(this.hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, 2.2));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -20;
    sc.right = 20;
    sc.top = 20;
    sc.bottom = -20;
    sc.near = 1;
    sc.far = 60;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
    this.scene.add(sun.target);

    this.mazeGroup = new THREE.Group();
    this.scene.add(this.mazeGroup);
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
    this.camera.aspect = w / h;
    // Keep at least ~17 tiles visible horizontally on narrow (portrait) screens.
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.camDist = THREE.MathUtils.clamp(15 / (2 * tanHalf * this.camera.aspect), 16, 32);
    this.camera.updateProjectionMatrix();
  }

  // ----------------------------------------------------------------- maze

  setMaze(maze, level, pellets) {
    this.maze = maze;
    const pal = (this.palette = PALETTES[(level - 1) % PALETTES.length]);
    this.scene.background = new THREE.Color(pal.bg);
    this.scene.fog = new THREE.Fog(pal.bg, 26, 60);
    for (const child of [...this.mazeGroup.children]) {
      this.mazeGroup.remove(child);
      child.geometry?.dispose();
    }

    const { w, h, cells } = maze;
    // Floor with a subtle checker.
    const tex = checkerTexture(pal.floor, pal.floor2);
    tex.repeat.set(w / 2, h / 2);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w + 0.2, h + 0.2),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((w - 1) / 2, 0, (h - 1) / 2);
    floor.receiveShadow = true;
    this.mazeGroup.add(floor);

    // Walls: one merged mesh with only the exposed faces (no seams), lighter
    // tops and sides that darken toward the floor.
    this.wallMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, emissive: 0x000000 });
    const walls = new THREE.Mesh(buildWallGeometry(maze, pal, WALL_H), this.wallMat);
    walls.castShadow = walls.receiveShadow = true;
    this.mazeGroup.add(walls);

    // Ghost house door.
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] !== DOOR) continue;
      const door = new THREE.Mesh(
        new THREE.BoxGeometry(1, 0.12, 0.25),
        new THREE.MeshStandardMaterial({ color: '#ffb6e6', emissive: '#ff6fcf', emissiveIntensity: 0.6 }),
      );
      door.position.set(i % w, WALL_H * 0.6, Math.floor(i / w));
      this.mazeGroup.add(door);
    }

    // Pellets (instanced) and power pellets (individual, pulsing).
    const pelletIdx = [];
    this.powerMeshes = new Map();
    const powerMat = new THREE.MeshStandardMaterial({ color: pal.pellet, emissive: pal.pellet, emissiveIntensity: 0.7 });
    const powerGeo = new THREE.SphereGeometry(0.27, 20, 14);
    for (let i = 0; i < pellets.length; i++) {
      if (maze.initialPellets[i] === PELLET) pelletIdx.push(i);
      else if (maze.initialPellets[i] === POWER) {
        const m = new THREE.Mesh(powerGeo, powerMat);
        m.position.set(i % w, 0.35, Math.floor(i / w));
        m.castShadow = true;
        this.mazeGroup.add(m);
        this.powerMeshes.set(i, m);
      }
    }
    const pelletMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.17, 0.17, 0.17),
      new THREE.MeshStandardMaterial({ color: pal.pellet, emissive: pal.pellet, emissiveIntensity: 0.45 }),
      pelletIdx.length,
    );
    this.pelletMesh = pelletMesh;
    this.pelletSlot = new Map();
    pelletIdx.forEach((cell, k) => {
      this.pelletSlot.set(cell, k);
      tmpObj.position.set(cell % w, 0.3, Math.floor(cell / w));
      tmpObj.rotation.set(Math.PI / 4, Math.PI / 4, 0);
      tmpObj.scale.setScalar(1);
      tmpObj.updateMatrix();
      pelletMesh.setMatrixAt(k, tmpObj.matrix);
    });
    pelletMesh.castShadow = true;
    this.mazeGroup.add(pelletMesh);
    this.lastPellets = new Uint8Array(maze.initialPellets);
    this.syncPellets(pellets);

    // Ghosts are (re)created per maze so colors stay fresh.
    if (!this.ghosts.length) {
      for (let i = 0; i < 4; i++) {
        const g = makeGhost(GHOST_COLORS[i]);
        this.ghosts.push(g);
        this.scene.add(g.group);
      }
    }
  }

  syncPellets(pellets) {
    if (!this.lastPellets) return;
    let dirty = false;
    for (let i = 0; i < pellets.length; i++) {
      if (pellets[i] === this.lastPellets[i]) continue;
      this.lastPellets[i] = pellets[i];
      const slot = this.pelletSlot.get(i);
      if (slot !== undefined) {
        const m = this.maze;
        tmpObj.position.set(i % m.w, 0.3, Math.floor(i / m.w));
        tmpObj.rotation.set(Math.PI / 4, Math.PI / 4, 0);
        tmpObj.scale.setScalar(pellets[i] ? 1 : 0);
        tmpObj.updateMatrix();
        this.pelletMesh.setMatrixAt(slot, tmpObj.matrix);
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
    const maze = game.maze;
    if (!maze || !this.maze) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.syncPellets(game.pellets);
    const t = this.time;

    // Power pellets pulse.
    for (const m of this.powerMeshes.values()) m.scale.setScalar(0.85 + Math.sin(t * 7) * 0.18);
    // Level clear: walls flash.
    if (this.clearFlash > 0) {
      this.clearFlash -= dt;
      const on = Math.floor(this.clearFlash * 6) % 2 === 0 && this.clearFlash > 0;
      this.wallMat.emissive.set(on ? '#ffffff' : '#000000');
      this.wallMat.emissiveIntensity = on ? 0.6 : 0;
    }

    // --- pacs
    const seen = new Set();
    const roster = game.roster;
    for (const [id, info] of roster) {
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
      pac.group.position.set(x, 0.42, y);
      // Smoothly rotate toward facing direction.
      const targetRot = DIR_ANGLE[face || 4];
      let dr = targetRot - pac.body.rotation.y;
      dr = Math.atan2(Math.sin(dr), Math.cos(dr));
      pac.body.rotation.y += dr * Math.min(1, dt * 18);

      const deathAt = game.deathAt.get(id);
      if (!alive && deathAt !== undefined) {
        // Death: mouth opens all the way while shrinking and spinning.
        const k = Math.min(1, Math.max(0, (now - deathAt) / 1100));
        pac.setMouth(0.2 + k * 1.4);
        pac.body.scale.setScalar(Math.max(0.001, 1 - k * k));
        pac.body.rotation.y += dt * 10 * k;
        pac.label.visible = k < 0.5;
      } else if (!alive) {
        pac.group.visible = false;
      } else {
        pac.body.scale.setScalar(1);
        pac.label.visible = true;
        pac.phase = (pac.phase || 0) + (moving ? dt * 16 : 0);
        pac.setMouth(moving ? 0.08 + Math.abs(Math.sin(pac.phase)) * 0.55 : 0.32);
        pac.body.position.y = moving ? Math.abs(Math.sin(pac.phase)) * 0.04 : 0;
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
    for (let i = 0; i < this.ghosts.length; i++) {
      const g = this.ghosts[i];
      const v = game.ghostView[i];
      if (!v) {
        g.group.visible = false;
        continue;
      }
      g.group.visible = true;
      const bob = v.mode === GM.HOUSE ? Math.sin(t * 5 + i) * 0.15 : Math.sin(t * 6 + i) * 0.04;
      g.group.position.set(v.x, 0.05 + bob, v.y);
      g.setMode(v.mode, flashWhite, v.face);
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

    // --- camera follows your pac
    const [mx, my] = game.me.life ? game.myRenderPos(alpha) : [maze.w / 2, maze.h / 2];
    this.updateCamera(mx, my, dt);
    this.renderer.render(this.scene, this.camera);
  }

  updateCamera(px, py, dt) {
    const maze = this.maze;
    const cam = this.camera;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const visW = 2 * this.camDist * tanHalf * cam.aspect * 0.9;
    let tx = px;
    if (visW >= maze.w + 2) tx = (maze.w - 1) / 2;
    else tx = THREE.MathUtils.clamp(px, visW / 2 - 1.5, maze.w - visW / 2 + 0.5);
    // Don't scroll so far that the screen fills up with empty space past the maze.
    const halfD = (this.camDist * tanHalf) / Math.sin(THREE.MathUtils.degToRad(PITCH_DEG));
    const zMin = Math.min(halfD * 0.55, maze.h / 2);
    const zMax = Math.max(maze.h - 1 - halfD * 0.7, maze.h / 2);
    const tz = THREE.MathUtils.clamp(py + 0.5, zMin, zMax);
    const target = this.camTarget;
    if (Math.abs(tx - target.x) > maze.w / 2) target.x = tx; // tunnel wrap
    const k = 1 - Math.exp(-dt * 5);
    target.x += (tx - target.x) * k;
    target.z += (tz - target.z) * k;
    // Angled view from the front, slightly to the side for an isometric feel.
    const pitch = THREE.MathUtils.degToRad(PITCH_DEG);
    const yaw = THREE.MathUtils.degToRad(-10);
    const d = this.camDist;
    cam.position.set(
      target.x + Math.sin(yaw) * Math.cos(pitch) * d,
      Math.sin(pitch) * d,
      target.z + Math.cos(yaw) * Math.cos(pitch) * d,
    );
    cam.lookAt(target.x, 0, target.z);
    this.sun.position.set(target.x - 8, 22, target.z + 10);
    this.sun.target.position.set(target.x, 0, target.z);
  }
}

// ------------------------------------------------------------------ models

function buildWallGeometry(maze, pal, H) {
  const { w, h, cells } = maze;
  const isWall = (x, y) => x >= 0 && y >= 0 && x < w && y < h && cells[y * w + x] === WALL;
  const pos = [];
  const nor = [];
  const col = [];
  const top = new THREE.Color(pal.top);
  const side = new THREE.Color(pal.wall);
  const low = side.clone().multiplyScalar(0.55);
  const quad = (a, b, c, d, n, ca, cb, cc, cd) => {
    for (const [v, k] of [[a, ca], [b, cb], [c, cc], [a, ca], [c, cc], [d, cd]]) {
      pos.push(...v);
      nor.push(...n);
      col.push(k.r, k.g, k.b);
    }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isWall(x, y)) continue;
      const x0 = x - 0.5;
      const x1 = x + 0.5;
      const z0 = y - 0.5;
      const z1 = y + 0.5;
      quad([x0, H, z1], [x1, H, z1], [x1, H, z0], [x0, H, z0], [0, 1, 0], top, top, top, top);
      if (!isWall(x, y + 1)) quad([x0, 0, z1], [x1, 0, z1], [x1, H, z1], [x0, H, z1], [0, 0, 1], low, low, side, side);
      if (!isWall(x, y - 1)) quad([x1, 0, z0], [x0, 0, z0], [x0, H, z0], [x1, H, z0], [0, 0, -1], low, low, side, side);
      if (!isWall(x + 1, y)) quad([x1, 0, z1], [x1, 0, z0], [x1, H, z0], [x1, H, z1], [1, 0, 0], low, low, side, side);
      if (!isWall(x - 1, y)) quad([x0, 0, z0], [x0, 0, z1], [x0, H, z1], [x0, H, z0], [-1, 0, 0], low, low, side, side);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

function checkerTexture(a, b) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = a;
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = b;
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillRect(32, 32, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

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
    const r = h / 2;
    ctx.beginPath();
    ctx.roundRect(2, 4, w - 4, h - 8, r - 4);
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
  const scale = 0.012 * (40 / size) * size;
  s.scale.set((w / h) * scale * 1.5 * 0.5, scale * 1.5 * 0.5, 1);
  s.renderOrder = 10;
  return s;
}

function makePac(color, hat, name, isYou) {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const R = 0.42;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.05 });
  const mouthMat = new THREE.MeshStandardMaterial({ color: '#5a0f22', roughness: 0.8, side: THREE.DoubleSide });

  const top = new THREE.Group();
  const topMesh = new THREE.Mesh(new THREE.SphereGeometry(R, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat);
  const topCap = new THREE.Mesh(new THREE.CircleGeometry(R, 32), mouthMat);
  topCap.rotation.x = Math.PI / 2;
  top.add(topMesh, topCap);

  const bottom = new THREE.Group();
  const botMesh = new THREE.Mesh(
    new THREE.SphereGeometry(R, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    mat,
  );
  const botCap = new THREE.Mesh(new THREE.CircleGeometry(R, 32), mouthMat);
  botCap.rotation.x = -Math.PI / 2;
  bottom.add(botMesh, botCap);
  for (const m of [topMesh, botMesh]) m.castShadow = true;

  // Eyes
  const eyeMat = new THREE.MeshStandardMaterial({ color: '#111111', roughness: 0.3 });
  const eyeGeo = new THREE.SphereGeometry(0.06, 12, 8);
  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(eyeGeo, eyeMat);
    e.position.set(sx * 0.17, 0.24, 0.29);
    top.add(e);
  }
  const hatObj = makeHat(hat, color);
  if (hatObj) top.add(hatObj);
  body.add(top, bottom);

  const label = textSprite(name, {
    color: isYou ? '#ffffff' : color,
    size: 40,
    bg: isYou ? 'rgba(0,0,0,0.45)' : null,
  });
  label.position.set(0, 1.25, 0);
  group.add(label);

  return {
    group,
    body,
    label,
    setMouth(a) {
      top.rotation.x = -a / 2;
      bottom.rotation.x = a / 2;
    },
  };
}

function makeHat(hat, bodyColor) {
  const g = new THREE.Group();
  const std = (c, extra = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, ...extra });
  switch (hat) {
    case 'bow': {
      const m = std('#ff2d7a');
      for (const s of [-1, 1]) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.2, 12), m);
        cone.rotation.z = (s * Math.PI) / 2;
        cone.position.set(s * 0.1, 0, 0);
        g.add(cone);
      }
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), m));
      g.position.set(-0.14, 0.4, 0.05);
      g.rotation.z = 0.5;
      break;
    }
    case 'cap': {
      const m = std(bodyColor === '#ff4d4d' ? '#3a7bff' : '#ff3b3b');
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), m);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 20, 1, false, -Math.PI / 2, Math.PI), m);
      brim.position.set(0, 0, 0.22);
      brim.scale.z = 1.3;
      g.add(dome, brim);
      g.position.set(0, 0.32, 0);
      break;
    }
    case 'crown': {
      const m = std('#ffcf33', { metalness: 0.6, roughness: 0.3 });
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.2, 0.12, 20, 1, true), m);
      m.side = THREE.DoubleSide;
      g.add(band);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.13, 6), m);
        spike.position.set(Math.cos(a) * 0.21, 0.12, Math.sin(a) * 0.21);
        g.add(spike);
      }
      const gem = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), std('#ff2d55'));
      gem.position.set(0, 0.0, 0.215);
      g.add(gem);
      g.position.set(0, 0.42, 0);
      break;
    }
    case 'tophat': {
      const m = std('#1b1b22');
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.32, 20), m);
      crown.position.y = 0.16;
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.03, 24), m);
      const ribbon = new THREE.Mesh(new THREE.CylinderGeometry(0.175, 0.175, 0.06, 20), std('#e0245e'));
      ribbon.position.y = 0.05;
      g.add(crown, brim, ribbon);
      g.position.set(0, 0.38, 0);
      g.rotation.z = -0.15;
      break;
    }
    case 'shades': {
      const m = std('#0d0d12', { metalness: 0.4, roughness: 0.2 });
      for (const s of [-1, 1]) {
        const lens = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.09, 0.03), m);
        lens.position.set(s * 0.12, 0, 0);
        g.add(lens);
      }
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.025, 0.025), m));
      g.position.set(0, 0.24, 0.345);
      g.rotation.x = -0.35;
      break;
    }
    case 'propeller': {
      const stripes = ['#ff3b3b', '#ffd60a', '#3a7bff', '#2ecc71'];
      for (let i = 0; i < 4; i++) {
        const seg = new THREE.Mesh(
          new THREE.SphereGeometry(0.24, 8, 8, (i * Math.PI) / 2, Math.PI / 2, 0, Math.PI / 2),
          std(stripes[i]),
        );
        g.add(seg);
      }
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.12, 6), std('#888888'));
      stem.position.y = 0.27;
      const prop = new THREE.Group();
      for (const s of [-1, 1]) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.015, 0.06), std(s > 0 ? '#ff3b3b' : '#3a7bff'));
        blade.position.x = s * 0.11;
        prop.add(blade);
      }
      prop.position.y = 0.33;
      prop.children.forEach((b) => (b.onBeforeRender = () => (prop.rotation.y += 0.12)));
      g.add(stem, prop);
      g.position.set(0, 0.34, 0);
      break;
    }
    default:
      return null;
  }
  g.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  return g;
}

function makeGhost(color) {
  const group = new THREE.Group();
  // Lathe body with a wavy skirt.
  const pts = [];
  const prof = [
    [0.001, 0.86], [0.12, 0.85], [0.24, 0.8], [0.33, 0.71], [0.39, 0.6],
    [0.42, 0.47], [0.43, 0.32], [0.44, 0.2], [0.45, 0.1],
  ];
  for (const [r, y] of prof) pts.push(new THREE.Vector2(r, y));
  const geo = new THREE.LatheGeometry(pts, 36);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < 0.15) {
      const a = Math.atan2(pos.getZ(i), pos.getX(i));
      pos.setY(i, 0.06 + Math.sin(a * 7) * 0.05);
    }
  }
  geo.computeVertexNormals();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, side: THREE.DoubleSide, emissive: color, emissiveIntensity: 0.12 });
  const body = new THREE.Mesh(geo, bodyMat);
  body.castShadow = true;
  group.add(body);

  // Eyes face the camera; pupils look where the ghost is heading.
  const eyes = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.3 });
  const pupilMat = new THREE.MeshStandardMaterial({ color: '#1d2bd6', roughness: 0.3 });
  const pupils = [];
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 10), white);
    e.scale.set(1, 1.2, 0.8);
    e.position.set(s * 0.15, 0.56, 0.3);
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), pupilMat);
    p.position.set(s * 0.15, 0.56, 0.38);
    eyes.add(e, p);
    pupils.push({ mesh: p, base: s * 0.15 });
  }
  group.add(eyes);

  // Frightened face: wobbly mouth.
  const scared = new THREE.Group();
  const scaredMat = new THREE.MeshStandardMaterial({ color: '#ffd2a8', roughness: 0.5 });
  for (const s of [-1, 1]) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), scaredMat);
    dot.position.set(s * 0.13, 0.58, 0.36);
    scared.add(dot);
  }
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.03, 0.03), scaredMat);
    m.position.set(-0.16 + i * 0.08, 0.4 + (i % 2) * 0.04, 0.4);
    scared.add(m);
  }
  group.add(scared);

  const base = new THREE.Color(color);
  const blue = new THREE.Color('#2236ff');
  const whiteC = new THREE.Color('#f2f2ff');
  return {
    group,
    setMode(mode, flashWhite, face) {
      const fright = mode === GM.FRIGHT;
      body.visible = mode !== GM.EATEN;
      eyes.visible = !fright;
      scared.visible = fright;
      const c = fright ? (flashWhite ? whiteC : blue) : base;
      bodyMat.color.copy(c);
      bodyMat.emissive.copy(c);
      scaredMat.color.set(fright && flashWhite ? '#ff3355' : '#ffd2a8');
      // Pupils
      const dx = face === 2 ? 0.05 : face === 4 ? -0.05 : 0;
      const dy = face === 1 ? 0.05 : face === 3 ? -0.04 : 0;
      for (const p of pupils) {
        p.mesh.position.x = p.base + dx;
        p.mesh.position.y = 0.56 + dy;
        p.mesh.position.z = face === 1 ? 0.34 : 0.38;
      }
    },
  };
}
