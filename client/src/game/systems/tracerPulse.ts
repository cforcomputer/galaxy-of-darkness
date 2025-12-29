import * as THREE from "three";

type Pulse = {
  line: THREE.Line;
  geom: THREE.BufferGeometry;
  mat: THREE.LineBasicMaterial;
  start: THREE.Vector3;
  end: THREE.Vector3;
  age: number;
  duration: number;
  segFrac: number; // how much of the path is visible as a short segment
};

export type TracerPulseSystem = {
  spawn: (start: THREE.Vector3, end: THREE.Vector3) => void;
  update: (dt: number) => void;
  dispose: () => void;
};

export function createTracerPulseSystem(scene: THREE.Scene): TracerPulseSystem {
  const pulses: Pulse[] = [];

  function spawn(start: THREE.Vector3, end: THREE.Vector3) {
    const positions = new Float32Array(6);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.LineBasicMaterial({
      transparent: true,
      opacity: 0.0,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // Make bloom pop (when UnrealBloom is enabled)
    mat.toneMapped = false;

    const line = new THREE.Line(geom, mat);
    line.frustumCulled = false;

    scene.add(line);

    pulses.push({
      line,
      geom,
      mat,
      start: start.clone(),
      end: end.clone(),
      age: 0,
      duration: 0.35, // slower than the previous “laser”
      segFrac: 0.10,  // short segment => less clutter
    });
  }

  function update(dt: number) {
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.age += dt;

      const t = Math.min(1, p.age / p.duration);

      // Pulse alpha curve (bloom pulse, not a constant line)
      const alpha = Math.sin(Math.PI * t); // 0->1->0
      p.mat.opacity = 0.85 * alpha;

      const head = new THREE.Vector3().lerpVectors(p.start, p.end, t);
      const tailT = Math.max(0, t - p.segFrac);
      const tail = new THREE.Vector3().lerpVectors(p.start, p.end, tailT);

      const attr = p.geom.getAttribute("position") as THREE.BufferAttribute;
      attr.setXYZ(0, tail.x, tail.y, tail.z);
      attr.setXYZ(1, head.x, head.y, head.z);
      attr.needsUpdate = true;

      if (t >= 1) {
        scene.remove(p.line);
        p.geom.dispose();
        p.mat.dispose();
        pulses.splice(i, 1);
      }
    }
  }

  function dispose() {
    for (const p of pulses) {
      scene.remove(p.line);
      p.geom.dispose();
      p.mat.dispose();
    }
    pulses.length = 0;
  }

  return { spawn, update, dispose };
}
