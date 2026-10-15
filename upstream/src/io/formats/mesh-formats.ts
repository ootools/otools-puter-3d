// Registration of the mesh-centric formats: Wavefront OBJ (+MTL), STL and Stanford PLY.
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { commitToApp, defineFormat, encodeImagePng, exportSceneFromApp, readFileBytes, reportWarnings, APPLY_MODIFIERS } from './glue';
import { companionFilesDialog, type FormatOption } from './ui';
import { mtlTextureFiles, objMaterialLibraries, readObj, writeObj } from './obj';
import { readStl, writeStl } from './stl';
import { readPly, writePly } from './ply';
import { AXIS_ITEMS, baseName, stripExt, type AxisId } from './common';
import { app } from '../../app/app';
import { download } from '../native';

const axisOptions = (forward: AxisId, up: AxisId): FormatOption[] => [
  { id: 'forward_axis', label: 'Forward Axis', type: 'enum', default: forward, items: AXIS_ITEMS },
  { id: 'up_axis', label: 'Up Axis', type: 'enum', default: up, items: AXIS_ITEMS },
];
const scaleOption = (label = 'Scale'): FormatOption => ({ id: 'global_scale', label, type: 'float', default: 1, min: 0.0001, max: 10000, step: 0.01 });
const axisArgs = (o: Record<string, unknown>) => ({ forward: o.forward_axis as AxisId, up: o.up_axis as AxisId, scale: Number(o.global_scale) || 1 });
const exportBase = () => app.filename.replace(/\.[^.]+$/, '') || 'untitled';

// ---------------------------------------------------------------------------- OBJ
defineFormat({
  id: 'obj',
  label: 'Wavefront (.obj)',
  extensions: ['.obj'],
  description: 'Wavefront OBJ with MTL materials',
  importOptions: [
    ...axisOptions('-Z', 'Y'),
    scaleOption(),
    { id: 'use_split_objects', label: 'Split By Object', type: 'bool', default: true },
    { id: 'use_split_groups', label: 'Split By Group', type: 'bool', default: false },
  ],
  exportOptions: [
    ...axisOptions('-Z', 'Y'),
    scaleOption(),
    APPLY_MODIFIERS,
    { id: 'export_uv', label: 'UV Coordinates', type: 'bool', default: true },
    { id: 'export_normals', label: 'Normals', type: 'bool', default: true },
    { id: 'export_colors', label: 'Colors', type: 'bool', default: false },
    { id: 'export_triangulated_mesh', label: 'Triangulated Mesh', type: 'bool', default: false },
    { id: 'export_smooth_groups', label: 'Smooth Groups', type: 'bool', default: true },
    { id: 'export_object_groups', label: 'Object Groups (g)', type: 'bool', default: false },
    { id: 'export_materials', label: 'Export Materials', type: 'bool', default: true },
    {
      id: 'packaging',
      label: 'Output',
      type: 'enum',
      default: 'ZIP',
      items: [
        ['ZIP', 'ZIP (OBJ + MTL + textures)'],
        ['FILES', 'Separate downloads'],
      ],
      showIf: (v) => !!v.export_materials,
    },
  ],
  async importFile(file, o) {
    const text = new TextDecoder().decode(await readFileBytes(file));
    const resources = new Map<string, Uint8Array>();
    const libs = objMaterialLibraries(text);
    if (libs.length) {
      const files = await companionFilesDialog('Materials', `"${file.name}" uses material libraries. Select the .mtl file(s) and their texture images together:`, libs, '.mtl,image/*,.tga,.tif,.tiff');
      for (const f of files) resources.set(f.name, await readFileBytes(f));
      // textures referenced by the libraries that were not selected yet
      const missing = [...resources.entries()]
        .filter(([n]) => n.toLowerCase().endsWith('.mtl'))
        .flatMap(([, b]) => mtlTextureFiles(new TextDecoder().decode(b)))
        .map(baseName)
        .filter((n) => ![...resources.keys()].some((k) => k.toLowerCase() === n.toLowerCase()));
      if (missing.length) {
        const more = await companionFilesDialog('Textures', 'The material library references these images:', [...new Set(missing)], 'image/*,.tga,.tif,.tiff');
        for (const f of more) resources.set(f.name, await readFileBytes(f));
      }
    }
    const ir = readObj(text, { ...axisArgs(o), splitByObject: !!o.use_split_objects, splitByGroup: !!o.use_split_groups, resources });
    commitToApp(ir, { setFrameRange: false });
  },
  async exportFile(o) {
    const scene = exportSceneFromApp({ selectedOnly: o.selectedOnly, applyModifiers: !!o.apply_modifiers, skins: false, shapeKeys: false, animation: false, types: ['MESH', 'CURVE', 'FONT'] });
    const base = exportBase();
    const res = writeObj(scene, {
      ...axisArgs(o),
      uvs: !!o.export_uv,
      normals: !!o.export_normals,
      colors: !!o.export_colors,
      triangulate: !!o.export_triangulated_mesh,
      smoothGroups: !!o.export_smooth_groups,
      groups: !!o.export_object_groups,
      materials: !!o.export_materials,
      mtlName: `${base}.mtl`,
    });
    reportWarnings(res.warnings);
    if (!res.mtl) return { bytes: res.obj, mime: 'text/plain', ext: '.obj' };
    const textures: { name: string; bytes: Uint8Array }[] = [];
    for (const t of res.textures) {
      let bytes = t.bytes;
      if (!bytes) bytes = (await encodeImagePng(app.doc.images[t.imageId]))?.bytes ?? null;
      if (bytes) textures.push({ name: t.name, bytes });
      else app.report('WARNING', `Texture "${t.name}" could not be written`);
    }
    if (o.packaging === 'FILES') {
      download(res.mtl, `${base}.mtl`, 'text/plain');
      for (const t of textures) download(t.bytes, t.name);
      return { bytes: res.obj, mime: 'text/plain', ext: '.obj' };
    }
    const enc = new TextEncoder();
    const files: Record<string, Uint8Array> = { [`${base}.obj`]: enc.encode(res.obj), [`${base}.mtl`]: enc.encode(res.mtl) };
    for (const t of textures) files[t.name] = t.bytes;
    return { bytes: zipSync(files, { level: 6 }), mime: 'application/zip', ext: '.obj.zip' };
  },
});

