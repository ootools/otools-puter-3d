// Node editor sidebar (N): Node (name, label, color), Options (properties and input values)
// and Group (interface sockets of the edited node group).
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { panel, textField, checkbox, colorSwatch, enumMenu, numberField, button } from '../../ui/widgets';
import { splitRow } from '../../ui/props';
import type { NodeTreeData } from '../../data/types';
import { getNodeType, nodeSockets, interfaceSocketType, SOCKET_IDNAME, SOCKET_COLORS } from '../registry';
import { nodeById, addInterfaceSocket } from '../tree';
import { propWidget, socketValueWidget, nodeChanged } from './nodeui';
import { visibleProps } from './layout';
import type { NodeTypeDef } from '../types';

interface Ed {
  sidebarTab: string;
  path: { group: string; node: string }[];
  tree(): NodeTreeData | null;
}

const changed = (label: string) => nodeChanged(label, true);

const SOCKET_TYPE_ITEMS: [string, string][] = [
  ['FLOAT', 'Float'],
  ['INT', 'Integer'],
  ['BOOLEAN', 'Boolean'],
  ['VECTOR', 'Vector'],
  ['RGBA', 'Color'],
  ['SHADER', 'Shader'],
  ['STRING', 'String'],
  ['GEOMETRY', 'Geometry'],
  ['OBJECT', 'Object'],
  ['COLLECTION', 'Collection'],
  ['IMAGE', 'Image'],
  ['MATERIAL', 'Material'],
  ['ROTATION', 'Rotation'],
  ['MATRIX', 'Matrix'],
];

let activeItem = 0;

export function drawSidebar(ed: Ed): Child {
  const tree = ed.tree();
  const tabs = ['Node', 'Options', ...(ed.path.length || tree?.interface ? ['Group'] : [])];
  if (!tabs.includes(ed.sidebarTab)) ed.sidebarTab = 'Node';
  const body = !tree ? h('div', { class: 'prop-note' }, 'No node tree') : ed.sidebarTab === 'Group' ? groupTab(tree) : ed.sidebarTab === 'Options' ? optionsTab(tree) : nodeTab(tree);
  return [
    h('div', { class: 'nd-side-body props-scroll' }, body),
    h(
      'div',
      { class: 'nd-side-tabs' },
      tabs.map((t) =>
        h(
          'button',
          {
            key: t,
            class: { 'nd-side-tab': true, on: ed.sidebarTab === t },
            onclick: () => ((ed.sidebarTab = t), app.changed('ui')),
          },
          h('span', null, t),
        ),
      ),
    ),
  ];
}

function activeNode(tree: NodeTreeData) {
  return tree.active_node ? nodeById(tree, tree.active_node) : undefined;
}

function nodeTab(tree: NodeTreeData): Child {
  const n = activeNode(tree);
  if (!n) return h('div', { class: 'prop-note' }, 'No active node');
  return [
    panel('nd-side-node', 'Node', () => [
      splitRow(
        'Name',
        textField(`nd-name-${n.id}`, n.name, (v) => {
          const name = v.trim();
          if (!name || tree.nodes.some((o) => o !== n && o.name === name)) {
            if (name) app.report('WARNING', `A node named "${name}" already exists`);
            app.changed('ui');
            return;
          }
          n.name = name;
          changed('Rename Node');
        }),
      ),
      splitRow(
        'Label',
        textField(`nd-label-${n.id}`, n.label ?? '', (v) => ((n.label = v), changed('Node Label'))),
      ),
    ]),
    panel(
      'nd-side-color',
      'Color',
      () => [
        splitRow(
          'Color',
          colorSwatch(
            `nd-color-${n.id}`,
            (n.color as number[] | null) ?? [0.608, 0.608, 0.608],
            (c, final) => ((n.color = [c[0], c[1], c[2]]), (n.use_custom_color = true), nodeChanged('Node Color', final)),
            { alpha: false },
          ),
        ),
      ],
      {
        header: h(
          'span',
          { class: 'nd-side-check' },
          checkbox(`nd-usecol-${n.id}`, '', !!n.use_custom_color, (v) => ((n.use_custom_color = v), (n.color ??= [0.608, 0.608, 0.608]), changed('Use Custom Color'))),
        ),
      },
    ),
    panel('nd-side-props', 'Properties', () => optionsBody(tree, n.id), {
      closed: false,
    }),
  ];
}

