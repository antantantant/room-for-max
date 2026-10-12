// The room itself: geometry, materials, sunrise lighting and the view outside.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Every position is given in pixels measured off the floor plan in the sketch
// (room outline: x 30..1690, y 300..1340) and converted to metres by assuming
// the bed is 2.0 m long (790 px). That makes the room 4.20 m x 2.63 m.
// Compass: -z is east (the two-window wall), +x is south, -x is north, +z is west.
const S = 2.0 / 790;
const W = 1660 * S, D = 1040 * S, H = 2.6;
const X = px => (px - 30) * S - W / 2;   // plan x -> world x (north wall .. south wall)
const Z = py => (py - 300) * S - D / 2;  // plan y -> world z (east wall .. west wall)
const Y0 = 0.7, Y1 = 2.15;               // sill and head height shared by all three windows

// Sunrise: the sun sits low in the east, a touch to the south.
const sunDir = new THREE.Vector3(0.12, 0.27, -1).normalize();

export const views = {
  overview: [[-3.3, 3.3, 4.6], [0.2, 0.85, -0.1]],
  sketch:   [[X(440), 1.5, Z(1325)], [X(930), 0.8, Z(600)]], // standing at the west wall, as drawn
  plan:     [[0, 6.4, 0.001], [0, 0, 0]],
};