// ---------------------------------------------------------------------------- PLY
defineFormat({
  id: 'ply',
  label: 'Stanford PLY (.ply)',
  extensions: ['.ply'],
  description: 'Stanford polygon file (ASCII or binary) with normals, UVs and vertex colors',
  importOptions: [
    ...axisOptions('Y', 'Z'),
    scaleOption(),
    { id: 'merge_verts', label: 'Merge Vertices', type: 'bool', default: false },
    {
      id: 'import_colors',
      label: 'Vertex Colors',
      type: 'enum',
      default: 'SRGB',
      items: [
        ['NONE', 'None'],
        ['SRGB', 'sRGB'],
        ['LINEAR', 'Linear'],
      ],
    },
  ],
  exportOptions: [
    { id: 'ascii_format', label: 'ASCII', type: 'bool', default: false },
    ...axisOptions('Y', 'Z'),
    scaleOption(),
    APPLY_MODIFIERS,
    { id: 'export_normals', label: 'Normals', type: 'bool', default: false },
    { id: 'export_uv', label: 'UV Coordinates', type: 'bool', default: true },
    {
      id: 'export_colors',
      label: 'Vertex Colors',
      type: 'enum',
      default: 'SRGB',
      items: [
        ['NONE', 'None'],
        ['SRGB', 'sRGB'],
        ['LINEAR', 'Linear'],
      ],
    },
    { id: 'export_triangulated_mesh', label: 'Triangulated Mesh', type: 'bool', default: false },
  ],
  async importFile(file, o) {
    const ir = readPly(await readFileBytes(file), { ...axisArgs(o), name: stripExt(file.name), colorSpace: o.import_colors as 'SRGB' });
    commitToApp(ir, { mergeVertices: !!o.merge_verts, setFrameRange: false });
  },
  async exportFile(o) {
    const scene = exportSceneFromApp({ selectedOnly: o.selectedOnly, applyModifiers: !!o.apply_modifiers, skins: false, shapeKeys: false, animation: false, types: ['MESH', 'CURVE', 'FONT'] });
    const res = writePly(scene, {
      ...axisArgs(o),
      ascii: !!o.ascii_format,
      normals: !!o.export_normals,
      uvs: !!o.export_uv,
      colors: o.export_colors as 'SRGB',
      triangulate: !!o.export_triangulated_mesh,
    });
    reportWarnings(res.warnings);
    return { bytes: res.bytes, mime: 'application/octet-stream', ext: '.ply' };
  },
});

// ---------------------------------------------------------------------------- STL
defineFormat({
  id: 'stl',
  label: 'STL (.stl)',
  extensions: ['.stl'],
  description: 'Stereolithography triangles (binary or ASCII)',
  importOptions: [
    ...axisOptions('Y', 'Z'),
    scaleOption(),
    { id: 'merge_verts', label: 'Merge Vertices', type: 'bool', default: true, description: 'Weld coincident triangle corners into connected geometry' },
  ],
  exportOptions: [{ id: 'ascii_format', label: 'ASCII', type: 'bool', default: false }, ...axisOptions('Y', 'Z'), scaleOption(), APPLY_MODIFIERS],
  async importFile(file, o) {
    const ir = readStl(await readFileBytes(file), { ...axisArgs(o), name: stripExt(file.name), mergeVertices: !!o.merge_verts });
    commitToApp(ir, { setFrameRange: false });
  },
  async exportFile(o) {
    const scene = exportSceneFromApp({ selectedOnly: o.selectedOnly, applyModifiers: !!o.apply_modifiers, skins: false, shapeKeys: false, animation: false, types: ['MESH', 'CURVE', 'FONT'] });
    const res = writeStl(scene, { ...axisArgs(o), ascii: !!o.ascii_format, name: exportBase() });
    reportWarnings(res.warnings);
    return { bytes: res.bytes, mime: o.ascii_format ? 'model/stl' : 'model/stl', ext: '.stl' };
  },
});
