// UV Editor: shows UVs of faces selected in Edit Mode over the texture image, with
// its own per-corner selection, grab/rotate/scale, selection tools and UV menus.
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app, registerOperators, type ChangeKind } from '../../app/app';
import { registerEditor, type Area, type Editor } from '../../ui/screen';
import { openMenu, type MenuItem } from '../../ui/menu';
import { enumMenu, enumRow } from '../../ui/widgets';
import { addKeys } from '../../app/keymap';
import type { MeshData, ObjectData, ImageData } from '../../data/types';
import { imageCanvas } from '../../render/images';
import { materialSlots } from '../view3d/draw';
import { packIslands } from '../../modes/editmesh/ops-uv';
import { MeshEdit } from '../../modes/editmesh/meshedit';

type UVSelMode = 'VERTEX' | 'EDGE' | 'FACE' | 'ISLAND';

interface Target {
  ob: ObjectData;
  me: MeshData;
  /** faces shown in the editor */
  faces: number[];
}

function targets(): Target[] {
  if (app.doc.mode !== 'EDIT') return [];
  const sync = app.doc.scene.tool_settings.use_uv_select_sync;
  return app
    .editObjects()
    .filter((o) => o.type === 'MESH' && o.data)
    .map((ob) => {
      const me = app.doc.meshes[ob.data!];
      const faces: number[] = [];
      const sel = me.select_vert;
      for (let f = 0; f < me.offsets.length - 1; f++) {
        let all = true,
          hidden = false;
        for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
          if (!sel?.[me.indices[c]]) all = false;
          if (me.hide_vert?.[me.indices[c]]) hidden = true;
        }
        if (!hidden && (sync || all)) faces.push(f);
      }
      return { ob, me, faces };
    });
}

function uvSel(me: MeshData): Uint8Array {
  if (!me.uv_select || me.uv_select.length !== me.indices.length) me.uv_select = new Uint8Array(me.indices.length);
  return me.uv_select;
}

/** Image shown behind the UVs: active material's first Image Texture node. */
function activeImage(me: MeshData, ob: ObjectData): ImageData | null {
  const slots = materialSlots(app.doc, ob);
  const ma = slots[ob.active_material_index] ?? slots[0];
  const mat = ma ? app.doc.materials[ma] : undefined;
  const node = mat?.tree.nodes.find((n) => n.type === 'ShaderNodeTexImage' && n.props.image);
  const id = node?.props.image as string | undefined;
  void me;
  return id ? app.doc.images[id] ?? null : null;
}

