// Placeholder head for milestone 1: a wireframe head shape with a CRT scanline shader.
// Milestone 2 replaces the geometry with assets/head.glb.
import * as THREE from "three";

const vertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec4 vClip;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(-(viewMatrix * world).xyz);
    vClip = projectionMatrix * viewMatrix * world;
    gl_Position = vClip;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec4 vClip;
  void main() {
    vec2 screen = vClip.xy / vClip.w;
    float rim = pow(1.0 - max(dot(vNormal, vViewDir), 0.0), 2.0);
    // Scanlines that move slowly down the screen, plus a fast interlace flicker.
    float line = 0.5 + 0.5 * sin(screen.y * 320.0 - uTime * 4.0);
    float interlace = mod(floor(gl_FragCoord.y) + floor(uTime * 30.0), 2.0) * 0.15;
    float light = 0.35 + 0.65 * rim;
    vec3 color = uColor * light * (0.6 + 0.4 * line) * (1.0 - interlace);
    gl_FragColor = vec4(color, 0.55 + 0.45 * rim);
  }
`;

export class HeadScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  private head = new THREE.Group();
  private material: THREE.ShaderMaterial;
  private timer = new THREE.Timer();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera.position.set(0, 0, 6);

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x7cf8ff) } },
      transparent: true,
      depthWrite: false,
    });

    // Skull: a stretched sphere. Jaw: a smaller, flatter sphere below it.
    const skull = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), this.material);
    skull.scale.set(0.85, 1.1, 0.95);
    const jaw = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 2), this.material);
    jaw.scale.set(0.9, 0.6, 0.9);
    jaw.position.set(0, -0.75, 0.1);
    const wire = new THREE.LineBasicMaterial({ color: 0xff3df2, transparent: true, opacity: 0.35 });
    const skullWire = new THREE.LineSegments(new THREE.WireframeGeometry(skull.geometry), wire);
    skullWire.scale.copy(skull.scale).multiplyScalar(1.01);
    this.head.add(skull, jaw, skullWire);
    this.scene.add(this.head);

    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  private resize(): void {
    const { innerWidth: w, innerHeight: h } = window;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start(): void {
    this.renderer.setAnimationLoop((timestamp) => {
      this.timer.update(timestamp);
      const t = this.timer.getElapsed();
      this.material.uniforms.uTime.value = t;
      // Idle motion: slow turn and a small bob.
      this.head.rotation.y = Math.sin(t * 0.5) * 0.6;
      this.head.position.y = Math.sin(t * 1.3) * 0.05;
      this.renderer.render(this.scene, this.camera);
    });
  }
}
