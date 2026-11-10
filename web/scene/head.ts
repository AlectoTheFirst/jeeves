// The head scene: faceted head, eyes, optional tunnel backdrop and a CRT post-process.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import type { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { createBackdrop } from "./backdrop.ts";
import { createCrtPass } from "./crt.ts";
import { faceById, type Face } from "./faces.ts";
import { createHead, type Eyes, type HeadUniforms } from "./headMesh.ts";
import { STATE_STYLES, type HeadState } from "./state.ts";

/** Mouth pose. Each value is 0 to 1. */
export type MouthPose = { jaw: number; wide: number; round: number };

/** Move `current` toward `target`. `rate` is about 1 / (time to get most of the way). */
function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export class HeadScene {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private crt: ShaderPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  private pivot = new THREE.Group();
  private uniforms!: HeadUniforms;
  private eyes!: Eyes;
  private headMesh: THREE.Mesh | null = null;
  private face: Face = faceById(null);
  private backdrop: THREE.LineSegments;
  private timer = new THREE.Timer();

  private state: HeadState = "idle";
  private mouthTarget: MouthPose = { jaw: 0, wide: 0, round: 0 };
  private listenLevel = 0;
  private rimColor = new THREE.Color(STATE_STYLES.idle.rim);
  private look = new THREE.Vector2();
  private tilt = 0;
  private brow = 0;
  private sweep = 0;
  private nextBlink = 2;
  private blinkUntil = 0;
  private nextIdleGlitch = 8;
  private glitchUntil = 0;
  private glitchStrength = 0;

  constructor(canvas: HTMLCanvasElement, face: Face = faceById(null)) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera.position.set(0, -0.05, 6.2);

    this.setFace(face);
    this.scene.add(this.pivot);

    this.backdrop = createBackdrop(0x7cf8ff);
    this.scene.add(this.backdrop);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera, null, new THREE.Color(0x000000), 0));
    this.crt = createCrtPass();
    this.composer.addPass(this.crt);

    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  /** Build the head again with another face. A short glitch hides the change. */
  setFace(face: Face): void {
    if (this.headMesh) {
      this.pivot.remove(this.headMesh, this.eyes.group);
      this.headMesh.geometry.dispose();
      (this.headMesh.material as THREE.Material).dispose();
      this.eyes.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      this.glitch(0.8, 250);
    }
    const head = createHead(face);
    this.face = face;
    this.headMesh = head.mesh;
    this.uniforms = head.uniforms;
    this.eyes = head.eyes;
    this.pivot.add(head.mesh, head.eyes.group);
  }

  getFace(): Face {
    return this.face;
  }

  setState(state: HeadState): void {
    this.state = state;
  }

  getState(): HeadState {
    return this.state;
  }

  /** Target mouth pose. The scene smooths toward it. */
  setMouth(pose: MouthPose): void {
    this.mouthTarget = pose;
  }

  /** Microphone level, 0 to 1. Used in the listening state. */
  setListenLevel(level: number): void {
    this.listenLevel = Math.min(Math.max(level, 0), 1);
  }

  /** Start a video glitch: tears, a stronger color split and dropped frames. */
  glitch(strength: number, ms: number): void {
    const now = this.timer.getElapsed();
    this.glitchStrength = Math.max(this.glitchStrength, Math.min(Math.max(strength, 0), 1));
    this.glitchUntil = Math.max(this.glitchUntil, now + ms / 1000);
  }

  setBackdrop(on: boolean): void {
    this.backdrop.visible = on;
  }

  get backdropOn(): boolean {
    return this.backdrop.visible;
  }

  private resize(): void {
    const { innerWidth: w, innerHeight: h } = window;
    const ratio = this.renderer.getPixelRatio();
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    this.crt.uniforms.uResolution.value.set(w * ratio, h * ratio);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start(): void {
    this.renderer.setAnimationLoop((timestamp) => this.frame(timestamp));
  }

  private frame(timestamp: number): void {
    this.timer.update(timestamp);
    const t = this.timer.getElapsed();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const style = STATE_STYLES[this.state];
    const u = this.uniforms;
    u.uTime.value = t;

    // Mouth: fast so that lip-sync stays sharp. Other moves are slower.
    u.uJaw.value = approach(u.uJaw.value, this.mouthTarget.jaw, 30, dt);
    u.uWide.value = approach(u.uWide.value, this.mouthTarget.wide, 25, dt);
    u.uRound.value = approach(u.uRound.value, this.mouthTarget.round, 25, dt);

    // State look: rim color, sweep band, brows, eyes and tilt.
    // Idle and speaking use the face's own accent color.
    const rim = this.state === "idle" || this.state === "speaking" ? this.face.colors.accent : style.rim;
    this.rimColor.lerp(new THREE.Color(rim), 1 - Math.exp(-6 * dt));
    u.uRim.value.copy(this.rimColor);
    const pulse = style.pulse > 0 ? 0.5 + 0.5 * Math.sin(t * style.pulse * Math.PI * 2) : 1;
    const listen = this.state === "listening" ? this.listenLevel * 1.5 : 0;
    u.uRimPower.value = style.rimPower * (0.6 + 0.4 * pulse) + listen;
    this.sweep = approach(this.sweep, style.sweep, 4, dt);
    u.uSweep.value = this.sweep;
    this.brow = approach(this.brow, style.brow, 6, dt);
    u.uBrow.value = this.brow;
    this.tilt = approach(this.tilt, style.tilt, 3, dt);
    this.look.x = approach(this.look.x, style.lookX, 5, dt);
    this.look.y = approach(this.look.y, style.lookY, 5, dt);
    for (const look of this.eyes.looks) {
      look.position.x = this.look.x * 0.02;
      look.position.y = this.look.y * 0.008;
    }

    // Idle motion: slow turn, small bob and nod.
    this.pivot.rotation.y = Math.sin(t * 0.37) * 0.35 + Math.sin(t * 0.91) * 0.08;
    this.pivot.rotation.x = Math.sin(t * 0.53) * 0.06 - this.tilt * 0.3;
    this.pivot.rotation.z = this.tilt + Math.sin(t * 0.29) * 0.03;
    this.pivot.position.y = Math.sin(t * 1.1) * 0.04;

    // Blinks at random times.
    if (t > this.nextBlink) {
      this.blinkUntil = t + 0.12;
      this.nextBlink = t + 2 + Math.random() * 4;
    }
    const eyeOpen = t < this.blinkUntil ? 0.1 : 1;
    for (const eye of this.eyes.eyes) eye.scale.y = approach(eye.scale.y, eyeOpen, 40, dt);

    // Small glitches at random times, so that the head never looks fully still.
    if (t > this.nextIdleGlitch) {
      this.glitch(0.3, 120);
      this.nextIdleGlitch = t + 6 + Math.random() * 10;
    }

    // Backdrop turns slowly.
    this.backdrop.rotation.z = t * 0.12;
    this.backdrop.rotation.y = Math.sin(t * 0.2) * 0.15;

    // CRT values. During a glitch: a moving tear, more color split, and dropped frames.
    const glitching = t < this.glitchUntil;
    if (!glitching) this.glitchStrength = 0;
    const g = this.glitchStrength;
    const crt = this.crt.uniforms;
    crt.uTime.value = t;
    crt.uAberration.value = 0.0015 + g * 0.012;
    if (glitching && Math.random() < 0.6) {
      crt.uTearY.value = Math.random();
      crt.uTearH.value = 0.01 + Math.random() * 0.06 * g;
      crt.uTearShift.value = (Math.random() - 0.5) * 0.1 * g;
    } else {
      crt.uTearH.value = 0;
    }
    // Skip the draw to hold the last frame on screen for a moment.
    if (glitching && Math.random() < 0.25 * g) return;
    this.composer.render(dt);
  }
}
