// Header and context menus of the node editor (entries refer to node.* operators).
import type { MenuItem } from '../../ui/menu';

interface EdLike {
  showSidebar: boolean;
  path: unknown[];
  addMenuItems(at?: { x: number; y: number }): MenuItem[];
}

export function viewMenu(ed: EdLike): MenuItem[] {
  return [
    {
      label: 'Sidebar',
      checked: ed.showSidebar,
      shortcut: 'N',
      op: 'node.toggle_sidebar',
    },
    { separator: true },
    {
      label: 'Zoom In',
      shortcut: 'Numpad +',
      op: 'node.zoom',
      props: { factor: 1.25 },
    },
    {
      label: 'Zoom Out',
      shortcut: 'Numpad -',
      op: 'node.zoom',
      props: { factor: 0.8 },
    },
    { separator: true },
    { label: 'Frame Selected', shortcut: 'Numpad .', op: 'node.view_selected' },
    { label: 'Frame All', shortcut: 'Home', op: 'node.view_all' },
    { separator: true },
    {
      label: 'Parent Node Tree',
      shortcut: 'Ctrl Tab',
      op: 'node.tree_path_parent',
    },
  ];
}

export function selectMenu(): MenuItem[] {
  return [
    {
      label: 'All',
      shortcut: 'A',
      op: 'node.select_all',
      props: { action: 'SELECT' },
    },
    {
      label: 'None',
      shortcut: 'Alt A',
      op: 'node.select_all',
      props: { action: 'DESELECT' },
    },
    {
      label: 'Invert',
      shortcut: 'Ctrl I',
      op: 'node.select_all',
      props: { action: 'INVERT' },
    },
    { separator: true },
    { label: 'Box Select', shortcut: 'B', op: 'node.select_box' },
    { separator: true },
    { label: 'Linked From', shortcut: 'L', op: 'node.select_linked_from' },
    { label: 'Linked To', shortcut: 'Shift L', op: 'node.select_linked_to' },
    { separator: true },
    { label: 'Find Node...', shortcut: 'Ctrl F', op: 'node.find_node' },
  ];
}

export function nodeMenuItems(): MenuItem[] {
  return [
    { label: 'Move', shortcut: 'G', op: 'node.translate_attach' },
    { separator: true },
    { label: 'Copy', shortcut: 'Ctrl C', op: 'node.clipboard_copy' },
    { label: 'Paste', shortcut: 'Ctrl V', op: 'node.clipboard_paste' },
    { label: 'Duplicate', shortcut: 'Shift D', op: 'node.duplicate_move' },
    { separator: true },
    { label: 'Delete', shortcut: 'X', op: 'node.delete' },
    {
      label: 'Delete with Reconnect',
      shortcut: 'Ctrl X',
      op: 'node.delete_reconnect',
    },
    { separator: true },
    { label: 'Join in New Frame', shortcut: 'Ctrl J', op: 'node.join' },
    { label: 'Remove from Frame', shortcut: 'Alt P', op: 'node.parent_clear' },
    { separator: true },
    { label: 'Make Group', shortcut: 'Ctrl G', op: 'node.group_make' },
    { label: 'Ungroup', shortcut: 'Ctrl Alt G', op: 'node.group_ungroup' },
    { label: 'Edit Group', shortcut: 'Tab', op: 'node.group_edit' },
    { separator: true },
    {
      label: 'Links',
      submenu: () => [
        { label: 'Make Links', shortcut: 'F', op: 'node.link_make' },
        { label: 'Detach Links', shortcut: 'Alt D', op: 'node.links_detach' },
      ],
    },
    { separator: true },
    { label: 'Toggle Node Mute', shortcut: 'M', op: 'node.mute_toggle' },
    { label: 'Collapse', shortcut: 'H', op: 'node.hide_toggle' },
    {
      label: 'Toggle Hidden Node Sockets',
      shortcut: 'Ctrl H',
      op: 'node.hide_socket_toggle',
    },
    { label: 'Toggle Node Options', op: 'node.options_toggle' },
    { separator: true },
    { label: 'Rename...', shortcut: 'F2', op: 'node.rename' },
  ];
}

export function contextMenuItems(ed: EdLike, onNode: boolean): MenuItem[] {
  if (!onNode)
    return [
      { label: 'Add', submenu: () => ed.addMenuItems() },
      { label: 'Paste', shortcut: 'Ctrl V', op: 'node.clipboard_paste' },
      { separator: true },
      { label: 'Frame All', shortcut: 'Home', op: 'node.view_all' },
      ed.path.length
        ? {
            label: 'Exit Group',
            shortcut: 'Tab',
            op: 'node.group_edit',
            props: { exit: true },
          }
        : {
            label: 'Select All',
            shortcut: 'A',
            op: 'node.select_all',
            props: { action: 'SELECT' },
          },
    ];
  return [
    { label: 'Duplicate', shortcut: 'Shift D', op: 'node.duplicate_move' },
    { label: 'Copy', shortcut: 'Ctrl C', op: 'node.clipboard_copy' },
    { label: 'Delete', shortcut: 'X', op: 'node.delete' },
    {
      label: 'Delete with Reconnect',
      shortcut: 'Ctrl X',
      op: 'node.delete_reconnect',
    },
    { separator: true },
    { label: 'Join in New Frame', shortcut: 'Ctrl J', op: 'node.join' },
    { label: 'Remove from Frame', shortcut: 'Alt P', op: 'node.parent_clear' },
    { separator: true },
    { label: 'Make Group', shortcut: 'Ctrl G', op: 'node.group_make' },
    { label: 'Ungroup', shortcut: 'Ctrl Alt G', op: 'node.group_ungroup' },
    { label: 'Edit Group', shortcut: 'Tab', op: 'node.group_edit' },
    { separator: true },
    {
      label: 'Toggle Hidden Node Sockets',
      shortcut: 'Ctrl H',
      op: 'node.hide_socket_toggle',
    },
    { label: 'Toggle Node Mute', shortcut: 'M', op: 'node.mute_toggle' },
    { label: 'Collapse', shortcut: 'H', op: 'node.hide_toggle' },
    { separator: true },
    { label: 'Rename...', shortcut: 'F2', op: 'node.rename' },
  ];
}