export class UVEditor implements Editor {
  el: HTMLElement;
  keymaps = ['UV Editor', 'Window', 'Screen'];
  canvas: HTMLCanvasElement;
  zoom = 1;
  pan = { x: 0, y: 0 };
  mode: UVSelMode = 'VERTEX';
  imageId: string | null = null;
  private fitted = false;
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor(public area: Area) {
    this.el = document.createElement('div');
    this.el.className = 'uv-editor';
    this.el.style.position = 'absolute';
    this.el.style.inset = '0';
    this.el.tabIndex = -1;
    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'absolute';
    this.canvas.style.inset = '0';
    this.el.append(this.canvas);
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(uvContextMenu(), { x: e.clientX, y: e.clientY });
    });
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  // view transform: uv (0..1, v up) → pixels
  private size() {
    return Math.min(this.el.clientWidth, this.el.clientHeight) * 0.8 * this.zoom;
  }
  toPx(u: number, v: number) {
    const s = this.size();
    const cx = this.el.clientWidth / 2 + this.pan.x,
      cy = this.el.clientHeight / 2 + this.pan.y;
    return { x: cx + (u - 0.5) * s, y: cy - (v - 0.5) * s };
  }
  toUV(x: number, y: number) {
    const s = this.size();
    const cx = this.el.clientWidth / 2 + this.pan.x,
      cy = this.el.clientHeight / 2 + this.pan.y;
    return { u: (x - cx) / s + 0.5, v: -(y - cy) / s + 0.5 };
  }

  header(): Child {
    const ts = app.doc.scene.tool_settings;
    const images = Object.values(app.doc.images);
    const t = targets()[0];
    const autoImg = t ? activeImage(t.me, t.ob) : null;
    const cur = this.imageId ?? autoImg?.id ?? '';
    return h(
      'div',
      { class: 'hdr-row' },
      h('button', { class: { 'hdr-toggle': true, on: ts.use_uv_select_sync }, 'data-tip': 'UV Sync Selection\nKeep UV and edit mode mesh selection in sync', onclick: () => ((ts.use_uv_select_sync = !ts.use_uv_select_sync), app.pushUndo('UV Sync Selection'), app.changed('ui')) }, icon('uv')),
      enumRow(
        'uv-selmode',
        [
          { value: 'VERTEX', label: '', icon: 'snap_vertex', description: 'Vertex' },
          { value: 'EDGE', label: '', icon: 'snap_edge', description: 'Edge' },
          { value: 'FACE', label: '', icon: 'snap_face', description: 'Face' },
          { value: 'ISLAND', label: '', icon: 'uv', description: 'Island' },
        ],
        this.mode,
        (m) => ((this.mode = m as UVSelMode), (ts.uv_select_mode = m as UVSelMode), this.draw(), this.area.drawHeader()),
        { iconOnly: true },
      ),
      ...(
        [
          ['View', () => [{ label: 'Frame All', op: 'uv.view_all', shortcut: 'Home' }, { label: 'Frame Selected', op: 'uv.view_selected', shortcut: 'Numpad .' }, { separator: true }, { label: 'Zoom 1:1', action: () => ((this.zoom = 1), this.draw()) }]],
          ['Select', () => [
            { label: 'All', op: 'uv.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
            { label: 'None', op: 'uv.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
            { label: 'Invert', op: 'uv.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
            { separator: true },
            { label: 'Select Linked', op: 'uv.select_linked', shortcut: 'Ctrl L' },
          ]],
          ['Image', () => [{ label: 'New', op: 'image.new' }, { label: 'Open…', op: 'image.open' }]],
          ['UV', () => uvMenu()],
        ] as [string, () => MenuItem[]][]
      ).map(([label, fn]) => h('button', { key: label, class: 'hdr-menu', onpointerdown: (e: PointerEvent) => (e.preventDefault(), openMenu(fn(), e.currentTarget as HTMLElement)) }, label)),
      h('div', { class: 'hdr-spacer' }),
      h('div', { style: 'width:180px' }, enumMenu('uv-image', [{ value: '', label: 'Image' }, ...images.map((i) => ({ value: i.id, label: i.name, icon: 'image' }))], cur, (v) => ((this.imageId = v || null), this.draw(), this.area.drawHeader()))),
    );
  }

  update(kinds?: Set<ChangeKind>) {
    void kinds;
    this.draw();
  }

  draw() {
    const c = this.canvas;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = this.el.clientWidth,
      H = this.el.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#303030';
    g.fillRect(0, 0, W, H);
    const t0 = this.toPx(0, 1),
      t1 = this.toPx(1, 0);
    const ts = targets();
    const img = this.imageId ? app.doc.images[this.imageId] : ts[0] ? activeImage(ts[0].me, ts[0].ob) : null;
    if (img) {
      g.imageSmoothingEnabled = this.zoom < 4;
      g.drawImage(imageCanvas(img), t0.x, t0.y, t1.x - t0.x, t1.y - t0.y);
    } else {
      // checker background for the 0–1 tile
      const n = 8;
      const s = (t1.x - t0.x) / n;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          g.fillStyle = (i + j) % 2 ? '#3d3d3d' : '#363636';
          g.fillRect(t0.x + i * s, t0.y + j * s, s + 0.5, s + 0.5);
        }
    }
    // grid lines
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      const a = this.toPx(i / 8, 0),
        b = this.toPx(i / 8, 1);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      const cc = this.toPx(0, i / 8),
        d = this.toPx(1, i / 8);
      g.beginPath();
      g.moveTo(cc.x, cc.y);
      g.lineTo(d.x, d.y);
      g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.strokeRect(t0.x, t0.y, t1.x - t0.x, t1.y - t0.y);
    if (!ts.length) {
      g.fillStyle = '#888';
      g.font = '12px Inter, sans-serif';
      g.textAlign = 'center';
      g.fillText(app.doc.mode === 'EDIT' ? 'Select faces in the 3D Viewport to edit their UVs' : 'Enter Edit Mode on a mesh to edit its UVs', W / 2, 24);
      return;
    }
    // faces
    for (const t of ts) {
      const sel = uvSel(t.me);
      for (const f of t.faces) {
        const s = t.me.offsets[f],
          e = t.me.offsets[f + 1];
        g.beginPath();
        let allSel = true;
        for (let k = s; k < e; k++) {
          const p = this.toPx(t.me.uvs[k * 2], t.me.uvs[k * 2 + 1]);
          if (k === s) g.moveTo(p.x, p.y);
          else g.lineTo(p.x, p.y);
          if (!sel[k]) allSel = false;
        }
        g.closePath();
        g.fillStyle = allSel ? 'rgba(255,133,0,0.24)' : 'rgba(255,255,255,0.05)';
        g.fill();
      }
      // edges
      for (const f of t.faces) {
        const s = t.me.offsets[f],
          e = t.me.offsets[f + 1];
        for (let k = s; k < e; k++) {
          const k2 = k + 1 < e ? k + 1 : s;
          const a = this.toPx(t.me.uvs[k * 2], t.me.uvs[k * 2 + 1]),
            b = this.toPx(t.me.uvs[k2 * 2], t.me.uvs[k2 * 2 + 1]);
          const seam = t.me.seams?.[k];
          g.strokeStyle = sel[k] && sel[k2] ? '#ff8500' : seam ? '#db2512' : '#c0c0c0';
          g.lineWidth = sel[k] && sel[k2] ? 1.6 : 1;
          g.beginPath();
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
          g.stroke();
        }
      }
      if (this.mode === 'VERTEX')
        for (const f of t.faces)
          for (let k = t.me.offsets[f]; k < t.me.offsets[f + 1]; k++) {
            const p = this.toPx(t.me.uvs[k * 2], t.me.uvs[k * 2 + 1]);
            g.fillStyle = sel[k] ? '#ff8500' : '#000';
            g.fillRect(p.x - 2, p.y - 2, 4, 4);
          }
      if (this.mode === 'FACE' || this.mode === 'ISLAND')
        for (const f of t.faces) {
          let u = 0,
            v = 0,
            all = true;
          const s = t.me.offsets[f],
            e = t.me.offsets[f + 1];
          for (let k = s; k < e; k++) {
            u += t.me.uvs[k * 2] / (e - s);
            v += t.me.uvs[k * 2 + 1] / (e - s);
            if (!sel[k]) all = false;
          }
          const p = this.toPx(u, v);
          g.fillStyle = all ? '#ff8500' : '#000';
          g.fillRect(p.x - 2, p.y - 2, 4, 4);
        }
    }
    if (this.box) {
      g.setLineDash([4, 3]);
      g.strokeStyle = '#fff';
      g.strokeRect(Math.min(this.box.x0, this.box.x1), Math.min(this.box.y0, this.box.y1), Math.abs(this.box.x1 - this.box.x0), Math.abs(this.box.y1 - this.box.y0));
      g.setLineDash([]);
    }
    // 2D cursor
    const cur = this.toPx(cursor.u, cursor.v);
    g.strokeStyle = '#d40000';
    g.setLineDash([3, 3]);
    g.beginPath();
    g.arc(cur.x, cur.y, 7, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
  }

  local(e: { clientX: number; clientY: number }) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const p = this.local(e);
    const before = this.toUV(p.x, p.y);
    if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) this.zoom = Math.max(0.05, Math.min(200, this.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))));
    else this.pan.x -= e.deltaX;
    const after = this.toPx(before.u, before.v);
    this.pan.x += p.x - after.x;
    this.pan.y += p.y - after.y;
    this.draw();
  }

  private onDown(e: PointerEvent) {
    this.el.focus({ preventScroll: true });
    if (app.modal) {
      const r = app.modal.onPointerDown?.(e);
      if (r) app.endModal(r);
      return;
    }
    const p0 = this.local(e);
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      let last = { x: e.clientX, y: e.clientY };
      const move = (ev: PointerEvent) => {
        this.pan.x += ev.clientX - last.x;
        this.pan.y += ev.clientY - last.y;
        last = { x: ev.clientX, y: ev.clientY };
        this.draw();
      };
      const up = () => (removeEventListener('pointermove', move), removeEventListener('pointerup', up));
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      return;
    }
    if (e.button === 2 && e.shiftKey) {
      const uv = this.toUV(p0.x, p0.y);
      cursor.u = uv.u;
      cursor.v = uv.v;
      this.draw();
      return;
    }
    if (e.button !== 0) return;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      const p = this.local(ev);
      if (!dragging && Math.hypot(p.x - p0.x, p.y - p0.y) > 4) dragging = true;
      if (dragging) {
        this.box = { x0: p0.x, y0: p0.y, x1: p.x, y1: p.y };
        this.draw();
      }
    };
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      const p = this.local(ev);
      if (dragging && this.box) {
        const a = this.toUV(Math.min(this.box.x0, this.box.x1), Math.max(this.box.y0, this.box.y1)),
          b = this.toUV(Math.max(this.box.x0, this.box.x1), Math.min(this.box.y0, this.box.y1));
        this.box = null;
        boxSelect(a.u, a.v, b.u, b.v, ev.shiftKey ? 'ADD' : ev.ctrlKey ? 'SUB' : 'SET', this.mode);
      } else this.pick(p.x, p.y, ev.shiftKey);
      app.pushUndo('Select');
      app.changed('select');
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  pick(x: number, y: number, extend: boolean) {
    const ts = targets();
    let best: { t: Target; corner: number; face: number; d: number } | null = null;
    for (const t of ts)
      for (const f of t.faces)
        for (let k = t.me.offsets[f]; k < t.me.offsets[f + 1]; k++) {
          const p = this.toPx(t.me.uvs[k * 2], t.me.uvs[k * 2 + 1]);
          const d = Math.hypot(p.x - x, p.y - y);
          if (d < 30 && (!best || d < best.d)) best = { t, corner: k, face: f, d };
        }
    // face mode: point-in-polygon test
    if (this.mode === 'FACE' || this.mode === 'ISLAND') {
      const uv = this.toUV(x, y);
      for (const t of ts)
        for (const f of t.faces) {
          const s = t.me.offsets[f],
            e = t.me.offsets[f + 1];
          let inside = false;
          for (let i = s, j = e - 1; i < e; j = i++) {
            const ui = t.me.uvs[i * 2],
              vi = t.me.uvs[i * 2 + 1],
              uj = t.me.uvs[j * 2],
              vj = t.me.uvs[j * 2 + 1];
            if (vi > uv.v !== vj > uv.v && uv.u < ((uj - ui) * (uv.v - vi)) / (vj - vi) + ui) inside = !inside;
          }
          if (inside) best = { t, corner: s, face: f, d: 0 };
        }
    }
    if (!extend) for (const t of ts) uvSel(t.me).fill(0);
    if (!best) return;
    const sel = uvSel(best.t.me);
    const corners = this.mode === 'VERTEX' ? coincident(best.t.me, best.t.faces, best.corner) : this.mode === 'EDGE' ? edgeCorners(best.t.me, best.t.faces, best.corner) : this.mode === 'FACE' ? faceCorners(best.t.me, best.face) : islandCorners(best.t.me, best.t.faces, best.face);
    const on = !(extend && corners.every((c) => sel[c]));
    for (const c of corners) sel[c] = on ? 1 : 0;
  }

  serialize() {
    return { zoom: this.zoom, pan: this.pan, mode: this.mode };
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.code === 'Home') {
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
      this.draw();
      return true;
    }
    void this.fitted;
    return false;
  }

  dispose() {}
}

