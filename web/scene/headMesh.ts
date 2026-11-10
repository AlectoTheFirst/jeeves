// Builds the faceted head mesh and its shader. The vertex shader moves the jaw, lips
// and brows from uniforms, so lip-sync only has to set 4 numbers per frame.
import * as THREE from "three";
import { EYE_DIRS, faceWeights, JAW_HINGE, MOUTH_Y, normalize, shapeHead } from "./shape.ts";

const WIDTH_SEGMENTS = 88;
const HEIGHT_SEGMENTS = 80;

const vertexShader = /* glsl */ `
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
  varying vec3 vRest;
  varying float vMouth;

  void main() {
    vec3 p = position;
    p.x *= 1.0 + aLip * (0.28 * uWide - 0.3 * uRound);
    p.z += aLip * 0.06 * uRound;
    p.y += aBrow * 0.05 * uBrow;

    // Turn the jaw around the hinge on the x axis. The chin goes down and back.
    float a = aJaw * uJaw * 0.32;
    vec3 q = p - uHinge;
    q = vec3(q.x, q.y * cos(a) - q.z * sin(a), q.y * sin(a) + q.z * cos(a));
    p = q + uHinge;

    vRest = position;
    vMouth = aMouth;
    vec4 view = modelViewMatrix * vec4(p, 1.0);
    vViewPos = view.xyz;
    gl_Position = projectionMatrix * view;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uJaw;
  uniform vec3 uBase;
  uniform vec3 uHighlight;
  uniform vec3 uRim;
  uniform float uRimPower;
  uniform float uSweep;
  uniform vec3 uSweepColor;
  varying vec3 vViewPos;
  varying vec3 vRest;
  varying float vMouth;

  void main() {
    // Flat normal per facet from the screen-space derivatives of the position.
    vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
    vec3 viewDir = normalize(-vViewPos);
    vec3 keyDir = normalize(vec3(-0.5, 0.7, 0.8));

    float diffuse = max(dot(n, keyDir), 0.0);
    float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.5);
    // Ambient part, so that facets that face away from the light do not go black.
    vec3 color = mix(uBase, uHighlight, 0.25 + diffuse * 0.7);
    color += uRim * rim * uRimPower;

    // Thinking: a bright band that moves up the head.
    float band = 1.0 - smoothstep(0.0, 0.06, abs(vRest.y - (fract(uTime * 0.5) * 2.4 - 1.2)));
    color += uSweepColor * band * uSweep;

    // Inside of the mouth: dark, more so when the jaw is open.
    float open = clamp(uJaw * 4.0, 0.0, 1.0);
    color = mix(color, vec3(0.02, 0.0, 0.04), smoothstep(0.1, 0.6, vMouth) * (0.55 + 0.45 * open));

    gl_FragColor = vec4(color, 1.0);
  }
`;

export type HeadUniforms = {
  uTime: { value: number };
  uJaw: { value: number };
  uWide: { value: number };
  uRound: { value: number };
  uBrow: { value: number };
  uHinge: { value: THREE.Vector3 };
  uBase: { value: THREE.Color };
  uHighlight: { value: THREE.Color };
  uRim: { value: THREE.Color };
  uRimPower: { value: number };
  uSweep: { value: number };
  uSweepColor: { value: THREE.Color };
};

function buildGeometry(): THREE.BufferGeometry {
  const sphere = new THREE.SphereGeometry(1, WIDTH_SEGMENTS, HEIGHT_SEGMENTS);
  // SphereGeometry: row j has polar angle PI * j / HEIGHT_SEGMENTS, from the top.
  // Pick the row just above the lip line. The cut is between this row and the next.
  const seamRow = Math.floor((Math.acos(MOUTH_Y) / Math.PI) * HEIGHT_SEGMENTS);
  const pos = sphere.getAttribute("position");
  const count = pos.count;
  const jaw = new Float32Array(count);
  const mouth = new Float32Array(count);
  const lip = new Float32Array(count);
  const brow = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / (WIDTH_SEGMENTS + 1));
    const unit = normalize({ x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) });
    const shaped = shapeHead(unit);
    const w = faceWeights(unit, shaped, row > seamRow, row === seamRow || row === seamRow + 1);
    pos.setXYZ(i, shaped.x, shaped.y, shaped.z);
    jaw[i] = w.jaw;
    mouth[i] = w.mouth;
    lip[i] = w.lip;
    brow[i] = w.brow;
  }

  sphere.setAttribute("aJaw", new THREE.BufferAttribute(jaw, 1));
  sphere.setAttribute("aMouth", new THREE.BufferAttribute(mouth, 1));
  sphere.setAttribute("aLip", new THREE.BufferAttribute(lip, 1));
  sphere.setAttribute("aBrow", new THREE.BufferAttribute(brow, 1));
  sphere.deleteAttribute("normal");
  sphere.deleteAttribute("uv");
  return sphere;
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

function buildEyes(): Eyes {
  const group = new THREE.Group();
  const eyes: THREE.Group[] = [];
  const looks: THREE.Object3D[] = [];
  const core = new THREE.MeshBasicMaterial({ color: 0xe6fdff });
  const coreGeometry = new THREE.SphereGeometry(1, 24, 8);
  const glowMaterial = new THREE.ShaderMaterial({
    vertexShader: glowVertex,
    fragmentShader: glowFragment,
    uniforms: { uColor: { value: new THREE.Color(0x3fe6ff) }, uStrength: { value: 1.2 } },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const glowGeometry = new THREE.PlaneGeometry(0.36, 0.14);

  for (const [index, dir] of EYE_DIRS.entries()) {
    const anchor = shapeHead(dir);
    const eye = new THREE.Group();
    eye.position.set(anchor.x, anchor.y, anchor.z);
    // Turn the outer end of each slit up a little.
    eye.rotation.z = (index === 0 ? -1 : 1) * 0.08;

    const look = new THREE.Group();
    const bar = new THREE.Mesh(coreGeometry, core);
    bar.scale.set(0.1, 0.013, 0.02);
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    glow.position.z = 0.03;
    glow.renderOrder = 10;
    look.add(bar, glow);
    eye.add(look);
    group.add(eye);
    eyes.push(eye);
    looks.push(look);
  }
  return { group, eyes, looks };
}

export function createHead(): { mesh: THREE.Mesh; uniforms: HeadUniforms; eyes: Eyes } {
  const uniforms: HeadUniforms = {
    uTime: { value: 0 },
    uJaw: { value: 0 },
    uWide: { value: 0 },
    uRound: { value: 0 },
    uBrow: { value: 0 },
    uHinge: { value: new THREE.Vector3(JAW_HINGE.x, JAW_HINGE.y, JAW_HINGE.z) },
    uBase: { value: new THREE.Color(0x0b3c52) },
    uHighlight: { value: new THREE.Color(0x56d8f0) },
    uRim: { value: new THREE.Color(0xff3df2) },
    uRimPower: { value: 0.9 },
    uSweep: { value: 0 },
    uSweepColor: { value: new THREE.Color(0xb48cff) },
  };
  const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms });
  const mesh = new THREE.Mesh(buildGeometry(), material);
  // The jaw moves in the vertex shader, so the default bounds can be too small.
  mesh.frustumCulled = false;
  return { mesh, uniforms, eyes: buildEyes() };
}
