// Builds the faceted head mesh and its shader. The vertex shader moves the jaw, lips
// and brows from uniforms, so lip-sync only has to set 4 numbers per frame.
import * as THREE from "three";
import { type Face, MAX_SPOTS, spotDirs } from "./faces.ts";
import { eyeDirs, faceWeights, JAW_HINGE, MOUTH_Y, normalize, shapeHead, type ShapeParams } from "./shape.ts";

const WIDTH_SEGMENTS = 88;
const HEIGHT_SEGMENTS = 80;

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uJaw;
  uniform float uWide;
  uniform float uRound;
  uniform float uBrow;
  uniform vec3 uHinge;
  attribute float aJaw;
  attribute float aMouth;
  attribute float aLip;
  attribute float aBrow;
  varying vec3 vViewPos;
  varying vec3 vNormal;
  varying vec3 vRest;
  varying float vMouth;

  void main() {
    vec3 p = position;
    p.x *= 1.0 + aLip * (0.28 * uWide - 0.3 * uRound);
    p.z += aLip * 0.06 * uRound;
    p.y += aBrow * 0.05 * uBrow;
    if (aMouth < -2.5) {
      float step = sin(uTime * 3.2) * sign(p.x);
      p.y += max(step, 0.0) * 0.035;
      p.z += step * 0.04;
    }

    // Turn the jaw around the hinge on the x axis. The chin goes down and back.
    float a = aJaw * uJaw * 0.32;
    vec3 q = p - uHinge;
    q = vec3(q.x, q.y * cos(a) - q.z * sin(a), q.y * sin(a) + q.z * cos(a));
    p = q + uHinge;

    vRest = position;
    vMouth = aMouth;
    vNormal = normalize(normalMatrix * normal);
    vec4 view = modelViewMatrix * vec4(p, 1.0);
    vViewPos = view.xyz;
    gl_Position = projectionMatrix * view;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uJaw;
  uniform float uSmooth;
  uniform vec3 uBase;
  uniform vec3 uHighlight;
  uniform vec3 uRim;
  uniform float uRimPower;
  uniform float uSweep;
  uniform vec3 uSweepColor;
  uniform float uCapY;
  uniform vec3 uCapBase;
  uniform vec3 uCapHighlight;
  uniform vec3 uSpotColor;
  uniform float uSpotSize;
  uniform vec3 uSpots[${MAX_SPOTS}];
  varying vec3 vViewPos;
  varying vec3 vNormal;
  varying vec3 vRest;
  varying float vMouth;

  void main() {
    // Flat normal per facet, blended with smooth vertex normal for organic shapes.
    vec3 flatN = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
    vec3 n = normalize(mix(flatN, normalize(vNormal), uSmooth));
    vec3 viewDir = normalize(-vViewPos);
    vec3 keyDir = normalize(vec3(-0.5, 0.7, 0.8));

    float diffuse = max(dot(n, keyDir), 0.0);
    float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.5);
    // Ambient part, so that facets that face away from the light do not go black.
    float light = 0.25 + diffuse * 0.7;
    vec3 color = mix(uBase, uHighlight, light);

    // Mushroom cap: own colors and pale spots. uCapY is above the head when there is no cap.
    float cap = smoothstep(uCapY - 0.02, uCapY + 0.01, vRest.y);
    if (cap > 0.0) {
      vec3 capColor = mix(uCapBase, uCapHighlight, light);
      if (uSpotSize > 0.0) {
        vec3 dir = normalize(vRest);
        float spot = 0.0;
        for (int i = 0; i < ${MAX_SPOTS}; i++) {
          spot = max(spot, 1.0 - smoothstep(uSpotSize * 0.8, uSpotSize, distance(dir, uSpots[i])));
        }
        capColor = mix(capColor, uSpotColor * (0.55 + diffuse * 0.5), spot);
      }
      color = mix(color, capColor, cap);
    }
    if (vMouth < -2.5) {
      color = mix(vec3(0.22, 0.12, 0.06), vec3(0.58, 0.37, 0.22), light);
    } else if (vMouth < -1.5) {
      color = mix(vec3(0.06, 0.06, 0.07), vec3(0.24, 0.24, 0.27), light);
    } else if (vMouth < -0.5) {
      color = mix(vec3(0.72, 0.74, 0.78), vec3(1.0, 0.99, 0.98), light);
    }
    color += uRim * rim * uRimPower;

    // Thinking: a bright band that moves up the head.
    float band = 1.0 - smoothstep(0.0, 0.06, abs(vRest.y - (fract(uTime * 0.5) * 2.4 - 1.2)));
    color += uSweepColor * band * uSweep;

    // Inside of the mouth: dark, more so when the jaw is open.
    float open = clamp(uJaw * 4.0, 0.0, 1.0);
    float mouthDark = smoothstep(0.1, 0.6, max(vMouth, 0.0)) * (0.55 + 0.45 * open);
    if (uSmooth > 0.5 && vMouth >= -0.2 && vRest.z > 0.4) {
      // Wide gentle frown crease between the two tusks when closed, opening cleanly with uJaw.
      float frownY = -0.22 - 0.65 * vRest.x * vRest.x;
      float line = (1.0 - smoothstep(0.007, 0.02, abs(vRest.y - frownY))) * (1.0 - smoothstep(0.34, 0.38, abs(vRest.x)));
      mouthDark = max(mouthDark * open, line * 0.88);
    }
    color = mix(color, vec3(0.05, 0.01, 0.01), mouthDark);

    gl_FragColor = vec4(color, 1.0);
  }