export const cursor = { u: 0.5, v: 0.5 };

function coincident(me: MeshData, faces: number[], corner: number): number[] {
  const v = me.indices[corner],
    u = me.uvs[corner * 2],
    w = me.uvs[corner * 2 + 1];
  const out: number[] = [];
  for (const f of faces)
    for (let k = me.offsets[f]; k < me.offsets[f + 1]; k++) if (me.indices[k] === v && Math.abs(me.uvs[k * 2] - u) < 1e-6 && Math.abs(me.uvs[k * 2 + 1] - w) < 1e-6) out.push(k);
  return out;
}

function edgeCorners(me: MeshData, faces: number[], corner: number): number[] {
  // corner and its next corner in the face (edge starting at corner) plus coincident ones
  let f = 0;
  while (me.offsets[f + 1] <= corner) f++;
  const next = corner + 1 < me.offsets[f + 1] ? corner + 1 : me.offsets[f];
  return [...coincident(me, faces, corner), ...coincident(me, faces, next)];
}

function faceCorners(me: MeshData, f: number): number[] {
  return Array.from({ length: me.offsets[f + 1] - me.offsets[f] }, (_, i) => me.offsets[f] + i);
}

function islandCorners(me: MeshData, faces: number[], f0: number): number[] {
  const visible = new Set(faces);
  const key = (k: number) => `${me.indices[k]}|${me.uvs[k * 2].toFixed(6)}|${me.uvs[k * 2 + 1].toFixed(6)}`;
  const byKey = new Map<string, number[]>();
  for (const f of faces) for (let k = me.offsets[f]; k < me.offsets[f + 1]; k++) (byKey.get(key(k)) ?? byKey.set(key(k), []).get(key(k))!).push(f);
  const seen = new Set([f0]);
  const st = [f0];
  while (st.length) {
    const f = st.pop()!;
    for (let k = me.offsets[f]; k < me.offsets[f + 1]; k++)
      for (const g of byKey.get(key(k)) ?? [])
        if (!seen.has(g) && visible.has(g)) {
          seen.add(g);
          st.push(g);
        }
  }
  return [...seen].flatMap((f) => faceCorners(me, f));
}

