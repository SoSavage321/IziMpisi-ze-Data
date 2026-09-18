/**
 * The plant in three dimensions — a digital twin of the rig.
 *
 * This is a second *rendering* of exactly the same state the 2D schematic
 * draws: it takes the same `PlantView` object, which is built in SiteLive from
 * whatever the data layer provides. Today that is the in-browser simulation or
 * a Supabase query; when the physical prototype is wired up and posting to
 * /ingest, the same prop carries real telemetry and this view follows the real
 * tanks with no change to this file. The only binding point is the `v` prop.
 *
 * What it shows, live:
 *   - water level in the check chamber and the treatment tank
 *   - water colour by measured quality (acid / alkaline / saline / in-band)
 *   - valve bodies lit by state, including V3's interlock lock
 *   - flow along whichever pipe is actually carrying water
 *   - the neutraliser drum draining as it doses
 *
 * Performance notes: one renderer, geometry and materials created once and
 * mutated per frame, the loop paused when the tab is hidden or the element is
 * scrolled out of view, and everything disposed on unmount. On a phone this
 * needs to cost less than the charts do.
 */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { Badge, Button, cn } from './ui.tsx';
import type { PlantView } from './plant.tsx';
import { num, ph as fmtPh } from '../lib/format.ts';

export interface Limits { phMin: number; phMax: number; tdsMax: number }

/**
 * Water colour by quality. Same thresholds as the 2D diagram; expressed as hex
 * here because a WebGL material cannot take a Tailwind class. Colour is never
 * the only cue — the labels carry the numbers too.
 */
function waterColour(ph: number | null, tds: number | null, l: Limits): number {
  if (ph === null) return 0x94a3b8;          // no reading: neutral slate
  if (ph < l.phMin) return 0xef4444;         // acidic
  if (ph > l.phMax) return 0xf59e0b;         // alkaline
  if (tds !== null && tds > l.tdsMax) return 0xf59e0b;  // over the TDS limit
  return 0x087ea4;                           // inside the band — water blue
}

interface Built {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  chamberWater: THREE.Mesh;
  tankWater: THREE.Mesh;
  drumWater: THREE.Mesh;
  valves: Record<'V1' | 'V2' | 'V3', THREE.Mesh>;
  flows: Array<{ key: string; curve: THREE.CatmullRomCurve3; dots: THREE.Mesh[] }>;
  labels: Array<{ id: string; anchor: THREE.Vector3 }>;
  ground: THREE.Mesh;
  river: THREE.Mesh;
  disposables: Array<{ dispose: () => void }>;
}

/**
 * What the marching dots mean, by colour. Raw water from the sump is not yet
 * judged; a pass is on its way to the river; a fail has been pulled aside for
 * treatment; the dosing line is the neutraliser itself.
 */
const FLOW_RAW  = { color: 0xbae6fd, emissive: 0x0284c7 };  // untested feed
const FLOW_PASS = { color: 0x99f6e4, emissive: 0x14b8a6 };  // released to the river
const FLOW_FAIL = { color: 0xfed7aa, emissive: 0xea580c };  // diverted to treatment
const FLOW_DOSE = { color: 0xe9d5ff, emissive: 0x9333ea };  // neutraliser dosing

const CHAMBER_H = 2.2;
const TANK_H = 1.7;
const DRUM_H = 1.0;

