// Header/context menus shared by the Dope Sheet ('action') and Graph Editor ('graph').
import type { MenuItem } from '../ui/menu';
import type { Interpolation, KeyHandleType, Keyframe } from '../data/types';
import type { AnimEditor } from './animeditor';
import { KEY_TYPES } from './footer';

export type Prefix = 'action' | 'graph';

export const INTERPOLATION_ITEMS: {
  heading: string;
  items: [Interpolation, string][];
}[] = [
  {
    heading: 'Interpolation',
    items: [
      ['CONSTANT', 'Constant'],
      ['LINEAR', 'Linear'],
      ['BEZIER', 'Bézier'],
    ],
  },
  {
    heading: 'Easing (by strength)',
    items: [
      ['SINE', 'Sinusoidal'],
      ['QUAD', 'Quadratic'],
      ['CUBIC', 'Cubic'],
      ['QUART', 'Quartic'],
      ['QUINT', 'Quintic'],
      ['EXPO', 'Exponential'],
      ['CIRC', 'Circular'],
    ],
  },
  {
    heading: 'Dynamic Effects',
    items: [
      ['BACK', 'Back'],
      ['BOUNCE', 'Bounce'],
      ['ELASTIC', 'Elastic'],
    ],
  },
];

export const HANDLE_ITEMS: [KeyHandleType, string][] = [
  ['FREE', 'Free'],
  ['VECTOR', 'Vector'],
  ['ALIGNED', 'Aligned'],
  ['AUTO', 'Automatic'],
  ['AUTO_CLAMPED', 'Auto Clamped'],
];

export const EASING_ITEMS: [Keyframe['easing'], string][] = [
  ['AUTO', 'Automatic Easing'],
  ['EASE_IN', 'Ease In'],
  ['EASE_OUT', 'Ease Out'],
  ['EASE_IN_OUT', 'Ease In and Out'],
];

export const EXTRAPOLATION_ITEMS: [string, string][] = [
  ['CONSTANT', 'Constant Extrapolation'],
  ['LINEAR', 'Linear Extrapolation'],
  ['MAKE_CYCLIC', 'Make Cyclic (F-Modifier)'],
  ['CLEAR_CYCLIC', 'Clear Cyclic (F-Modifier)'],
];

export function interpolationMenu(p: Prefix): MenuItem[] {
  const out: MenuItem[] = [];
  for (const sec of INTERPOLATION_ITEMS) {
    out.push({ heading: sec.heading });
    for (const [v, l] of sec.items) out.push({ label: l, op: `${p}.interpolation_type`, props: { type: v } });
  }
  return out;
}
export const handleMenu = (p: Prefix): MenuItem[] =>
  HANDLE_ITEMS.map(([v, l]) => ({
    label: l,
    op: `${p}.handle_type`,
    props: { type: v },
  }));
export const easingMenu = (p: Prefix): MenuItem[] =>
  EASING_ITEMS.map(([v, l]) => ({
    label: l,
    op: `${p}.easing_type`,
    props: { type: v },
  }));
export const keyTypeMenu = (p: Prefix): MenuItem[] =>
  KEY_TYPES.map(([v, l]) => ({
    label: l,
    op: `${p}.keyframe_type`,
    props: { type: v },
  }));
export const extrapolationMenu = (p: Prefix): MenuItem[] =>
  EXTRAPOLATION_ITEMS.map(([v, l]) => ({
    label: l,
    op: `${p}.extrapolation_type`,
    props: { type: v },
  }));

export function snapMenu(p: Prefix): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: 'Selection to Current Frame',
      op: `${p}.snap`,
      props: { type: 'CFRA' },
    },
    {
      label: 'Selection to Nearest Frame',
      op: `${p}.snap`,
      props: { type: 'NEAREST_FRAME' },
    },
    {
      label: 'Selection to Nearest Second',
      op: `${p}.snap`,
      props: { type: 'NEAREST_SECOND' },
    },
    {
      label: 'Selection to Nearest Marker',
      op: `${p}.snap`,
      props: { type: 'NEAREST_MARKER' },
    },
  ];
  if (p === 'graph') {
    items.push(
      {
        label: 'Selection to Cursor Value',
        op: 'graph.snap',
        props: { type: 'VALUE' },
      },
      {
        label: 'Flatten Handles',
        op: 'graph.snap',
        props: { type: 'HORIZONTAL' },
      },
      { separator: true },
      {
        label: 'Cursor to Selected',
        op: 'graph.frame_jump',
        shortcut: 'Ctrl G',
      },
      { label: 'Cursor Value to Selection', op: 'graph.snap_cursor_value' },
    );
  } else
    items.push(
      { separator: true },
      {
        label: 'Current Frame to Selection',
        op: 'action.frame_jump',
        shortcut: 'Ctrl G',
      },
    );
  return items;
}