function boxSelect(u0: number, v0: number, u1: number, v1: number, mode: 'SET' | 'ADD' | 'SUB', selMode: UVSelMode) {
  for (const t of targets()) {
    const sel = uvSel(t.me);
    if (mode === 'SET') sel.fill(0);
    for (const f of t.faces) {
      const s = t.me.offsets[f],
        e = t.me.offsets[f + 1];
      if (selMode === 'FACE' || selMode === 'ISLAND') {
        let u = 0,
          v = 0;
        for (let k = s; k < e; k++) {
          u += t.me.uvs[k * 2] / (e - s);
          v += t.me.uvs[k * 2 + 1] / (e - s);
        }
        if (u >= u0 && u <= u1 && v >= v0 && v <= v1) for (let k = s; k < e; k++) sel[k] = mode === 'SUB' ? 0 : 1;
        continue;
      }
      for (let k = s; k < e; k++) {
        const u = t.me.uvs[k * 2],
          v = t.me.uvs[k * 2 + 1];
        if (u >= u0 && u <= u1 && v >= v0 && v <= v1) sel[k] = mode === 'SUB' ? 0 : 1;
      }
    }
  }
}

function uvMenu(): MenuItem[] {
  return [
    { label: 'Unwrap', op: 'uv.unwrap' },
    { label: 'Smart UV Project', op: 'uv.smart_project' },
    { label: 'Lightmap Pack', op: 'uv.lightmap_pack' },
    { label: 'Follow Active Quads', op: 'uv.follow_active_quads' },
    { separator: true },
    { label: 'Pack Islands', op: 'uv.pack_islands' },
    { label: 'Average Islands Scale', op: 'uv.average_islands_scale' },
    { separator: true },
    { label: 'Mirror X', op: 'uv.mirror', props: { axis: 0 } },
    { label: 'Mirror Y', op: 'uv.mirror', props: { axis: 1 } },
    { label: 'Rotate 90°', op: 'uv.rotate90' },
    { separator: true },
    { label: 'Snap Selected to Cursor', op: 'uv.snap_selected' },
    { label: 'Snap Cursor to Selected', op: 'uv.snap_cursor' },
  ];
}

