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
const SPRITE_SCALE_MIN = 0.0000005;
const SPRITE_SCALE_MAX = 0.5;

// Bloom
const BLOOM_STRENGTH = 1.05;
const BLOOM_RADIUS = 0.55;
const BLOOM_THRESHOLD = 0.93;

// Lighting tuning
const EXPOSURE = 1.25;

// ✅ CHANGED: slightly stronger ambient/hemi so dark sides aren’t pitch black
const AMBIENT_INTENSITY = 0.045; // was 0.020
const HEMI_INTENSITY = 0.035;    // was 0.012

// Star lights (keep as before)
const STAR_KEY_INTENSITY = 95.0;
const STAR_KEY_DECAY = 1.7;
const STAR_FILL_INTENSITY = 1.15;
const STAR_FILL_DECAY = 0.0;

// ✅ NEW: very soft “global bounce” lights (do NOT wash out)
const BOUNCE_KEY_INTENSITY = 0.22;  // faint
const BOUNCE_BACK_INTENSITY = 0.10; // even fainter
const BOUNCE_COLOR = 0xbfd6ff;      // cool-ish ambient
const BOUNCE_BACK_COLOR = 0x221b2a; // subtle warm/dark lift

// Base subtle luminance on bodies (keep subtle; don’t rely on emissive)
const BODY_BASE_LUMINANCE_PLANET = 0.020;
const BODY_BASE_LUMINANCE_MOON = 0.012;
const BODY_BASE_LUMINANCE_STATION = 0.028;
const BODY_BASE_LUMINANCE_GATE = 0.020;

// Ship subtle luminance
const SHIP_BASE_LUMINANCE = 0.050;

// Warp tunnel world-space
const WARP_TUNNEL_RADIUS = 0.014;
const WARP_TUNNEL_LENGTH = 0.12;
const WARP_TUNNEL_CENTER_FORWARD = 0.06;

type CelestialMeta = Celestial & {
  radiusWorld: number;
  key: string;
  warpInWorld: THREE.Vector3;
};

type OverviewRow = {
  key: string;
  name: string;
  kind: Celestial["kind"];
  distMeters: number;
};

