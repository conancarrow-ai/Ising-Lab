# Ising Lab

Browser-based interactive tool for building probabilistic graphical model graphs and simulating Ising model Glauber dynamics. No dependencies, no build step — open `index.html` in a browser.

## Files

- `index.html` — HTML shell, canvas, HUD overlays, controls div, inline CSS
- `app.js` — All application logic (~1100 lines, single IIFE)

## Architecture (app.js)

**State object** holds all mutable app state: nodes, edges, weights, selection, display mode, etc.

**Nodes**: `{ id, x, y, color, spin, bias, clamped, hidden }`. Internal `id` is stable; display number is 1-based array index (auto-renumbers on delete). `nodeMap` (Map<id, node>) provides O(1) lookup.

**Edges**: `state.edges` (Set of canonical string keys `"minId-maxId"`), `state.weights` (Map<edgeKey, number>). `addEdge`/`removeEdge` manage both together.

**Color** is a graph-theoretic property (integer index into PALETTE) for partitioning nodes into independent update blocks for chromatic Gibbs sampling. It is NOT a spin or model property. The coloring checker validates no adjacent nodes share a color.

**Three display modes**: COLORS (graph coloring), STATE (spin arrows on orange fill, statistics, history grid), MODEL (edge weights and node biases in blue).

**Three interaction modes**: NEW_NODE (click to place), LASSO_SELECT (drag to select, additive only), CLICK_SELECT (click to toggle selection, drag selected nodes to move).

**Key bindings**: Number keys 1-3 switch modes. Letters c/s/m switch display. q is context-sensitive (cycle color / toggle spin / entry mode). w=connect, e=hide, r=clamp, d=delete. ArrowRight=Glauber update (State display only). !=random init, @=wipe stats. Ctrl+Z=undo (1 level).

**Glauber dynamics**: `glauberUpdate()` cycles through colors. For each unclamped node of current color, computes local field h = bias + Σ(weight × neighbor_spin), flips with P(+1) = σ(2h). Clamped nodes are frozen.

**Statistics**: `statsHistory` ring buffer (size controlled by History input). Records node spins and edge products per snapshot. `drawStateStats` shows running averages; `drawHistoryGrid` shows black/white grid top-right.

**Entry mode** (Model display, q key): overlays input fields on all weights and biases simultaneously. Enter advances between fields, q/Escape commits all. Uses `separateLabels` for overlap avoidance on input positions.

**Rendering**: Full canvas redraw on every state change via `render()`. Order: background → edges → nodes → model/state labels → lasso → HUD.

## Key design decisions

- `state` is JS program state, not physics state
- Selection is a Set on state, not a property of nodes
- Undo is a single snapshot (not a stack)
- Lasso is additive-only; click-select toggles individual nodes
- `separateLabels()` iteratively pushes overlapping edge labels apart
- Stats history is wiped on node add/delete/@ but not on graph property changes
