// client/src/game/GameCanvas.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

import type { DbConnection } from "../module_bindings";
import { loadSystemScene, type Celestial } from "../esi";
import {
  SCALE_FACTOR,
  mToWorld,
  formatDistanceMeters,
  safeDispose,
} from "./threeHelpers";

import { DEFAULT_SHIP_STATS } from "./shipConfig";
import { spawnDefaultCombatSite, computeSiteWarpInWorld } from "./combatSites";
import { spawnNpcWave, type NpcSpec } from "./npcs";

import "./game.css";

type Props = {
  conn: DbConnection; // reserved for multiplayer; currently unused
  identityHex: string;
};

type HoverInfo = { name: string; kind: string; distMeters: number };

const SYSTEM_ID = 30002407;

// If ESI can't provide radius (moons), fall back
const FALLBACK_RADIUS_M: Record<Celestial["kind"], number> = {
  star: 500_000_000,
  planet: 6_000_000,
  moon: 400_000,
  stargate: 10_000,
  station: 15_000,
};

const WARP_IN_BUFFER_M = 10_000;

const WARP_ALIGN_SPEED_FRAC = 0.75; // must be at 75% sublight max before entering warp
const WARP_ALIGN_ANGLE_EPS = THREE.MathUtils.degToRad(3); // degrees from desired dir
const WARP_ALIGN_MIN_TIME = 0.35; // prevents “instant” warp from standstill

// Lock constraints
const LOCK_RANGE_M = 100_000; // 100 km
const MAX_LOCKS = 5;

// Sublight
const SUBLIGHT_MAX_SPEED = 3000 * SCALE_FACTOR; // world units / sec
const SUBLIGHT_ACCEL = 900 * SCALE_FACTOR;
const SUBLIGHT_DECEL = 1200 * SCALE_FACTOR;

// Warp feel
const WARP_MAX_SPEED = 18.0;
const WARP_ACCEL = 2.4;
const WARP_DECEL = 2.8;
const WARP_MIN_SPEED = 0.22;

// Camera distances
const CAMERA_MAX_DISTANCE_DEFAULT = 0.006;
const CAMERA_MAX_DISTANCE_WARP = 0.0025;

// Sprite: constant screen size (px)
const SPRITE_PX_BODY = 14;
const SPRITE_PX_STAR = 18;
const SPRITE_PX_SITE = 16;
const SPRITE_PX_NPC = 16;
const SPRITE_SCALE_MIN = 0.0000005;
const SPRITE_SCALE_MAX = 0.5;

// Bloom
const BLOOM_STRENGTH = 1.05;
const BLOOM_RADIUS = 0.55;
const BLOOM_THRESHOLD = 0.93;

// Lighting tuning
const EXPOSURE = 1.25;

// You already tuned these — keeping your current values
const AMBIENT_INTENSITY = 0.045;
const HEMI_INTENSITY = 0.035;

// Star lights (world)
const STAR_KEY_INTENSITY = 95.0;
const STAR_KEY_DECAY = 1.7;
const STAR_FILL_INTENSITY = 1.15;
const STAR_FILL_DECAY = 0.0;

// Bounce lights (global fill, on both layers)
const BOUNCE_KEY_INTENSITY = 0.52;
const BOUNCE_BACK_INTENSITY = 0.46;
const BOUNCE_COLOR = 0xbfd6ff;
const BOUNCE_BACK_COLOR = 0x221b2a;

// Base subtle luminance on bodies
const BODY_BASE_LUMINANCE_PLANET = 0.038;
const BODY_BASE_LUMINANCE_MOON = 0.032;
const BODY_BASE_LUMINANCE_STATION = 0.028;
const BODY_BASE_LUMINANCE_GATE = 0.020;

// Ship subtle luminance
const SHIP_BASE_LUMINANCE = 0.050;

// Warp tunnel world-space
const WARP_TUNNEL_RADIUS = 0.014;
const WARP_TUNNEL_LENGTH = 0.12;
const WARP_TUNNEL_CENTER_FORWARD = 0.06;

// Turning / alignment
const ALIGN_TURN_RATE_RAD = THREE.MathUtils.degToRad(42); // slower align
const NAV_DIR_SMOOTHING = 1.0; // derived from turn rate (keep 1.0)

// Layers: 0 = world, 1 = ship layer
const LAYER_WORLD = 0;
const LAYER_SHIP = 1;

// Tracer (gun line)
const TRACER_TTL_S = 0.11;
const TRACER_INTENSITY = 6.0;

// NPC visuals
const NPC_SPHERE_RADIUS_M = 350; // optional red sphere size
const NPC_SPHERE_RADIUS_WORLD = NPC_SPHERE_RADIUS_M * SCALE_FACTOR;

// Encounter
const ENCOUNTER_WAVE_DELAY_MS = 1200;

type SpaceKind = Celestial["kind"] | "combat_site" | "npc";

type CelestialMeta = Celestial & {
  radiusWorld: number;
  key: string;
  posWorld: THREE.Vector3;
  warpInWorld: THREE.Vector3;
};

type CombatSiteMeta = {
  key: string;
  kind: "combat_site";
  name: string;
  posWorld: THREE.Vector3;
};

type NpcMeta = {
  key: string;
  kind: "npc";
  name: string;
  posWorld: THREE.Vector3;

  hp: number;
  maxHp: number;

  wave: number;
  spec: NpcSpec;

  nextFireAt: number;
  strafeDir: THREE.Vector3;

  mesh: THREE.Mesh;
  sprite: THREE.Sprite;
};

type SpaceMeta = CelestialMeta | CombatSiteMeta | NpcMeta;

type OverviewRow = {
  key: string;
  name: string;
  kind: SpaceKind;
  distMeters: number;
};

const KIND_LABEL: Record<SpaceKind, string> = {
  star: "STAR",
  planet: "PLANET",
  moon: "MOON",
  stargate: "GATE",
  station: "STATION",
  combat_site: "COMBAT",
  npc: "NPC",
};

