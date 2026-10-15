// Mode-specific header menus registered by mode modules (edit mesh, sculpt, pose...).
import type { MenuItem } from '../../ui/menu';

export interface ModeMenus {
  /** menus shown in the header after View / Select / Add, e.g. [['Mesh', fn], ['Vertex', fn]] */
  header?: () => [string, () => MenuItem[]][];
  select?: () => MenuItem[];
  add?: () => MenuItem[];
  context?: () => MenuItem[];
  /** extra header widgets after the menus (e.g. select mode buttons) */
  headerExtra?: () => import('../../ui/h').Child;
}

export const modeMenus: Record<string, ModeMenus> = {};
