// @ts-check

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docs: [
    'intro',
    'installation',
    'getting-started',
    {
      type: 'category',
      label: 'User Guide',
      link: { type: 'doc', id: 'user-guide/index' },
      items: [
        'user-guide/how-it-works',
        'user-guide/mcp-tools',
        'user-guide/hooks',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      link: { type: 'doc', id: 'reference/index' },
      items: [
        'reference/mcp-tools',
        'reference/hooks',
        'reference/graph-schema',
      ],
    },
    {
      type: 'category',
      label: 'Architecture',
      link: { type: 'doc', id: 'architecture/index' },
      items: [
        'architecture/design-spec',
        'architecture/data-model',
      ],
    },
    'contributing',
    'changelog',
  ],
};

module.exports = sidebars;