function uvContextMenu(): MenuItem[] {
  return [{ label: 'Unwrap', op: 'uv.unwrap' }, { label: 'Pack Islands', op: 'uv.pack_islands' }, { separator: true }, { label: 'Mirror X', op: 'uv.mirror', props: { axis: 0 } }, { label: 'Mirror Y', op: 'uv.mirror', props: { axis: 1 } }];
}

function activeUVEditor(): UVEditor | null {
  const a = app.hoverArea ?? app.activeArea;
  return a && (a.editor as unknown) instanceof UVEditor ? (a.editor as UVEditor) : null;
}

/** Selected UV corners of all targets: [mesh, corner indices]. */
function selectedCorners(): { me: MeshData; corners: number[] }[] {
  return targets().map((t) => {
    const sel = uvSel(t.me);
    const corners: number[] = [];
    for (const f of t.faces) for (let k = t.me.offsets[f]; k < t.me.offsets[f + 1]; k++) if (sel[k]) corners.push(k);
    return { me: t.me, corners };
  });
}

function transformUVs(fn: (u: number, v: number) => [number, number]) {
  for (const { me, corners } of selectedCorners()) {
    if (!corners.length) continue;
    const uv = new Float32Array(me.uvs);
    for (const k of corners) {
      const [u, v] = fn(uv[k * 2], uv[k * 2 + 1]);
      uv[k * 2] = u;
      uv[k * 2 + 1] = v;
    }
    me.uvs = uv;
  }
}

