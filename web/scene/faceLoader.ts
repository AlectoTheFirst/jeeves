// Turn a face package (.glb) into a face. Read docs/face-packages.md for the format.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { colorNumber, MAX_VERTICES, packageFaceId, readManifest, type Manifest } from "./facePackage.ts";
import type { EyeStyle, Face, FaceModel } from "./faces.ts";
import { DEFAULT_SHAPE } from "./shape.ts";

/** The glTF attribute names of the animation weights, as the GLTF loader gives them. */
const WEIGHTS: [string, string][] = [
  ["_ajaw", "aJaw"],
  ["_amouth", "aMouth"],
  ["_alip", "aLip"],
  ["_abrow", "aBrow"],
];

function eyeStyle(e: Manifest["look"]["eyes"]): EyeStyle {
  return {
    length: e.length,
    height: e.height,
    tilt: e.tilt,
    core: colorNumber(e.core),
    glow: colorNumber(e.glow),
    glowStrength: e.glowStrength,
    glowWidth: e.glowWidth,
    glowHeight: e.glowHeight,
    ...(e.white ? { white: { color: colorNumber(e.white.color), length: e.white.length, height: e.white.height } } : {}),
    ...(e.pupil ? { pupil: { ...e.pupil } } : {}),
    ...(e.whiteFlat !== undefined ? { whiteFlat: e.whiteFlat } : {}),
  };
}

/** The head geometry with the names that the head shader uses. */
function headGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
  const source = mesh.geometry;
  const position = source.getAttribute("position");
  if (!position) throw new Error("the head mesh has no positions");
  if (position.count > MAX_VERTICES) throw new Error(`the head mesh has more than ${MAX_VERTICES} vertices`);
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", position);
  const index = source.getIndex();
  if (index) out.setIndex(index);
  for (const [from, to] of WEIGHTS) {
    const attr = source.getAttribute(from);
    // A missing weight is 0: that part of the head does not move.
    out.setAttribute(to, attr && attr.count === position.count ? attr : new THREE.Float32BufferAttribute(new Float32Array(position.count), 1));
  }
  const uv = source.getAttribute("uv");
  if (uv && uv.count === position.count) out.setAttribute("uv", uv);
  // The head shader lights from vertex normals. Compute them, so that a package cannot give bad ones.
  out.computeVertexNormals();
  // Apply the transform of the node, so that the package can place the head.
  mesh.updateWorldMatrix(true, false);
  out.applyMatrix4(mesh.matrixWorld);
  return out;
}

function paintOf(mesh: THREE.Mesh): THREE.Texture | null {
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const map = (material as THREE.MeshStandardMaterial | undefined)?.map ?? null;
  if (map) {
    map.colorSpace = THREE.NoColorSpace;
    map.needsUpdate = true;
  }
  return map;
}

/** Load 1 package. Throws with a clear text if the package is bad. */
export async function loadFacePackage(bytes: ArrayBuffer): Promise<{ face: Face; manifest: Manifest }> {
  const manifest = readManifest(new Uint8Array(bytes));
  const gltf = await new GLTFLoader().parseAsync(bytes, "");
  const root = gltf.scene;
  const head = root.getObjectByName("head");
  if (!(head instanceof THREE.Mesh)) throw new Error('the package has no mesh with the name "head"');
  root.updateMatrixWorld(true);

  const eyes: FaceModel["eyes"] = [];
  // No "." in the names: the GLTF loader removes it from node names.
  for (const name of ["eye_0", "eye_1"]) {
    const node = root.getObjectByName(name);
    if (!node) throw new Error(`the package has no node with the name "${name}"`);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    node.matrixWorld.decompose(position, quaternion, new THREE.Vector3());
    eyes.push({ position, quaternion });
  }

  const look = manifest.look;
  const face: Face = {
    id: packageFaceId(manifest.id),
    name: manifest.name,
    shape: DEFAULT_SHAPE,
    colors: {
      base: colorNumber(look.colors.base),
      highlight: colorNumber(look.colors.highlight),
      accent: colorNumber(look.colors.accent),
      sweep: colorNumber(look.colors.sweep),
    },
    eyes: eyeStyle(look.eyes),
    smooth: look.smooth ?? 0,
    ...(look.mouthShade !== undefined ? { mouthShade: look.mouthShade } : {}),
    ...(look.cap
      ? {
          cap: {
            base: colorNumber(look.cap.base),
            highlight: colorNumber(look.cap.highlight),
            spots: colorNumber(look.cap.spots),
            spotSize: look.cap.spotSize,
          },
          capY: look.cap.y,
        }
      : {}),
    model: { geometry: headGeometry(head), eyes, paint: paintOf(head) },
  };
  return { face, manifest };
}