`;

export type HeadUniforms = {
  uTime: { value: number };
  uJaw: { value: number };
  uWide: { value: number };
  uRound: { value: number };
  uBrow: { value: number };
  uSmooth: { value: number };
  uHinge: { value: THREE.Vector3 };
  uBase: { value: THREE.Color };
  uHighlight: { value: THREE.Color };
  uRim: { value: THREE.Color };
  uRimPower: { value: number };
  uSweep: { value: number };
  uSweepColor: { value: THREE.Color };
  uCapY: { value: number };
  uCapBase: { value: THREE.Color };
  uCapHighlight: { value: THREE.Color };
  uSpotColor: { value: THREE.Color };
  uSpotSize: { value: number };
  uSpots: { value: THREE.Vector3[] };
};

function appendMesh(
  parts: { pos: number[]; idx: number[]; jaw: number[]; mouth: number[]; lip: number[]; brow: number[] },
  geom: THREE.BufferGeometry,
  weights: { jaw: number; mouth: number; lip: number; brow: number },
): void {
  const base = parts.pos.length / 3;
  const p = geom.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    parts.pos.push(p.getX(i), p.getY(i), p.getZ(i));
    parts.jaw.push(weights.jaw);
    parts.mouth.push(weights.mouth);
    parts.lip.push(weights.lip);
    parts.brow.push(weights.brow);
  }
  const index = geom.getIndex();
  if (index) {
    for (let i = 0; i < index.count; i++) parts.idx.push(base + index.getX(i));
  }
  geom.dispose();
}

function addTusksAndBrows(
  parts: { pos: number[]; idx: number[]; jaw: number[]; mouth: number[]; lip: number[]; brow: number[] },
  shape: ShapeParams,
): void {
  for (const side of [-1, 1]) {
    // Plump white rounded-cone tusk emerging from the frown line at each corner of the mouth.
    const cone = new THREE.SphereGeometry(1, 24, 16);
    const cp = cone.getAttribute("position");
    for (let i = 0; i < cp.count; i++) {
      // h goes from 0 at the base along the frown line to 1 at the rounded tip.
      const sy = cp.getY(i);
      const h = Math.max(sy, -0.15);
      const t = Math.min(Math.max((h + 0.15) / 1.15, 0), 1);
      const profile = Math.pow(1 - t, 0.72) * Math.sqrt(Math.max(1 - sy * sy, 0) / Math.max(1 - t * t + 0.08, 0.08));
      const rx = cp.getX(i) * 0.068 * profile;
      const rz = cp.getZ(i) * 0.052 * profile;
      const cx = side * (0.335 - t * 0.03) + rx;
      const frownBase = -0.22 - 0.65 * cx * cx;
      const cy = frownBase + t * 0.165;
      const surf = shapeHead(normalize({ x: cx, y: cy, z: 0.95 }), shape);
      cp.setXYZ(i, surf.x, surf.y, surf.z + 0.012 + 0.038 * profile + rz);
    }
    appendMesh(parts, cone, { jaw: 1, mouth: -1, lip: 0.65, brow: 0 });

    // High-arching gull-wing black eyebrow that runs along the top rim of the eye and hooks down off the side of the head.
    const brow = new THREE.SphereGeometry(1, 36, 18);
    const bp = brow.getAttribute("position");
    for (let i = 0; i < bp.count; i++) {
      const sx = bp.getX(i);
      const r = Math.hypot(bp.getY(i), bp.getZ(i)) || 1;
      const u = side > 0 ? sx * 0.5 + 0.5 : 0.5 - sx * 0.5;
      // Round inner tip, thick arch peak around u = 0.62, sharp pointed outer hook at u = 1.
      const inner = Math.pow(Math.min(u / 0.08, 1), 0.45);
      const outer = Math.pow(Math.max(1 - Math.max(u - 0.55, 0) / 0.45, 0), 0.85);
      const thick = (0.025 + 0.044 * Math.sin(Math.min(u / 0.88, 1) * Math.PI * 0.85)) * inner * outer;
      const ny = (bp.getY(i) / r) * thick;
      const nz = (bp.getZ(i) / r) * thick * 0.85;

      const bx = side * (0.04 + u * 0.62);
      const hook = Math.pow(Math.max(u - 0.54, 0) / 0.46, 2.15) * 0.3;
      const by = 0.28 + u * 0.47 - hook + ny;
      const onHead = shapeHead(normalize({ x: bx, y: Math.min(by, 0.56), z: 0.92 }), shape);
      const freeZ = 0.54 - u * 0.14;
      const blendFree = Math.min(Math.max((u - 0.44) / 0.34, 0), 1);
      const bz = onHead.z * (1 - blendFree) + freeZ * blendFree + 0.072 + nz;
      const outX = onHead.x * (1 - blendFree) + bx * blendFree;
      bp.setXYZ(i, outX, by, bz);
    }
    appendMesh(parts, brow, { jaw: 0, mouth: -2, lip: 0, brow: 1 });

    // Big, plump, potato-shaped chestnut-brown Goomba shoe tucked against the lower tan belly.
    const foot = new THREE.SphereGeometry(1, 28, 20);
    const fp = foot.getAttribute("position");
    for (let i = 0; i < fp.count; i++) {
      let fx = fp.getX(i);
      let fy = fp.getY(i);
      let fz = fp.getZ(i);
      if (fy < 0) fy *= 0.45; // Rounded-flat sole.
      fx *= 0.265 * (1 + 0.12 * fz);
      fy *= 0.21 * (1 - 0.1 * Math.max(fz, 0));
      fz = fz > 0 ? fz * 0.39 : fz * 0.26;
      fp.setXYZ(i, fx, fy, fz);
    }
    foot.rotateY(side * 0.34);
    foot.translate(side * 0.28, -1.0, 0.14);
    appendMesh(parts, foot, { jaw: 0, mouth: -3, lip: 0, brow: 0 });
  }
}

function buildGeometry(shape: ShapeParams): THREE.BufferGeometry {
  const sphere = new THREE.SphereGeometry(1, WIDTH_SEGMENTS, HEIGHT_SEGMENTS);
  // SphereGeometry: row j has polar angle PI * j / HEIGHT_SEGMENTS, from the top.
  // Pick the row just above the lip line. The cut is between this row and the next.
  const seamY = shape.tusks ? -0.3 : MOUTH_Y;
  const seamRow = Math.floor((Math.acos(seamY) / Math.PI) * HEIGHT_SEGMENTS);
  const pos = sphere.getAttribute("position");
  const count = pos.count;
  const parts = {
    pos: new Array<number>(count * 3),
    idx: Array.from(sphere.getIndex()!.array),
    jaw: new Array<number>(count),
    mouth: new Array<number>(count),
    lip: new Array<number>(count),
    brow: new Array<number>(count),
  };

  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / (WIDTH_SEGMENTS + 1));
    const unit = normalize({ x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) });
    const shaped = shapeHead(unit, shape);
    const inStem = shape.cap !== undefined && unit.y < shape.cap.base;
    const w = faceWeights(unit, shaped, row > seamRow && !inStem, row === seamRow || row === seamRow + 1);
    parts.pos[i * 3] = shaped.x;
    parts.pos[i * 3 + 1] = shaped.y;
    parts.pos[i * 3 + 2] = shaped.z;
    parts.jaw[i] = w.jaw;
    parts.mouth[i] = w.mouth;
    parts.lip[i] = w.lip;
    parts.brow[i] = w.brow;
  }

  if (shape.tusks) addTusksAndBrows(parts, shape);

  const out = new THREE.BufferGeometry();
  out.setIndex(parts.idx);
  out.setAttribute("position", new THREE.Float32BufferAttribute(parts.pos, 3));
  out.setAttribute("aJaw", new THREE.Float32BufferAttribute(parts.jaw, 1));
  out.setAttribute("aMouth", new THREE.Float32BufferAttribute(parts.mouth, 1));
  out.setAttribute("aLip", new THREE.Float32BufferAttribute(parts.lip, 1));
  out.setAttribute("aBrow", new THREE.Float32BufferAttribute(parts.brow, 1));
  out.computeVertexNormals();
  sphere.dispose();
  return out;
}

/**
 * The eyes are glowing slits.
 * `eyes`: 1 group per eye. Scale y to blink.
 * `looks`: the part of each eye that moves when the head looks around.
 */
export type Eyes = { group: THREE.Group; eyes: THREE.Group[]; looks: THREE.Object3D[] };

// Soft glow: a flat quad with an oval fall-off, added on top of what is behind it.
const glowVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv * 2.0 - 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const glowFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    float d = length(vUv * vec2(1.0, 2.6));
    float glow = exp(-d * d * 4.0) * uStrength;
    gl_FragColor = vec4(uColor * glow, glow);
  }
`;