export function mirrorMenu(p: Prefix): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: 'By Times Over Current Frame',
      op: `${p}.mirror`,
      props: { type: 'CFRA' },
    },
    {
      label: 'By Values Over Zero Value',
      op: `${p}.mirror`,
      props: { type: 'XAXIS' },
    },
    {
      label: 'By Times Over Zero Time',
      op: `${p}.mirror`,
      props: { type: 'YAXIS' },
    },
    {
      label: 'By Times Over First Selected Marker',
      op: `${p}.mirror`,
      props: { type: 'MARKER' },
    },
  ];
  if (p === 'graph')
    items.splice(1, 0, {
      label: 'By Values Over Cursor Value',
      op: 'graph.mirror',
      props: { type: 'VALUE' },
    });
  return items;
}

export function selectMenu(p: Prefix): MenuItem[] {
  return [
    {
      label: 'All',
      op: `${p}.select_all`,
      props: { action: 'SELECT' },
      shortcut: 'A',
    },
    {
      label: 'None',
      op: `${p}.select_all`,
      props: { action: 'DESELECT' },
      shortcut: 'Alt A',
    },
    {
      label: 'Invert',
      op: `${p}.select_all`,
      props: { action: 'INVERT' },
      shortcut: 'Ctrl I',
    },
    { separator: true },
    { label: 'Box Select', op: `${p}.select_box`, shortcut: 'B' },
    { separator: true },
    {
      label: 'Columns on Selected Keys',
      op: `${p}.select_column`,
      props: { mode: 'KEYS' },
      shortcut: 'K',
    },
    {
      label: 'Column on Current Frame',
      op: `${p}.select_column`,
      props: { mode: 'CFRA' },
      shortcut: 'Ctrl K',
    },
    {
      label: 'Columns on Selected Markers',
      op: `${p}.select_column`,
      props: { mode: 'MARKERS_COLUMN' },
      shortcut: 'Shift K',
    },
    {
      label: 'Between Selected Markers',
      op: `${p}.select_column`,
      props: { mode: 'MARKERS_BETWEEN' },
      shortcut: 'Alt K',
    },
    { separator: true },
    {
      label: 'Before Current Frame',
      op: `${p}.select_leftright`,
      props: { mode: 'LEFT' },
      shortcut: '[',
    },
    {
      label: 'After Current Frame',
      op: `${p}.select_leftright`,
      props: { mode: 'RIGHT' },
      shortcut: ']',
    },
    { separator: true },
    { label: 'Select More', op: `${p}.select_more`, shortcut: 'Ctrl Numpad +' },
    { label: 'Select Less', op: `${p}.select_less`, shortcut: 'Ctrl Numpad -' },
    { label: 'Select Linked', op: `${p}.select_linked`, shortcut: 'Ctrl L' },
  ];
}

export function viewMenuCommon(p: Prefix, ed: AnimEditor): MenuItem[] {
  return [
    { separator: true },
    { label: 'Frame Selected', op: `${p}.view_selected`, shortcut: 'Numpad .' },
    { label: 'Frame All', op: `${p}.view_all`, shortcut: 'Home' },
    {
      label: 'Go to Current Frame',
      op: `${p}.view_frame`,
      shortcut: 'Numpad 0',
    },
    { separator: true },
    {
      label: 'Set Preview Range to Selected',
      op: `${p}.previewrange_set`,
      shortcut: 'Ctrl Alt P',
    },
    {
      label: 'Clear Preview Range',
      op: 'anim.previewrange_clear',
      shortcut: 'Alt P',
    },
    { separator: true },
    {
      label: p === 'action' ? 'Toggle Graph Editor' : 'Toggle Dope Sheet',
      op: 'anim.switch_editor',
      props: { type: p === 'action' ? 'GRAPH' : 'DOPESHEET' },
      shortcut: 'Ctrl Tab',
    },
    {
      label: ed.area.screen.maximized === ed.area ? 'Back to Previous' : 'Maximize Area',
      op: 'screen.screen_full_area',
      shortcut: 'Ctrl Space',
    },
  ];
}

function settingMenu(op: string, graph: boolean): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'Mute', op, props: { type: 'MUTE' } },
    { label: 'Lock', op, props: { type: 'PROTECT' } },
  ];
  if (graph) items.push({ label: 'Visibility', op, props: { type: 'VISIBLE' } });
  return items;
}

