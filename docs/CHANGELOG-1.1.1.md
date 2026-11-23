# STRPG 1.1.1 — Story generation schema fix

Small corrective release for the Workbench AI content interface.

## Fixed

- The built-in **Story Arc** preset no longer suggests the invalid node type
  `choice`. STRPG's story schema uses `branch` for choice nodes. The preset now
  also states that `startNodeKey` and `endings` must reference declared nodes,
  that `sceneKey` must be an existing scene, and that every node must be
  reachable from the start.
- Generated stories are normalized before preview:
  - `choice` is rewritten to `branch`;
  - unknown node types fall back to `scene`;
  - node keys are slugged and missing titles are filled from the key;
  - an ending node is used to infer `endings` when the model omitted it;
  - dangling edges are kept visible but reported as warnings instead of
    silently dropping content.
- The story preview now warns about a missing `startNodeKey`, empty endings,
  endings that are not declared as nodes, edges that point at undeclared node
  keys, and a story with no branch node.

## Compatibility

No schema or server API change. Existing stories and campaigns are untouched.
Plugin and extension version report `1.1.1`.