function optionsBody(tree: NodeTreeData, id: string): Child {
  const n = nodeById(tree, id);
  if (!n) return null;
  const def = getNodeType(n.type) as NodeTypeDef | undefined;
  const props = def ? visibleProps(n, def.props, 'sidebar') : [];
  const linked = new Set(tree.links.filter((l) => l.to_node === n.id).map((l) => l.to_socket));
  const inputs = nodeSockets(n, { doc: app.doc, tree })
    .inputs.map((s) => ({
      ...s,
      label: s.shortLabel && s.label === s.shortLabel ? s.name : s.label,
    }))
    .filter((s) => !linked.has(s.identifier) && !s.hide_value && ['FLOAT', 'INT', 'BOOLEAN', 'VECTOR', 'RGBA', 'STRING'].includes(s.type));
  const rows: Child[] = [];
  for (const p of props)
    rows.push(
      h(
        'div',
        { class: 'nd-side-row' },
        p.type === 'BOOLEAN'
          ? propWidget(n, p, `side-${n.id}`, { tree })
          : splitRow(
              p.name,
              propWidget(n, { ...p, noLabel: true }, `side-${n.id}`, {
                tree,
                compact: true,
              }),
            ),
      ),
    );
  if (def?.drawOptions)
    rows.push(
      def.drawOptions({
        node: n,
        tree,
        changed: (l, f) => nodeChanged(l, f ?? true),
        where: 'sidebar',
        key: `side-${n.id}`,
      }),
    );
  else if (def?.drawBody && !n.hide_options)
    rows.push(
      def.drawBody({
        node: n,
        tree,
        changed: (l, f) => nodeChanged(l, f ?? true),
        where: 'sidebar',
        key: `side-${n.id}`,
      }),
    );
  if (inputs.length) {
    rows.push(h('div', { class: 'nd-side-sub' }, 'Inputs:'));
    for (const s of inputs)
      rows.push(
        h(
          'div',
          { class: 'nd-side-row' },
          s.type === 'FLOAT' || s.type === 'INT' || s.type === 'BOOLEAN' ? socketValueWidget(n, s, `side-${n.id}`) : splitRow(s.label, socketValueWidget(n, s, `side-${n.id}`, { label: false })),
        ),
      );
  }
  if (!rows.length) rows.push(h('div', { class: 'prop-note' }, 'This node has no options'));
  return rows;
}

function optionsTab(tree: NodeTreeData): Child {
  const n = activeNode(tree);
  if (!n) return h('div', { class: 'prop-note' }, 'No active node');
  return panel('nd-side-options', 'Properties', () => optionsBody(tree, n.id));
}