function startUVTransform(kind: 'G' | 'R' | 'S') {
  const ed = activeUVEditor();
  if (!ed) return 'CANCELLED' as const;
  const sels = selectedCorners();
  if (!sels.some((s) => s.corners.length)) return 'CANCELLED' as const;
  const base = sels.map((s) => ({ me: s.me, uvs: new Float32Array(s.me.uvs), corners: s.corners }));
  let cu = 0,
    cv = 0,
    n = 0;
  for (const b of base)
    for (const k of b.corners) {
      cu += b.uvs[k * 2];
      cv += b.uvs[k * 2 + 1];
      n++;
    }
  cu /= n;
  cv /= n;
  const r = ed.el.getBoundingClientRect();
  const start = { x: app.pointer.x - r.left, y: app.pointer.y - r.top };
  const c = ed.toPx(cu, cv);
  let axis: 0 | 1 | -1 = -1;
  let numeric = '';
  let last = { u: 0, v: 0, a: 0, s: 1 };
  const apply = (mx: number, my: number, snap: boolean) => {
    const num = numeric ? parseFloat(numeric) : NaN;
    for (const b of base) {
      const uv = new Float32Array(b.uvs);
      for (const k of b.corners) {
        let u = b.uvs[k * 2],
          v = b.uvs[k * 2 + 1];
        if (kind === 'G') {
          const p0 = ed.toUV(start.x, start.y),
            p1 = ed.toUV(mx, my);
          let du = p1.u - p0.u,
            dv = p1.v - p0.v;
          if (Number.isFinite(num)) {
            du = axis === 1 ? 0 : num;
            dv = axis === 1 ? num : 0;
          }
          if (axis === 0) dv = 0;
          if (axis === 1) du = 0;
          if (snap) {
            du = Math.round(du * 64) / 64;
            dv = Math.round(dv * 64) / 64;
          }
          u += du;
          v += dv;
          last = { ...last, u: du, v: dv };
        } else if (kind === 'R') {
          const a0 = Math.atan2(start.y - c.y, start.x - c.x),
            a1 = Math.atan2(my - c.y, mx - c.x);
          let a = Number.isFinite(num) ? (num * Math.PI) / 180 : -(a1 - a0);
          if (snap) a = Math.round(a / (Math.PI / 36)) * (Math.PI / 36);
          const du = u - cu,
            dv = v - cv;
          u = cu + du * Math.cos(a) - dv * Math.sin(a);
          v = cv + du * Math.sin(a) + dv * Math.cos(a);
          last = { ...last, a };
        } else {
          let s = Number.isFinite(num) ? num : Math.hypot(mx - c.x, my - c.y) / Math.max(1, Math.hypot(start.x - c.x, start.y - c.y));
          if (snap) s = Math.round(s * 10) / 10;
          if (axis !== 1) u = cu + (u - cu) * s;
          if (axis !== 0) v = cv + (v - cv) * s;
          last = { ...last, s };
        }
        uv[k * 2] = u;
        uv[k * 2 + 1] = v;
      }
      b.me.uvs = uv;
    }
    app.changed('geometry');
  };
  let mouse = { ...start };
  app.startModal({
    label: kind === 'G' ? 'Move' : kind === 'R' ? 'Rotate' : 'Resize',
    header: () => (kind === 'G' ? `D: ${last.u.toFixed(4)}  ${last.v.toFixed(4)}` : kind === 'R' ? `Rot: ${((last.a * 180) / Math.PI).toFixed(2)}°` : `Scale: ${last.s.toFixed(4)}`) + (numeric ? ` [${numeric}]` : '') + (axis >= 0 ? ` along ${'XY'[axis]}` : ''),
    onPointerMove(e) {
      mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      apply(mouse.x, mouse.y, e.ctrlKey);
    },
    onPointerDown(e) {
      return e.button === 0 ? 'FINISHED' : 'CANCELLED';
    },
    onKey(e) {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      if (e.key === 'x' || e.key === 'X') axis = axis === 0 ? -1 : 0;
      else if (e.key === 'y' || e.key === 'Y') axis = axis === 1 ? -1 : 1;
      else if (/^[0-9.\-]$/.test(e.key)) numeric += e.key;
      else if (e.key === 'Backspace') numeric = numeric.slice(0, -1);
      apply(mouse.x, mouse.y, false);
      return true;
    },
    cancel() {
      for (const b of base) b.me.uvs = b.uvs;
      app.changed('geometry');
    },
  });
  apply(start.x, start.y, false);
  return 'RUNNING_MODAL' as const;
}

