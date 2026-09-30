import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { buildCarModel, setWheelPose, type CarModel } from '../vehicle/CarModel';
import { carById } from '../vehicle/specs';
import { buildEnvMap } from '../world/Env';
import { Sky } from '../world/Sky';
import { glowTexture } from '../world/textures';

/**
 * Car-select studio: turntable, mirror floor, neon rim lights. Rendered
 * instead of the world while the car select screen is open.
 */
export class Showroom {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private model: CarModel | null = null;
  private turntable = new THREE.Group();
  private key = '';
  private time = 0;
  private readonly disposables: { dispose(): void }[] = [];
  private reflector: Reflector;
  private rings: THREE.Mesh[] = [];
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpR = new THREE.Vector3();
  private readonly tmpL = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(gl: THREE.WebGLRenderer, aspect: number) {
    this.camera = new THREE.PerspectiveCamera(34, aspect, 0.1, 200);
    const skyP = {
      zenith: new THREE.Color(0x020207),
      mid: new THREE.Color(0x07061a),
      horizon: new THREE.Color(0x1a0d33),
      ground: new THREE.Color(0x020205),
      sunDir: new THREE.Vector3(0, 1, 0),
      sunColor: new THREE.Color(0xffffff),
      sunSize: 0,
      sunStripes: 0,
      glowColor: new THREE.Color(0x5a1a8a),
      glowStrength: 0.5,
      stars: 0.4,
      clouds: 0,
      cloudColor: new THREE.Color(0),
    };
    const sky = new Sky(skyP, 90);
    this.scene.add(sky.mesh);
    this.disposables.push(sky);
    const env = buildEnvMap(gl, skyP, [
      { dir: [0, 1, 0.1], color: 0xffffff, intensity: 3.5, w: 40, h: 14 },
      { dir: [1, 0.3, 0.4], color: 0x19f5ff, intensity: 5, w: 20, h: 30 },
      { dir: [-1, 0.3, -0.2], color: 0xff2bd6, intensity: 5, w: 20, h: 30 },
      { dir: [0, 0.2, -1], color: 0x7a5bff, intensity: 3, w: 30, h: 8 },
    ]);
    this.disposables.push(env);
    this.scene.environment = env.texture;
    this.scene.fog = new THREE.FogExp2(0x05040b, 0.022);

    this.scene.add(new THREE.HemisphereLight(0x6a6aff, 0x100818, 0.5));
    const keyL = new THREE.DirectionalLight(0xffffff, 1.6);
    keyL.position.set(4, 9, 6);
    this.scene.add(keyL);
    const rimA = new THREE.DirectionalLight(0x19f5ff, 2.2);
    rimA.position.set(-8, 3, -6);
    const rimB = new THREE.DirectionalLight(0xff2bd6, 2.2);
    rimB.position.set(8, 3, -4);
    this.scene.add(rimA, rimB);

    this.reflector = new Reflector(new THREE.CircleGeometry(40, 64), {
      clipBias: 0.003,
      textureWidth: 1024,
      textureHeight: 1024,
      color: 0x2a2838,
    });
    this.reflector.rotation.x = -Math.PI / 2;
    this.scene.add(this.reflector);
    // dark glossy overlay to dim the mirror with distance
    const overlay = new THREE.Mesh(
      new THREE.CircleGeometry(40, 64),
      new THREE.MeshBasicMaterial({ map: glowTexture(256, 0.8), color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    (overlay.material as THREE.MeshBasicMaterial).alphaMap = (overlay.material as THREE.MeshBasicMaterial).map;
    (overlay.material as THREE.MeshBasicMaterial).map = null;
    overlay.rotation.x = -Math.PI / 2;
    overlay.position.y = 0.005;
    this.scene.add(overlay);
    this.disposables.push(overlay.geometry, overlay.material as THREE.Material);

    // neon floor rings
    for (const [r, col] of [
      [3.6, new THREE.Color(0.2, 2.2, 3)],
      [3.75, new THREE.Color(3, 0.3, 2.4)],
      [7.5, new THREE.Color(0.6, 0.4, 2.5)],
    ] as [number, THREE.Color][]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.05, 128), new THREE.MeshBasicMaterial({ color: col }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.01;
      this.scene.add(ring);
      this.rings.push(ring);
      this.disposables.push(ring.geometry, ring.material as THREE.Material);
    }
    this.scene.add(this.turntable);
  }

  setCar(carId: string, paint: number): void {
    const key = `${carId}:${paint}`;
    if (key === this.key) return;
    this.key = key;
    if (this.model) {
      this.turntable.remove(this.model.root);
      this.model.dispose();
    }
    const spec = carById(carId);
    this.model = buildCarModel(spec, spec.paints[paint % spec.paints.length]);
    this.model.root.matrixAutoUpdate = true;
    this.model.shadow.visible = true;
    this.turntable.add(this.model.root);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number): void {
    this.time += dt;
    this.turntable.rotation.y = this.time * 0.35 + 0.6;
    const t = this.time;
    // camera slowly drifting around the right side, car framed off-centre (UI on the left)
    const a = 0.55 + Math.sin(t * 0.18) * 0.18;
    const r = 10.5;
    this.camera.position.set(Math.cos(a) * r, 1.7 + Math.sin(t * 0.3) * 0.15, Math.sin(a) * r);
    // aim left of the car so it sits in the right half of the frame (UI is on the left)
    const dir = this.tmpV.copy(this.camera.position).negate().setY(0).normalize();
    const right = this.tmpR.crossVectors(dir, this.up).normalize();
    const look = this.tmpL.set(0, 0.55, 0).addScaledVector(right, -2.6 * Math.min(1, this.camera.aspect / 1.4));
    this.camera.lookAt(look);
    if (this.model) setWheelPose(this.model, 0, Math.sin(t * 0.5) * 0.25, 0);
    this.rings.forEach((ring, i) => {
      const m = ring.material as THREE.MeshBasicMaterial;
      m.opacity = 1;
      ring.scale.setScalar(1 + Math.sin(t * 1.5 + i) * 0.004);
    });
  }

  dispose(): void {
    this.model?.dispose();
    this.reflector.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