function makeMarkerTexture(kind: SpaceKind) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;

  let fill =
    kind === "star"
      ? "#FFD27D"
      : kind === "planet"
        ? "#38FF7F"
        : kind === "moon"
          ? "#B0B0B0"
          : kind === "stargate"
            ? "#33B6FF"
            : kind === "station"
              ? "#FF4CF0"
              : kind === "combat_site"
                ? "#FFC94A"
                : "#FF3B3B"; // npc

  ctx.clearRect(0, 0, 64, 64);

  const grd = ctx.createRadialGradient(32, 32, 3, 32, 32, 28);
  grd.addColorStop(0, fill);
  grd.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(32, 32, 28, 0, Math.PI * 2);
  ctx.fill();

  // inner dot
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(32, 32, 8.5, 0, Math.PI * 2);
  ctx.fill();

  // ring
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(32, 32, 10.5, 0, Math.PI * 2);
  ctx.stroke();

  // NPC cross
  if (kind === "npc") {
    ctx.strokeStyle = "rgba(255,70,70,0.95)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(18, 18);
    ctx.lineTo(46, 46);
    ctx.moveTo(46, 18);
    ctx.lineTo(18, 46);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function radiusMetersToWorld(kind: Celestial["kind"], radius_m?: number) {
  const r =
    typeof radius_m === "number" && radius_m > 0
      ? radius_m
      : FALLBACK_RADIUS_M[kind];
  return r * SCALE_FACTOR;
}

function centerDistanceMeters(shipPosWorld: THREE.Vector3, posWorld: THREE.Vector3) {
  return shipPosWorld.distanceTo(posWorld) / SCALE_FACTOR;
}

// For overview: show surface-ish distance for big bodies (except star)
function effectiveDistanceMeters(shipPosWorld: THREE.Vector3, meta: SpaceMeta) {
  const centerDistMeters = shipPosWorld.distanceTo(meta.posWorld) / SCALE_FACTOR;
  if (meta.kind === "star" || meta.kind === "combat_site" || meta.kind === "npc") return centerDistMeters;

  const c = meta as CelestialMeta;
  const radiusMeters = c.radiusWorld / SCALE_FACTOR;
  const adjusted = centerDistMeters - (radiusMeters + WARP_IN_BUFFER_M);
  return Math.max(0, adjusted);
}

// ✅ Warp-in points should be on the sun-facing (lit) side of the body, most of the time.
function computeFixedWarpInWorld(
  starPosWorld: THREE.Vector3,
  bodyPosWorld: THREE.Vector3,
  bodyRadiusWorld: number
) {
  // Direction from body toward star = sun-facing direction
  const dirToStar = starPosWorld.clone().sub(bodyPosWorld);
  if (dirToStar.lengthSq() < 1e-12) dirToStar.set(1, 0, 0);
  else dirToStar.normalize();

  const offsetWorld = bodyRadiusWorld + WARP_IN_BUFFER_M * SCALE_FACTOR;
  return bodyPosWorld.clone().add(dirToStar.multiplyScalar(offsetWorld));
}

// More numerically-stable segment-sphere test
function segmentIntersectsSphere(
  a: THREE.Vector3,
  b: THREE.Vector3,
  center: THREE.Vector3,
  radius: number
): boolean {
  const ab = b.clone().sub(a);
  const abLenSq = ab.lengthSq();
  if (abLenSq < 1e-16) return a.distanceTo(center) <= radius;

  const t = THREE.MathUtils.clamp(center.clone().sub(a).dot(ab) / abLenSq, 0, 1);
  const closest = a.clone().add(ab.multiplyScalar(t));
  return closest.distanceTo(center) <= radius;
}

const AU_METERS = 149_597_870_700; // 1 AU in meters

function formatSpeed(mps: number, unit: "mps" | "aups") {
  if (!isFinite(mps)) return unit === "aups" ? "0.00 AU/s" : "0 m/s";

  if (unit === "aups") {
    const aups = mps / AU_METERS;
    return `${aups.toFixed(2)} AU/s`;
  }

  const abs = Math.abs(mps);
  if (abs >= 10_000) return `${(mps / 1000).toFixed(1)} km/s`;
  if (abs >= 1000) return `${mps.toFixed(0)} m/s`;
  return `${mps.toFixed(0)} m/s`;
}

// --- Sky ----------------------------------------------------------------------

function createProceduralSkySphere() {
  const geom = new THREE.SphereGeometry(200_000, 48, 24);
  geom.scale(-1, 1, 1);

  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec3 vPos;
      void main(){
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vPos;
      uniform float uTime;

      float hash(vec2 p){
        return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123);
      }

      void main(){
        vec3 p = normalize(vPos);
        float d = dot(p, vec3(0.0, 1.0, 0.0));
        vec3 base = mix(vec3(0.01,0.01,0.02), vec3(0.0,0.0,0.0), clamp(d*0.5+0.5,0.0,1.0));

        vec2 uv = vec2(atan(p.z, p.x), asin(p.y));
        uv *= 95.0;
        float h = hash(floor(uv));
        float star = step(0.9965, h);
        float twinkle = 0.8 + 0.2 * sin(uTime * 1.2 + h * 40.0);
        vec3 stars = vec3(1.0) * star * twinkle;

        gl_FragColor = vec4(base + stars * 0.85, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = "SkySphere";
  mesh.renderOrder = -10_000;
  mesh.layers.set(LAYER_WORLD);
  return { mesh, mat };
}

// --- Warp tunnel --------------------------------------------------------------

function createWarpTunnelAuroraCylinderWorld() {
  const geom = new THREE.CylinderGeometry(
    WARP_TUNNEL_RADIUS,
    WARP_TUNNEL_RADIUS,
    WARP_TUNNEL_LENGTH,
    220,
    1,
    true
  );
  geom.rotateX(Math.PI / 2);

  const uniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 0 },
    uSpeed: { value: 0 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uIntensity;
      uniform float uSpeed;
      varying vec2 vUv;

      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123); }
      float noise(vec2 p){
        vec2 i=floor(p), f=fract(p);
        float a=hash(i), b=hash(i+vec2(1.0,0.0));
        float c=hash(i+vec2(0.0,1.0)), d=hash(i+vec2(1.0,1.0));
        vec2 u=f*f*(3.0-2.0*f);
        return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
      }

      void main(){
        float ang = vUv.x * 6.28318530718;
        vec2 ring = vec2(cos(ang), sin(ang));

        float scroll = 2.0 + 4.0 * uSpeed;
        float y = vUv.y * 12.0 - uTime * scroll;

        float n1 = noise(ring * 8.0  + vec2(0.0, y * 0.25));
        float n2 = noise(ring * 14.0 + vec2(4.1, y * 0.55));
        float n  = n1*0.6 + n2*0.4;

        float curtain = smoothstep(0.35, 1.0, n);
        float wav = 0.5 + 0.5 * sin(ang * (3.0 + uSpeed*1.5) + y*1.7 + n*1.7);

        vec3 c1 = vec3(0.10, 0.65, 0.50);
        vec3 c2 = vec3(0.12, 0.35, 0.85);
        vec3 col = mix(c1, c2, wav * 0.65);

        float endFade = smoothstep(0.00, 0.18, vUv.y) * (1.0 - smoothstep(0.82, 1.00, vUv.y));
        float seamFade = smoothstep(0.0, 0.01, vUv.x) * (1.0 - smoothstep(0.99, 1.0, vUv.x));

        float alpha = (curtain * 0.30 + wav * 0.18) * endFade * seamFade * (0.16 + 0.20*uSpeed) * uIntensity;

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = 10_000;
  mesh.name = "WarpAuroraCylinderWorld";
  mesh.layers.set(LAYER_WORLD);

  return { mesh, uniforms, geom, mat };
}

function createWarpFlashPlane() {
  const geom = new THREE.PlaneGeometry(2, 2);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uAlpha: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uAlpha;
      varying vec2 vUv;
      void main(){
        vec2 p = vUv - 0.5;
        float r = length(p) * 1.35;
        float falloff = smoothstep(1.0, 0.0, r);
        gl_FragColor = vec4(vec3(1.0), uAlpha * falloff);
      }
    `,
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = 20_000;
  mesh.name = "WarpFlash";
  mesh.layers.set(LAYER_WORLD);
  return { mesh, mat };
}

export default function GameCanvas({ identityHex }: Props) {
  const canvasHostRef = useRef<HTMLDivElement | null>(null);

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const composerRef = useRef<EffectComposer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const camRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const rayRef = useRef<THREE.Raycaster | null>(null);
  const clockRef = useRef(new THREE.Clock());

  const shipRef = useRef<THREE.Mesh | null>(null);
  const shipPosRef = useRef(new THREE.Vector3(0, 0, 0));
  const shipVelRef = useRef(new THREE.Vector3(0, 0, 0));
  const shipForwardRef = useRef(new THREE.Vector3(1, 0, 0));
  const lastShipPosRef = useRef(new THREE.Vector3(0, 0, 0));

  const navDirRef = useRef(new THREE.Vector3(1, 0, 0)); // smoothed movement direction
  const shipShadowMultRef = useRef(1.0); // smoothed sunlight occlusion multiplier

  const starPosWorldRef = useRef(new THREE.Vector3(0, 0, 0));

  const skyRef = useRef<{ mesh: THREE.Mesh; mat: THREE.ShaderMaterial } | null>(null);

  const warpTunnelRef = useRef<{
    mesh: THREE.Mesh;
    uniforms: {
      uTime: { value: number };
      uIntensity: { value: number };
      uSpeed: { value: number };
    };
    geom: THREE.BufferGeometry;
    mat: THREE.ShaderMaterial;
  } | null>(null);

  const warpFlashRef = useRef<{ mesh: THREE.Mesh; mat: THREE.ShaderMaterial } | null>(null);
  const warpExitFlashRef = useRef<number>(0);

  const sublightDirRef = useRef<THREE.Vector3 | null>(null);

  const approachRef = useRef<{
    active: boolean;
    targetPos: THREE.Vector3;
    targetRadius: number;
    targetKey: string;
  } | null>(null);

  const warpRef = useRef<{
    active: boolean;
    phase: "align" | "warp";
    destPos: THREE.Vector3;
    centerPos: THREE.Vector3;
    targetName: string;
    targetKey: string;
    alignTime: number;
  } | null>(null);

  // Markers for picking (celestials + sites + npc markers)
  const spriteMetaRef = useRef<Map<THREE.Object3D, SpaceMeta>>(new Map());
  const spritesRef = useRef<THREE.Sprite[]>([]);
  const spriteMatsRef = useRef<Map<THREE.Sprite, THREE.SpriteMaterial>>(new Map());

  const celestialsRef = useRef<CelestialMeta[]>([]);
  const combatSitesRef = useRef<CombatSiteMeta[]>([]);
  const npcsRef = useRef<NpcMeta[]>([]);

  const encounterRef = useRef<{ siteKey: string; wave: 0 | 1 | 2 | 3; nextWaveAt: number } | null>(null);

  // Tracers
  const tracersRef = useRef<Array<{ line: THREE.Line; born: number; ttl: number }>>([]);

  // Bounce lights refs so we can update their direction after ESI load
  const bounceKeyRef = useRef<THREE.DirectionalLight | null>(null);
  const bounceBackRef = useRef<THREE.DirectionalLight | null>(null);

  // World star lights (do NOT affect ship)
  const worldStarLightsRef = useRef<{ key: THREE.PointLight; fill: THREE.PointLight } | null>(null);

  // Ship-only star lights (these get occluded by planets)
  const shipStarLightsRef = useRef<{ key: THREE.PointLight; fill: THREE.PointLight } | null>(null);

  const [systemName, setSystemName] = useState("Loading…");
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    target: SpaceMeta;
  } | null>(null);

  const shipStats = DEFAULT_SHIP_STATS;

  const [armor, setArmor] = useState(shipStats.maxArmor);
  const [hull, setHull] = useState(shipStats.maxHull);

  const armorRef = useRef(shipStats.maxArmor);
  const hullRef = useRef(shipStats.maxHull);

  const [speedMps, setSpeedMps] = useState(0);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedKeyRef = useRef<string | null>(null);

  const [lockedKeys, setLockedKeys] = useState<string[]>([]);
  const lockedKeysRef = useRef<string[]>([]);
  const [activeLockedKey, setActiveLockedKey] = useState<string | null>(null);
  const activeLockedKeyRef = useRef<string | null>(null);

  // 0..100 hp display for locked UI (celestials can stay 100; NPCs update)
  const [targetTestHp, setTargetTestHp] = useState<Record<string, number>>({});
  const targetTestHpRef = useRef<Record<string, number>>({});

  const [firing, setFiring] = useState(false);
  const firingRef = useRef(false);
  const nextFireAtRef = useRef<number>(0);

  const [overviewRows, setOverviewRows] = useState<OverviewRow[]>([]);

  useEffect(() => {
    selectedKeyRef.current = selectedKey;
  }, [selectedKey]);

  useEffect(() => {
    lockedKeysRef.current = lockedKeys;
  }, [lockedKeys]);

  useEffect(() => {
    activeLockedKeyRef.current = activeLockedKey;
  }, [activeLockedKey]);

  useEffect(() => {
    targetTestHpRef.current = targetTestHp;
  }, [targetTestHp]);

  useEffect(() => {
    firingRef.current = firing;
  }, [firing]);

  useEffect(() => {
    armorRef.current = armor;
  }, [armor]);

  useEffect(() => {
    hullRef.current = hull;
  }, [hull]);

  const findSpaceByKey = (key: string | null): SpaceMeta | null => {
    if (!key) return null;

    for (const n of npcsRef.current) if (n.key === key) return n;
    for (const s of combatSitesRef.current) if (s.key === key) return s;
    for (const c of celestialsRef.current) if (c.key === key) return c;

    return null;
  };

  const canLockNow = (meta: SpaceMeta) => {
    const shipPos = shipPosRef.current;
    const d = effectiveDistanceMeters(shipPos, meta);
    return d <= LOCK_RANGE_M;
  };

  const ensureLocked = (key: string) => {
    const meta = findSpaceByKey(key);
    if (!meta) return;
    if (!canLockNow(meta)) return;

    setLockedKeys((prev) => {
      if (prev.includes(key)) return prev;
      if (prev.length >= MAX_LOCKS) return prev;
      return [...prev, key];
    });

    // initialize hp bar
    setTargetTestHp((prev) => {
      if (prev[key] != null) return prev;
      if (meta.kind === "npc") {
        const pct = Math.round((meta.hp / Math.max(1, meta.maxHp)) * 100);
        return { ...prev, [key]: pct };
      }
      return { ...prev, [key]: 100 };
    });

    setActiveLockedKey((prev) => prev ?? key);
  };

  const unlockTarget = (key: string) => {
    setLockedKeys((prev) => prev.filter((k) => k !== key));
    setTargetTestHp((prev) => {
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
    setActiveLockedKey((prev) => {
      if (prev !== key) return prev;
      const remaining = lockedKeysRef.current.filter((k) => k !== key);
      return remaining.length ? remaining[0] : null;
    });
    if (selectedKeyRef.current === key) setSelectedKey(null);
  };

  const isLocked = (key: string) => lockedKeysRef.current.includes(key);

  const canFire = useMemo(() => {
    return !!activeLockedKey;
  }, [activeLockedKey]);

  const toggleFire = () => {
    if (!activeLockedKeyRef.current) {
      setFiring(false);
      return;
    }
    setFiring((v) => !v);
  };

  const approachTo = (m: SpaceMeta) => {
    if (warpRef.current?.active) return;
    setSelectedKey(m.key);
    approachRef.current = {
      active: true,
      targetPos: m.posWorld.clone(),
      targetRadius: (m as any).radiusWorld ?? 0,
      targetKey: m.key,
    };
    sublightDirRef.current = null;
    setCtxMenu(null);
  };

  const warpTo = (m: SpaceMeta) => {
    if (warpRef.current?.active) return;
    if (m.kind === "npc") return; // no warp-to NPCs for now

    approachRef.current = null;
    sublightDirRef.current = null;

    const shipPos = shipPosRef.current.clone();

    const dest =
      m.kind === "combat_site"
        ? computeSiteWarpInWorld(shipPos, m.posWorld)
        : (m as CelestialMeta).warpInWorld.clone();

    warpRef.current = {
      active: true,
      phase: "align",
      destPos: dest,
      centerPos: m.posWorld.clone(),
      targetName: m.name,
      targetKey: m.key,
      alignTime: 0,
    };

    setCtxMenu(null);
  };

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;

    while (host.firstChild) host.removeChild(host.firstChild);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    const camera = new THREE.PerspectiveCamera(
      65,
      host.clientWidth / host.clientHeight,
      1e-7,
      1_000_000_000
    );

    camera.layers.enable(LAYER_SHIP);

    camera.position.set(0.00003, 0.000012, 0.00003);
    scene.add(camera);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      logarithmicDepthBuffer: true,
    });

    (renderer as any).useLegacyLights = false;
    (renderer as any).physicallyCorrectLights = true;

    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
    host.appendChild(renderer.domElement);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(
      new UnrealBloomPass(
        new THREE.Vector2(host.clientWidth, host.clientHeight),
        BLOOM_STRENGTH,
        BLOOM_RADIUS,
        BLOOM_THRESHOLD
      )
    );

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.enableRotate = true;

    const shipSizeW = shipStats.size_m * SCALE_FACTOR;
    controls.minDistance = Math.max(0.000002, shipSizeW * 10);
    controls.maxDistance = CAMERA_MAX_DISTANCE_DEFAULT;

    const raycaster = new THREE.Raycaster();

    const sky = createProceduralSkySphere();
    scene.add(sky.mesh);
    skyRef.current = sky;

    // Ambient + hemi should affect both world and ship
    const amb = new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY);
    amb.layers.enable(LAYER_SHIP);
    scene.add(amb);

    const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x08060c, HEMI_INTENSITY);
    hemi.layers.enable(LAYER_SHIP);
    scene.add(hemi);

    // Bounce lights should affect both world and ship (persistent; do NOT delete on system rebuild)
    const bounceKey = new THREE.DirectionalLight(BOUNCE_COLOR, BOUNCE_KEY_INTENSITY);
    bounceKey.position.set(1, 1, 1);
    bounceKey.target.position.set(0, 0, 0);
    bounceKey.castShadow = false;
    bounceKey.userData.godPersistent = true;
    bounceKey.layers.enable(LAYER_SHIP);
    scene.add(bounceKey);
    scene.add(bounceKey.target);
    bounceKeyRef.current = bounceKey;

    const bounceBack = new THREE.DirectionalLight(BOUNCE_BACK_COLOR, BOUNCE_BACK_INTENSITY);
    bounceBack.position.set(-1, -1, -1);
    bounceBack.target.position.set(0, 0, 0);
    bounceBack.castShadow = false;
    bounceBack.userData.godPersistent = true;
    bounceBack.layers.enable(LAYER_SHIP);
    scene.add(bounceBack);
    scene.add(bounceBack.target);
    bounceBackRef.current = bounceBack;

    // Ship cube on ship layer
    const shipSize = shipStats.size_m * SCALE_FACTOR;
    const ship = new THREE.Mesh(
      new THREE.BoxGeometry(shipSize, shipSize, shipSize),
      new THREE.MeshStandardMaterial({
        color: 0xdde6ef,
        emissive: new THREE.Color(0x334455),
        emissiveIntensity: SHIP_BASE_LUMINANCE,
        roughness: 0.65,
        metalness: 0.08,
      })
    );
    ship.position.copy(shipPosRef.current);
    ship.layers.set(LAYER_SHIP);
    scene.add(ship);
    shipRef.current = ship;

    const tunnel = createWarpTunnelAuroraCylinderWorld();
    scene.add(tunnel.mesh);
    warpTunnelRef.current = tunnel;

    const flash = createWarpFlashPlane();
    scene.add(flash.mesh);
    warpFlashRef.current = flash;

    sceneRef.current = scene;
    camRef.current = camera;
    rendererRef.current = renderer;
    composerRef.current = composer;
    controlsRef.current = controls;
    rayRef.current = raycaster;

    controls.target.copy(ship.position);

    const onResize = () => {
      const h = canvasHostRef.current;
      const r = rendererRef.current;
      const c = camRef.current;
      const comp = composerRef.current;
      if (!h || !r || !c || !comp) return;
      c.aspect = h.clientWidth / h.clientHeight;
      c.updateProjectionMatrix();
      r.setSize(h.clientWidth, h.clientHeight);
      comp.setSize(h.clientWidth, h.clientHeight);
    };
    window.addEventListener("resize", onResize);

    const tmp = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const baseAxis = new THREE.Vector3(0, 0, 1);

    const spawnTracer = (fromWorld: THREE.Vector3, toWorld: THREE.Vector3) => {
      const sc = sceneRef.current;
      if (!sc) return;

      const geom = new THREE.BufferGeometry().setFromPoints([fromWorld.clone(), toWorld.clone()]);
      const mat = new THREE.LineBasicMaterial({
        color: new THREE.Color(TRACER_INTENSITY, TRACER_INTENSITY, TRACER_INTENSITY),
        transparent: true,
        opacity: 1,
      });
      (mat as any).toneMapped = false;

      const line = new THREE.Line(geom, mat);
      line.layers.set(LAYER_WORLD);
      line.renderOrder = 9500;
      line.userData.godSystem = true;

      sc.add(line);
      tracersRef.current.push({ line, born: performance.now(), ttl: TRACER_TTL_S });
    };

    const applyDamageToPlayer = (dmgArmor: number, dmgHull: number) => {
      let a = armorRef.current;
      let h = hullRef.current;

      // armor first
      const armorTaken = Math.min(a, dmgArmor);
      a -= armorTaken;

      // overflow armor damage to hull
      const overflow = dmgArmor - armorTaken;
      const hullFromOverflow = Math.max(0, overflow);

      h -= hullFromOverflow;
      h -= dmgHull;

      a = Math.max(0, a);
      h = Math.max(0, h);

      armorRef.current = a;
      hullRef.current = h;
      setArmor(a);
      setHull(h);

      if (h <= 0) {
        // Player “dies” -> respawn where it died (no teleport for now)
        armorRef.current = shipStats.maxArmor;
        hullRef.current = shipStats.maxHull;
        setArmor(shipStats.maxArmor);
        setHull(shipStats.maxHull);

        shipVelRef.current.set(0, 0, 0);
        sublightDirRef.current = null;
        approachRef.current = null;
        warpRef.current = null;
        setFiring(false);
        firingRef.current = false;
      }
    };

    const killNpc = (npc: NpcMeta) => {
      // remove visuals
      npc.mesh.removeFromParent();
      npc.sprite.removeFromParent();
      safeDispose(npc.mesh);
      if (npc.sprite.material) (npc.sprite.material as any).dispose?.();

      // remove from selection arrays
      spritesRef.current = spritesRef.current.filter((s) => s !== npc.sprite);
      spriteMatsRef.current.delete(npc.sprite);
      spriteMetaRef.current.delete(npc.sprite);

      // remove from npc list
      npcsRef.current = npcsRef.current.filter((n) => n.key !== npc.key);

      // if locked, unlock
      if (lockedKeysRef.current.includes(npc.key)) unlockTarget(npc.key);
    };

    const damageNpc = (npc: NpcMeta, dmg: number) => {
      npc.hp = Math.max(0, npc.hp - dmg);
      if (targetTestHpRef.current[npc.key] != null) {
        const pct = Math.round((npc.hp / Math.max(1, npc.maxHp)) * 100);
        setTargetTestHp((prev) => ({ ...prev, [npc.key]: pct }));
      }
      if (npc.hp <= 0) killNpc(npc);
    };

    const performShot = (targetKey: string, originWorld: THREE.Vector3) => {
      const meta = findSpaceByKey(targetKey);
      if (!meta) return;

      spawnTracer(originWorld, meta.posWorld);

      // If NPC: actually damage it
      if (meta.kind === "npc") {
        const dmg = shipStats.weapon.damage.armor + shipStats.weapon.damage.hull;
        damageNpc(meta, dmg);
        return;
      }

      // Otherwise: keep your old “test hp” behavior
      setTargetTestHp((prev) => {
        const cur = prev[targetKey] ?? 100;
        const next = Math.max(0, cur - 5);
        return { ...prev, [targetKey]: next };
      });
    };

    const updateNavDirection = (desired: THREE.Vector3, dt: number) => {
      const nav = navDirRef.current;
      if (desired.lengthSq() < 1e-10) return nav;

      desired.normalize();
      const angle = nav.angleTo(desired);
      if (angle < 1e-6) {
        nav.copy(desired);
        return nav;
      }

      const maxStep = ALIGN_TURN_RATE_RAD * dt * NAV_DIR_SMOOTHING;
      const t = Math.min(1, maxStep / angle);

      nav.lerp(desired, t).normalize();
      return nav;
    };

    const stepEncounter = (nowMs: number) => {
      const enc = encounterRef.current;
      if (!enc) return;

      const alive = npcsRef.current.length;
      if (alive > 0) return;

      if (nowMs < enc.nextWaveAt) return;

      if (enc.wave >= 3) return;

      const nextWave = (enc.wave + 1) as 1 | 2 | 3;
      enc.wave = nextWave;
      enc.nextWaveAt = nowMs + ENCOUNTER_WAVE_DELAY_MS;

      const sc = sceneRef.current;
      if (!sc) return;

      const site = combatSitesRef.current.find((s) => s.key === enc.siteKey);
      if (!site) return;

      const spawned = spawnNpcWave(site.posWorld, nextWave);

      for (const sp of spawned) {
        // sphere
        const npcMat = new THREE.MeshStandardMaterial({
          color: 0xff2a2a,
          emissive: new THREE.Color(0xff0000),
          emissiveIntensity: 1.2,
          roughness: 0.6,
          metalness: 0.0,
        });

        const npcMesh = new THREE.Mesh(
          new THREE.SphereGeometry(NPC_SPHERE_RADIUS_WORLD, 14, 12),
          npcMat
        );
        npcMesh.position.copy(sp.posWorld);
        npcMesh.layers.set(LAYER_WORLD);
        npcMesh.userData.godSystem = true;
        sc.add(npcMesh);

        // marker sprite (red cross)
        const tex = makeMarkerTexture("npc");
        const smat = new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
          depthTest: true,
        });
        const sprite = new THREE.Sprite(smat);
        sprite.position.copy(sp.posWorld);
        sprite.layers.set(LAYER_WORLD);
        sprite.userData.godSystem = true;
        sc.add(sprite);

        const meta: NpcMeta = {
          key: sp.key,
          kind: "npc",
          name: sp.name,
          posWorld: sp.posWorld,
          hp: sp.hp,
          maxHp: sp.spec.maxHp,
          wave: nextWave,
          spec: sp.spec,
          nextFireAt: sp.nextFireAt,
          strafeDir: sp.strafeDir,
          mesh: npcMesh,
          sprite,
        };

        npcsRef.current.push(meta);
        spritesRef.current.push(sprite);
        spriteMatsRef.current.set(sprite, smat);
        spriteMetaRef.current.set(sprite, meta);
      }
    };

    const stepNpcs = (dt: number) => {
      const now = performance.now();
      const shipPos = shipPosRef.current;

      for (const npc of npcsRef.current) {
        // Maintain range ~5km with some strafe
        const toShip = shipPos.clone().sub(npc.posWorld);
        const distWorld = toShip.length();
        const distM = distWorld / SCALE_FACTOR;

        const desiredWorld = npc.spec.desiredRange_m * SCALE_FACTOR;
        const bandWorld = 600 * SCALE_FACTOR; // +/- 0.6km

        let moveDir = new THREE.Vector3();
        if (distWorld < desiredWorld - bandWorld) {
          moveDir.copy(toShip.normalize()).multiplyScalar(-1); // too close -> move away
          moveDir.lerp(npc.strafeDir, 0.25);
        } else if (distWorld > desiredWorld + bandWorld) {
          moveDir.copy(toShip.normalize()); // too far -> move closer
          moveDir.lerp(npc.strafeDir, 0.18);
        } else {
          moveDir.copy(npc.strafeDir); // in band -> strafe
        }

        if (moveDir.lengthSq() < 1e-12) moveDir.set(1, 0, 0);
        else moveDir.normalize();

        const speedWorld = npc.spec.speed_mps * SCALE_FACTOR;
        npc.posWorld.addScaledVector(moveDir, speedWorld * dt);

        npc.mesh.position.copy(npc.posWorld);
        npc.sprite.position.copy(npc.posWorld);

        // Fire if in range
        if (distM <= npc.spec.range_m && now >= npc.nextFireAt) {
          npc.nextFireAt = now + npc.spec.cooldownMs;

          spawnTracer(npc.posWorld, shipPos);
          applyDamageToPlayer(npc.spec.damage.armor, npc.spec.damage.hull);
        }
      }
    };

    const stepMovement = (dt: number) => {
      const shipPos = shipPosRef.current;
      const shipVel = shipVelRef.current;

      // auto-firing loop (player)
      if (firingRef.current) {
        const active = activeLockedKeyRef.current;
        if (!active) {
          firingRef.current = false;
          setFiring(false);
        } else {
          const now = performance.now();
          if (now >= nextFireAtRef.current) {
            if (!lockedKeysRef.current.includes(active)) {
              firingRef.current = false;
              setFiring(false);
            } else {
              const meta = findSpaceByKey(active);
              if (meta) {
                const distMeters = centerDistanceMeters(shipPos, meta.posWorld);
                if (distMeters <= shipStats.weapon.range_m) {
                  performShot(active, shipPos.clone());
                }
              }
              nextFireAtRef.current = now + shipStats.weapon.cooldownMs;
            }
          }
        }
      }

      // warp (two-phase: align -> warp)
      const warp = warpRef.current;
      if (warp?.active) {
        const toDest = warp.destPos.clone().sub(shipPos);
        const dist = toDest.length();

        const stopDist = Math.max(shipStats.size_m * SCALE_FACTOR * 10, 1e-7);

        if (dist <= stopDist) {
          shipPos.copy(warp.destPos);
          shipVel.set(0, 0, 0);
          warpExitFlashRef.current = 1.0;
          warpRef.current = null;
          return;
        }

        const desired = toDest.normalize();

        // --- PHASE 1: ALIGN ---
        if (warp.phase === "align") {
          warp.alignTime += dt;

          const nav = updateNavDirection(desired.clone(), dt);
          shipForwardRef.current.copy(nav);

          const alignSpeed = SUBLIGHT_MAX_SPEED * WARP_ALIGN_SPEED_FRAC;

          const v = shipVel.length();
          let newSpeed = v;

          if (v < alignSpeed) newSpeed = Math.min(alignSpeed, v + SUBLIGHT_ACCEL * dt);
          else newSpeed = Math.max(alignSpeed, v - SUBLIGHT_DECEL * dt);

          shipVel.copy(nav.clone().multiplyScalar(newSpeed));
          shipPos.addScaledVector(shipVel, dt);

          const angle = nav.angleTo(desired);
          const speedOk = newSpeed >= alignSpeed * 0.98;
          const angleOk = angle <= WARP_ALIGN_ANGLE_EPS;
          const timeOk = warp.alignTime >= WARP_ALIGN_MIN_TIME;

          if (angleOk && speedOk && timeOk) {
            warp.phase = "warp";
            navDirRef.current.copy(desired);
            shipForwardRef.current.copy(desired);

            const startWarpSpeed = Math.max(WARP_MIN_SPEED, shipVel.length());
            shipVel.copy(desired.clone().multiplyScalar(startWarpSpeed));
          }

          return;
        }

        // --- PHASE 2: WARP ---
        navDirRef.current.copy(desired);
        shipForwardRef.current.copy(desired);

        const remaining = Math.max(1e-7, dist - stopDist);
        const v = shipVel.length();
        const requiredDecel = (v * v) / (2 * remaining);

        let newSpeed = v;
        if (requiredDecel > WARP_DECEL * 0.92) {
          newSpeed = Math.max(0, v - WARP_DECEL * dt);
        } else {
          newSpeed = Math.min(WARP_MAX_SPEED, v + WARP_ACCEL * dt);
        }
        if (newSpeed > 0) newSpeed = Math.max(newSpeed, WARP_MIN_SPEED);

        shipVel.copy(desired.clone().multiplyScalar(newSpeed));
        shipPos.addScaledVector(shipVel, dt);

        const after = warp.destPos.clone().sub(shipPos);
        if (after.dot(desired) < 0) {
          shipPos.copy(warp.destPos);
          shipVel.set(0, 0, 0);
          warpExitFlashRef.current = 1.0;
          warpRef.current = null;
        }
        return;
      }

      // approach mode
      const approach = approachRef.current;
      if (approach?.active) {
        const to = approach.targetPos.clone().sub(shipPos);
        const dist = to.length();

        const stopDist = Math.max(
          shipStats.size_m * SCALE_FACTOR * 40,
          approach.targetRadius + WARP_IN_BUFFER_M * SCALE_FACTOR
        );

        if (dist <= stopDist) {
          shipVel.set(0, 0, 0);
          approachRef.current = null;
          return;
        }

        const desired = to.normalize();
        const nav = updateNavDirection(desired, dt);
        shipForwardRef.current.copy(nav);

        const remaining = Math.max(1e-7, dist - stopDist);
        const v = shipVel.length();
        const requiredDecel = (v * v) / (2 * remaining);

        let newSpeed = v;
        if (requiredDecel > SUBLIGHT_DECEL * 0.92) {
          newSpeed = Math.max(0, v - SUBLIGHT_DECEL * dt);
        } else {
          newSpeed = Math.min(SUBLIGHT_MAX_SPEED, v + SUBLIGHT_ACCEL * dt);
        }

        shipVel.copy(nav.clone().multiplyScalar(newSpeed));
        shipPos.addScaledVector(shipVel, dt);
        return;
      }

      // manual double-click direction
      const desiredDir = sublightDirRef.current;
      if (!desiredDir) {
        const v = shipVel.length();
        if (v > 0) {
          const newSpeed = Math.max(0, v - SUBLIGHT_DECEL * dt);
          if (newSpeed === 0) shipVel.set(0, 0, 0);
          else shipVel.setLength(newSpeed);
        }
        shipPos.addScaledVector(shipVel, dt);
        return;
      }

      const nav = updateNavDirection(desiredDir.clone().normalize(), dt);
      shipForwardRef.current.copy(nav);

      const currentSpeed = shipVel.length();
      const targetSpeed = SUBLIGHT_MAX_SPEED;

      let newSpeed = currentSpeed;
      if (currentSpeed < targetSpeed) {
        newSpeed = Math.min(targetSpeed, currentSpeed + SUBLIGHT_ACCEL * dt);
      } else {
        newSpeed = Math.max(targetSpeed, currentSpeed - SUBLIGHT_DECEL * dt);
      }

      shipVel.copy(nav.clone().multiplyScalar(newSpeed));
      shipPos.addScaledVector(shipVel, dt);
    };

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      const dt = Math.min(clockRef.current.getDelta(), 0.05);

      const cam = camRef.current;
      const ctrl = controlsRef.current;
      const comp = composerRef.current;
      const shipObj = shipRef.current;
      const tunnelObj = warpTunnelRef.current;
      const flashObj = warpFlashRef.current;
      const skyObj = skyRef.current;

      if (!cam || !ctrl || !comp || !shipObj) return;

      // encounter + npc AI
      stepEncounter(performance.now());
      stepNpcs(dt);

      stepMovement(dt);

      if (skyObj) skyObj.mat.uniforms.uTime.value += dt;

      // camera locked to ship translation
      const newShipPos = shipPosRef.current;
      const lastShipPos = lastShipPosRef.current;
      const delta = newShipPos.clone().sub(lastShipPos);
      if (delta.lengthSq() > 0) cam.position.add(delta);

      shipObj.position.copy(newShipPos);
      ctrl.target.copy(newShipPos);

      // ship faces smoothed nav dir
      const fwdDir = shipForwardRef.current;
      if (fwdDir.lengthSq() > 0.000001) {
        shipObj.lookAt(shipObj.position.clone().add(fwdDir));
      }

      const warping = !!warpRef.current?.active;
      ctrl.maxDistance = warping ? CAMERA_MAX_DISTANCE_WARP : CAMERA_MAX_DISTANCE_DEFAULT;

      // clamp camera distance
      const camToTarget = new THREE.Vector3().copy(cam.position).sub(ctrl.target);
      const camDist = camToTarget.length();
      if (camDist > ctrl.maxDistance) {
        cam.position.copy(ctrl.target.clone().add(camToTarget.multiplyScalar(ctrl.maxDistance / camDist)));
      }
      if (camDist < ctrl.minDistance) {
        cam.position.copy(ctrl.target.clone().add(camToTarget.normalize().multiplyScalar(ctrl.minDistance)));
      }

      // sprites constant screen-size scaling
      const viewportH = Math.max(1, rendererRef.current?.domElement.clientHeight ?? 1);
      const fovRad = THREE.MathUtils.degToRad(cam.fov);
      const pxToWorldAtDist = (dist: number) =>
        (2 * dist * Math.tan(fovRad / 2)) / viewportH;

      const sel = selectedKeyRef.current;

      for (const s of spritesRef.current) {
        const meta = spriteMetaRef.current.get(s);
        if (!meta) continue;

        const d = s.position.distanceTo(cam.position);
        const desiredPx =
          meta.kind === "star"
            ? SPRITE_PX_STAR
            : meta.kind === "combat_site"
              ? SPRITE_PX_SITE
              : meta.kind === "npc"
                ? SPRITE_PX_NPC
                : SPRITE_PX_BODY;

        const worldSize = pxToWorldAtDist(d) * desiredPx;
        const size = THREE.MathUtils.clamp(worldSize, SPRITE_SCALE_MIN, SPRITE_SCALE_MAX);

        s.scale.set(size, size, 1);

        const mat = spriteMatsRef.current.get(s);
        if (mat) {
          if (sel && meta.key === sel) mat.color.set(0x7fe7ff);
          else mat.color.set(0xffffff);
        }
      }

      // --- Ship sunlight occlusion (shadow) ---
      // Dim ship-only star lights if planets/moons block star->ship line-of-sight.
      const shipStar = shipStarLightsRef.current;
      if (shipStar) {
        const starPos = starPosWorldRef.current;
        let occluded = false;

        const bodies = celestialsRef.current;
        for (const c of bodies) {
          if (c.kind !== "planet" && c.kind !== "moon") continue;

          const center = c.posWorld;
          const r = c.radiusWorld * 1.02;

          if (segmentIntersectsSphere(starPos, newShipPos, center, r)) {
            occluded = true;
            break;
          }
        }

        // darker in shadow (this was previously too bright)
        const targetMult = occluded ? 0.012 : 1.0;
        const current = shipShadowMultRef.current;
        const lerp = 1 - Math.pow(0.0001, dt);
        const next = current + (targetMult - current) * lerp;
        shipShadowMultRef.current = next;

        shipStar.key.intensity = STAR_KEY_INTENSITY * next;
        shipStar.fill.intensity = STAR_FILL_INTENSITY * (0.12 + 0.88 * next);
      }

      // update tracers (fade + cleanup)
      {
        const now = performance.now();
        const next: typeof tracersRef.current = [];
        for (const t of tracersRef.current) {
          const age = (now - t.born) / 1000;
          const a = 1 - age / t.ttl;

          if (a <= 0) {
            t.line.removeFromParent();
            if (t.line.geometry) t.line.geometry.dispose();
            const m = t.line.material as any;
            m?.dispose?.();
            continue;
          }

          const m = t.line.material as THREE.LineBasicMaterial;
          m.opacity = a;
          next.push(t);
        }
        tracersRef.current = next;
      }

      // warp tunnel
      if (tunnelObj) {
        tunnelObj.uniforms.uTime.value += dt;

        const v = shipVelRef.current.length();
        const speed01 = THREE.MathUtils.clamp(v / WARP_MAX_SPEED, 0, 1);

        tunnelObj.uniforms.uSpeed.value = THREE.MathUtils.lerp(
          tunnelObj.uniforms.uSpeed.value,
          speed01,
          1 - Math.pow(0.001, dt)
        );

        const targetIntensity = warping ? 1 : 0;
        tunnelObj.uniforms.uIntensity.value = THREE.MathUtils.lerp(
          tunnelObj.uniforms.uIntensity.value,
          targetIntensity,
          1 - Math.pow(0.0001, dt)
        );

        tunnelObj.mesh.visible = tunnelObj.uniforms.uIntensity.value > 0.01;

        if (warping && warpRef.current) {
          const dir = new THREE.Vector3().copy(warpRef.current.destPos).sub(newShipPos).normalize();
          if (dir.lengthSq() > 0.000001) {
            q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
            tunnelObj.mesh.quaternion.copy(q);
            tunnelObj.mesh.position.copy(cam.position).add(dir.multiplyScalar(WARP_TUNNEL_CENTER_FORWARD));
          } else {
            tunnelObj.mesh.position.copy(cam.position);
          }
        } else {
          tunnelObj.mesh.position.copy(cam.position);
        }
      }

      // exit flash
      if (flashObj) {
        const f = warpExitFlashRef.current;
        const newF = f * Math.pow(0.00005, dt);
        warpExitFlashRef.current = newF;

        const alpha = THREE.MathUtils.clamp(newF, 0, 1) * 0.75;
        flashObj.mat.uniforms.uAlpha.value = alpha;
        flashObj.mesh.visible = alpha > 0.01;
      }

      ctrl.update();
      comp.render();

      lastShipPosRef.current.copy(newShipPos);
    };

    animate();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);

      composerRef.current = null;

      if (rendererRef.current) rendererRef.current.dispose();
      if (sceneRef.current) safeDispose(sceneRef.current);

      if (renderer.domElement.parentElement === host) {
        host.removeChild(renderer.domElement);
      }

      if (warpTunnelRef.current) {
        warpTunnelRef.current.mesh.removeFromParent();
        warpTunnelRef.current.geom.dispose();
        warpTunnelRef.current.mat.dispose();
        warpTunnelRef.current = null;
      }

      if (warpFlashRef.current) {
        warpFlashRef.current.mesh.removeFromParent();
        warpFlashRef.current.mat.dispose();
        warpFlashRef.current = null;
      }

      if (skyRef.current) {
        skyRef.current.mesh.removeFromParent();
        skyRef.current.mat.dispose();
        skyRef.current = null;
      }

      rendererRef.current = null;
      sceneRef.current = null;
      camRef.current = null;
      controlsRef.current = null;
      rayRef.current = null;

      shipRef.current = null;

      spritesRef.current = [];
      spriteMetaRef.current.clear();
      spriteMatsRef.current.clear();

      celestialsRef.current = [];
      combatSitesRef.current = [];
      npcsRef.current = [];

      bounceKeyRef.current = null;
      bounceBackRef.current = null;

      worldStarLightsRef.current = null;
      shipStarLightsRef.current = null;

      warpRef.current = null;
      approachRef.current = null;
      sublightDirRef.current = null;
      warpExitFlashRef.current = 0;

      tracersRef.current = [];
      encounterRef.current = null;
    };
  }, []);

  // Load system + build celestials + lighting + combat site
  useEffect(() => {
    const scene = sceneRef.current;
    const shipObj = shipRef.current;

    if (!scene || !shipObj) return;
    let cancelled = false;

    (async () => {
      const sys = await loadSystemScene(SYSTEM_ID);
      if (cancelled) return;

      setSystemName(sys.systemName);

      // cleanup old sprites/materials
      for (const s of spritesRef.current) {
        const mat = spriteMatsRef.current.get(s);
        if (mat?.map) mat.map.dispose();
        mat?.dispose();
        s.removeFromParent();
      }
      spritesRef.current = [];
      spriteMetaRef.current.clear();
      spriteMatsRef.current.clear();

      celestialsRef.current = [];
      combatSitesRef.current = [];
      npcsRef.current = [];
      encounterRef.current = null;

      // remove old system objects
      const toRemove: THREE.Object3D[] = [];
      scene.traverse((o) => {
        if (o.userData?.godSystem === true) toRemove.push(o);
      });
      for (const o of toRemove) {
        o.removeFromParent();
        safeDispose(o);
      }

      worldStarLightsRef.current = null;
      shipStarLightsRef.current = null;

      const star = sys.celestials.find((c) => c.kind === "star") ?? null;
      const starPos = star ? mToWorld(star.position_m) : new THREE.Vector3();
      starPosWorldRef.current.copy(starPos);

      const starRadius = star ? radiusMetersToWorld(star.kind, star.radius_m) : 0.02;

      // --- World star lights (layer 0 only) ---
      const starKeyWorld = new THREE.PointLight(0xfff0cc, STAR_KEY_INTENSITY, 0, STAR_KEY_DECAY);
      starKeyWorld.position.copy(starPos);
      starKeyWorld.layers.set(LAYER_WORLD);
      starKeyWorld.userData.godSystem = true;
      scene.add(starKeyWorld);

      const starFillWorld = new THREE.PointLight(0xfff0cc, STAR_FILL_INTENSITY, 0, STAR_FILL_DECAY);
      starFillWorld.position.copy(starPos);
      starFillWorld.layers.set(LAYER_WORLD);
      starFillWorld.userData.godSystem = true;
      scene.add(starFillWorld);

      worldStarLightsRef.current = { key: starKeyWorld, fill: starFillWorld };

      // --- Ship-only star lights (layer 1 only; these get occluded) ---
      const starKeyShip = new THREE.PointLight(0xfff0cc, STAR_KEY_INTENSITY, 0, STAR_KEY_DECAY);
      starKeyShip.position.copy(starPos);
      starKeyShip.layers.set(LAYER_SHIP);
      starKeyShip.userData.godSystem = true;
      scene.add(starKeyShip);

      const starFillShip = new THREE.PointLight(0xfff0cc, STAR_FILL_INTENSITY, 0, STAR_FILL_DECAY);
      starFillShip.position.copy(starPos);
      starFillShip.layers.set(LAYER_SHIP);
      starFillShip.userData.godSystem = true;
      scene.add(starFillShip);

      shipStarLightsRef.current = { key: starKeyShip, fill: starFillShip };
      shipShadowMultRef.current = 1.0;

      // update bounce light directions based on star position, targeting ship
      const bounceKey = bounceKeyRef.current;
      const bounceBack = bounceBackRef.current;

      if (bounceKey && bounceKey.target) {
        const dir = shipPosRef.current.clone().sub(starPos).normalize();
        bounceKey.position.copy(shipPosRef.current.clone().add(dir.multiplyScalar(1000)));
        bounceKey.target.position.copy(shipPosRef.current);
      }

      if (bounceBack && bounceBack.target) {
        const dirBack = starPos.clone().sub(shipPosRef.current).normalize();
        bounceBack.position.copy(shipPosRef.current.clone().add(dirBack.multiplyScalar(1000)));
        bounceBack.target.position.copy(shipPosRef.current);
      }

      // visible star mesh
      if (star) {
        const sMesh = new THREE.Mesh(
          new THREE.SphereGeometry(starRadius, 48, 32),
          new THREE.MeshStandardMaterial({
            color: 0xffe1a8,
            emissive: 0xffd27d,
            emissiveIntensity: 14.0,
            roughness: 0.15,
            metalness: 0.0,
          })
        );
        sMesh.position.copy(starPos);
        sMesh.userData.godSystem = true;
        sMesh.layers.set(LAYER_WORLD);
        scene.add(sMesh);

        // single star marker sprite
        const starTex = makeMarkerTexture("star");
        const starMarkerMat = new THREE.SpriteMaterial({
          map: starTex,
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
          depthTest: false,
          blending: THREE.AdditiveBlending,
        });
        const starMarker = new THREE.Sprite(starMarkerMat);
        starMarker.position.copy(starPos);
        (starMarker as any).renderOrder = 9_000;
        starMarker.userData.godSystem = true;
        starMarker.layers.set(LAYER_WORLD);
        scene.add(starMarker);

        const key = `star:${star.name}`;
        const warpInWorld = computeFixedWarpInWorld(starPos, starPos, starRadius);

        const meta: CelestialMeta = {
          ...(star as Celestial),
          radiusWorld: starRadius,
          key,
          posWorld: starPos.clone(),
          warpInWorld,
        };

        celestialsRef.current.push(meta);
        spritesRef.current.push(starMarker);
        spriteMatsRef.current.set(starMarker, starMarkerMat);
        spriteMetaRef.current.set(starMarker, meta);
      }

      let primaryPlanetPos: THREE.Vector3 | null = null;
      let primaryPlanetRadius: number | null = null;

      // skip star in loop so it only appears once
      for (let i = 0; i < sys.celestials.length; i++) {
        const c = sys.celestials[i];
        if (c.kind === "star") continue;

        const pos = mToWorld(c.position_m);
        const radiusWorld = radiusMetersToWorld(c.kind, c.radius_m);
        const key = `${c.kind}:${c.name}:${i}`;

        if (!primaryPlanetPos && c.kind === "planet") {
          primaryPlanetPos = pos.clone();
          primaryPlanetRadius = radiusWorld;
        }

        const warpInWorld = computeFixedWarpInWorld(starPos, pos, radiusWorld);

        const meta: CelestialMeta = { ...c, radiusWorld, key, posWorld: pos.clone(), warpInWorld };
        celestialsRef.current.push(meta);

        const seg = radiusWorld > 0.05 ? 42 : radiusWorld > 0.01 ? 32 : 20;

        const color =
          c.kind === "planet"
            ? new THREE.Color(0x2c8f5a)
            : c.kind === "moon"
              ? new THREE.Color(0x8f8f8f)
              : c.kind === "stargate"
                ? new THREE.Color(0x2b84b8)
                : new THREE.Color(0x9b2aa2);

        const baseLum =
          c.kind === "planet"
            ? BODY_BASE_LUMINANCE_PLANET
            : c.kind === "moon"
              ? BODY_BASE_LUMINANCE_MOON
              : c.kind === "station"
                ? BODY_BASE_LUMINANCE_STATION
                : c.kind === "stargate"
                  ? BODY_BASE_LUMINANCE_GATE
                  : BODY_BASE_LUMINANCE_MOON;

        const mat = new THREE.MeshStandardMaterial({
          color,
          emissive: color.clone(),
          emissiveIntensity: baseLum,
          roughness: c.kind === "stargate" ? 0.35 : 0.98,
          metalness: c.kind === "stargate" ? 0.15 : 0.0,
        });

        const sphere = new THREE.Mesh(
          new THREE.SphereGeometry(radiusWorld, seg, Math.floor(seg * 0.7)),
          mat
        );
        sphere.position.copy(pos);
        sphere.userData.godSystem = true;
        sphere.layers.set(LAYER_WORLD);
        scene.add(sphere);

        // sprite marker
        const tex = makeMarkerTexture(c.kind);
        const smat = new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
          depthTest: true,
        });

        const sprite = new THREE.Sprite(smat);
        sprite.position.copy(pos);
        sprite.userData.godSystem = true;
        sprite.layers.set(LAYER_WORLD);
        scene.add(sprite);

        spritesRef.current.push(sprite);
        spriteMatsRef.current.set(sprite, smat);
        spriteMetaRef.current.set(sprite, meta);
      }

      // --- Spawn a combat site + start encounter ---
      const site = spawnDefaultCombatSite(primaryPlanetPos, primaryPlanetRadius, 0);
      const siteMeta: CombatSiteMeta = {
        key: site.key,
        kind: "combat_site",
        name: site.name,
        posWorld: site.posWorld.clone(),
      };
      combatSitesRef.current = [siteMeta];

      const siteTex = makeMarkerTexture("combat_site");
      const siteMat = new THREE.SpriteMaterial({
        map: siteTex,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        depthTest: true,
      });

      const siteSprite = new THREE.Sprite(siteMat);
      siteSprite.position.copy(siteMeta.posWorld);
      siteSprite.userData.godSystem = true;
      siteSprite.layers.set(LAYER_WORLD);
      scene.add(siteSprite);

      spritesRef.current.push(siteSprite);
      spriteMatsRef.current.set(siteSprite, siteMat);
      spriteMetaRef.current.set(siteSprite, siteMeta);

      encounterRef.current = {
        siteKey: siteMeta.key,
        wave: 0,
        nextWaveAt: performance.now() + 500,
      };
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Overview distance updates (~10Hz)
  useEffect(() => {
    const t = setInterval(() => {
      const shipPos = shipPosRef.current;

      const rows: OverviewRow[] = [];

      for (const c of celestialsRef.current) {
        rows.push({
          key: c.key,
          name: c.name,
          kind: c.kind,
          distMeters: effectiveDistanceMeters(shipPos, c),
        });
      }

      for (const s of combatSitesRef.current) {
        rows.push({
          key: s.key,
          name: s.name,
          kind: s.kind,
          distMeters: effectiveDistanceMeters(shipPos, s),
        });
      }

      for (const n of npcsRef.current) {
        rows.push({
          key: n.key,
          name: n.name,
          kind: n.kind,
          distMeters: effectiveDistanceMeters(shipPos, n),
        });
      }

      rows.sort((a, b) => a.distMeters - b.distMeters);
      setOverviewRows(rows);

      const mps = shipVelRef.current.length() / SCALE_FACTOR;
      setSpeedMps(mps);
    }, 100);

    return () => clearInterval(t);
  }, []);

  // Interaction: hover + sprite right click menu + double click approach
  useEffect(() => {
    const host = canvasHostRef.current;
    const camera = camRef.current;
    const raycaster = rayRef.current;
    if (!host || !camera || !raycaster) return;

    const getMouseNdc = (e: MouseEvent) => {
      const r = host.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2 - 1;
      const y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      return { x, y };
    };

    const pickSprite = (e: MouseEvent) => {
      const { x, y } = getMouseNdc(e);
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera);

      const hits = raycaster.intersectObjects(spritesRef.current, true);
      if (!hits.length) return null;

      for (const h of hits) {
        const meta = spriteMetaRef.current.get(h.object);
        if (meta) return { meta, object: h.object as THREE.Sprite };
      }
      return null;
    };

    const onMove = (e: MouseEvent) => {
      const hit = pickSprite(e);
      if (!hit) {
        setHover(null);
        return;
      }

      const distMeters = effectiveDistanceMeters(shipPosRef.current, hit.meta);
      setHover({ name: hit.meta.name, kind: hit.meta.kind, distMeters });
    };

    const onDblClick = (e: MouseEvent) => {
      if (warpRef.current?.active) return;

      const hit = pickSprite(e);
      if (hit) {
        approachTo(hit.meta);
        return;
      }

      const { x, y } = getMouseNdc(e);
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera);

      const dir = raycaster.ray.direction.clone().normalize();
      sublightDirRef.current = dir;
      approachRef.current = null;
      setCtxMenu(null);
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const hit = pickSprite(e);
      if (!hit) {
        setCtxMenu(null);
        return;
      }
      setSelectedKey(hit.meta.key);
      setCtxMenu({ x: e.clientX, y: e.clientY, target: hit.meta });
    };

    host.addEventListener("mousemove", onMove);
    host.addEventListener("dblclick", onDblClick);
    host.addEventListener("contextmenu", onContextMenu);

    return () => {
      host.removeEventListener("mousemove", onMove);
      host.removeEventListener("dblclick", onDblClick);
      host.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

  const tooltipText = useMemo(() => {
    if (!hover) return null;
    return `${hover.name} (${hover.kind}) • ${formatDistanceMeters(hover.distMeters)}`;
  }, [hover]);

  const warpPhase = warpRef.current?.phase ?? null;
  const inWarp = warpPhase === "warp";
  const inAlign = warpPhase === "align";

  const speedLabel = inWarp ? "WARP" : inAlign ? "ALIGN" : "SPEED";
  const speedUnit: "mps" | "aups" = inWarp ? "aups" : "mps";

  const armorPct = Math.max(0, Math.min(1, armor / shipStats.maxArmor));
  const hullPct = Math.max(0, Math.min(1, hull / shipStats.maxHull));

  const speedMaxMps = inWarp ? (WARP_MAX_SPEED / SCALE_FACTOR) : (SUBLIGHT_MAX_SPEED / SCALE_FACTOR);
  const speedPct = Math.max(0, Math.min(1, speedMps / Math.max(1, speedMaxMps)));

  const ctxLockInfo = useMemo(() => {
    if (!ctxMenu) return null;
    const meta = ctxMenu.target;
    const inRange = canLockNow(meta);
    const atCap = !isLocked(meta.key) && lockedKeysRef.current.length >= MAX_LOCKS;
    return { inRange, atCap };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxMenu]);

  return (
    <div className="god-canvas-root">
      <div className="god-canvas-host" ref={canvasHostRef} />

      {tooltipText && <div className="god-tooltip">{tooltipText}</div>}

      {/* Locked targets bar */}
      {lockedKeys.length > 0 && (
        <div className="god-locked">
          {lockedKeys.map((k) => {
            const meta = findSpaceByKey(k);
            if (!meta) return null;

            const dist = (overviewRows.find((r) => r.key === k)?.distMeters ?? 0);

            // If it's an NPC, prefer live %; otherwise fall back to stored test HP.
            const livePct =
              meta.kind === "npc"
                ? Math.round((meta.hp / Math.max(1, meta.maxHp)) * 100)
                : (targetTestHp[k] ?? 100);

            const hpPct = Math.max(0, Math.min(1, livePct / 100));
            const active = activeLockedKey === k;

            return (
              <div
                key={k}
                className={"god-lock" + (active ? " is-active" : "")}
                onClick={() => {
                  setSelectedKey(k);
                  setActiveLockedKey(k);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSelectedKey(k);
                  setCtxMenu({ x: e.clientX, y: e.clientY, target: meta });
                }}
                title="Click to make active target • Right click for menu"
              >
                <div className="god-lock-name">{meta.name}</div>
                <div className="god-lock-sub">
                  <div>{meta.kind}</div>
                  <div>{formatDistanceMeters(dist)}</div>
                </div>
                <div className="god-lock-hp">
                  <div className="god-lock-hp-fill" style={{ width: `${hpPct * 100}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Overview (dense, single-line, type column) */}
      <div
        className="god-overview"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <div className="god-overview-list">
          {overviewRows.map((r) => (
            <div
              key={r.key}
              className={"god-overview-row" + (r.key === selectedKey ? " is-selected" : "")}
              onClick={() => {
                setSelectedKey(r.key);
                if (lockedKeysRef.current.includes(r.key)) setActiveLockedKey(r.key);
              }}
              onDoubleClick={() => {
                const meta = findSpaceByKey(r.key);
                if (meta) approachTo(meta);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const meta = findSpaceByKey(r.key);
                if (!meta) return;
                setSelectedKey(r.key);
                setCtxMenu({ x: e.clientX, y: e.clientY, target: meta });
              }}
              title="Double click: approach • Right click: menu"
            >
              <div className="god-overview-left">
                <div className="god-overview-type">{KIND_LABEL[r.kind]}</div>
                <div className="god-overview-name">{r.name}</div>
              </div>
              <div className="god-overview-dist">{formatDistanceMeters(r.distMeters)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Context menu layer */}
      {ctxMenu && (
        <div
          className="god-context-layer"
          onMouseDown={(e) => {
            e.preventDefault();
            setCtxMenu(null);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu(null);
          }}
        >
          <div
            className="god-context"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <div className="god-context-title">{ctxMenu.target.name}</div>

            <button
              className="god-btn"
              disabled={inWarp}
              onClick={() => approachTo(ctxMenu.target)}
              title={inWarp ? "Cannot change course while in warp" : "Approach target"}
            >
              Approach
            </button>

            <button
              className="god-btn"
              disabled={inWarp || ctxMenu.target.kind === "npc"}
              onClick={() => warpTo(ctxMenu.target)}
              title={
                ctxMenu.target.kind === "npc"
                  ? "Cannot warp to NPCs"
                  : inWarp
                    ? "Already in warp"
                    : "Warp to target"
              }
            >
              Warp
            </button>

            {!isLocked(ctxMenu.target.key) ? (
              <button
                className="god-btn"
                disabled={!ctxLockInfo?.inRange || !!ctxLockInfo?.atCap}
                onClick={() => {
                  ensureLocked(ctxMenu.target.key);
                  setSelectedKey(ctxMenu.target.key);
                  setCtxMenu(null);
                }}
                title={
                  ctxLockInfo?.atCap
                    ? `Max locked targets: ${MAX_LOCKS}`
                    : !ctxLockInfo?.inRange
                      ? `Too far to lock (≤ ${formatDistanceMeters(LOCK_RANGE_M)})`
                      : "Lock target (required to fire)"
                }
              >
                Lock target
              </button>
            ) : (
              <button
                className="god-btn"
                onClick={() => {
                  unlockTarget(ctxMenu.target.key);
                  setCtxMenu(null);
                }}
                title="Unlock target"
              >
                Unlock target
              </button>
            )}
          </div>
        </div>
      )}

      {/* Health + Fire control + Speed scale */}
      <div className="god-hud-bottom">
        <div className="god-health">
          <div className="god-bars">
            <div className="god-bar-labels">
              <div>ARMOR</div>
              <div>
                {armor}/{shipStats.maxArmor}
              </div>
            </div>
            <div className="god-bar">
              <div className="god-bar-fill" style={{ width: `${armorPct * 100}%` }} />
            </div>

            <div className="god-bar-labels">
              <div>HULL</div>
              <div>
                {hull}/{shipStats.maxHull}
              </div>
            </div>
            <div className="god-bar">
              <div className="god-bar-fill" style={{ width: `${hullPct * 100}%` }} />
            </div>

            <div className="god-speed">
              <div className="god-speed-label">
                <div>{speedLabel}</div>
                <div>{formatSpeed(speedMps, speedUnit)}</div>
              </div>
              <div className="god-speed-bar">
                <div className="god-speed-fill" style={{ width: `${speedPct * 100}%` }} />
              </div>
            </div>
          </div>

          <button
            className="god-fire"
            onClick={toggleFire}
            disabled={!canFire}
            title={
              !canFire
                ? "Lock a target first (right click -> Lock target)"
                : firing
                  ? "Firing (click to stop)"
                  : "Start firing (auto-repeat)"
            }
          >
            {firing ? "F1*" : "F1"}
          </button>
        </div>
      </div>

      <div className="god-corner">
        <div>{systemName}</div>
        <div>{identityHex.slice(0, 8)}</div>
      </div>
    </div>
  );
}