export function channelMenu(p: Prefix): MenuItem[] {
  const graph = p === 'graph';
  const items: MenuItem[] = [
    { label: 'Delete Channels', op: 'anim.channels_delete', shortcut: 'X' },
    { separator: true },
    { label: 'Group Channels', op: 'anim.channels_group', shortcut: 'Ctrl G' },
    {
      label: 'Ungroup Channels',
      op: 'anim.channels_ungroup',
      shortcut: 'Ctrl Alt G',
    },
    { separator: true },
    {
      label: 'Toggle Channel Setting',
      submenu: () => settingMenu('anim.channels_setting_toggle', graph),
      shortcut: 'Shift W',
    },
    {
      label: 'Enable Channel Setting',
      submenu: () => settingMenu('anim.channels_setting_enable', graph),
      shortcut: 'Shift Ctrl W',
    },
    {
      label: 'Disable Channel Setting',
      submenu: () => settingMenu('anim.channels_setting_disable', graph),
      shortcut: 'Alt W',
    },
    { separator: true },
    {
      label: 'Expand Channels',
      op: 'anim.channels_expand',
      shortcut: 'Numpad +',
    },
    {
      label: 'Collapse Channels',
      op: 'anim.channels_collapse',
      shortcut: 'Numpad -',
    },
    { separator: true },
    {
      label: 'Extrapolation Mode',
      submenu: () => extrapolationMenu(p),
      shortcut: 'Shift E',
    },
  ];
  if (graph)
    items.push(
      { separator: true },
      { label: 'Hide Selected Curves', op: 'graph.hide', shortcut: 'H' },
      {
        label: 'Hide Unselected Curves',
        op: 'graph.hide',
        props: { unselected: true },
        shortcut: 'Shift H',
      },
      { label: 'Reveal Curves', op: 'graph.reveal', shortcut: 'Alt H' },
    );
  return items;
}

export function keyMenu(p: Prefix): MenuItem[] {
  const transform: MenuItem[] =
    p === 'action'
      ? [
          {
            label: 'Move',
            op: 'action.transform',
            props: { mode: 'TIME_TRANSLATE' },
            shortcut: 'G',
          },
          {
            label: 'Extend',
            op: 'action.transform',
            props: { mode: 'TIME_EXTEND' },
            shortcut: 'E',
          },
          {
            label: 'Scale',
            op: 'action.transform',
            props: { mode: 'TIME_SCALE' },
            shortcut: 'S',
          },
        ]
      : [
          {
            label: 'Move',
            op: 'graph.transform',
            props: { mode: 'TRANSLATION' },
            shortcut: 'G',
          },
          {
            label: 'Extend',
            op: 'graph.transform',
            props: { mode: 'TIME_EXTEND' },
            shortcut: 'E',
          },
          {
            label: 'Rotate',
            op: 'graph.transform',
            props: { mode: 'ROTATION' },
            shortcut: 'R',
          },
          {
            label: 'Scale',
            op: 'graph.transform',
            props: { mode: 'RESIZE' },
            shortcut: 'S',
          },
        ];
  return [
    { label: 'Transform', submenu: () => transform },
    { label: 'Snap', submenu: () => snapMenu(p), shortcut: 'Shift S' },
    { label: 'Mirror', submenu: () => mirrorMenu(p), shortcut: 'Ctrl M' },
    { separator: true },
    { label: 'Insert Keyframes', op: `${p}.keyframe_insert`, shortcut: 'I' },
    {
      label: p === 'action' ? 'Jump to Keyframes' : 'Jump to Selected',
      op: `${p}.frame_jump`,
      shortcut: 'Ctrl G',
    },
    { separator: true },
    { label: 'Copy', op: `${p}.copy`, shortcut: 'Ctrl C' },
    { label: 'Paste', op: `${p}.paste`, shortcut: 'Ctrl V' },
    {
      label: 'Paste Flipped',
      op: `${p}.paste`,
      props: { flipped: true },
      shortcut: 'Shift Ctrl V',
    },
    { label: 'Duplicate', op: `${p}.duplicate_move`, shortcut: 'Shift D' },
    { label: 'Delete Keyframes', op: `${p}.delete`, shortcut: 'X' },
    { separator: true },
    {
      label: 'Keyframe Type',
      submenu: () => keyTypeMenu(p),
      shortcut: p === 'action' ? 'R' : '',
    },
    { label: 'Handle Type', submenu: () => handleMenu(p), shortcut: 'V' },
    {
      label: 'Interpolation Mode',
      submenu: () => interpolationMenu(p),
      shortcut: 'T',
    },
    { label: 'Easing Mode', submenu: () => easingMenu(p), shortcut: 'Ctrl E' },
    { separator: true },
    { label: 'Clean Keyframes', op: `${p}.clean` },
    { label: 'Clean Channels', op: `${p}.clean`, props: { channels: true } },
  ];
}