export function Plant3D({ v, limits, deviceName }: {
  v: PlantView;
  limits: Limits;
  deviceName: string;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const builtRef = useRef<Built | null>(null);
  const viewRef = useRef<PlantView>(v);
  const limitsRef = useRef<Limits>(limits);
  const [ready, setReady] = useState(false);
  const [expanded, setExpanded] = useState(false);
  /** Label DOM nodes, positioned imperatively so the render loop never
   *  triggers a React update. */
  const labelEls = useRef<Map<string, HTMLDivElement>>(new Map());

  // Keep the latest plant state where the animation loop can reach it without
  // rebuilding the scene on every telemetry tick.
  viewRef.current = v;
  limitsRef.current = limits;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const built = buildScene(mount);
    builtRef.current = built;
    setReady(true);

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let running = true;
    let last = performance.now();
    const clock = { t: 0 };

    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      built.renderer.setSize(w, h, false);
      built.camera.aspect = w / h;
      built.camera.updateProjectionMatrix();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    // Stop drawing when nobody is looking: a control room leaves this open all
    // shift and it should not cook a laptop.
    const visibility = new IntersectionObserver(([entry]) => { running = entry.isIntersecting; });
    visibility.observe(mount);
    const onVisibility = () => { running = !document.hidden; };
    document.addEventListener('visibilitychange', onVisibility);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (!running) return;

      clock.t += dt;
      applyState(built, viewRef.current, limitsRef.current, clock.t, dt, reduceMotion);
      built.controls.update();
      built.renderer.render(built.scene, built.camera);

      // Project the label anchors into screen space and move the HTML nodes.
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      const p = new THREE.Vector3();
      for (const label of built.labels) {
        const el = labelEls.current.get(label.id);
        if (!el) continue;
        p.copy(label.anchor).project(built.camera);
        const behind = p.z >= 1;
        el.style.visibility = behind ? 'hidden' : 'visible';
        if (behind) continue;
        el.style.transform =
          `translate(-50%, -50%) translate(${((p.x + 1) / 2) * w}px, ${((-p.y + 1) / 2) * h}px)`;
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      visibility.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      built.controls.dispose();
      for (const d of built.disposables) d.dispose();
      built.renderer.dispose();
      if (built.renderer.domElement.parentElement === mount) {
        mount.removeChild(built.renderer.domElement);
      }
      builtRef.current = null;
    };
  }, []);

  // Re-theme without rebuilding when the viewer switches light/dark.
  useEffect(() => {
    const apply = () => {
      const b = builtRef.current;
      if (!b) return;
      const dark = isDark();
      b.scene.background = new THREE.Color(dark ? 0x071523 : 0xf4f9fb);
      (b.scene.fog as THREE.Fog).color.set(dark ? 0x071523 : 0xf4f9fb);
      (b.ground.material as THREE.MeshStandardMaterial).color.set(dark ? 0x0f2438 : 0xdde9ef);
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { mq.removeEventListener('change', apply); mo.disconnect(); };
  }, [ready]);

  const resetCamera = () => {
    const b = builtRef.current;
    if (!b) return;
    b.camera.position.set(9, 6.5, 10);
    b.controls.target.set(0, 0.8, 0);
    b.controls.update();
  };

  const chamberPct = Math.round((v.chamberL / Math.max(1, v.batchL)) * 100);
  const tankPct = Math.round((v.tankL / Math.max(1, v.tankCapL)) * 100);

  return (
    <div className={cn('relative', expanded && 'fixed inset-0 z-50 bg-bg p-4')}>
      <div
        ref={mountRef}
        className={cn(
          'relative w-full overflow-hidden rounded-xl border border-line bg-raised',
          expanded ? 'h-[calc(100%-3rem)]' : 'h-[320px] sm:h-[420px]',
          v.offline && 'opacity-50',
        )}
        role="img"
        aria-label={
          `Three-dimensional view of ${deviceName}. Check chamber ${chamberPct}% full, ` +
          `treatment tank ${tankPct}% full at pH ${fmtPh(v.tankPh)}. ` +
          `V1 ${v.v1 ? 'open' : 'shut'}, V2 ${v.v2 ? 'open' : 'shut'}, V3 ${v.v3 ? 'open' : 'shut'}.`
        }
      >
        {/* HTML labels. The text comes from React on each telemetry update;
            the position is written by the render loop. */}
        {LABEL_IDS.map((id) => {
          const text = labelText(id, v);
          if (!text) return null;
          return (
            <div
              key={id}
              ref={(el) => {
                if (el) labelEls.current.set(id, el);
                else labelEls.current.delete(id);
              }}
              className="pointer-events-none absolute left-0 top-0 whitespace-nowrap rounded-md border border-line bg-surface/90 px-2 py-1 text-center font-mono text-[10px] leading-tight text-ink backdrop-blur-sm"
            >
              {text.map((line, n) => (
                <span key={n} className={cn('block', n === 0 && 'font-semibold tracking-[0.08em]')}>
                  {line}
                </span>
              ))}
            </div>
          );
        })}

        <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-1.5">
          <Badge tone={v.offline ? 'crit' : 'neutral'}>
            {v.offline ? 'Offline — last known state' : 'Live'}
          </Badge>
          {v.v3LockReason && !v.v3 ? <Badge tone="warn">V3 locked</Badge> : null}
        </div>

        <div className="absolute right-3 top-3 flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={resetCamera} aria-label="Reset the camera"
            className="bg-surface/80 backdrop-blur-sm">
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setExpanded((e) => !e)}
            aria-label={expanded ? 'Exit full screen' : 'Full screen'}
            className="bg-surface/80 backdrop-blur-sm">
            {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
        </div>

        <p className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] text-muted">
          drag to orbit · scroll to zoom
        </p>
      </div>

      {expanded ? (
        <div className="mt-2 flex justify-end">
          <Button size="sm" onClick={() => setExpanded(false)}>Close</Button>
        </div>
      ) : null}
    </div>
  );
}