function buildEyes(face: Face): Eyes {
  const group = new THREE.Group();
  const eyes: THREE.Group[] = [];
  const looks: THREE.Object3D[] = [];
  const style = face.eyes;
  const core = new THREE.MeshBasicMaterial({ color: style.core });
  const backing = new THREE.MeshBasicMaterial({ color: style.white?.color ?? 0x050308 });
  const specMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const coreGeometry = new THREE.SphereGeometry(1, 24, 12);
  const whiteGeometry = new THREE.SphereGeometry(1, 28, 16);
  if (style.white) {
    const wp = whiteGeometry.getAttribute("position");
    for (let i = 0; i < wp.count; i++) {
      const wy = wp.getY(i);
      if (wy < 0) wp.setY(i, wy * 0.78); // Gently flattened lower cheek edge.
    }
  }
  const glowMaterial = new THREE.ShaderMaterial({
    vertexShader: glowVertex,
    fragmentShader: glowFragment,
    uniforms: { uColor: { value: new THREE.Color(style.glow) }, uStrength: { value: style.glowStrength } },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const glowGeometry = new THREE.PlaneGeometry(style.glowWidth, style.glowHeight);

  for (const [index, dir] of eyeDirs(face.shape).entries()) {
    const anchor = shapeHead(dir, face.shape);
    const eye = new THREE.Group();
    eye.position.set(anchor.x, anchor.y, anchor.z);
    // Align a cartoon eye disc with the head surface slope so its bottom edge never clips into the cap.
    if (style.white) {
      const top = shapeHead(normalize({ x: dir.x, y: dir.y + 0.14, z: dir.z }), face.shape);
      const bot = shapeHead(normalize({ x: dir.x, y: dir.y - 0.14, z: dir.z }), face.shape);
      eye.rotation.x = Math.atan2(top.z - bot.z, top.y - bot.y);
      eye.rotation.y = (index === 0 ? -1 : 1) * 0.16;
      eye.position.z += style.white.length * 0.42;
    }
    // Turn the outer end of each slit up a little.
    eye.rotation.z = (index === 0 ? -1 : 1) * style.tilt;

    const look = new THREE.Group();
    const bar = new THREE.Mesh(coreGeometry, core);
    bar.scale.set(style.length, style.height, 0.02);
    // A dark slit behind the core, so that the eye shows on light skin too.
    const back = new THREE.Mesh(style.white ? whiteGeometry : coreGeometry, backing);
    if (style.white) back.scale.set(style.white.length, style.white.height, 0.015);
    else back.scale.set(style.length * 1.35, style.height * 2.2 + 0.012, 0.012);
    back.position.z = -0.006;
    // The pupil sits in front of the eye white, in the lower-inner portion with a bright catchlight dot.
    if (style.white) {
      bar.position.set((index === 0 ? 1 : -1) * style.white.length * 0.22, -style.white.height * 0.15, 0.014);
      const spec = new THREE.Mesh(coreGeometry, specMat);
      spec.scale.set(style.length * 0.34, style.height * 0.3, 0.01);
      spec.position.set(bar.position.x + style.length * 0.28, bar.position.y + style.height * 0.32, 0.028);
      look.add(spec);
    }
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    glow.position.z = 0.03;
    glow.renderOrder = 10;
    look.add(back, bar, glow);
    eye.add(look);
    group.add(eye);
    eyes.push(eye);
    looks.push(look);
  }
  return { group, eyes, looks };
}

export function createHead(face: Face): { mesh: THREE.Mesh; uniforms: HeadUniforms; eyes: Eyes } {
  const c = face.colors;
  const cap = face.cap;
  const uniforms: HeadUniforms = {
    uTime: { value: 0 },
    uJaw: { value: 0 },
    uWide: { value: 0 },
    uRound: { value: 0 },
    uBrow: { value: 0 },
    uSmooth: { value: face.shape.tusks ? 0.9 : 0 },
    uHinge: { value: new THREE.Vector3(JAW_HINGE.x, JAW_HINGE.y, JAW_HINGE.z) },
    uBase: { value: new THREE.Color(c.base) },
    uHighlight: { value: new THREE.Color(c.highlight) },
    uRim: { value: new THREE.Color(c.accent) },
    uRimPower: { value: 0.9 },
    uSweep: { value: 0 },
    uSweepColor: { value: new THREE.Color(c.sweep) },
    uCapY: { value: face.shape.cap?.base ?? 9 },
    uCapBase: { value: new THREE.Color(cap?.base ?? 0) },
    uCapHighlight: { value: new THREE.Color(cap?.highlight ?? 0) },
    uSpotColor: { value: new THREE.Color(cap?.spots ?? 0) },
    uSpotSize: { value: cap?.spotSize ?? 0 },
    uSpots: { value: spotDirs().map(([x, y, z]) => new THREE.Vector3(x, y, z)) },
  };
  const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms });
  const mesh = new THREE.Mesh(buildGeometry(face.shape), material);
  // The jaw moves in the vertex shader, so the default bounds can be too small.
  mesh.frustumCulled = false;
  return { mesh, uniforms, eyes: buildEyes(face) };
}
