// Alembic registration: File ▸ Import ▸ Alembic (.abc) — import only (Ogawa archives).
import { commitToApp, defineFormat, readFileBytes } from '../glue';
import { readAlembic } from './read';

defineFormat({
  id: 'abc',
  label: 'Alembic (.abc)',
  extensions: ['.abc'],
  description: 'Alembic Ogawa archives: meshes, transforms (animated), cameras, vertex caches as shape keys',
  importOptions: [
    { id: 'scale', label: 'Scale', type: 'float', default: 1, min: 0.0001, max: 10000 },
    { id: 'import_animation', label: 'Animation', type: 'bool', default: true, description: 'Animated transforms and vertex caches (as per-frame shape keys)' },
  ],
  async importFile(file, o) {
    const ir = readAlembic(await readFileBytes(file));
    ir.unitScale *= Number(o.scale) || 1;
    if (!o.import_animation) ir.animations = [];
    commitToApp(ir, {});
  },
});
