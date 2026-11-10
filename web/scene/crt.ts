// Full-screen CRT pass: RGB channel offset, scanlines, noise, and horizontal tears.
// The input buffer holds premultiplied alpha, so the window stays transparent.
import * as THREE from "three";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

const CrtShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uAberration: { value: 0.0015 },
    uScan: { value: 0.18 },
    uNoise: { value: 0.04 },
    uTearY: { value: -1 },
    uTearH: { value: 0 },
    uTearShift: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uAberration;
    uniform float uScan;
    uniform float uNoise;
    uniform float uTearY;
    uniform float uTearH;
    uniform float uTearShift;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      // Horizontal tear: shift 1 band of rows sideways.
      if (abs(uv.y - uTearY) < uTearH) uv.x += uTearShift;

      vec2 off = vec2(uAberration, 0.0);
      vec4 r = texture2D(tDiffuse, uv + off);
      vec4 g = texture2D(tDiffuse, uv);
      vec4 b = texture2D(tDiffuse, uv - off);
      float a = max(max(r.a, g.a), b.a);
      vec3 color = vec3(r.r, g.g, b.b);

      // Scanlines at the physical pixel rows, with a slow roll.
      float row = uv.y * uResolution.y;
      float scan = 1.0 - uScan * (0.5 + 0.5 * sin(row * 3.14159 + uTime * 2.0));
      float noise = (hash(uv * uResolution + uTime) - 0.5) * uNoise;
      color = max(color * scan + noise * a, 0.0);

      gl_FragColor = vec4(min(color, vec3(a)), a);
    }
  `,
};

export function createCrtPass(): ShaderPass {
  return new ShaderPass(CrtShader);
}
