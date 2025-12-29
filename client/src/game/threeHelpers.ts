import * as THREE from 'three';

export const SCALE_FACTOR = 1e-9; // meters -> world units (same idea as your map)
export const KM_PER_AU = 149_597_870.7;

export function mToWorld(posM: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(posM.x * SCALE_FACTOR, posM.y * SCALE_FACTOR, posM.z * SCALE_FACTOR);
}

export function formatDistanceMeters(m: number): string {
  const km = m / 1000;
  if (km >= KM_PER_AU * 0.5) return `${(km / KM_PER_AU).toFixed(2)} AU`;
  return `${km.toFixed(2)} km`;
}

export function safeDispose(obj: THREE.Object3D) {
  obj.traverse((o: any) => {
    if (o.geometry?.dispose) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m: any) => m.dispose?.());
      else o.material.dispose?.();
    }
  });
}

export function worldToM(posW: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: posW.x / SCALE_FACTOR, y: posW.y / SCALE_FACTOR, z: posW.z / SCALE_FACTOR };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