function makeCelestialSpriteTexture(kind: Celestial["kind"]) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;

  const fill =
    kind === "star"
      ? "#FFD27D"
      : kind === "planet"
        ? "#38FF7F"
        : kind === "moon"
          ? "#B0B0B0"
          : kind === "stargate"
            ? "#33B6FF"
            : "#FF4CF0";

  ctx.clearRect(0, 0, 64, 64);

  const grd = ctx.createRadialGradient(32, 32, 3, 32, 32, 28);
  grd.addColorStop(0, fill);
  grd.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(32, 32, 28, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(32, 32, 8.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(32, 32, 10.5, 0, Math.PI * 2);
  ctx.stroke();

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

function effectiveDistanceMeters(shipPosWorld: THREE.Vector3, meta: CelestialMeta) {
  const centerPosWorld = mToWorld(meta.position_m);
  const centerDistMeters = shipPosWorld.distanceTo(centerPosWorld) / SCALE_FACTOR;
  if (meta.kind === "star") return centerDistMeters;

  const radiusMeters = meta.radiusWorld / SCALE_FACTOR;
  const adjusted = centerDistMeters - (radiusMeters + WARP_IN_BUFFER_M);
  return Math.max(0, adjusted);
}

function computeFixedWarpInWorld(
  starPosWorld: THREE.Vector3,
  bodyPosWorld: THREE.Vector3,
  bodyRadiusWorld: number
) {
  const dir = bodyPosWorld.clone().sub(starPosWorld);
  if (dir.lengthSq() < 1e-12) dir.set(1, 0, 0);
  else dir.normalize();

  const offsetWorld = bodyRadiusWorld + WARP_IN_BUFFER_M * SCALE_FACTOR;
  return bodyPosWorld.clone().add(dir.multiplyScalar(offsetWorld));
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

  const starPosWorldRef = useRef(new THREE.Vector3(0, 0, 0));

  const skyRef = useRef<{ mesh: THREE.Mesh; mat: THREE.ShaderMaterial } | null>(
    null
  );

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

  const warpFlashRef = useRef<{
    mesh: THREE.Mesh;
    mat: THREE.ShaderMaterial;
  } | null>(null);
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
    destPos: THREE.Vector3;
    centerPos: THREE.Vector3;
    targetName: string;
    targetKey: string;
  } | null>(null);

  const spriteMetaRef = useRef<Map<THREE.Object3D, CelestialMeta>>(new Map());
  const spritesRef = useRef<THREE.Sprite[]>([]);
  const spriteMatsRef = useRef<Map<THREE.Sprite, THREE.SpriteMaterial>>(
    new Map()
  );

  const celestialsRef = useRef<CelestialMeta[]>([]);

  // ✅ NEW: bounce lights refs so we can update their direction after ESI load
  const bounceKeyRef = useRef<THREE.DirectionalLight | null>(null);
  const bounceBackRef = useRef<THREE.DirectionalLight | null>(null);

  const [systemName, setSystemName] = useState("Loading…");
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    celestial: CelestialMeta;
  } | null>(null);

  const shipStats = DEFAULT_SHIP_STATS;

  const [armor, setArmor] = useState(shipStats.maxArmor);
  const [hull, setHull] = useState(shipStats.maxHull);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedKeyRef = useRef<string | null>(null);

  const [lockedKeys, setLockedKeys] = useState<string[]>([]);
  const lockedKeysRef = useRef<string[]>([]);
  const [activeLockedKey, setActiveLockedKey] = useState<string | null>(null);
  const activeLockedKeyRef = useRef<string | null>(null);

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

  const distByKey = useMemo(() => {
    const map: Record<string, number> = {};
    for (const r of overviewRows) map[r.key] = r.distMeters;
    return map;
  }, [overviewRows]);

  const findCelestialByKey = (key: string | null): CelestialMeta | null => {
    if (!key) return null;
    const list = celestialsRef.current;
    for (const c of list) if (c.key === key) return c;
    return null;
  };

  const canLockNow = (meta: CelestialMeta) => {
    const shipPos = shipPosRef.current;
    const d = effectiveDistanceMeters(shipPos, meta);
    return d <= LOCK_RANGE_M;
  };

  const ensureLocked = (key: string) => {
    const meta = findCelestialByKey(key);
    if (!meta) return;

    if (!canLockNow(meta)) return;

    setLockedKeys((prev) => {
      if (prev.includes(key)) return prev;
      if (prev.length >= MAX_LOCKS) return prev;
      return [...prev, key];
    });

    setTargetTestHp((prev) => (prev[key] == null ? { ...prev, [key]: 100 } : prev));
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

  const approachTo = (c: CelestialMeta) => {
    if (warpRef.current?.active) return;
    setSelectedKey(c.key);
    approachRef.current = {
      active: true,
      targetPos: mToWorld(c.position_m),
      targetRadius: c.radiusWorld,
      targetKey: c.key,
    };
    sublightDirRef.current = null;
    setCtxMenu(null);
  };

  const warpTo = (c: CelestialMeta) => {
    if (warpRef.current?.active) return;

    approachRef.current = null;
    sublightDirRef.current = null;

    const dest = c.warpInWorld.clone();
    const center = mToWorld(c.position_m);

    warpRef.current = {
      active: true,
      destPos: dest,
      centerPos: center,
      targetName: c.name,
      targetKey: c.key,
    };

    const shipPos = shipPosRef.current;
    const dir = dest.clone().sub(shipPos).normalize();
    shipForwardRef.current.copy(dir);
    shipVelRef.current.copy(dir.multiplyScalar(WARP_MIN_SPEED));

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

    // ✅ CHANGED: slightly stronger ambient + hemi for “space fill”
    scene.add(new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY));
    scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x08060c, HEMI_INTENSITY));

    // ✅ NEW: soft global bounce keyed off star direction (positions get set after ESI load)
    const bounceKey = new THREE.DirectionalLight(BOUNCE_COLOR, BOUNCE_KEY_INTENSITY);
    bounceKey.position.set(1, 1, 1);
    bounceKey.target.position.set(0, 0, 0);
    bounceKey.castShadow = false;
    bounceKey.userData.godCelestial = true; // will be cleared on reload
    scene.add(bounceKey);
    scene.add(bounceKey.target);
    bounceKeyRef.current = bounceKey;

    const bounceBack = new THREE.DirectionalLight(BOUNCE_BACK_COLOR, BOUNCE_BACK_INTENSITY);
    bounceBack.position.set(-1, -1, -1);
    bounceBack.target.position.set(0, 0, 0);
    bounceBack.castShadow = false;
    bounceBack.userData.godCelestial = true;
    scene.add(bounceBack);
    scene.add(bounceBack.target);
    bounceBackRef.current = bounceBack;

    // Ship cube
    const ship = new THREE.Mesh(
      new THREE.BoxGeometry(shipSizeW, shipSizeW, shipSizeW),
      new THREE.MeshStandardMaterial({
        color: 0xdde6ef,
        emissive: new THREE.Color(0x334455),
        emissiveIntensity: SHIP_BASE_LUMINANCE,
        roughness: 0.65,
        metalness: 0.08,
      })
    );
    ship.position.copy(shipPosRef.current);
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
    const tmp2 = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const baseAxis = new THREE.Vector3(0, 0, 1);

    const performShot = (targetKey: string) => {
      setTargetTestHp((prev) => {
        const cur = prev[targetKey] ?? 100;
        const next = Math.max(0, cur - 5);
        return { ...prev, [targetKey]: next };
      });
    };

    const stepMovement = (dt: number) => {
      const shipPos = shipPosRef.current;
      const shipVel = shipVelRef.current;

      // auto-firing loop
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
              const meta = findCelestialByKey(active);
              if (meta) {
                const distMeters = effectiveDistanceMeters(shipPos, meta);
                if (distMeters <= shipStats.weapon.range_m) {
                  performShot(active);
                }
              }
              nextFireAtRef.current = now + shipStats.weapon.cooldownMs;
            }
          }
        }
      }

      // warp
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

        const dir = toDest.normalize();
        shipForwardRef.current.copy(dir);

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

        shipVel.copy(dir.multiplyScalar(newSpeed));
        shipPos.addScaledVector(shipVel, dt);

        const after = warp.destPos.clone().sub(shipPos);
        if (after.dot(dir) < 0) {
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

        const dir = to.normalize();
        shipForwardRef.current.copy(dir);

        const remaining = Math.max(1e-7, dist - stopDist);
        const v = shipVel.length();
        const requiredDecel = (v * v) / (2 * remaining);

        let newSpeed = v;
        if (requiredDecel > SUBLIGHT_DECEL * 0.92) {
          newSpeed = Math.max(0, v - SUBLIGHT_DECEL * dt);
        } else {
          newSpeed = Math.min(SUBLIGHT_MAX_SPEED, v + SUBLIGHT_ACCEL * dt);
        }

        shipVel.copy(dir.multiplyScalar(newSpeed));
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

      shipForwardRef.current.copy(desiredDir);

      const currentSpeed = shipVel.length();
      const targetSpeed = SUBLIGHT_MAX_SPEED;

      let newSpeed = currentSpeed;
      if (currentSpeed < targetSpeed) {
        newSpeed = Math.min(targetSpeed, currentSpeed + SUBLIGHT_ACCEL * dt);
      } else {
        newSpeed = Math.max(targetSpeed, currentSpeed - SUBLIGHT_DECEL * dt);
      }

      shipVel.copy(desiredDir.clone().multiplyScalar(newSpeed));
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

      stepMovement(dt);

      if (skyObj) skyObj.mat.uniforms.uTime.value += dt;

      // camera locked to ship translation
      const newShipPos = shipPosRef.current;
      const lastShipPos = lastShipPosRef.current;
      const delta = newShipPos.clone().sub(lastShipPos);
      if (delta.lengthSq() > 0) cam.position.add(delta);

      shipObj.position.copy(newShipPos);
      ctrl.target.copy(newShipPos);

      // ship faces intended direction
      const fwdDir = shipForwardRef.current;
      if (fwdDir.lengthSq() > 0.000001) {
        shipObj.lookAt(shipObj.position.clone().add(fwdDir));
      }

      const warping = !!warpRef.current?.active;
      ctrl.maxDistance = warping ? CAMERA_MAX_DISTANCE_WARP : CAMERA_MAX_DISTANCE_DEFAULT;

      // clamp camera distance
      const camToTarget = tmp.copy(cam.position).sub(ctrl.target);
      const camDist = camToTarget.length();
      if (camDist > ctrl.maxDistance) {
        cam.position.copy(
          ctrl.target.clone().add(camToTarget.multiplyScalar(ctrl.maxDistance / camDist))
        );
      }
      if (camDist < ctrl.minDistance) {
        cam.position.copy(
          ctrl.target.clone().add(camToTarget.normalize().multiplyScalar(ctrl.minDistance))
        );
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
        const desiredPx = meta.kind === "star" ? SPRITE_PX_STAR : SPRITE_PX_BODY;

        const worldSize = pxToWorldAtDist(d) * desiredPx;
        const size = THREE.MathUtils.clamp(worldSize, SPRITE_SCALE_MIN, SPRITE_SCALE_MAX);

        s.scale.set(size, size, 1);

        const mat = spriteMatsRef.current.get(s);
        if (mat) {
          if (sel && meta.key === sel) mat.color.set(0x7fe7ff);
          else mat.color.set(0xffffff);
        }
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
          const dir = tmp2.copy(warpRef.current.destPos).sub(newShipPos).normalize();
          if (dir.lengthSq() > 0.000001) {
            q.setFromUnitVectors(baseAxis, dir);
            tunnelObj.mesh.quaternion.copy(q);
            tunnelObj.mesh.position
              .copy(cam.position)
              .add(dir.multiplyScalar(WARP_TUNNEL_CENTER_FORWARD));
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

      bounceKeyRef.current = null;
      bounceBackRef.current = null;

      warpRef.current = null;
      approachRef.current = null;
      sublightDirRef.current = null;
      warpExitFlashRef.current = 0;
    };
  }, []);

  // Load system + build celestials + lighting
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

      // remove old celestials + lights
      const toRemove: THREE.Object3D[] = [];
      scene.traverse((o) => {
        if (o.userData?.godCelestial === true) toRemove.push(o);
      });
      for (const o of toRemove) {
        o.removeFromParent();
        safeDispose(o);
      }

      const star = sys.celestials.find((c) => c.kind === "star") ?? null;
      const starPos = star ? mToWorld(star.position_m) : new THREE.Vector3();
      starPosWorldRef.current.copy(starPos);

      const starRadius = star ? radiusMetersToWorld(star.kind, star.radius_m) : 0.02;

      // star lights
      const starKey = new THREE.PointLight(0xfff0cc, STAR_KEY_INTENSITY, 0, STAR_KEY_DECAY);
      starKey.position.copy(starPos);
      starKey.userData.godCelestial = true;
      scene.add(starKey);

      const starFill = new THREE.PointLight(0xfff0cc, STAR_FILL_INTENSITY, 0, STAR_FILL_DECAY);
      starFill.position.copy(starPos);
      starFill.userData.godCelestial = true;
      scene.add(starFill);

      // ✅ NEW: update bounce light directions based on star position
      // DirectionalLight points from its position toward its target.
      // We want the bounce to be a soft "skylight" from the star direction and a faint back lift.
      const bounceKey = bounceKeyRef.current;
      const bounceBack = bounceBackRef.current;

      if (bounceKey && bounceKey.target) {
        // Place the light far away in the star direction and point it at the ship.
        const dir = shipPosRef.current.clone().sub(starPos).normalize(); // away from star -> "lit side" direction
        bounceKey.position.copy(shipPosRef.current.clone().add(dir.multiplyScalar(1000)));
        bounceKey.target.position.copy(shipPosRef.current);
        bounceKey.userData.godCelestial = true;
      }

      if (bounceBack && bounceBack.target) {
        // Opposite direction, weaker: lifts the very dark silhouette
        const dirBack = starPos.clone().sub(shipPosRef.current).normalize();
        bounceBack.position.copy(shipPosRef.current.clone().add(dirBack.multiplyScalar(1000)));
        bounceBack.target.position.copy(shipPosRef.current);
        bounceBack.userData.godCelestial = true;
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
        sMesh.userData.godCelestial = true;
        scene.add(sMesh);

        // single star marker sprite
        const starTex = makeCelestialSpriteTexture("star");
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
        starMarker.userData.godCelestial = true;
        scene.add(starMarker);

        const key = `star:${star.name}`;
        const warpInWorld = computeFixedWarpInWorld(starPos, starPos, starRadius);

        const meta: CelestialMeta = {
          ...(star as Celestial),
          radiusWorld: starRadius,
          key,
          warpInWorld,
        };

        celestialsRef.current.push(meta);
        spritesRef.current.push(starMarker);
        spriteMatsRef.current.set(starMarker, starMarkerMat);
        spriteMetaRef.current.set(starMarker, meta);
      }

      // skip star in loop so it only appears once
      for (let i = 0; i < sys.celestials.length; i++) {
        const c = sys.celestials[i];
        if (c.kind === "star") continue;

        const pos = mToWorld(c.position_m);
        const radiusWorld = radiusMetersToWorld(c.kind, c.radius_m);
        const key = `${c.kind}:${c.name}:${i}`;

        const warpInWorld = computeFixedWarpInWorld(starPos, pos, radiusWorld);

        const meta: CelestialMeta = { ...c, radiusWorld, key, warpInWorld };
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
        sphere.userData.godCelestial = true;
        scene.add(sphere);

        // sprite marker
        const tex = makeCelestialSpriteTexture(c.kind);
        const smat = new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
          depthTest: true,
        });

        const sprite = new THREE.Sprite(smat);
        sprite.position.copy(pos);
        sprite.userData.godCelestial = true;
        scene.add(sprite);

        spritesRef.current.push(sprite);
        spriteMatsRef.current.set(sprite, smat);
        spriteMetaRef.current.set(sprite, meta);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Overview distance updates (~10Hz)
  useEffect(() => {
    const t = setInterval(() => {
      const shipPos = shipPosRef.current;
      const list = celestialsRef.current;
      if (!list.length) return;

      const rows: OverviewRow[] = list.map((c) => {
        const distMeters = effectiveDistanceMeters(shipPos, c);
        return { key: c.key, name: c.name, kind: c.kind, distMeters };
      });

      rows.sort((a, b) => a.distMeters - b.distMeters);
      setOverviewRows(rows);
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
      setCtxMenu({ x: e.clientX, y: e.clientY, celestial: hit.meta });
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

  const inWarp = !!warpRef.current?.active;

  const armorPct = Math.max(0, Math.min(1, armor / shipStats.maxArmor));
  const hullPct = Math.max(0, Math.min(1, hull / shipStats.maxHull));

  const ctxLockInfo = useMemo(() => {
    if (!ctxMenu) return null;
    const meta = ctxMenu.celestial;
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
            const meta = findCelestialByKey(k);
            if (!meta) return null;
            const dist = (overviewRows.find((r) => r.key === k)?.distMeters ?? 0);
            const hp = targetTestHp[k] ?? 100;
            const hpPct = Math.max(0, Math.min(1, hp / 100));
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
                  setCtxMenu({ x: e.clientX, y: e.clientY, celestial: meta });
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

      {/* Overview */}
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
                const meta = findCelestialByKey(r.key);
                if (meta) approachTo(meta);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const meta = findCelestialByKey(r.key);
                if (!meta) return;
                setSelectedKey(r.key);
                setCtxMenu({ x: e.clientX, y: e.clientY, celestial: meta });
              }}
              title="Double click: approach • Right click: menu"
            >
              <div>
                <div className="god-overview-name">{r.name}</div>
                <div className="god-overview-kind">{r.kind}</div>
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
            <div className="god-context-title">{ctxMenu.celestial.name}</div>

            <button
              className="god-btn"
              disabled={inWarp}
              onClick={() => approachTo(ctxMenu.celestial)}
              title={inWarp ? "Cannot change course while in warp" : "Approach target"}
            >
              Approach
            </button>

            <button
              className="god-btn"
              disabled={inWarp}
              onClick={() => warpTo(ctxMenu.celestial)}
              title={inWarp ? "Already in warp" : "Warp to target"}
            >
              Warp
            </button>

            {!isLocked(ctxMenu.celestial.key) ? (
              <button
                className="god-btn"
                disabled={!ctxLockInfo?.inRange || !!ctxLockInfo?.atCap}
                onClick={() => {
                  ensureLocked(ctxMenu.celestial.key);
                  setSelectedKey(ctxMenu.celestial.key);
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
                  unlockTarget(ctxMenu.celestial.key);
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

      {/* Health + Fire control */}
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