const uvPoll = () => !!activeUVEditor() && app.doc.mode === 'EDIT';

registerOperators([
  { idname: 'uv.translate', label: 'Move', poll: uvPoll, invoke: () => startUVTransform('G'), undo: false },
  { idname: 'uv.rotate', label: 'Rotate', poll: uvPoll, invoke: () => startUVTransform('R'), undo: false },
  { idname: 'uv.resize', label: 'Resize', poll: uvPoll, invoke: () => startUVTransform('S'), undo: false },
  {
    idname: 'uv.select_all',
    label: '(De)select All',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] }],
    poll: () => app.doc.mode === 'EDIT',
    exec: (_ctx, p) => {
      const ts = targets();
      let action = p.action as string;
      if (action === 'TOGGLE') action = ts.some((t) => t.faces.some((f) => uvSel(t.me).subarray(t.me.offsets[f], t.me.offsets[f + 1]).some(Boolean))) ? 'DESELECT' : 'SELECT';
      for (const t of ts) {
        const sel = new Uint8Array(uvSel(t.me));
        for (const f of t.faces) for (let k = t.me.offsets[f]; k < t.me.offsets[f + 1]; k++) sel[k] = action === 'SELECT' ? 1 : action === 'DESELECT' ? 0 : sel[k] ^ 1;
        t.me.uv_select = sel;
      }
    },
    redo: false,
  },
  {
    idname: 'uv.select_linked',
    label: 'Select Linked',
    poll: () => app.doc.mode === 'EDIT',
    exec: () => {
      for (const t of targets()) {
        const sel = new Uint8Array(uvSel(t.me));
        const seeds = t.faces.filter((f) => sel.subarray(t.me.offsets[f], t.me.offsets[f + 1]).some(Boolean));
        for (const f of seeds) for (const k of islandCorners(t.me, t.faces, f)) sel[k] = 1;
        t.me.uv_select = sel;
      }
    },
  },
  {
    idname: 'uv.mirror',
    label: 'Mirror UVs',
    props: [{ id: 'axis', label: 'Axis', type: 'int', default: 0, min: 0, max: 1 }],
    poll: () => app.doc.mode === 'EDIT',
    exec: (_ctx, p) => {
      const sels = selectedCorners();
      let cu = 0,
        cv = 0,
        n = 0;
      for (const s of sels)
        for (const k of s.corners) {
          cu += s.me.uvs[k * 2];
          cv += s.me.uvs[k * 2 + 1];
          n++;
        }
      if (!n) return 'CANCELLED';
      cu /= n;
      cv /= n;
      transformUVs((u, v) => (p.axis === 0 ? [2 * cu - u, v] : [u, 2 * cv - v]));
    },
  },
  {
    idname: 'uv.rotate90',
    label: 'Rotate UVs 90°',
    poll: () => app.doc.mode === 'EDIT',
    exec: () => {
      const sels = selectedCorners();
      let cu = 0,
        cv = 0,
        n = 0;
      for (const s of sels)
        for (const k of s.corners) {
          cu += s.me.uvs[k * 2];
          cv += s.me.uvs[k * 2 + 1];
          n++;
        }
      if (!n) return 'CANCELLED';
      cu /= n;
      cv /= n;
      transformUVs((u, v) => [cu - (v - cv), cv + (u - cu)]);
    },
  },
  {
    idname: 'uv.snap_selected',
    label: 'Snap Selected to Cursor',
    poll: () => app.doc.mode === 'EDIT',
    exec: () => transformUVs(() => [cursor.u, cursor.v]),
  },
  {
    idname: 'uv.snap_cursor',
    label: 'Snap Cursor to Selected',
    poll: () => app.doc.mode === 'EDIT',
    exec: () => {
      let cu = 0,
        cv = 0,
        n = 0;
      for (const s of selectedCorners())
        for (const k of s.corners) {
          cu += s.me.uvs[k * 2];
          cv += s.me.uvs[k * 2 + 1];
          n++;
        }
      if (!n) return 'CANCELLED';
      cursor.u = cu / n;
      cursor.v = cv / n;
      app.changed('ui');
    },
    undo: false,
  },
  {
    idname: 'uv.average_islands_scale',
    label: 'Average Islands Scale',
    poll: () => app.doc.mode === 'EDIT',
    exec: () => {
      for (const t of targets()) {
        const m = MeshEdit.from(t.me);
        const seen = new Set<number>();
        const islands: number[][] = [];
        for (const f of t.faces) {
          if (seen.has(f)) continue;
          const corners = islandCorners(t.me, t.faces, f);
          const faces = [...new Set(corners.map((k) => cornerFace(t.me, k)))];
          faces.forEach((x) => seen.add(x));
          islands.push(faces);
        }
        // packing normalizes texel density; keep positions by re-centering each island afterwards
        const before = islands.map((isl) => isl.map((fi) => [...m.faces[fi].uvs]));
        packIslands(m, islands, 0.002);
        islands.forEach((isl, i) => {
          // restore island centers
          const c0 = center(before[i]),
            c1 = center(isl.map((fi) => m.faces[fi].uvs));
          for (const fi of isl) {
            const f = m.faces[fi];
            for (let k = 0; k < f.verts.length; k++) {
              f.uvs[k * 2] += c0[0] - c1[0];
              f.uvs[k * 2 + 1] += c0[1] - c1[1];
            }
          }
        });
        m.write(t.me);
      }
      app.changed('geometry');
    },
  },
  {
    idname: 'uv.view_all',
    label: 'Frame All',
    poll: () => !!activeUVEditor(),
    exec: () => {
      const ed = activeUVEditor()!;
      ed.zoom = 1;
      ed.pan = { x: 0, y: 0 };
      ed.draw();
    },
    undo: false,
  },
  {
    idname: 'uv.view_selected',
    label: 'Frame Selected',
    poll: () => !!activeUVEditor(),
    exec: () => {
      const ed = activeUVEditor()!;
      let cu = 0,
        cv = 0,
        n = 0;
      for (const s of selectedCorners())
        for (const k of s.corners) {
          cu += s.me.uvs[k * 2];
          cv += s.me.uvs[k * 2 + 1];
          n++;
        }
      if (!n) return 'CANCELLED';
      const p = ed.toPx(cu / n, cv / n);
      ed.pan.x += ed.el.clientWidth / 2 - p.x;
      ed.pan.y += ed.el.clientHeight / 2 - p.y;
      ed.draw();
    },
    undo: false,
  },
]);