const LABEL_IDS = ['sump', 'chamber', 'tank', 'drum', 'V1', 'V2', 'V3', 'river'] as const;

/** Text for each floating label, from the current plant state. */
function labelText(id: string, v: PlantView): string[] | null {
  switch (id) {
    case 'sump':
      return ['SUMP', v.sumpPump ? 'pumping' : 'pump off'];
    case 'chamber': {
      // Say what was actually gauged: centimetres from an ultrasonic head, or
      // litres from a metered vessel. Never both, never a converted guess.
      if (typeof v.chamberDepthCm === 'number') {
        const pct = typeof v.chamberFraction === 'number' ? ` · ${Math.round(v.chamberFraction * 100)}%` : '';
        return ['CHECK CHAMBER', `${v.chamberDepthCm.toFixed(1)} cm to surface${pct}`,
          v.chamberFull ? 'full — testing' : 'filling'];
      }
      return ['CHECK CHAMBER', `${num(v.chamberL)} / ${num(v.batchL)} L`, `pH ${fmtPh(v.ph)} · ${num(v.tds)} mg/L`];
    }
    case 'tank':
      return ['TREATMENT TANK', `${num(v.tankL)} / ${num(v.tankCapL)} L`,
        v.tankL > 0 ? `pH ${fmtPh(v.tankPh)}${v.dosingPump ? ' · dosing' : ''}` : 'empty'];
    case 'drum':
      return ['NEUTRALISER', v.neutraliserPct === null ? '—' : `${Math.round(v.neutraliserPct)}%`];
    case 'V1':
      return ['V1 → RIVER', v.v1 ? 'open' : 'shut'];
    case 'V2':
      return ['V2 → TANK', v.v2 ? 'open' : 'shut'];
    case 'V3':
      return ['V3 → RIVER', v.v3 ? 'open' : v.v3LockReason ? 'locked' : 'shut'];
    case 'river':
      return ['RIVER', v.v1 ? 'receiving tested water' : v.v3 ? 'receiving treated water' : 'no discharge'];
    default:
      return null;
  }
}

