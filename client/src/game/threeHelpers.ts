import * as THREE from 'three';

export const SCALE_FACTOR = 1e-9; // meters -> world units (same idea as your map)
export const KM_PER_AU = 149_597_870.7;

export function mToWorld(v: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(v.x * SCALE_FACTOR, v.y * SCALE_FACTOR, v.z * SCALE_FACTOR);
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
