// A turning wireframe tunnel behind the head: 4 walls of grid lines that fade with depth.
import * as THREE from "three";

const HALF = 2.4; // Half the width and height of the tunnel.
const NEAR = -1.5;
const FAR = -14;
const STEPS = 8; // Grid lines across each wall.
const RINGS = 14; // Grid lines along the depth.

export function createBackdrop(color: THREE.ColorRepresentation): THREE.LineSegments {
  const positions: number[] = [];
  const colors: number[] = [];
  const base = new THREE.Color(color);
  const fade = (z: number) => 1 - (z - NEAR) / (FAR - NEAR);

  const push = (a: THREE.Vector3, b: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    for (const p of [a, b]) {
      const k = fade(p.z) * 0.9;
      colors.push(base.r * k, base.g * k, base.b * k);
    }
  };

  // Each wall is a square frame position that turns around the z axis.
  for (let wall = 0; wall < 4; wall++) {
    const turn = (wall * Math.PI) / 2;
    const rot = (x: number, y: number, z: number) =>
      new THREE.Vector3(x, y, z).applyAxisAngle(new THREE.Vector3(0, 0, 1), turn);
    // Lines along the depth.
    for (let i = 0; i <= STEPS; i++) {
      const s = -HALF + (2 * HALF * i) / STEPS;
      push(rot(s, -HALF, NEAR), rot(s, -HALF, FAR));
    }
    // Lines across the wall.
    for (let j = 0; j <= RINGS; j++) {
      const z = NEAR + ((FAR - NEAR) * j) / RINGS;
      push(rot(-HALF, -HALF, z), rot(HALF, -HALF, z));
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.LineSegments(geometry, material);
}