function isDark(): boolean {
  const stamped = document.documentElement.dataset.theme;
  if (stamped === 'dark') return true;
  if (stamped === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

// ============================================================ scene ==========

function buildScene(mount: HTMLElement): Built {
  const dark = isDark();
  const disposables: Array<{ dispose: () => void }> = [];
  const keep = <T extends { dispose: () => void }>(x: T): T => { disposables.push(x); return x; };

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(mount.clientWidth || 800, mount.clientHeight || 420, false);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.touchAction = 'pan-y';
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(dark ? 0x071523 : 0xf4f9fb);
  scene.fog = new THREE.Fog(dark ? 0x071523 : 0xf4f9fb, 22, 44);

  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 100);
  camera.position.set(9, 6.5, 10);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0.8, 0);
  controls.minDistance = 6;
  controls.maxDistance = 26;
  controls.maxPolarAngle = Math.PI / 2.08;     // never go under the ground plane
  controls.update();

  // ------------------------------------------------------------- lighting ---
  scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x0b1f33 : 0xa8bcc7, dark ? 1.1 : 1.6));
  const key = new THREE.DirectionalLight(0xffffff, dark ? 1.4 : 1.9);
  key.position.set(7, 12, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x5eead4, 0.5);
  rim.position.set(-8, 5, -7);
  scene.add(rim);

  // ---------------------------------------------------------------- ground ---
  const groundGeo = keep(new THREE.CylinderGeometry(15, 15, 0.3, 64));
  const groundMat = keep(new THREE.MeshStandardMaterial({
    color: dark ? 0x0f2438 : 0xdde9ef, roughness: 0.95, metalness: 0,
  }));
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.y = -0.15;
  scene.add(ground);

  const grid = new THREE.GridHelper(30, 30, dark ? 0x1d3a52 : 0xc7d8e1, dark ? 0x142a3e : 0xd5e3ea);
  grid.position.y = 0.002;
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.5;
  scene.add(grid);
  keep(grid.geometry);

  // --------------------------------------------------------------- helpers ---
  const steel = keep(new THREE.MeshStandardMaterial({
    color: dark ? 0x46607a : 0x8ba3b4, roughness: 0.4, metalness: 0.7,
  }));
  const shellMat = keep(new THREE.MeshPhysicalMaterial({
    color: dark ? 0x9db9cc : 0xc3d5df,
    roughness: 0.15, metalness: 0.1,
    transparent: true, opacity: 0.22,
    side: THREE.DoubleSide,
  }));
  const edgeMat = keep(new THREE.LineBasicMaterial({ color: dark ? 0x6f8aa3 : 0x8399a8 }));

  const addEdges = (geo: THREE.BufferGeometry, mesh: THREE.Object3D) => {
    const edges = keep(new THREE.EdgesGeometry(geo, 25));
    const line = new THREE.LineSegments(edges, edgeMat);
    mesh.add(line);
  };

  /** A vertical vessel: transparent shell, a water cylinder inside, a base. */
  const vessel = (radius: number, height: number, at: THREE.Vector3) => {
    const group = new THREE.Group();
    group.position.copy(at);

    const shellGeo = keep(new THREE.CylinderGeometry(radius, radius, height, 40, 1, true));
    const shell = new THREE.Mesh(shellGeo, shellMat);
    shell.position.y = height / 2;
    group.add(shell);

    const rimGeo = keep(new THREE.TorusGeometry(radius, 0.045, 10, 44));
    const top = new THREE.Mesh(rimGeo, steel);
    top.rotation.x = Math.PI / 2;
    top.position.y = height;
    group.add(top);
    const bottom = new THREE.Mesh(rimGeo, steel);
    bottom.rotation.x = Math.PI / 2;
    group.add(bottom);

    const baseGeo = keep(new THREE.CylinderGeometry(radius * 1.05, radius * 1.1, 0.12, 32));
    const base = new THREE.Mesh(baseGeo, steel);
    base.position.y = -0.06;
    group.add(base);

    // Water: a unit-height cylinder scaled on Y, so the level animates by
    // scaling rather than by rebuilding geometry every frame.
    const waterGeo = keep(new THREE.CylinderGeometry(radius * 0.965, radius * 0.965, 1, 36));
    const waterMat = keep(new THREE.MeshStandardMaterial({
      color: 0x087ea4, transparent: true, opacity: 0.82,
      roughness: 0.18, metalness: 0.05,
    }));
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.userData.height = height;
    water.scale.y = 0.001;
    water.position.y = 0;
    group.add(water);

    scene.add(group);
    return { group, water };
  };

  // ---------------------------------------------------------------- plant ---
  // Sump
  const sumpGeo = keep(new THREE.BoxGeometry(1.6, 0.9, 1.6));
  const sump = new THREE.Mesh(sumpGeo, steel);
  sump.position.set(-6.5, 0.45, 0);
  addEdges(sumpGeo, sump);
  scene.add(sump);

  const chamber = vessel(1.0, CHAMBER_H, new THREE.Vector3(-3.2, 0, 0));
  const tank = vessel(1.5, TANK_H, new THREE.Vector3(3.0, 0, 2.6));
  const drum = vessel(0.42, DRUM_H, new THREE.Vector3(1.0, 0, 3.6));

  // River: a shallow slab with a gently moving surface
  const riverGeo = keep(new THREE.BoxGeometry(4.0, 0.18, 12));
  const riverMat = keep(new THREE.MeshStandardMaterial({
    color: 0x087ea4, transparent: true, opacity: 0.78, roughness: 0.22, metalness: 0.1,
  }));
  const river = new THREE.Mesh(riverGeo, riverMat);
  river.position.set(7.6, 0.09, 0);
  scene.add(river);

  const bankGeo = keep(new THREE.BoxGeometry(4.6, 0.3, 12.6));
  const bank = new THREE.Mesh(bankGeo, keep(new THREE.MeshStandardMaterial({
    color: dark ? 0x132c42 : 0xcbdae2, roughness: 1,
  })));
  bank.position.set(7.6, -0.02, 0);
  scene.add(bank);

  // ---------------------------------------------------------------- valves ---
  const valveBody = keep(new THREE.CylinderGeometry(0.28, 0.28, 0.42, 20));
  const makeValve = (at: THREE.Vector3) => {
    const mat = keep(new THREE.MeshStandardMaterial({
      color: 0x7c93a6, roughness: 0.4, metalness: 0.5,
      emissive: new THREE.Color(0x000000), emissiveIntensity: 1,
    }));
    const mesh = new THREE.Mesh(valveBody, mat);
    mesh.position.copy(at);
    mesh.rotation.z = Math.PI / 2;
    scene.add(mesh);

    const collarGeo = keep(new THREE.TorusGeometry(0.3, 0.05, 8, 24));
    const collar = new THREE.Mesh(collarGeo, steel);
    collar.rotation.y = Math.PI / 2;
    mesh.add(collar);
    return mesh;
  };

  const v1 = makeValve(new THREE.Vector3(0.2, 1.5, -1.9));
  const v2 = makeValve(new THREE.Vector3(0.2, 1.0, 2.6));
  const v3 = makeValve(new THREE.Vector3(5.2, 0.95, 2.6));

  // ----------------------------------------------------------------- pipes ---
  const pipeMat = keep(new THREE.MeshStandardMaterial({
    color: dark ? 0x3a5670 : 0x9aaebc, roughness: 0.5, metalness: 0.6,
  }));

  const pipe = (points: THREE.Vector3[], radius = 0.13) => {
    const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.02);
    const geo = keep(new THREE.TubeGeometry(curve, Math.max(24, points.length * 12), radius, 12, false));
    const mesh = new THREE.Mesh(geo, pipeMat);
    scene.add(mesh);
    return curve;
  };

  // sump -> chamber
  const cSump = pipe([
    new THREE.Vector3(-6.5, 0.95, 0), new THREE.Vector3(-6.5, 1.9, 0),
    new THREE.Vector3(-5.2, 2.15, 0), new THREE.Vector3(-3.9, 2.25, 0),
  ]);
  // chamber -> manifold -> V1 -> river
  const cV1 = pipe([
    new THREE.Vector3(-3.2, 0.55, 0), new THREE.Vector3(-1.6, 0.55, 0),
    new THREE.Vector3(-0.6, 1.0, -0.9), new THREE.Vector3(0.2, 1.5, -1.9),
    new THREE.Vector3(2.6, 1.5, -2.4), new THREE.Vector3(5.4, 1.2, -2.0),
    new THREE.Vector3(6.6, 0.7, -1.2), new THREE.Vector3(7.0, 0.35, -0.6),
  ]);
  // chamber -> manifold -> V2 -> tank
  const cV2 = pipe([
    new THREE.Vector3(-3.2, 0.55, 0), new THREE.Vector3(-1.6, 0.55, 0),
    new THREE.Vector3(-0.8, 0.8, 1.4), new THREE.Vector3(0.2, 1.0, 2.6),
    new THREE.Vector3(1.4, 1.6, 2.6), new THREE.Vector3(2.4, 1.9, 2.6),
  ]);
  // tank -> V3 -> river
  const cV3 = pipe([
    new THREE.Vector3(4.4, 0.55, 2.6), new THREE.Vector3(5.2, 0.95, 2.6),
    new THREE.Vector3(6.2, 0.8, 2.2), new THREE.Vector3(7.0, 0.35, 1.4),
  ]);
  // drum -> tank (dosing line, thinner)
  const cDose = pipe([
    new THREE.Vector3(1.0, 1.0, 3.6), new THREE.Vector3(1.8, 1.9, 3.3),
    new THREE.Vector3(2.6, 2.0, 2.9),
  ], 0.06);

  // ----------------------------------------------------------- flow markers ---
  const dotGeo = keep(new THREE.SphereGeometry(0.085, 10, 8));
  const makeFlow = (
    keyName: string, curve: THREE.CatmullRomCurve3, count = 7, size = 1,
    tint: { color: number; emissive: number } = FLOW_PASS,
  ) => {
    const mat = keep(new THREE.MeshStandardMaterial({
      color: tint.color, emissive: new THREE.Color(tint.emissive), emissiveIntensity: 0.9,
      transparent: true, opacity: 0.95,
    }));
    const dots: THREE.Mesh[] = [];
    for (let n = 0; n < count; n++) {
      const dot = new THREE.Mesh(dotGeo, mat);
      dot.scale.setScalar(size);
      dot.visible = false;
      scene.add(dot);
      dots.push(dot);
    }
    return { key: keyName, curve, dots };
  };

  const flows = [
    // Colour carries the meaning: water on its way to the river is not the
    // same event as water being pulled aside for treatment, and at a glance
    // the two paths were previously indistinguishable.
    makeFlow('sump', cSump, 7, 1, FLOW_RAW),
    makeFlow('v1', cV1, 10, 1, FLOW_PASS),     // tested, passed -> river
    makeFlow('v2', cV2, 8, 1, FLOW_FAIL),      // failed -> treatment tank
    makeFlow('v3', cV3, 6, 1, FLOW_PASS),      // treated and re-tested -> river
    makeFlow('dose', cDose, 4, 0.6, FLOW_DOSE),
  ];

  // --------------------------------------------------------------- labels ---
  const labels = [
    { id: 'sump', anchor: new THREE.Vector3(-6.5, 1.5, 0) },
    { id: 'chamber', anchor: new THREE.Vector3(-3.2, CHAMBER_H + 0.75, 0) },
    { id: 'tank', anchor: new THREE.Vector3(3.0, TANK_H + 0.8, 2.6) },
    { id: 'drum', anchor: new THREE.Vector3(1.0, DRUM_H + 0.5, 3.6) },
    { id: 'V1', anchor: new THREE.Vector3(0.2, 2.15, -1.9) },
    { id: 'V2', anchor: new THREE.Vector3(0.2, 1.65, 2.6) },
    { id: 'V3', anchor: new THREE.Vector3(5.2, 1.6, 2.6) },
    { id: 'river', anchor: new THREE.Vector3(7.6, 1.0, -4.2) },
  ];

  return {
    renderer, scene, camera, controls,
    chamberWater: chamber.water,
    tankWater: tank.water,
    drumWater: drum.water,
    valves: { V1: v1, V2: v2, V3: v3 },
    flows, labels, ground, river, disposables,
  };
}

