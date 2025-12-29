import * as THREE from "three";
import { SCALE_FACTOR } from "./threeHelpers";

export type NpcSpec = {
  archetype: "basic" | "boss";
  maxHp: number;

  // Movement / spacing
  speed_mps: number;
  desiredRange_m: number;

  // Weapon
  range_m: number;
  cooldownMs: number;
  damage: { armor: number; hull: number };
};

export const BASIC_NPC_SPEC: NpcSpec = {
  archetype: "basic",
  maxHp: 40,
  speed_mps: 1200,
  desiredRange_m: 5_000,
  range_m: 20_000,
  cooldownMs: 1100,
  damage: { armor: 6, hull: 4 },
};

export const BOSS_NPC_SPEC: NpcSpec = {
  archetype: "boss",
  maxHp: 180,
  speed_mps: 1450,
  desiredRange_m: 5_000,
  range_m: 28_000,
  cooldownMs: 850,
  damage: { armor: 10, hull: 8 },
};

export type SpawnedNpc = {
  key: string;
  name: string;
  spec: NpcSpec;

  posWorld: THREE.Vector3;
  hp: number;

  // A stable strafe direction to make them feel less “on rails”.
  strafeDir: THREE.Vector3;

  nextFireAt: number;
};

function pseudoRand(seed: number) {
  // deterministic 0..1
  const x = Math.sin(seed * 999.123 + 0.12345) * 43758.5453123;
  return x - Math.floor(x);
}

function orthonormalStrafe(dirToShip: THREE.Vector3, seed: number) {
  const up = Math.abs(dirToShip.y) < 0.92 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const s = new THREE.Vector3().crossVectors(dirToShip, up).normalize();
  const t = new THREE.Vector3().crossVectors(dirToShip, s).normalize();

  // rotate in the plane
  const a = pseudoRand(seed) * Math.PI * 2;
  return s.multiplyScalar(Math.cos(a)).add(t.multiplyScalar(Math.sin(a))).normalize();
}

export function spawnNpcWave(sitePosWorld: THREE.Vector3, wave: 1 | 2 | 3) {
  const now = performance.now();
  const out: SpawnedNpc[] = [];

  if (wave === 3) {
    // boss
    const seed = 3000 + wave * 17;
    const offsetM = 8_000;
    const ang = pseudoRand(seed) * Math.PI * 2;
    const off = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang)).multiplyScalar(offsetM * SCALE_FACTOR);

    const pos = sitePosWorld.clone().add(off);
    const toShip = new THREE.Vector3(1, 0, 0);
    const strafe = orthonormalStrafe(toShip, seed);

    out.push({
      key: `npc:wave:${wave}:boss`,
      name: "Boss NPC",
      spec: BOSS_NPC_SPEC,
      posWorld: pos,
      hp: BOSS_NPC_SPEC.maxHp,
      strafeDir: strafe,
      nextFireAt: now + 650,
    });

    return out;
  }

  // 3 basics
  for (let i = 0; i < 3; i++) {
    const seed = 1000 + wave * 31 + i * 97;
    const offsetM = 6_500 + i * 1_000;
    const ang = (i / 3) * Math.PI * 2 + pseudoRand(seed) * 0.6;

    const off = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang)).multiplyScalar(offsetM * SCALE_FACTOR);
    const pos = sitePosWorld.clone().add(off);

    const toShip = new THREE.Vector3(1, 0, 0);
    const strafe = orthonormalStrafe(toShip, seed);

    out.push({
      key: `npc:wave:${wave}:${i}`,
      name: `NPC ${wave}-${i + 1}`,
      spec: BASIC_NPC_SPEC,
      posWorld: pos,
      hp: BASIC_NPC_SPEC.maxHp,
      strafeDir: strafe,
      nextFireAt: now + 400 + i * 160,
    });
  }

  return out;
}