function cornerFace(me: MeshData, k: number) {
  let lo = 0,
    hi = me.offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (me.offsets[mid] <= k) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function center(list: number[][]) {
  let u = 0,
    v = 0,
    n = 0;
  for (const uvs of list)
    for (let i = 0; i < uvs.length; i += 2) {
      u += uvs[i];
      v += uvs[i + 1];
      n++;
    }
  return [u / Math.max(1, n), v / Math.max(1, n)];
}

const inUV = () => !!activeUVEditor();
addKeys('UV Editor', [
  { key: 'G', op: 'uv.translate', when: inUV },
  { key: 'R', op: 'uv.rotate', when: inUV },
  { key: 'S', op: 'uv.resize', when: inUV },
  { key: 'A', op: 'uv.select_all', props: { action: 'SELECT' } },
  { key: 'A', alt: true, op: 'uv.select_all', props: { action: 'DESELECT' } },
  { key: 'I', ctrl: true, op: 'uv.select_all', props: { action: 'INVERT' } },
  { key: 'L', ctrl: true, op: 'uv.select_linked' },
  { key: 'U', menu: uvMenu, menuTitle: 'UV' },
  { key: 'NUMPAD_PERIOD', op: 'uv.view_selected' },
]);

registerEditor({ id: 'UV', label: 'UV Editor', icon: 'uv_editor', group: 'General', create: (a) => new UVEditor(a) });
