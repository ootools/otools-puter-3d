// FBX registration: File ▸ Import / Export ▸ FBX (.fbx)
import { commitToApp, defineFormat, encodeImagePng, exportSceneFromApp, readFileBytes, reportWarnings, APPLY_MODIFIERS } from '../glue';
import { companionFilesDialog } from '../ui';
import { fbxExternalTextures, readFbx } from './read';
import { writeFbx } from './write';
import { AXIS_ITEMS, type AxisId } from '../common';

defineFormat({
  id: 'fbx',
  label: 'FBX (.fbx)',
  extensions: ['.fbx'],
  description: 'Autodesk FBX (binary 7.x or ASCII): meshes, materials, skeletons, shape keys and animation',
  importOptions: [
    { id: 'global_scale', label: 'Scale', type: 'float', default: 1, min: 0.0001, max: 10000 },
    { id: 'use_anim', label: 'Animation', type: 'bool', default: true },
    {
      id: 'shading',
      label: 'Shading',
      type: 'enum',
      default: 'NORMALS',
      items: [
        ['NORMALS', 'Use Normal / Smoothing Data'],
        ['FLAT', 'Flat Shading'],
        ['SMOOTH', 'Smooth Shading'],
      ],
    },
    {
      id: 'bone_heuristic',
      label: 'Bone Dir',
      type: 'enum',
      default: 'AUTO',
      items: [
        ['AUTO', 'Best Fit (point at children)'],
        ['Y', 'Keep Joint Axes'],
      ],
    },
  ],
  exportOptions: [
    { id: 'forward_axis', label: 'Forward', type: 'enum', default: '-Z', items: AXIS_ITEMS },
    { id: 'up_axis', label: 'Up', type: 'enum', default: 'Y', items: AXIS_ITEMS },
    { id: 'global_scale', label: 'Scale', type: 'float', default: 1, min: 0.0001, max: 10000 },
    {
      id: 'apply_scale_options',
      label: 'Apply Scalings',
      type: 'enum',
      default: 'CM',
      items: [
        ['CM', 'FBX Units (cm, scale on roots)'],
        ['M', 'Meters (UnitScaleFactor 100)'],
      ],
    },
    APPLY_MODIFIERS,
    { id: 'skins', label: 'Armatures & Skinning', type: 'bool', default: true },
    { id: 'shape_keys', label: 'Shape Keys', type: 'bool', default: true },
    { id: 'embed_textures', label: 'Embed Textures', type: 'bool', default: true },
    { id: 'bake_anim', label: 'Baked Animation', type: 'bool', default: true },
  ],
  async importFile(file, o) {
    const bytes = await readFileBytes(file);
    const resources = new Map<string, Uint8Array>();
    const missing = fbxExternalTextures(bytes);
    if (missing.length) {
      const files = await companionFilesDialog(
        'FBX Textures',
        `"${file.name}" references texture files that are not embedded. Select them to import the textures:`,
        missing,
        'image/*,.tga,.tif,.tiff,.dds',
      );
      for (const f of files) resources.set(f.name, await readFileBytes(f));
    }
    const ir = readFbx(bytes, { resources });
    ir.unitScale *= Number(o.global_scale) || 1;
    if (!o.use_anim) ir.animations = [];
    commitToApp(ir, { shading: o.shading as 'NORMALS', boneDirection: o.bone_heuristic as 'AUTO' });
  },
  async exportFile(o) {
    const scene = exportSceneFromApp({ selectedOnly: o.selectedOnly, applyModifiers: !!o.apply_modifiers, skins: !!o.skins, shapeKeys: !!o.shape_keys, animation: !!o.bake_anim });
    const res = await writeFbx(scene, {
      forward: o.forward_axis as AxisId,
      up: o.up_axis as AxisId,
      scale: Number(o.global_scale) || 1,
      units: o.apply_scale_options as 'CM',
      embedTextures: !!o.embed_textures,
      animation: !!o.bake_anim,
      encodeImage: encodeImagePng,
    });
    reportWarnings(res.warnings);
    return { bytes: res.bytes, mime: 'application/octet-stream', ext: '.fbx' };
  },
});