export function buildScene(scene, renderer) {
  const hideFromAO = [];

  // ---------- helpers ----------
  let seed = 7;
  const rand = () => { // small deterministic generator so the room looks the same on every load
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };

  // Materials are shared wherever colour, texture and options match, which lets
  // the final merge step fold many small meshes into a single draw call.
  const matCache = new Map();
  const mat = (color, map, extra) => {
    const key = `${color}|${map ? map.uuid : ''}|${extra ? JSON.stringify(extra) : ''}`;
    if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...(map && { map }), ...extra }));
    return matCache.get(key);
  };

  function add(geo, material, x, y, z, parent = scene) {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  // Boxes get softly rounded edges so they catch a highlight instead of looking razor-cut.
  const box = (w, h, d, material, x, y, z, parent) => {
    const m = Math.min(w, h, d);
    const geo = m >= 0.02 ? new RoundedBoxGeometry(w, h, d, 2, Math.min(0.012, m * 0.25)) : new THREE.BoxGeometry(w, h, d);
    return add(geo, material, x, y, z, parent);
  };
  const ball = (r, material, x, y, z, parent, sx = 1, sy = 1, sz = 1) => {
    const m = add(new THREE.SphereGeometry(r, 28, 18), material, x, y, z, parent);
    m.scale.set(sx, sy, sz);
    return m;
  };
  const cyl = (rTop, rBottom, h, material, x, y, z, parent) =>
    add(new THREE.CylinderGeometry(rTop, rBottom, h, 28), material, x, y, z, parent);
  const group = (x, y, z, rotY = 0, parent = scene) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = rotY;
    parent.add(g);
    return g;
  };
  // A flat picture that hangs on a wall and, like the wall, is only visible from inside.
  const flat = (w, h, material, x, y, z, parent) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    m.position.set(x, y, z);
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  // Many copies of one small shape in a single draw call.
  function scatter(geo, material, matrices, parent) {
    const im = new THREE.InstancedMesh(geo, material, matrices.length);
    matrices.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = im.receiveShadow = true;
    parent.add(im);
    return im;
  }

  // Rounded-corner slab lying flat; (x, y, z) is the centre of its underside.
  // mats = [top/bottom material, side material]
  function slab(w, h, d, r, mats, x, y, z, parent) {
    const s = new THREE.Shape(), a = -w / 2, b = -d / 2;
    s.moveTo(a + r, b); s.lineTo(a + w - r, b); s.quadraticCurveTo(a + w, b, a + w, b + r);
    s.lineTo(a + w, b + d - r); s.quadraticCurveTo(a + w, b + d, a + w - r, b + d);
    s.lineTo(a + r, b + d); s.quadraticCurveTo(a, b + d, a, b + d - r);
    s.lineTo(a, b + r); s.quadraticCurveTo(a, b, a + r, b);
    const geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 12 });
    geo.rotateX(-Math.PI / 2);
    return add(geo, mats, x, y, z, parent);
  }

  function tex(w, h, draw, repeatX = 1, repeatY = repeatX) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeatX, repeatY);
    t.anisotropy = 8;
    return t;
  }

  // ---------- textures ----------
  // Warm, mottled Tuscan plaster. One tile = 2.5 m.
  const stuccoTex = tex(1024, 1024, (g, w, h) => {
    g.fillStyle = '#e8c78c'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 1400; i++) {
      const x = rand() * w, y = rand() * h, r = 12 + rand() * 80;
      g.fillStyle = rand() < 0.5 ? 'rgba(255,238,200,0.05)' : 'rgba(176,112,52,0.045)';
      for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) { g.beginPath(); g.arc(x + ox, y + oy, r, 0, Math.PI * 2); g.fill(); }
    }
  }, 1 / 2.5);

  // Terracotta cotto floor tiles, 0.3 m square (the texture holds 4 x 4 of them).
  const floorTex = tex(1024, 1024, (g, w) => {
    g.fillStyle = '#9b8672'; g.fillRect(0, 0, w, w);
    const q = w / 4;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      g.fillStyle = `hsl(${14 + rand() * 9}, ${48 + rand() * 12}%, ${40 + rand() * 11}%)`;
      g.fillRect(i * q + 5, j * q + 5, q - 10, q - 10);
      for (let k = 0; k < 90; k++) {
        g.fillStyle = rand() < 0.5 ? 'rgba(255,220,180,0.07)' : 'rgba(70,30,10,0.07)';
        g.beginPath(); g.arc(i * q + 8 + rand() * (q - 16), j * q + 8 + rand() * (q - 16), 2 + rand() * 9, 0, Math.PI * 2); g.fill();
      }
    }
  }, W / 1.2, D / 1.2);

  const woodTex = (base, grain, rep = 1) => tex(1024, 1024, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    g.strokeStyle = grain;
    for (let i = 0; i < 260; i++) {
      const y = rand() * h;
      g.globalAlpha = 0.06 + rand() * 0.22; g.lineWidth = 1 + rand() * 3;
      g.beginPath(); g.moveTo(0, y);
      g.bezierCurveTo(w / 3, y + rand() * 14 - 7, 2 * w / 3, y + rand() * 14 - 7, w, y); g.stroke();
    }
    g.globalAlpha = 1;
  }, rep);

  // Quilt: stitched squares with little hippo faces. One tile = 0.4 m.
  const quiltTex = tex(512, 512, (g, s) => {
    g.fillStyle = '#f6efdf'; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#d3c6aa'; g.lineWidth = 3; g.setLineDash([12, 9]);
    for (const p of [0, s / 2]) {
      g.beginPath(); g.moveTo(p + 2, 0); g.lineTo(p + 2, s); g.stroke();
      g.beginPath(); g.moveTo(0, p + 2); g.lineTo(s, p + 2); g.stroke();
    }
    g.setLineDash([]);
    const hippo = (x, y) => {
      g.fillStyle = '#e88fa8';
      for (const dx of [-34, 34]) { g.beginPath(); g.arc(x + dx, y - 32, 14, 0, Math.PI * 2); g.fill(); }
      g.beginPath(); g.ellipse(x, y, 54, 38, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f6b5c6'; g.beginPath(); g.ellipse(x, y + 14, 36, 20, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#3a2228';
      for (const dx of [-20, 20]) {
        g.beginPath(); g.arc(x + dx, y - 12, 6, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(x + dx * 0.6, y + 14, 4, 0, Math.PI * 2); g.fill();
      }
    };
    hippo(128, 128); hippo(384, 384);
  }, 1 / 0.4);

  // Mattress edge: vertical stitching, as drawn. One tile = 0.12 m.
  const stitchTex = tex(128, 128, (g, s) => {
    g.fillStyle = '#f7f2e6'; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#bcae93'; g.lineWidth = 3;
    for (const x of [2, s / 2]) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, s); g.stroke(); }
    g.beginPath(); g.moveTo(0, s / 2); g.lineTo(s, s / 2); g.stroke();
  }, 1 / 0.12);

  const plaidTex = (base, band, line, rx, ry = rx) => tex(256, 256, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.fillStyle = band; g.globalAlpha = 0.55;
    g.fillRect(0, 40, s, 68); g.fillRect(40, 0, 68, s);
    g.globalAlpha = 1; g.strokeStyle = line; g.lineWidth = 6;
    g.beginPath(); g.moveTo(0, 184); g.lineTo(s, 184); g.moveTo(184, 0); g.lineTo(184, s); g.stroke();
  }, rx, ry);

  const linenTex = (base, thread, rx, ry) => tex(256, 256, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.strokeStyle = thread;
    for (let i = 0; i < s; i += 4) {
      g.globalAlpha = 0.1 + rand() * 0.2; g.lineWidth = 1;
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, s); g.moveTo(0, i); g.lineTo(s, i); g.stroke();
    }
    g.globalAlpha = 1;
  }, rx, ry);

  const wovenTex = (rx, ry) => tex(256, 256, (g, s) => {
    g.fillStyle = '#e3c88c'; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#a57f3e'; g.lineWidth = 5;
    for (let y = 16; y < s; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); }
    g.lineWidth = 3;
    for (let x = 16; x < s; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, s); g.stroke(); }
  }, rx, ry);

  const hatchTex = tex(256, 256, (g, s) => {
    g.fillStyle = '#d29a5a'; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#b07636'; g.lineWidth = 4;
    for (const p of [32, 160]) { g.beginPath(); g.moveTo(p, 0); g.lineTo(p, s); g.moveTo(0, p); g.lineTo(s, p); g.stroke(); }
    g.strokeStyle = 'rgba(255,235,200,0.25)'; g.lineWidth = 2;
    for (const p of [96, 224]) { g.beginPath(); g.moveTo(p, 0); g.lineTo(p, s); g.moveTo(0, p); g.lineTo(s, p); g.stroke(); }
  }, 10, 6);

  // Chunky knit for throws: ribs of little V stitches.
  const knitTex = (base, light, dark, rx, ry) => tex(128, 128, (g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.lineWidth = 5; g.lineCap = 'round';
    for (let x = 0; x < s; x += 32) for (let y = -8; y < s; y += 16) {
      g.strokeStyle = light; g.beginPath(); g.moveTo(x + 4, y); g.lineTo(x + 16, y + 12); g.stroke();
      g.strokeStyle = dark; g.beginPath(); g.moveTo(x + 28, y); g.lineTo(x + 16, y + 12); g.stroke();
    }
  }, rx, ry);

  // Majolica glaze for the vase: cobalt and ochre bands on cream, as striped in the sketch.
  const majolicaTex = tex(512, 512, (g, s) => {
    g.fillStyle = '#f5edd8'; g.fillRect(0, 0, s, s);
    const bands = [[0, 40, '#1f4c9a'], [52, 14, '#e0a526'], [110, 34, '#1f4c9a'], [300, 34, '#1f4c9a'], [380, 14, '#e0a526'], [410, 50, '#1f4c9a'], [480, 32, '#e0a526']];
    for (const [y, h, c] of bands) { g.fillStyle = c; g.fillRect(0, y, s, h); }
    for (let i = 0; i < 8; i++) { // diamond frieze round the belly
      const x = i * 64 + 32, y = 222;
      g.fillStyle = '#e0a526'; g.beginPath(); g.moveTo(x, y - 54); g.lineTo(x + 26, y); g.lineTo(x, y + 54); g.lineTo(x - 26, y); g.fill();
      g.fillStyle = '#1f4c9a'; g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#2f7d4f'; g.beginPath(); g.arc(x + 32, y, 7, 0, Math.PI * 2); g.fill();
    }
  });

  const stripeTex = tex(64, 64, (g, s) => {
    for (let i = 0; i < 6; i++) { g.fillStyle = i % 2 ? '#f28c1e' : '#d7261e'; g.fillRect(0, i * s / 6, s, s / 6 + 1); }
  });

  // A flat-woven kilim: bands of terracotta, indigo and mustard with a row of diamonds.
  const kilimTex = tex(1024, 640, (g, w, h) => {
    g.fillStyle = '#a4472e'; g.fillRect(0, 0, w, h);
    const band = (x, bw, c) => { g.fillStyle = c; g.fillRect(x, 0, bw, h); g.fillRect(w - x - bw, 0, bw, h); };
    band(0, 34, '#efe2c4'); band(34, 26, '#27406b'); band(60, 12, '#d19a2e'); band(118, 44, '#efe2c4'); band(128, 24, '#a4472e');
    band(200, 16, '#27406b'); band(260, 70, '#d19a2e'); band(274, 42, '#7d2f25'); band(360, 14, '#efe2c4');
    for (let i = 0; i < 5; i++) {
      const y = h * (i + 0.5) / 5, x = w / 2;
      g.fillStyle = '#efe2c4'; g.beginPath(); g.moveTo(x - 110, y); g.lineTo(x, y - 56); g.lineTo(x + 110, y); g.lineTo(x, y + 56); g.fill();
      g.fillStyle = '#27406b'; g.beginPath(); g.moveTo(x - 70, y); g.lineTo(x, y - 36); g.lineTo(x + 70, y); g.lineTo(x, y + 36); g.fill();
      g.fillStyle = '#d19a2e'; g.beginPath(); g.moveTo(x - 30, y); g.lineTo(x, y - 16); g.lineTo(x + 30, y); g.lineTo(x, y + 16); g.fill();
    }
    g.strokeStyle = 'rgba(60,30,15,0.16)'; g.lineWidth = 1;   // weave
    for (let y = 0; y < h; y += 4) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  });

  // Poster: Thierry Henry, number 14, seen from behind in the red-and-white shirt.
  const posterTex = tex(768, 1024, (g, w, h) => {
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#7a0d14'); bg.addColorStop(1, '#2c0508');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 9; i++) { g.beginPath(); g.moveTo(384, 430); g.lineTo(i * 110 - 60, 0); g.lineTo(i * 110, 0); g.fill(); }
    const skin = '#7b5236';
    g.fillStyle = skin;
    g.fillRect(334, 262, 100, 90);                                                     // neck
    g.beginPath(); g.moveTo(96, 560); g.lineTo(176, 590); g.lineTo(150, 860); g.lineTo(84, 850); g.fill();   // arms
    g.beginPath(); g.moveTo(672, 560); g.lineTo(592, 590); g.lineTo(618, 860); g.lineTo(684, 850); g.fill();
    g.fillStyle = '#f4f1ea'; g.fillRect(214, 770, 340, 254);                           // shorts
    g.fillStyle = '#d7141a';                                                           // shirt body
    g.beginPath(); g.moveTo(300, 318); g.quadraticCurveTo(384, 372, 468, 318);
    g.lineTo(590, 366); g.lineTo(566, 800); g.lineTo(202, 800); g.lineTo(178, 366); g.closePath(); g.fill();
    g.fillStyle = '#f4f1ea';                                                           // white sleeves
    g.beginPath(); g.moveTo(178, 366); g.lineTo(78, 566); g.lineTo(184, 606); g.lineTo(226, 450); g.fill();
    g.beginPath(); g.moveTo(590, 366); g.lineTo(690, 566); g.lineTo(584, 606); g.lineTo(542, 450); g.fill();
    g.fillStyle = skin; g.beginPath(); g.ellipse(384, 190, 82, 100, 0, 0, Math.PI * 2); g.fill();   // head
    g.beginPath(); g.ellipse(298, 200, 14, 26, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(470, 200, 14, 26, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(30,18,12,0.55)'; g.beginPath(); g.ellipse(384, 168, 80, 78, 0, 0, Math.PI * 2); g.fill(); // cropped hair
    g.fillStyle = '#fff'; g.textAlign = 'center';
    g.font = 'bold 62px Arial, Helvetica, sans-serif'; g.fillText('HENRY', 384, 458);
    g.font = 'bold 270px Arial, Helvetica, sans-serif'; g.fillText('14', 384, 720);
    g.fillStyle = 'rgba(20,4,6,0.88)'; g.fillRect(0, 880, w, 144);
    g.fillStyle = '#fff'; g.font = 'bold 66px Georgia, serif'; g.fillText('THIERRY HENRY', 384, 950);
    g.fillStyle = '#e3b23c'; g.font = 'bold 34px Georgia, serif'; g.fillText('ARSENAL  ·  14', 384, 1000);
  });

  // Pressed-herb prints for the wall above the dresser.
  const herbTex = kind => tex(384, 512, (g, w, h) => {
    g.fillStyle = '#f4ecd8'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#5b6b34'; g.lineWidth = 4; g.lineCap = 'round';
    g.beginPath(); g.moveTo(w / 2, h - 90); g.quadraticCurveTo(w / 2 - 20, h / 2, w / 2 + 10, 70); g.stroke();
    for (let i = 0; i < 11; i++) {
      const t = i / 11, y = h - 110 - t * 320, x = w / 2 - 14 + t * 22, side = i % 2 ? 1 : -1;
      if (kind === 'olive') {
        g.fillStyle = '#6f8442'; g.save(); g.translate(x + side * 34, y - 14); g.rotate(side * -0.7); g.beginPath(); g.ellipse(0, 0, 34, 10, 0, 0, Math.PI * 2); g.fill(); g.restore();
        if (i % 3 === 0) { g.fillStyle = '#3d3a4a'; g.beginPath(); g.ellipse(x + side * 14, y + 8, 9, 12, 0, 0, Math.PI * 2); g.fill(); }
      } else if (kind === 'lavender') {
        g.strokeStyle = '#6f8442'; g.lineWidth = 3; g.beginPath(); g.moveTo(x, y + 20); g.lineTo(x + side * 50, y - 40); g.stroke();
        g.fillStyle = '#7d67b0'; for (let k = 0; k < 5; k++) { g.beginPath(); g.ellipse(x + side * (50 + k * 4), y - 40 - k * 14, 8, 10, 0, 0, Math.PI * 2); g.fill(); }
      } else {
        g.strokeStyle = '#4f6a3a'; g.lineWidth = 4;
        for (const sgn of [-1, 1]) { g.beginPath(); g.moveTo(x, y); g.lineTo(x + sgn * 30, y - 22); g.stroke(); }
      }
    }
    g.fillStyle = '#6a5a44'; g.font = 'italic 26px Georgia, serif'; g.textAlign = 'center';
    g.fillText({ olive: 'Olea europaea', lavender: 'Lavandula', rosemary: 'Rosmarinus' }[kind], w / 2, h - 36);
  });

  // A small oil of the hills at noon, for over the sofa.
  const paintingTex = tex(768, 512, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h * 0.6);
    sky.addColorStop(0, '#7fb4dc'); sky.addColorStop(1, '#f1e4c2');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    [['#9db39a', 0.5, 20, 1.1], ['#b9b266', 0.62, 26, 2.3], ['#8a9a45', 0.78, 22, 4.2]].forEach(([c, base, amp, ph], n) => {
      const ridge = x => h * base + amp * Math.sin(x / w * 6 + ph);
      g.fillStyle = c; g.beginPath(); g.moveTo(0, h); for (let x = 0; x <= w; x += 8) g.lineTo(x, ridge(x)); g.lineTo(w, h); g.fill();
      for (let i = 0; i < 6; i++) {
        const x = rand() * w, th = 30 + n * 18 + rand() * 20;
        g.fillStyle = '#34503a'; g.beginPath(); g.ellipse(x, ridge(x) - th * 0.45, th * 0.14, th * 0.55, 0, 0, Math.PI * 2); g.fill();
      }
      if (n === 1) { const y = ridge(520); g.fillStyle = '#e6c487'; g.fillRect(480, y - 44, 84, 46); g.fillStyle = '#b5532f'; g.beginPath(); g.moveTo(470, y - 44); g.lineTo(522, y - 72); g.lineTo(574, y - 44); g.fill(); }
    });
  });

  // The view outside: a full 360-degree dawn over the hills. u = 0.5 is due east.
  const sunU = Math.atan2(sunDir.x, sunDir.z) / (Math.PI * 2);
  const skyTex = tex(8192, 1024, (g, w, h) => {
    const horizon = h * 0.55, sx = (sunU < 0 ? sunU + 1 : sunU) * w;
    const sky = g.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#263a78'); sky.addColorStop(0.45, '#6477b4'); sky.addColorStop(0.78, '#e59c92'); sky.addColorStop(1, '#ffd9a2');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    // the glow of the low sun, spread wide along the horizon
    g.save(); g.translate(sx, horizon - 40); g.scale(1, 0.24);
    const glow = g.createRadialGradient(0, 0, 0, 0, 0, 2600);
    glow.addColorStop(0, 'rgba(255,214,140,0.95)'); glow.addColorStop(0.35, 'rgba(255,160,100,0.55)'); glow.addColorStop(1, 'rgba(255,140,110,0)');
    g.fillStyle = glow; g.fillRect(-2600, -2600, 5200, 5200); g.restore();
    const halo = g.createRadialGradient(sx, h * 0.167, 0, sx, h * 0.167, 620);
    halo.addColorStop(0, 'rgba(255,246,214,1)'); halo.addColorStop(0.12, 'rgba(255,224,160,0.8)'); halo.addColorStop(1, 'rgba(255,200,140,0)');
    g.fillStyle = halo; g.fillRect(sx - 620, 0, 1240, horizon);
    // streaks of cloud, lit pink and gold near the sun
    for (let i = 0; i < 70; i++) {
      const x = rand() * w, y = 110 + rand() * 330, cw = 220 + rand() * 620, ch = 9 + rand() * 20;
      const near = Math.max(0, 1 - Math.abs(x - sx) / 2200);
      g.fillStyle = `rgba(${180 + 75 * near | 0},${150 + 50 * near | 0},${185 - 40 * near | 0},${0.22 + 0.3 * near})`;
      for (const ox of [-w, 0, w]) { g.beginPath(); g.ellipse(x + ox, y, cw / 2, ch, 0, 0, Math.PI * 2); g.fill(); }
    }
    const layers = [['#8791b8', 0.52, 26, 3, 7], ['#7f9c97', 0.58, 32, 4, 9], ['#93a273', 0.65, 38, 5, 11], ['#a89c5a', 0.73, 30, 4, 13], ['#617639', 0.82, 34, 6, 15]];
    layers.forEach(([color, base, amp, k1, k2], n) => {
      const p1 = rand() * 6, p2 = rand() * 6;   // whole numbers of waves, so the panorama closes on itself
      const ridge = x => h * base + amp * Math.sin(x / w * Math.PI * 2 * k1 + p1) + amp * 0.5 * Math.sin(x / w * Math.PI * 2 * k2 + p2);
      g.fillStyle = color;
      g.beginPath(); g.moveTo(0, h);
      for (let x = 0; x <= w; x += 8) g.lineTo(x, ridge(x));
      g.lineTo(w, h); g.fill();
      if (n >= 1) for (let i = 0; i < 60; i++) {         // cypresses along each ridge
        const x = rand() * w, th = (18 + rand() * 26) * (0.6 + n * 0.35);
        g.fillStyle = n < 3 ? '#4a6557' : '#2c4630';
        g.beginPath(); g.ellipse(x, ridge(x) - th * 0.45, th * 0.14, th * 0.55, 0, 0, Math.PI * 2); g.fill();
      }
      if (n === 2) for (let i = 0; i < 7; i++) {         // farmhouses, a lamp already lit in each
        const fx = (i + 0.35 + rand() * 0.3) * w / 7, y = ridge(fx);
        g.fillStyle = '#e2bd86'; g.fillRect(fx - 46, y - 50, 92, 52);
        g.fillStyle = '#a94e2e'; g.beginPath(); g.moveTo(fx - 56, y - 50); g.lineTo(fx, y - 80); g.lineTo(fx + 56, y - 50); g.fill();
        g.fillStyle = '#ffd77a'; for (const dx of [-26, 14]) g.fillRect(fx + dx, y - 36, 12, 16);
      }
      if (n === 4) {                                      // vineyard rows in the foreground
        g.strokeStyle = 'rgba(44,66,30,0.55)'; g.lineWidth = 5;
        for (let x = -200; x < w + 200; x += 46) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 90, h * 0.83); g.stroke(); }
      }
      if (n < 4) {                                        // morning mist pooled in each valley
        const mist = g.createLinearGradient(0, h * base - 10, 0, h * base + 110);
        mist.addColorStop(0, 'rgba(255,226,206,0)'); mist.addColorStop(0.55, 'rgba(255,226,206,0.5)'); mist.addColorStop(1, 'rgba(255,226,206,0)');
        g.fillStyle = mist; g.fillRect(0, h * base - 10, w, 120);
      }
    });
    const warm = g.createRadialGradient(sx, horizon, 0, sx, horizon, 1800);   // hills facing the sun warm up
    warm.addColorStop(0, 'rgba(255,170,90,0.3)'); warm.addColorStop(1, 'rgba(255,170,90,0)');
    g.fillStyle = warm; g.fillRect(sx - 1800, horizon - 100, 3600, h);
  });

  // ---------- shared materials ----------
  const walnut = mat(0xffffff, woodTex('#6a4226', '#2c180b'));
  const walnutPanel = mat(0xffffff, woodTex('#5a361e', '#241308'));
  const chestnut = mat(0xffffff, woodTex('#a67440', '#5d3a18', 2));
  const frameWood = mat(0xffffff, woodTex('#7a5230', '#3a2210'));
  const iron = mat(0x1f1d1b, null, { metalness: 0.7, roughness: 0.45 });
  const brass = mat(0xb8913f, null, { metalness: 0.8, roughness: 0.35 });
  const terracotta = mat(0xb9623a);
  const stone = mat(0xe6dcc4, null, { roughness: 0.95 });
  const cream = mat(0xf7f2e6);
  const leafGreen = mat(0x4d7a3a);
  const darkLeaf = mat(0x2f5a2c);
  const ceramic = mat(0xffffff, majolicaTex, { roughness: 0.25 });
  // Bevelled panes use real transmission, so the view outside bends at the bevels.
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 1, roughness: 0.02, ior: 1.52, thickness: 0.06, specularIntensity: 1 });

  // ---------- sunrise lighting ----------
  scene.background = new THREE.Color(0x10141f);
  scene.add(new THREE.HemisphereLight(0x9db2e8, 0x6b4a34, 0.5));     // cool dawn sky, warm bounce off the floor

  const sun = new THREE.DirectionalLight(0xffa45c, 6);
  sun.target.position.set(0, 1.1, 0);
  sun.position.copy(sunDir).multiplyScalar(8).add(sun.target.position);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 2.5;
  Object.assign(sun.shadow.camera, { left: -2.5, right: 2.5, top: 2.3, bottom: -2.3, near: 0.5, far: 16 });
  scene.add(sun, sun.target);

  // light bounced off the sunlit bed and floor back into the room
  const bounce = new THREE.PointLight(0xffb98a, 1.6, 6, 2);
  bounce.position.set(0.5, 0.9, 0.2);
  scene.add(bounce);

  // A soft procedural dawn for image-based fill and for reflections in glass, glaze and brass.
  {
    const pmrem = new THREE.PMREMGenerator(renderer), env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { sd: { value: sunDir } },
      vertexShader: 'varying vec3 d; void main(){ d = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: `varying vec3 d; uniform vec3 sd;
        void main(){ vec3 n = normalize(d);
          vec3 c = mix(vec3(.50,.36,.30), vec3(.14,.20,.42), smoothstep(-.05,.6,n.y));
          c = mix(vec3(.16,.10,.07), c, smoothstep(-.35,.0,n.y));
          float s = max(dot(n, sd), 0.);
          c += vec3(3.,1.5,.6) * pow(s, 8.) + vec3(.9,.45,.22) * pow(s, 2.);
          gl_FragColor = vec4(c, 1.); }`,
    })));
    scene.environment = pmrem.fromScene(env, 0.03).texture;
    scene.environmentIntensity = 0.55;
    pmrem.dispose();
  }

  // ---------- room shell ----------
  const floor = add(new THREE.PlaneGeometry(W, D), mat(0xffffff, floorTex, { roughness: 0.7 }), 0, 0, 0);
  floor.rotation.x = -Math.PI / 2;
  floor.castShadow = false;
  box(W + 0.24, 0.3, D + 0.24, mat(0x241f1c), 0, -0.152, 0).castShadow = false;   // the slab the room stands on

  // Walls and ceiling are single inward-facing sheets: they vanish when seen from
  // behind, yet still block the sun, so light only enters through the windows.
  const wallMat = mat(0xffffff, stuccoTex, { roughness: 1, shadowSide: THREE.DoubleSide });
  function wall(width, openings, x, z, rotY) {
    const s = new THREE.Shape();
    s.moveTo(-width / 2, 0); s.lineTo(width / 2, 0); s.lineTo(width / 2, H); s.lineTo(-width / 2, H); s.closePath();
    for (const [a, b] of openings) {
      const hole = new THREE.Path();
      hole.moveTo(a, Y0); hole.lineTo(a, Y1); hole.lineTo(b, Y1); hole.lineTo(b, Y0); hole.closePath();
      s.holes.push(hole);
    }
    const m = add(new THREE.ShapeGeometry(s), wallMat, x, 0, z);
    m.rotation.y = rotY;
  }
  wall(W, [[X(220), X(610)], [X(920), X(1290)]], 0, -D / 2, 0);   // east: two windows
  wall(D, [[Z(420), Z(770)]], W / 2, 0, -Math.PI / 2);             // south: one window
  wall(D, [], -W / 2, 0, Math.PI / 2);                             // north
  wall(W, [], 0, D / 2, Math.PI);                                  // west
  const ceiling = add(new THREE.PlaneGeometry(W, D), mat(0xf6ecd6, null, { roughness: 1, shadowSide: THREE.DoubleSide }), 0, H, 0);
  ceiling.rotation.x = Math.PI / 2;

  // ---------- the view outside ----------
  // Drawn only where a window opening is on screen (stencil), so it never shows
  // around or above the walls.
  const portalMat = new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false, stencilWrite: true, stencilRef: 1,
    stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
  });
  const throughWindows = { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc };
  const outside = new THREE.Group();
  outside.renderOrder = -1;
  scene.add(outside);
  hideFromAO.push(outside);
  {
    const eye = 1.4, R = 20, tall = 14, y0 = eye - tall * 0.45;       // horizon at eye level
    const pano = new THREE.Mesh(new THREE.CylinderGeometry(R, R, tall, 96, 1, true),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, ...throughWindows }));
    pano.material.color.setScalar(1.3);                               // a little over white, so the horizon blooms
    pano.position.y = y0 + tall / 2;
    pano.renderOrder = -1;
    const ground = new THREE.Mesh(new THREE.CircleGeometry(R, 64), new THREE.MeshBasicMaterial({ color: 0x617639, ...throughWindows }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = y0;
    ground.renderOrder = -1;
    const flat2 = Math.hypot(sunDir.x, sunDir.z);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.42, 40), new THREE.MeshBasicMaterial({ ...throughWindows }));
    disc.material.color.setRGB(14, 9, 3.5);                           // far over white: the sun itself
    disc.position.set(0, eye, 0).addScaledVector(sunDir, (R - 1) / flat2);
    disc.lookAt(0, eye, 0);
    disc.renderOrder = -1;
    outside.add(pano, ground, disc);
  }

  // ---------- windows ----------
  function paneGeo(pw, ph) {
    const b = 0.022, a = pw / 2 - b, c = ph / 2 - b, s = new THREE.Shape();
    s.moveTo(-a, -c); s.lineTo(a, -c); s.lineTo(a, c); s.lineTo(-a, c); s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.004, bevelEnabled: true, bevelSize: b, bevelThickness: 0.007, bevelSegments: 1 });
    geo.translate(0, 0, -0.002);
    return geo;
  }

  // A two-leaf wooden casement, three bevelled panes per leaf, with a handle on each leaf.
  function casement(w, h, parent) {
    const f = 0.05, st = 0.045, mu = 0.024;
    for (const s of [-1, 1]) {
      box(w, f, 0.07, frameWood, 0, s * (h - f) / 2, 0, parent);
      box(f, h - 2 * f, 0.07, frameWood, s * (w - f) / 2, 0, 0, parent);
    }
    const iw = w - 2 * f, ih = h - 2 * f, lw = iw / 2;
    const pw = lw - 2 * st, ph = (ih - 2 * st - 2 * mu) / 3;
    const geo = paneGeo(pw, ph);
    for (const s of [-1, 1]) {
      const leaf = group(s * lw / 2, 0, 0.012, 0, parent);
      for (const t of [-1, 1]) {
        box(st, ih, 0.045, frameWood, t * (lw - st) / 2, 0, 0, leaf);
        box(pw, st, 0.045, frameWood, 0, t * (ih - st) / 2, 0, leaf);
      }
      for (let i = -1; i <= 1; i++) {
        const pane = new THREE.Mesh(geo, glass);
        pane.position.y = i * (ph + mu);
        leaf.add(pane);
        hideFromAO.push(pane);
        if (i < 1) box(pw, mu, 0.035, frameWood, 0, (i + 0.5) * (ph + mu), 0, leaf);
      }
      // handle: iron plate fixed to the stile, a short stem, then the brass knob
      const hx = -s * (lw - st) / 2, face = 0.0225;
      box(0.026, 0.15, 0.008, iron, hx, -0.05, face + 0.004, leaf);
      cyl(0.006, 0.006, 0.035, iron, hx, -0.05, face + 0.0255, leaf).rotation.x = Math.PI / 2;
      ball(0.019, brass, hx, -0.05, face + 0.053, leaf, 1, 1, 0.8);
    }
  }

  function curtain(width, height, material) {
    const geo = new THREE.PlaneGeometry(width, height, 80, 1), p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, 0.028 * Math.sin(p.getX(i) / width * Math.PI * 9));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, material);
    m.castShadow = m.receiveShadow = true;
    return m;
  }

  // A window set `depth` metres into the wall, with an iron rod and a pair of curtains.
  function windowUnit(w, depth, x, z, rotY, curtainMat, curtainBottom) {
    const h = Y1 - Y0, g = group(x, (Y0 + Y1) / 2, z, rotY);
    const portal = new THREE.Mesh(new THREE.PlaneGeometry(w, h), portalMat);
    portal.renderOrder = -2;
    g.add(portal);
    hideFromAO.push(portal);
    // the reveal: plaster cheeks and head, a stone sill
    const plaster = mat(0xffffff, stuccoTex, { roughness: 1, shadowSide: THREE.DoubleSide });
    const sillStone = mat(0xe6dcc4, null, { roughness: 0.9, shadowSide: THREE.DoubleSide });
    for (const s of [-1, 1]) {
      const cheek = add(new THREE.PlaneGeometry(depth, h), plaster, s * w / 2, 0, -depth / 2, g);
      cheek.rotation.y = -s * Math.PI / 2;
      const lid = add(new THREE.PlaneGeometry(w, depth), s < 0 ? sillStone : plaster, 0, s * h / 2, -depth / 2, g);
      lid.rotation.x = s * Math.PI / 2;
    }
    box(w + 0.1, 0.035, 0.06, stone, 0, -h / 2 - 0.0175, 0.03, g);          // sill nosing
    casement(w, h, group(0, 0, -depth + 0.035, 0, g));

    const rodY = h / 2 + 0.12, rodLen = w + 0.56, yb = curtainBottom - (Y0 + Y1) / 2;
    cyl(0.011, 0.011, rodLen, iron, 0, rodY, 0.09, g).rotation.z = Math.PI / 2;
    for (const s of [-1, 1]) {
      ball(0.024, iron, s * rodLen / 2, rodY, 0.09, g);
      box(0.012, 0.012, 0.09, iron, s * (w / 2 + 0.2), rodY, 0.045, g);
      const c = curtain(0.32, rodY - yb, curtainMat);
      c.position.set(s * (w / 2 + 0.09), (rodY + yb) / 2, 0.09);
      g.add(c);
    }
    return g;
  }

  const linen = mat(0xffffff, linenTex('#f3e6c8', '#b89f6e', 3, 10), { side: THREE.DoubleSide });
  const plaid = mat(0xffffff, plaidTex('#f1e3c4', '#b5562f', '#6f7f3f', 2.5, 9), { side: THREE.DoubleSide });
  const DEEP = 0.42;                                                           // east windows sit deep in the wall
  const eastWindows = [[220, 610, 1.09], [920, 1290, 0.62]];                   // [plan x0, plan x1, curtain hem]
  for (const [a, b, hem] of eastWindows) windowUnit((b - a) * S, DEEP, X((a + b) / 2), -D / 2, 0, linen, hem);
  windowUnit(350 * S, 0.12, W / 2, Z(595), -Math.PI / 2, plaid, 0.62);         // south, behind the pillow

  // Shafts of sunlight hanging in the air, one per east window.
  {
    const reach = new THREE.Vector3().copy(sunDir).multiplyScalar(D / sunDir.z);   // wall-to-wall along the light
    const shaftMat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    shaftMat.color.setRGB(0.075, 0.042, 0.02);
    for (const [a, b] of eastWindows) {
      const x0 = X(a) + 0.07, x1 = X(b) - 0.07, xm = (x0 + x1) / 2, ym = (Y0 + Y1) / 2, z = -D / 2 + 0.01;
      const quads = [                                       // four sides plus two sheets through the middle
        [[x0, Y0], [x1, Y0]], [[x0, Y1], [x1, Y1]], [[x0, Y0], [x0, Y1]], [[x1, Y0], [x1, Y1]],
        [[xm, Y0], [xm, Y1]], [[x0, ym], [x1, ym]],
      ];
      const pos = [], col = [];
      for (const [[ax, ay], [bx, by]] of quads) {
        const n0 = [ax, ay, z], n1 = [bx, by, z];
        const f0 = [ax + reach.x, ay + reach.y, z + reach.z], f1 = [bx + reach.x, by + reach.y, z + reach.z];
        pos.push(...n0, ...n1, ...f1, ...n0, ...f1, ...f0);
        col.push(1, 1, 1, 1, 1, 1, 0.15, 0.15, 0.15, 1, 1, 1, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15);   // fades with distance
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const shaft = new THREE.Mesh(geo, shaftMat);
      scene.add(shaft);
      hideFromAO.push(shaft);
    }
  }

  // ---------- large majolica vase of flowers on the deep sill above the bed ----------
  {
    const g = group(X(1105) + 0.1, Y0, -D / 2 - 0.2);
    const profile = [[0.07, 0], [0.11, 0.03], [0.155, 0.14], [0.165, 0.24], [0.135, 0.36], [0.08, 0.44], [0.072, 0.47], [0.095, 0.5]]
      .map(([r, y]) => new THREE.Vector2(r, y));
    add(new THREE.LatheGeometry(profile, 64), mat(0xffffff, majolicaTex, { roughness: 0.25, side: THREE.DoubleSide }), 0, 0, 0, g);
    const stemMat = mat(0x4c7a34), up = new THREE.Vector3(0, 1, 0), from = new THREE.Vector3(0, 0.46, 0);
    const stemTo = (x, y, z) => {
      const d = new THREE.Vector3(x, y, z).sub(from);
      const st = cyl(0.006, 0.006, d.length(), stemMat, 0, 0, 0, g);
      st.position.copy(from).addScaledVector(d, 0.5);
      st.quaternion.setFromUnitVectors(up, d.normalize());
      return st.quaternion;
    };
    // sunflowers, poppies and roses
    [[-0.16, 0.74, 0.1, 'sun'], [0.02, 0.86, 0.12, 'sun'], [0.17, 0.72, 0.09, 'poppy'], [-0.06, 0.66, 0.16, 'rose'], [0.1, 0.62, 0.17, 'poppy'], [-0.2, 0.6, 0.02, 'rose']]
      .forEach(([x, y, z, kind]) => {
        stemTo(x, y, z);
        const head = group(x, y, z, 0, g);
        head.lookAt(g.localToWorld(new THREE.Vector3(x * 2.2, y + 0.25, z + 1)));
        if (kind === 'sun') {
          for (let i = 0; i < 14; i++) {
            const a = i * Math.PI * 2 / 14;
            ball(1, mat(0xf2b81c), Math.cos(a) * 0.06, Math.sin(a) * 0.06, 0, head, 0.03, 0.012, 0.004).rotation.z = a;
          }
          ball(1, mat(0x4a2d14), 0, 0, 0.004, head, 0.042, 0.042, 0.014);
        } else {
          const c = mat(kind === 'poppy' ? 0xd3311f : 0xe58aa0);
          for (let i = 0; i < 6; i++) {
            const a = i * Math.PI / 3;
            ball(1, c, Math.cos(a) * 0.03, Math.sin(a) * 0.03, 0, head, 0.036, 0.036, 0.016);
          }
          ball(0.018, mat(kind === 'poppy' ? 0x221a14 : 0xf6d36a), 0, 0, 0.014, head);
        }
      });
    // tall feathery fronds, as drawn
    const leaflets = [], scale = new THREE.Vector3(0.004, 0.035, 0.012);
    [[-0.1, 1.12, -0.02], [0.14, 1.2, 0.0], [0.26, 1.05, 0.04], [-0.3, 0.8, 0.08]].forEach(([x, y, z]) => {
      const q = stemTo(x, y, z);
      for (let i = 3; i < 16; i++) for (const s of [-1, 1]) {
        const t = i / 16, side = new THREE.Vector3(s * 0.03, 0.012, 0).applyQuaternion(q);
        const p = new THREE.Vector3(x * t, 0.46 + (y - 0.46) * t, z * t).add(side);
        const r = q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -s)));
        leaflets.push(new THREE.Matrix4().compose(p, r, scale));
      }
    });
    scatter(new THREE.SphereGeometry(1, 8, 6), leafGreen, leaflets, g);
  }

  // ---------- bed: long side on the east wall, head at the south wall ----------
  {
    const x0 = X(850), x1 = X(1640), z0 = -D / 2 + 0.02, z1 = Z(800);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const lx = cx + sx * (w / 2 - 0.1), lz = cz + sz * (d / 2 - 0.1);
      cyl(0.055, 0.03, 0.14, walnut, lx, 0.07, lz);               // turned legs
      ball(0.05, walnut, lx, 0.16, lz, scene, 1, 0.7, 1);
    }
    slab(w - 0.04, 0.14, d - 0.04, 0.08, [walnut, walnut], cx, 0.2, cz);                              // wooden base
    slab(w, 0.2, d, 0.12, [cream, mat(0xffffff, stitchTex)], cx, 0.34, cz);                           // mattress
    slab(w + 0.02, 0.05, d + 0.02, 0.13, [mat(0xffffff, quiltTex), mat(0xf6efdf)], cx, 0.54, cz);     // quilt
    const top = 0.59;
    const pillow = add(new THREE.SphereGeometry(1, 48, 32), mat(0xffffff, plaidTex('#7d2f25', '#3f1712', '#e6c487', 5, 4)), X(1540), top + 0.07, Z(560));
    pillow.scale.set(0.24, 0.085, 0.4);

    // a chunky knitted throw across the foot of the bed, spilling over the side
    const knit = mat(0xffffff, knitTex('#c98a35', '#e0a850', '#9a6420', 6, 14));
    const knitFall = mat(0xffffff, knitTex('#c98a35', '#e0a850', '#9a6420', 6, 4));
    box(0.52, 0.03, d + 0.05, knit, x0 + 0.42, top + 0.012, cz);
    box(0.52, 0.34, 0.03, knitFall, x0 + 0.42, top - 0.14, z1 + 0.026);

    // stuffed pink hippo beside the pillow, legs in red-and-orange stripes
    const pink = mat(0xf2a0b8), pale = mat(0xf8c3d2), dark = mat(0x2a1a20), socks = mat(0xffffff, stripeTex);
    const hippo = group(X(1385), top, Z(440), -0.65);
    ball(1, pink, 0, 0.12, -0.08, hippo, 0.13, 0.115, 0.19);        // body
    ball(1, pink, 0, 0.14, 0.15, hippo, 0.1, 0.095, 0.12);          // head
    ball(1, pale, 0, 0.11, 0.26, hippo, 0.115, 0.085, 0.1);         // snout
    ball(0.02, pink, 0, 0.14, -0.27, hippo);                        // tail
    for (const sx of [-1, 1]) {
      ball(0.028, pink, sx * 0.07, 0.23, 0.1, hippo);               // ears
      ball(0.024, cream, sx * 0.045, 0.225, 0.19, hippo);           // eyes sit on top of the head
      ball(0.012, dark, sx * 0.045, 0.232, 0.208, hippo);
      ball(0.012, dark, sx * 0.04, 0.16, 0.345, hippo);             // nostrils
      for (const [z, splay] of [[0.1, 0.5], [-0.2, 2.4]]) {         // four striped legs, lying flat
        const leg = add(new THREE.CapsuleGeometry(0.04, 0.1, 12, 24), socks, sx * 0.15, 0.042, z, hippo);
        leg.rotation.set(Math.PI / 2, 0, -sx * splay);
      }
    }
  }

  // ---------- pictures ----------
  const frameDark = mat(0x2a1a10), frameGilt = mat(0xa8843c, null, { metalness: 0.6, roughness: 0.45 });
  function picture(map, w, h, border, frameMat, parent) {
    flat(w + border * 2, h + border * 2, frameMat, 0, 0, 0, parent);
    flat(w, h, new THREE.MeshStandardMaterial({ map, roughness: 0.6 }), 0, 0, 0.003, parent);
  }
  picture(posterTex, 0.5, 0.667, 0.015, frameDark, group(X(1520), 1.75, -D / 2 + 0.004));             // Thierry Henry, east wall
  ['olive', 'lavender', 'rosemary'].forEach((kind, i) =>                                              // herbs above the dresser
    picture(herbTex(kind), 0.24, 0.32, 0.022, frameDark, group(X(1010 + i * 120), 1.5, D / 2 - 0.004, Math.PI)));
  picture(paintingTex, 0.66, 0.44, 0.04, frameGilt, group(-W / 2 + 0.004, 1.6, Z(910), Math.PI / 2));  // hills, over the sofa

  // ---------- lamps (both lit: it is early) ----------
  function shade(rTop, rBottom, h, y, parent, map) {
    const m = add(new THREE.CylinderGeometry(rTop, rBottom, h, 48, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xfff1c4, map, emissive: 0xffb866, emissiveMap: map, emissiveIntensity: 1.5, side: THREE.DoubleSide }),
      0, y, 0, parent);
    m.castShadow = false;
    return m;
  }
  const lampLight = (x, y, z, power) => {
    const l = new THREE.PointLight(0xffac5e, power, 5, 2);
    l.position.set(x, y, z);
    scene.add(l);
  };
  { // wrought-iron floor lamp with a woven shade, between the desk and the bed
    const g = group(X(735), 0, Z(440));
    cyl(0.04, 0.14, 0.05, iron, 0, 0.025, 0, g);
    cyl(0.014, 0.014, 1.42, iron, 0, 0.75, 0, g);
    for (const y of [0.12, 0.7, 1.3]) ball(0.03, iron, 0, y, 0, g, 1, 0.7, 1);
    shade(0.11, 0.22, 0.5, 1.62, g, wovenTex(8, 3));
    lampLight(X(735), 1.5, Z(440), 2.2);
  }

  // ---------- rustic chests: walnut, raised drawer fronts, iron ring pulls ----------
  // Built with the drawers on local +z; the group is then turned to face the room.
  function chest(w, h, d, rows, cols, x, z, rotY) {
    const g = group(x, 0, z, rotY), foot = 0.06, bodyH = h - foot - 0.03;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) ball(0.04, walnut, sx * (w / 2 - 0.05), 0.035, sz * (d / 2 - 0.05), g, 1, 0.9, 1);
    box(w, bodyH, d, walnut, 0, foot + bodyH / 2, 0, g);
    box(w + 0.05, 0.03, d + 0.05, walnut, 0, h - 0.015, 0, g);
    const cw = w / cols, rh = bodyH / rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const dx = (c + 0.5) * cw - w / 2, dy = foot + (r + 0.5) * rh;
      box(cw - 0.03, rh - 0.03, 0.016, walnutPanel, dx, dy, d / 2 + 0.008, g);
      box(cw - 0.1, rh - 0.09, 0.01, walnut, dx, dy, d / 2 + 0.02, g);
      ball(0.009, iron, dx, dy + 0.012, d / 2 + 0.03, g);
      add(new THREE.TorusGeometry(0.022, 0.0045, 10, 28), iron, dx, dy - 0.012, d / 2 + 0.032, g);
    }
    return g;
  }
  const book = (w, h, d, color, x, y, z, rotY, parent) => {
    const b = group(x, y, z, rotY, parent);
    box(w, h, d, mat(color), 0, h / 2, 0, b);
    box(w - 0.012, h - 0.012, d - 0.006, cream, 0.004, h / 2, 0, b);   // page block, proud of the cover on three sides
    return b;
  };
  function candle(x, y, z, tall) {
    const g = group(x, y, z);
    cyl(0.04, 0.05, 0.012, brass, 0, 0.006, 0, g);
    cyl(0.012, 0.02, 0.03, brass, 0, 0.027, 0, g);
    cyl(0.017, 0.017, tall, mat(0xf3e7cf, null, { emissive: 0xffa040, emissiveIntensity: 0.25 }), 0, 0.042 + tall / 2, 0, g);
    const flame = ball(1, new THREE.MeshBasicMaterial(), 0, 0.042 + tall + 0.022, 0, g, 0.007, 0.018, 0.007);
    flame.material.color.setRGB(9, 4, 1);
    flame.castShadow = false;
  }
  { // "drawer" against the west wall, drawers facing east into the room
    const x0 = X(880), x1 = X(1380), z0 = Z(1050), z1 = D / 2 - 0.03, top = 0.85;
    chest(x1 - x0, top, z1 - z0, 3, 2, (x0 + x1) / 2, (z0 + z1) / 2, Math.PI);
    // on top: a bowl of lemons, two candles, a couple of books
    const bowl = group(X(1130), top, Z(1195));
    const rim = [[0.05, 0], [0.07, 0.012], [0.13, 0.05], [0.16, 0.09], [0.165, 0.1]].map(([r, y]) => new THREE.Vector2(r, y));
    add(new THREE.LatheGeometry(rim, 48), mat(0xffffff, majolicaTex, { roughness: 0.25, side: THREE.DoubleSide }), 0, 0, 0, bowl);
    const lemon = mat(0xf3d23a, null, { roughness: 0.5 });
    [[0, 0.07, 0], [0.07, 0.075, 0.02], [-0.06, 0.075, 0.04], [0.01, 0.075, -0.07], [0.02, 0.12, 0.01]].forEach(([x, y, z], i) =>
      ball(0.04, lemon, x, y, z, bowl, 1.25, 1, 1).rotation.y = i * 1.3);
    candle(X(960), top, Z(1170), 0.15);
    candle(X(1005), top, Z(1235), 0.1);
    book(0.16, 0.03, 0.22, 0x2f4f6b, X(1300), top, Z(1190), 0.3);
    book(0.15, 0.026, 0.21, 0x8a3b2a, X(1302), top + 0.03, Z(1192), 0.12);
  }
  { // "small counter" by the bed head, against the south wall, with book and lamp
    const x0 = X(1450), x1 = W / 2 - 0.03, z0 = Z(880), z1 = Z(1100), h = 0.55;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const g = chest(z1 - z0, h, x1 - x0, 2, 1, cx, cz, -Math.PI / 2);
    book(0.2, 0.035, 0.27, 0x7a2a22, -0.13, h, 0.12, 0.25, g);
    // after the quarter turn, local x runs west and local z runs north
    const lamp = group(Z(1000) - cz, h, -(X(1590) - cx), 0, g);
    ball(1, ceramic, 0, 0.09, 0, lamp, 0.07, 0.09, 0.07);
    cyl(0.02, 0.03, 0.06, brass, 0, 0.2, 0, lamp);
    cyl(0.05, 0.06, 0.012, brass, 0, 0.006, 0, lamp);
    shade(0.07, 0.16, 0.24, 0.34, lamp, linenTex('#f6ecd2', '#c4ad7c', 6, 2));
    lampLight(X(1590), h + 0.3, Z(1000), 1.3);
  }

  // ---------- plants ----------
  function pot(g, r, h) {
    cyl(r, r * 0.72, h, terracotta, 0, h / 2, 0, g);
    add(new THREE.TorusGeometry(r, r * 0.11, 10, 36), terracotta, 0, h, 0, g).rotation.x = Math.PI / 2;
    cyl(r * 0.94, r * 0.94, 0.01, mat(0x3b2a1c), 0, h - 0.01, 0, g);
  }
  { // tall lemon tree in the south-west corner
    const g = group(X(1545), 0, Z(1225));
    pot(g, 0.2, 0.38);
    cyl(0.018, 0.03, 0.95, mat(0x6b5236), 0, 0.38 + 0.475, 0, g);
    const cy = 1.6, lemon = mat(0xf3d23a, null, { roughness: 0.5 });
    ball(1, darkLeaf, 0, cy, 0, g, 0.24, 0.34, 0.24);
    const leaves = [[], []], size = new THREE.Vector3(0.035, 0.007, 0.075);
    for (let i = 0; i < 170; i++) {
      const u = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      const p = new THREE.Vector3(r * Math.cos(a) * 0.28, cy + u * 0.38, r * Math.sin(a) * 0.28);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3));
      leaves[i % 3 ? 0 : 1].push(new THREE.Matrix4().compose(p, q, size));
    }
    const leafGeo = new THREE.SphereGeometry(1, 8, 6);
    scatter(leafGeo, leafGreen, leaves[0], g);
    scatter(leafGeo, darkLeaf, leaves[1], g);
    for (let i = 0; i < 10; i++) {
      const u = rand() * 1.4 - 0.9, a = rand() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      ball(0.034, lemon, r * Math.cos(a) * 0.3, cy + u * 0.38, r * Math.sin(a) * 0.3, g, 1, 1.25, 1);
    }
  }

  // ---------- stand-up desk in the north-east corner: thick chestnut top on trestle slabs ----------
  {
    const x0 = X(100), x1 = X(590), z0 = Z(310), z1 = Z(590);
    const w = x1 - x0, d = z1 - z0, top = 1.05, surface = top + 0.025;
    const g = group((x0 + x1) / 2, 0, (z0 + z1) / 2);
    box(w, 0.05, d, chestnut, 0, top, 0, g);
    for (const sx of [-1, 1]) {
      box(0.06, top - 0.025, d * 0.55, walnut, sx * (w / 2 - 0.14), (top - 0.025) / 2, 0, g);
      box(0.1, 0.04, d * 0.9, walnut, sx * (w / 2 - 0.14), 0.02, 0, g);
    }
    box(w - 0.28, 0.08, 0.04, walnut, 0, 0.35, 0, g);   // stretcher

    // small plant on the back corner
    const plant = group(X(530), surface, Z(355));
    pot(plant, 0.05, 0.085);
    const blades = [];
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI * 2 / 12, tilt = i % 2 ? 0.7 : 0.3, len = i % 2 ? 0.16 : 0.2;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, a, -tilt, 'YXZ'));
      const p = new THREE.Vector3(Math.sin(tilt) * len / 2, Math.cos(tilt) * len / 2, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
      p.y += 0.085;
      blades.push(new THREE.Matrix4().compose(p, q, new THREE.Vector3(len * 0.12, len / 2, len * 0.04)));
    }
    scatter(new THREE.SphereGeometry(1, 10, 8), leafGreen, blades, plant);

    // a morning's work left out: books, an open notebook, an espresso
    book(0.17, 0.035, 0.24, 0x3d5a3a, X(185), surface, Z(385), 0.15);
    book(0.16, 0.03, 0.22, 0xb9623a, X(188), surface + 0.035, Z(383), -0.1);
    book(0.14, 0.025, 0.2, 0xd8b45a, X(184), surface + 0.065, Z(386), 0.35);
    const note = group(X(330), surface, Z(480), 0.12);
    for (const s of [-1, 1]) box(0.15, 0.008, 0.21, cream, s * 0.076, 0.004, 0, note);
    cyl(0.004, 0.004, 0.17, mat(0xd8a020), 0.03, 0.013, 0.02, note).rotation.set(Math.PI / 2, 0, 0.5);
    const cup = group(X(455), surface, Z(520));
    cyl(0.06, 0.045, 0.01, cream, 0, 0.005, 0, cup);
    cyl(0.034, 0.024, 0.05, cream, 0, 0.035, 0, cup);
    cyl(0.029, 0.029, 0.004, mat(0x2a1608, null, { roughness: 0.3 }), 0, 0.058, 0, cup);
    add(new THREE.TorusGeometry(0.017, 0.005, 8, 20), cream, 0.04, 0.036, 0, cup);
  }

  // ---------- kilim rug, tucked under the bed, sofa and dresser ----------
  {
    const w = 1.6, d = 1.0;
    kilimTex.repeat.set(1 / w, 1 / d);
    kilimTex.offset.set(0.5, 0.5);
    const rug = slab(w, 0.012, d, 0.01, [mat(0xffffff, kilimTex, { roughness: 1 }), mat(0xefe2c4)], X(680), 0.001, Z(890));
    rug.castShadow = false;
  }

  // ---------- cozy sofa: a big round lounger against the north wall ----------
  {
    const g = group(X(270), 0, Z(910));
    const fabric = mat(0xffffff, hatchTex), soft = mat(0xffffff, linenTex('#f1dfba', '#b39a68', 4, 4));
    const base = add(new THREE.SphereGeometry(1, 48, 32), fabric, 0, 0.24, 0, g);
    base.scale.set(0.58, 0.26, 0.58);
    ball(1, soft, 0.06, 0.4, 0, g, 0.44, 0.13, 0.44);                               // seat cushion
    const back = group(0, 0.5, 0, 1.335, g);                                         // bolster wrapping the wall side
    const bolster = add(new THREE.TorusGeometry(0.4, 0.17, 20, 56, Math.PI * 1.15), fabric, 0, 0, 0, back);
    bolster.rotation.x = -Math.PI / 2;
    bolster.scale.z = 0.95;
    for (const a of [0, Math.PI * 1.15]) ball(0.17, fabric, Math.cos(a) * 0.4, 0, -Math.sin(a) * 0.4, back, 1, 0.95, 1);
    const p1 = ball(1, mat(0xffffff, plaidTex('#b5562f', '#7d2f25', '#f1e3c4', 3)), -0.12, 0.62, -0.2, g, 0.17, 0.17, 0.075);
    p1.rotation.set(-0.25, 0.9, 0);
    const p2 = ball(1, mat(0xffffff, linenTex('#7c8a47', '#4c5a26', 3, 3)), -0.14, 0.6, 0.2, g, 0.16, 0.16, 0.07);
    p2.rotation.set(0.25, -0.9, 0);
    const throwRug = ball(1, mat(0xffffff, plaidTex('#f1e3c4', '#c98a3a', '#7d2f25', 4)), 0.3, 0.44, 0.28, g, 0.2, 0.05, 0.3);
    throwRug.rotation.set(0.25, 0.5, -0.45);
  }

  // ---------- wicker basket of spare blankets, by the sofa ----------
  {
    const g = group(X(470), 0, Z(1235));
    const wicker = mat(0xffffff, wovenTex(10, 3), { side: THREE.DoubleSide });
    add(new THREE.CylinderGeometry(0.2, 0.16, 0.3, 36, 1, true), wicker, 0, 0.15, 0, g);
    cyl(0.16, 0.16, 0.01, wicker, 0, 0.006, 0, g);
    add(new THREE.TorusGeometry(0.2, 0.014, 8, 36), wicker, 0, 0.3, 0, g).rotation.x = Math.PI / 2;
    const rolls = [[mat(0xffffff, knitTex('#a8452c', '#c4623f', '#7a2c1a', 6, 3)), -0.06, 0.03, 0.12],
                   [mat(0xffffff, knitTex('#efe2c4', '#fff6dd', '#c9b88f', 6, 3)), 0.07, -0.04, -0.14]];
    for (const [m, x, z, lean] of rolls) {
      const roll = cyl(0.075, 0.075, 0.4, m, x, 0.24, z, g);
      roll.rotation.set(lean, 0, lean * 0.8);
    }
  }

  // ---------- leather shoes with laces, on the floor by the west wall ----------
  {
    const leather = mat(0x6b3f22, null, { roughness: 0.55 }), inside = mat(0x2a1a10), lace = mat(0xf4efe2), rubber = mat(0xe9e1cf);
    for (const [px, py, r] of [[600, 1185, 1.2], [640, 1225, 1.05]]) {
      const s = group(X(px), 0, Z(py), r);                          // toe points along local +z
      slab(0.1, 0.022, 0.29, 0.045, [rubber, rubber], 0, 0, 0, s);
      ball(1, leather, 0, 0.05, 0.065, s, 0.047, 0.04, 0.08);       // toe and vamp
      box(0.09, 0.085, 0.135, leather, 0, 0.064, -0.07, s);         // quarters and heel
      box(0.066, 0.008, 0.1, inside, 0, 0.108, -0.07, s);           // opening
      box(0.042, 0.012, 0.085, leather, 0, 0.092, 0.012, s).rotation.x = -0.45;   // tongue
      for (let i = 0; i < 4; i++) for (const sgn of [-1, 1]) {      // criss-crossed laces
        box(0.052, 0.005, 0.006, lace, 0, 0.078 + i * 0.008, 0.066 - i * 0.022, s).rotation.y = sgn * 0.42;
      }
      for (const sgn of [-1, 1]) {                                  // bow and loose ends
        add(new THREE.TorusGeometry(0.014, 0.003, 8, 20), lace, sgn * 0.017, 0.11, -0.008, s).rotation.set(-1.1, sgn * 0.5, 0);
        cyl(0.0028, 0.0028, 0.05, lace, sgn * 0.034, 0.088, 0.0, s).rotation.z = sgn * 0.9;
      }
    }
  }

  // Nothing in the room moves. Fold every mesh that shares a material into one
  // world-space mesh (hundreds of draw calls become a few dozen), then freeze
  // all transforms.
  scene.updateMatrixWorld(true);
  {
    const special = new Set(hideFromAO), buckets = new Map();
    scene.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh || Array.isArray(o.material) || o.renderOrder !== 0) return;
      for (let p = o; p; p = p.parent) if (special.has(p)) return;
      const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(o);
    });
    for (const meshes of buckets.values()) {
      if (meshes.length < 2) continue;
      const parts = meshes.map(m => {
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
        return g.applyMatrix4(m.matrixWorld);
      });
      const merged = new THREE.Mesh(mergeGeometries(parts), meshes[0].material);
      merged.castShadow = meshes[0].castShadow;
      merged.receiveShadow = meshes[0].receiveShadow;
      scene.add(merged);
      meshes.forEach(m => m.removeFromParent());
      parts.forEach(g => g.dispose());
    }
  }
  scene.updateMatrixWorld(true);
  scene.traverse(o => { o.matrixAutoUpdate = false; });

  return { hideFromAO };
}
