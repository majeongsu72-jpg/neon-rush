import * as THREE from 'three';
import { Sky, type SkyParams } from './Sky';

export interface EnvPanel {
  dir: [number, number, number];
  color: number;
  intensity: number;
  w: number;
  h: number;
}

/**
 * Pre-filtered environment map from a tiny procedural scene (sky + emissive
 * "neon" panels). Gives car paint, glass and wet asphalt coloured reflections.
 */
export function buildEnvMap(
  renderer: THREE.WebGLRenderer,
  sky: SkyParams,
  panels: EnvPanel[],
): { texture: THREE.Texture; dispose: () => void } {
  const scene = new THREE.Scene();
  const s = new Sky(sky, 60);
  scene.add(s.mesh);
  const disposables: { dispose(): void }[] = [s];
  for (const p of panels) {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(p.color).multiplyScalar(p.intensity),
      side: THREE.DoubleSide,
      fog: false,
    });
    const geo = new THREE.PlaneGeometry(p.w, p.h);
    const m = new THREE.Mesh(geo, mat);
    const dir = new THREE.Vector3(...p.dir).normalize();
    m.position.copy(dir).multiplyScalar(40);
    m.lookAt(0, 0, 0);
    scene.add(m);
    disposables.push(mat, geo);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.035, 0.1, 100, { size: 256 });
  pmrem.dispose();
  for (const d of disposables) d.dispose();
  return {
    texture: rt.texture,
    dispose: () => rt.dispose(),
  };
}