// ============================================================ per frame ======

function applyState(
  b: Built, v: PlantView, limits: Limits, t: number, dt: number, reduceMotion: boolean,
) {
  // ---- levels ------------------------------------------------------------
  // A depth-gauged chamber — the bench rig's ultrasonic — reports how full it
  // is directly; a metered one is a ratio of litres. Either way it fills.
  setLevel(b.chamberWater,
    typeof v.chamberFraction === 'number' ? v.chamberFraction : v.chamberL / Math.max(1, v.batchL),
    CHAMBER_H, dt);
  setLevel(b.tankWater, v.tankL / Math.max(1, v.tankCapL), TANK_H, dt);
  setLevel(b.drumWater, (v.neutraliserPct ?? 0) / 100, DRUM_H, dt);

  // ---- colour by quality -------------------------------------------------
  (b.chamberWater.material as THREE.MeshStandardMaterial).color.setHex(
    waterColour(v.ph, v.tds, limits));
  (b.tankWater.material as THREE.MeshStandardMaterial).color.setHex(
    waterColour(v.tankPh, null, limits));
  (b.drumWater.material as THREE.MeshStandardMaterial).color.setHex(
    (v.neutraliserPct ?? 0) <= 0 ? 0xef4444 : 0x14b8a6);

  // ---- valves ------------------------------------------------------------
  setValve(b.valves.V1, v.v1, false, t, reduceMotion);
  setValve(b.valves.V2, v.v2, false, t, reduceMotion);
  setValve(b.valves.V3, v.v3, Boolean(v.v3LockReason) && !v.v3, t, reduceMotion);

  // ---- flow --------------------------------------------------------------
  const active: Record<string, boolean> = {
    sump: v.sumpPump,
    v1: v.v1,
    v2: v.v2,
    v3: v.v3,
    dose: v.dosingPump,
  };

  for (const flow of b.flows) {
    const on = Boolean(active[flow.key]) && !v.offline;
    flow.dots.forEach((dot, n) => {
      dot.visible = on;
      if (!on) return;
      // Evenly spaced along the pipe, marching from source to destination.
      const phase = reduceMotion ? n / flow.dots.length : (t * 0.35 + n / flow.dots.length) % 1;
      flow.curve.getPointAt(phase, dot.position);
    });
  }

  // ---- river surface -----------------------------------------------------
  const receiving = (v.v1 || v.v3) && !v.offline;
  const riverMat = b.river.material as THREE.MeshStandardMaterial;
  riverMat.color.lerp(new THREE.Color(receiving ? 0x0ea5cf : 0x087ea4), 0.05);
  if (!reduceMotion) b.river.position.y = 0.09 + Math.sin(t * 1.1) * 0.012;
}

/**
 * Ease the level toward its target so a fresh telemetry sample does not make
 * the water jump. The fraction is tracked in userData because scale.y is in
 * world units once the vessel height is applied.
 */
function setLevel(water: THREE.Mesh, fraction: number, height: number, dt: number) {
  const target = Math.max(0.001, Math.min(1, fraction));
  const current = (water.userData.fraction as number) ?? target;
  const next = current + (target - current) * Math.min(1, dt * 4);
  water.userData.fraction = next;
  water.scale.y = next * height;          // the source cylinder is 1 unit high
  water.position.y = (next * height) / 2;
}

function setValve(mesh: THREE.Mesh, open: boolean, locked: boolean, t: number, reduceMotion: boolean) {
  const mat = mesh.material as THREE.MeshStandardMaterial;
  const target = new THREE.Color(open ? 0x16a34a : locked ? 0xb91c1c : 0x000000);
  mat.emissive.lerp(target, 0.12);
  mat.emissiveIntensity = locked && !reduceMotion ? 0.7 + Math.sin(t * 4) * 0.3 : 1;
  // An open valve turns its handwheel; a shut one sits still.
  if (open && !reduceMotion) mesh.rotation.x += 0.02;
}