function groupTab(tree: NodeTreeData): Child {
  const items = tree.interface ?? [];
  activeItem = Math.max(0, Math.min(activeItem, items.length - 1));
  const it = items[activeItem];
  const move = (d: number) => {
    const j = activeItem + d;
    if (!it || j < 0 || j >= items.length) return;
    [items[activeItem], items[j]] = [items[j], items[activeItem]];
    activeItem = j;
    changed('Move Interface Item');
  };
  const add = (inOut: 'INPUT' | 'OUTPUT') => {
    addInterfaceSocket(tree, inOut, inOut === 'INPUT' ? 'Input' : 'Output', tree.type === 'GEOMETRY' ? 'GEOMETRY' : 'FLOAT', tree.type === 'GEOMETRY' ? undefined : 0);
    activeItem = (tree.interface?.length ?? 1) - 1;
    changed('Add Interface Socket');
  };
  const remove = () => {
    if (!it) return;
    tree.interface = items.filter((x) => x !== it);
    tree.links = tree.links.filter(
      (l) =>
        !(
          (l.from_socket === it.identifier && tree.nodes.find((n) => n.id === l.from_node)?.type === 'NodeGroupInput') ||
          (l.to_socket === it.identifier && tree.nodes.find((n) => n.id === l.to_node)?.type === 'NodeGroupOutput')
        ),
    );
    changed('Remove Interface Socket');
  };
  const t = it ? interfaceSocketType(it.socket_type) : null;
  return panel('nd-side-iface', 'Group Sockets', () => [
    h(
      'div',
      { class: 'nd-iface' },
      h(
        'div',
        { class: 'nd-iface-list' },
        items.map((x, i) =>
          h(
            'div',
            {
              key: x.identifier,
              class: { 'nd-iface-item': true, on: i === activeItem },
              onclick: () => ((activeItem = i), app.changed('ui')),
            },
            h('span', {
              class: 'nd-iface-dot',
              style: {
                background: SOCKET_COLORS[interfaceSocketType(x.socket_type).type],
              },
            }),
            h('span', { class: 'nd-iface-dir' }, x.in_out === 'INPUT' ? '→' : '←'),
            x.name,
          ),
        ),
        items.length ? null : h('div', { class: 'prop-note' }, 'No sockets'),
      ),
      h(
        'div',
        { class: 'nd-iface-btns' },
        button('nd-if-addin', h('span', null, icon('add'), 'In'), () => add('INPUT'), { tip: 'Add Input Socket' }),
        button('nd-if-addout', h('span', null, icon('add'), 'Out'), () => add('OUTPUT'), { tip: 'Add Output Socket' }),
        button('nd-if-rem', icon('remove'), remove, {
          tip: 'Remove Socket',
          disabled: !it,
        }),
        button('nd-if-up', icon('triangle_up'), () => move(-1), {
          tip: 'Move Up',
          disabled: !it,
        }),
        button('nd-if-down', icon('triangle_down'), () => move(1), {
          tip: 'Move Down',
          disabled: !it,
        }),
      ),
    ),
    it && t
      ? [
          splitRow(
            'Name',
            textField(`nd-if-name-${it.identifier}`, it.name, (v) => ((it.name = v || it.name), changed('Rename Socket'))),
          ),
          splitRow(
            'Type',
            enumMenu(
              `nd-if-type-${it.identifier}`,
              SOCKET_TYPE_ITEMS.map(([value, label]) => ({ value, label })),
              t.type,
              (v) => ((it.socket_type = SOCKET_IDNAME[v] ?? 'NodeSocketFloat'), (it.default_value = undefined), changed('Socket Type')),
            ),
          ),
          t.type === 'FLOAT' || t.type === 'INT'
            ? [
                splitRow(
                  'Default',
                  numberField({
                    id: `nd-if-def-${it.identifier}`,
                    value: typeof it.default_value === 'number' ? it.default_value : 0,
                    int: t.type === 'INT',
                    set: (v, f) => ((it.default_value = v), nodeChanged('Socket Default', f)),
                  }),
                ),
                splitRow(
                  'Min',
                  numberField({
                    id: `nd-if-min-${it.identifier}`,
                    value: it.min_value ?? -3.4e38,
                    int: t.type === 'INT',
                    set: (v, f) => ((it.min_value = v), nodeChanged('Socket Min', f)),
                  }),
                ),
                splitRow(
                  'Max',
                  numberField({
                    id: `nd-if-max-${it.identifier}`,
                    value: it.max_value ?? 3.4e38,
                    int: t.type === 'INT',
                    set: (v, f) => ((it.max_value = v), nodeChanged('Socket Max', f)),
                  }),
                ),
              ]
            : null,
          t.type === 'RGBA'
            ? splitRow(
                'Default',
                colorSwatch(`nd-if-col-${it.identifier}`, (it.default_value as number[]) ?? [0.8, 0.8, 0.8, 1], (c, f) => ((it.default_value = c), nodeChanged('Socket Default', f))),
              )
            : null,
          t.type === 'VECTOR'
            ? splitRow(
                'Default',
                h(
                  'div',
                  { class: 'col' },
                  [0, 1, 2].map((k) =>
                    numberField({
                      id: `nd-if-vec-${it.identifier}-${k}`,
                      label: 'XYZ'[k],
                      value: ((it.default_value as number[]) ?? [0, 0, 0])[k],
                      set: (v, f) => {
                        const a = [...((it.default_value as number[]) ?? [0, 0, 0])];
                        a[k] = v;
                        it.default_value = a;
                        nodeChanged('Socket Default', f);
                      },
                    }),
                  ),
                ),
              )
            : null,
          t.type === 'BOOLEAN'
            ? h(
                'div',
                { class: 'nd-side-row' },
                checkbox(`nd-if-bool-${it.identifier}`, 'Default', !!it.default_value, (v) => ((it.default_value = v), changed('Socket Default'))),
              )
            : null,
        ]
      : null,
  ]);
}
