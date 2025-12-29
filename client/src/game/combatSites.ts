import * as THREE from "three";
import { SCALE_FACTOR } from "./threeHelpers";

export type CombatSite = {
  key: string;
  name: string;
  posWorld: THREE.Vector3;
};

export const DEFAULT_SITE_STANDOFF_M = 10_000;

export function spawnDefaultCombatSite(
  primaryPlanetPosWorld: THREE.Vector3 | null,
  primaryPlanetRadiusWorld: number | null,
  index = 0
): CombatSite {
  const key = `combat_site:${index}`;
  const name = `Combat Site ${index + 1}`;

  // If we have a planet, place the site slightly "above" it; otherwise a small fixed offset from origin.
  const base = primaryPlanetPosWorld ? primaryPlanetPosWorld.clone() : new THREE.Vector3(0.02, 0, 0);

  const offsetWorld =
    (primaryPlanetRadiusWorld ?? 0) + 250_000 * SCALE_FACTOR; // ~250km above the surface

  base.add(new THREE.Vector3(0, 1, 0).multiplyScalar(Math.max(offsetWorld, 0.0002)));

  return { key, name, posWorld: base };
}

export function computeSiteWarpInWorld(
  shipPosWorld: THREE.Vector3,
  sitePosWorld: THREE.Vector3,
  standoffM: number = DEFAULT_SITE_STANDOFF_M
) {
  // Warp to a point standoffM away from the site, on the side facing the ship.
  const toShip = shipPosWorld.clone().sub(sitePosWorld);
  if (toShip.lengthSq() < 1e-12) toShip.set(1, 0, 0);
  else toShip.normalize();

  return sitePosWorld.clone().add(toShip.multiplyScalar(standoffM * SCALE_FACTOR));
}
