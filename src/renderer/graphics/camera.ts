/**
 * Camera rig shared by all 3D engines. Modes:
 *   orbital      continuous orbit (user can still drag / zoom)
 *   interactive  full user control (OrbitControls, damping)
 *   macro        whole structure from a distance
 *   microscopic  drifts just inside/near the structure, revealing individual strands
 *   cinematic    smooth predetermined spline path through and around the scene
 *   tracking     follows a signal reported by the engine (e.g. a neural impulse)
 * Mode switches blend smoothly over ~1.6 s.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraMode } from '../../shared/commands';

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  mode: CameraMode = 'orbital';
  radius = 1;
  speed = 1;
  private blend = 1;
  private fromPos = new THREE.Vector3();
  private fromTarget = new THREE.Vector3();
  private curTarget = new THREE.Vector3();
  private desiredPos = new THREE.Vector3();
  private desiredTarget = new THREE.Vector3();
  private path: THREE.CatmullRomCurve3 | null = null;
  private targetPath: THREE.CatmullRomCurve3 | null = null;
  private trackSmooth = new THREE.Vector3();
  private trackAhead = new THREE.Vector3();
  private t = 0;
  private userDragging = false;

  constructor(dom: HTMLElement, fov = 50) {
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.01, 1000);
    this.camera.position.set(0, 0.4, 2.6);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 0.8;
    this.controls.enablePan = true;
    this.controls.addEventListener('start', () => (this.userDragging = true));
    this.controls.addEventListener('end', () => (this.userDragging = false));
  }

  setRadius(r: number): void {
    this.radius = r;
    this.camera.near = r * 0.002;
    this.camera.far = r * 200;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = r * 0.05;
    this.controls.maxDistance = r * 30;
    this.buildPaths();
    if (this.mode === 'orbital' || this.mode === 'interactive' || this.mode === 'macro') {
      const d = this.mode === 'macro' ? 4.6 : 2.7;
      this.camera.position.set(0, r * 0.35, r * d);
      this.controls.target.set(0, 0, 0);
    }
  }

  setAspect(a: number): void {
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  setMode(mode: CameraMode, immediate = false): void {
    if (mode === this.mode && !immediate) return;
    this.fromPos.copy(this.camera.position);
    this.fromTarget.copy(this.controls.target);
    this.mode = mode;
    this.blend = immediate ? 1 : 0;
    const interactiveish = mode === 'orbital' || mode === 'interactive' || mode === 'macro';
    this.controls.enabled = interactiveish;
    this.controls.autoRotate = mode === 'orbital' || mode === 'macro';
    if (mode === 'macro') this.controls.target.set(0, 0, 0);
    this.trackSmooth.set(0, 0, 0);
  }

  private buildPaths(): void {
    const r = this.radius;
    const pts = [
      [0, 0.6, 3.6], [2.4, 0.9, 1.9], [1.5, 0.15, 0.62], [0.4, -0.2, 0.3], [-0.5, 0.1, 0.55], [-1.3, 0.5, 0.9], [-2.6, 1.2, -1.2], [-0.6, -1.4, -2.4], [1.9, -0.7, -1.6], [3.0, 0.3, 0.8],
    ].map(([x, y, z]) => new THREE.Vector3(x * r, y * r, z * r));
    this.path = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
    const tgt = [[0, 0, 0], [0.3, 0, 0], [0.9, 0.05, 0.1], [-0.4, 0, 0.2], [-1.2, 0.2, 0.4], [-0.5, 0, 0], [0, 0, 0], [0.2, -0.2, 0], [0, 0, 0], [0, 0, 0]].map(([x, y, z]) => new THREE.Vector3(x * r, y * r, z * r));
    this.targetPath = new THREE.CatmullRomCurve3(tgt, true, 'centripetal', 0.5);
  }

  /**
   * Advance the rig. `track` provides the signal-tracking target.
   * `rotationSpeed` is the global auto-rotation multiplier.
   */
  update(dt: number, rotationSpeed: number, track: (() => { position: THREE.Vector3; ahead: THREE.Vector3 } | null) | null): void {
    this.t += dt;
    const r = this.radius;
    const cam = this.camera;
    this.blend = Math.min(1, this.blend + dt / 1.6);
    const ease = this.blend * this.blend * (3 - 2 * this.blend);
    switch (this.mode) {
      case 'orbital':
      case 'macro':
      case 'interactive': {
        this.controls.autoRotateSpeed = (this.mode === 'macro' ? 0.35 : 0.8) * rotationSpeed * this.speed * (this.userDragging ? 0 : 1);
        if (this.blend < 1 && this.mode === 'macro') {
          this.desiredPos.copy(this.fromPos).normalize().multiplyScalar(r * 4.6);
          cam.position.lerpVectors(this.fromPos, this.desiredPos, ease);
          this.controls.target.lerpVectors(this.fromTarget, new THREE.Vector3(), ease);
        } else if (this.blend < 1 && this.fromPos.length() < r * 1.4) {
          this.desiredPos.copy(this.fromPos).normalize().multiplyScalar(r * 2.7);
          cam.position.lerpVectors(this.fromPos, this.desiredPos, ease);
          this.controls.target.lerpVectors(this.fromTarget, new THREE.Vector3(), ease);
        }
        this.controls.update(dt);
        return;
      }
      case 'microscopic': {
        const s = this.t * 0.035 * this.speed * Math.max(0.2, rotationSpeed);
        const theta = s * 2.1 + Math.sin(s * 0.7) * 0.8;
        const phi = 1.2 + Math.sin(s * 0.9) * 0.55;
        const rad = r * (0.86 + 0.12 * Math.sin(s * 1.3));
        this.desiredPos.set(Math.sin(phi) * Math.cos(theta) * rad, Math.cos(phi) * rad, Math.sin(phi) * Math.sin(theta) * rad);
        const ahead = s + 0.08;
        const th2 = ahead * 2.1 + Math.sin(ahead * 0.7) * 0.8;
        const ph2 = 1.2 + Math.sin(ahead * 0.9) * 0.55;
        this.desiredTarget.set(Math.sin(ph2) * Math.cos(th2), Math.cos(ph2), Math.sin(ph2) * Math.sin(th2)).multiplyScalar(r * 0.98);
        break;
      }
      case 'cinematic': {
        if (!this.path || !this.targetPath) this.buildPaths();
        const u = (this.t * this.speed * Math.max(0.15, rotationSpeed) / 75) % 1;
        this.path!.getPointAt(u, this.desiredPos);
        this.targetPath!.getPointAt(u, this.desiredTarget);
        break;
      }
      case 'tracking': {
        const tr = track?.();
        if (tr) {
          if (this.trackSmooth.lengthSq() === 0) { this.trackSmooth.copy(tr.position); this.trackAhead.copy(tr.ahead); }
          const k = 1 - Math.exp(-dt * 3.5);
          this.trackSmooth.lerp(tr.position, k);
          this.trackAhead.lerp(tr.ahead, k);
          const dir = this.trackAhead.clone().sub(this.trackSmooth).normalize();
          const out = this.trackSmooth.clone().normalize();
          this.desiredPos.copy(this.trackSmooth).addScaledVector(dir, -r * 0.14).addScaledVector(out, r * 0.09);
          this.desiredTarget.copy(this.trackAhead);
        } else {
          this.desiredPos.set(0, r * 0.3, r * 2.2);
          this.desiredTarget.set(0, 0, 0);
        }
        break;
      }
    }
    if (this.blend < 1) {
      cam.position.lerpVectors(this.fromPos, this.desiredPos, ease);
      this.curTarget.lerpVectors(this.fromTarget, this.desiredTarget, ease);
    } else {
      const k = this.mode === 'tracking' ? 1 : 1 - Math.exp(-dt * 6);
      cam.position.lerp(this.desiredPos, k);
      this.curTarget.lerp(this.desiredTarget, k);
    }
    cam.lookAt(this.curTarget);
    this.controls.target.copy(this.curTarget);
  }

  dispose(): void {
    this.controls.dispose();
  }
}
