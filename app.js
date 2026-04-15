(function () {
  'use strict';

  // --- Constants ---
  var NODE_RADIUS = 16;
  var PALETTE = [
    '#ffffff', // 0: white
    '#1a1a1a', // 1: black
    '#e74c3c', // 2: red
    '#3498db', // 3: blue
    '#2ecc71', // 4: green
    '#f1c40f', // 5: yellow
    '#9b59b6', // 6: purple
    '#e67e22', // 7: orange
  ];
  var COLORS = {
    background: '#f5f5f0',
    edge: '#999999',
    border: '#555555',
    selected: '#ff6600',
    lasso_fill: 'rgba(255, 102, 0, 0.15)',
    lasso_stroke: '#ff6600',
  };

  // --- State ---
  var state = {
    mode: 'NEW_NODE',
    nodes: [],            // { id, x, y, color: 0..colorCount-1, spin: +1|-1, clamped, hidden }
    edges: new Set(),
    nextNodeId: 0,
    colorCount: 2,
    display: 'COLORS',   // 'COLORS' | 'STATE'
    selection: new Set(),
    lasso: { active: false, points: [] },
  };

  var nodeMap = new Map();
  var undoSnapshot = null;

  function saveUndo() {
    undoSnapshot = {
      nodes: state.nodes.map(function (n) {
        return { id: n.id, x: n.x, y: n.y, color: n.color, spin: n.spin, clamped: n.clamped, hidden: n.hidden };
      }),
      edges: new Set(state.edges),
      nextNodeId: state.nextNodeId,
      colorCount: state.colorCount,
      selection: new Set(state.selection),
    };
  }

  function restoreUndo() {
    if (!undoSnapshot) return;
    state.nodes = undoSnapshot.nodes;
    state.edges = undoSnapshot.edges;
    state.nextNodeId = undoSnapshot.nextNodeId;
    state.colorCount = undoSnapshot.colorCount;
    state.selection = undoSnapshot.selection;
    nodeMap.clear();
    for (var i = 0; i < state.nodes.length; i++) {
      nodeMap.set(state.nodes[i].id, state.nodes[i]);
    }
    undoSnapshot = null;
    document.getElementById('color-count').value = state.colorCount;
    render();
  }

  // --- Canvas setup ---
  var canvas = document.getElementById('canvas');
  var ctx = canvas.getContext('2d');

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    render();
  }

  window.addEventListener('resize', resizeCanvas);

  // --- Node/Edge helpers ---
  function getNodeById(id) {
    return nodeMap.get(id);
  }

  function edgeKey(a, b) {
    return a < b ? a + '-' + b : b + '-' + a;
  }

  function addEdge(a, b) {
    if (a !== b) state.edges.add(edgeKey(a, b));
  }

  function removeEdge(a, b) {
    state.edges.delete(edgeKey(a, b));
  }

  function parseEdge(key) {
    var parts = key.split('-');
    return [Number(parts[0]), Number(parts[1])];
  }

  // --- Geometry utilities ---
  function pointInPolygon(px, py, polygon) {
    var inside = false;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      var xi = polygon[i].x, yi = polygon[i].y;
      var xj = polygon[j].x, yj = polygon[j].y;
      var intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // Minimum distance from point (px,py) to line segment (ax,ay)-(bx,by)
  function distToSegment(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
      var ex = px - ax, ey = py - ay;
      return Math.sqrt(ex * ex + ey * ey);
    }
    var t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    var projX = ax + t * dx, projY = ay + t * dy;
    var fx = px - projX, fy = py - projY;
    return Math.sqrt(fx * fx + fy * fy);
  }

  // Does a circle (cx, cy, r) intersect or lie inside the polygon?
  // True if: center is inside, OR any polygon edge passes within r of center.
  function circleIntersectsPolygon(cx, cy, r, polygon) {
    if (pointInPolygon(cx, cy, polygon)) return true;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      if (distToSegment(cx, cy, polygon[j].x, polygon[j].y, polygon[i].x, polygon[i].y) <= r) {
        return true;
      }
    }
    return false;
  }

  // --- Rendering ---
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawEdges();
    drawNodes();
    drawLasso();
    updateHUD();
  }

  function drawEdges() {
    ctx.strokeStyle = COLORS.edge;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    state.edges.forEach(function (key) {
      var pair = parseEdge(key);
      var a = getNodeById(pair[0]);
      var b = getNodeById(pair[1]);
      if (!a || !b) return;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });
  }

  function drawNodes() {
    for (var i = 0; i < state.nodes.length; i++) {
      var node = state.nodes[i];
      var isSelected = state.selection.has(node.id);

      ctx.beginPath();
      ctx.arc(node.x, node.y, NODE_RADIUS, 0, Math.PI * 2);

      // Fill
      if (state.display === 'STATE') {
        ctx.fillStyle = node.spin === 1 ? '#ffffff' : '#1a1a1a';
      } else {
        ctx.fillStyle = PALETTE[node.color] || PALETTE[0];
      }
      ctx.fill();

      // Stroke
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.strokeStyle = isSelected ? COLORS.selected : COLORS.border;
      ctx.setLineDash(node.hidden ? [4, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);

      // Clamp indicator: emoji inside the node
      if (node.clamped) {
        ctx.font = (NODE_RADIUS) + 'px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('\u{1F5DC}', node.x, node.y + 1);
      }

      // Node number to the left
      ctx.font = '11px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.border;
      ctx.fillText(String(i + 1), node.x - NODE_RADIUS - 4, node.y);
    }
  }

  function drawLasso() {
    if (!state.lasso.active || state.lasso.points.length < 2) return;

    var pts = state.lasso.points;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.closePath();

    ctx.fillStyle = COLORS.lasso_fill;
    ctx.fill();

    ctx.strokeStyle = COLORS.lasso_stroke;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.stroke();
  }

  function updateHUD() {
    var spans = document.querySelectorAll('[data-mode]');
    for (var i = 0; i < spans.length; i++) {
      if (spans[i].getAttribute('data-mode') === state.mode) {
        spans[i].classList.add('mode-active');
      } else {
        spans[i].classList.remove('mode-active');
      }
    }
    var dspans = document.querySelectorAll('[data-display]');
    for (var i = 0; i < dspans.length; i++) {
      if (dspans[i].getAttribute('data-display') === state.display) {
        dspans[i].classList.add('mode-active');
      } else {
        dspans[i].classList.remove('mode-active');
      }
    }
    // Update q label based on display mode
    var qLabel = document.getElementById('q-label');
    if (qLabel) qLabel.textContent = state.display === 'STATE' ? 'q — State' : 'q — Color';

    canvas.style.cursor = state.mode === 'NEW_NODE' ? 'crosshair' : 'default';
  }

  // --- Actions ---
  function createNode(x, y) {
    saveUndo();
    var node = {
      id: state.nextNodeId++,
      x: x,
      y: y,
      color: 0,
      spin: 1,
      clamped: false,
      hidden: false,
    };
    state.nodes.push(node);
    nodeMap.set(node.id, node);
    render();
  }

  function cycleColorSelected() {
    saveUndo();
    state.selection.forEach(function (id) {
      var node = getNodeById(id);
      if (node) node.color = (node.color + 1) % state.colorCount;
    });
    render();
  }

  function toggleSpinSelected() {
    saveUndo();
    state.selection.forEach(function (id) {
      var node = getNodeById(id);
      if (node) node.spin *= -1;
    });
    render();
  }

  function toggleConnectSelected() {
    saveUndo();
    var ids = Array.from(state.selection);
    // Check if all pairs are already connected
    var allConnected = true;
    for (var i = 0; i < ids.length && allConnected; i++) {
      for (var j = i + 1; j < ids.length && allConnected; j++) {
        if (!state.edges.has(edgeKey(ids[i], ids[j]))) allConnected = false;
      }
    }
    if (allConnected) {
      for (var i = 0; i < ids.length; i++) {
        for (var j = i + 1; j < ids.length; j++) {
          removeEdge(ids[i], ids[j]);
        }
      }
    } else {
      for (var i = 0; i < ids.length; i++) {
        for (var j = i + 1; j < ids.length; j++) {
          addEdge(ids[i], ids[j]);
        }
      }
    }
    render();
  }

  function toggleClampSelected() {
    saveUndo();
    state.selection.forEach(function (id) {
      var node = getNodeById(id);
      if (node) node.clamped = !node.clamped;
    });
    render();
  }

  function toggleHideSelected() {
    saveUndo();
    state.selection.forEach(function (id) {
      var node = getNodeById(id);
      if (node) node.hidden = !node.hidden;
    });
    render();
  }

  function deleteSelected() {
    saveUndo();
    // Remove all edges that touch any selected node
    var toDelete = new Set(state.selection);
    state.edges.forEach(function (key) {
      var pair = parseEdge(key);
      if (toDelete.has(pair[0]) || toDelete.has(pair[1])) {
        state.edges.delete(key);
      }
    });
    // Remove the nodes
    state.nodes = state.nodes.filter(function (n) { return !toDelete.has(n.id); });
    toDelete.forEach(function (id) { nodeMap.delete(id); });
    state.selection.clear();
    render();
  }

  function clearSelection() {
    state.selection.clear();
    render();
  }

  // --- Mouse helpers ---
  function getMousePos(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function nodeAtPos(x, y) {
    // Search back-to-front so topmost (last drawn) node wins
    for (var i = state.nodes.length - 1; i >= 0; i--) {
      var n = state.nodes[i];
      var dx = x - n.x, dy = y - n.y;
      if (dx * dx + dy * dy <= NODE_RADIUS * NODE_RADIUS) return n;
    }
    return null;
  }

  // --- Lasso helpers ---
  function lassoBBox(points) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < points.length; i++) {
      if (points[i].x < minX) minX = points[i].x;
      if (points[i].y < minY) minY = points[i].y;
      if (points[i].x > maxX) maxX = points[i].x;
      if (points[i].y > maxY) maxY = points[i].y;
    }
    return { width: maxX - minX, height: maxY - minY };
  }

  // --- Event handlers ---
  function onMouseDown(e) {
    if (e.target !== canvas) return;
    var pos = getMousePos(e);

    if (state.mode === 'NEW_NODE') {
      createNode(pos.x, pos.y);
      return;
    }

    if (state.mode === 'CLICK_SELECT') {
      var hit = nodeAtPos(pos.x, pos.y);
      if (hit) {
        if (state.selection.has(hit.id)) {
          state.selection.delete(hit.id);
        } else {
          state.selection.add(hit.id);
        }
        render();
      }
      return;
    }

    if (state.mode === 'LASSO_SELECT') {
      state.lasso.active = true;
      state.lasso.points = [pos];
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }
  }

  function onMouseMove(e) {
    if (!state.lasso.active) return;
    var pos = getMousePos(e);
    state.lasso.points.push(pos);
    render();
  }

  function onMouseUp(e) {
    if (!state.lasso.active) return;

    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);

    var pts = state.lasso.points;
    var bbox = lassoBBox(pts);

    state.lasso.active = false;
    state.lasso.points = [];

    // Tiny lasso (accidental click) = no-op
    if (bbox.width < 5 && bbox.height < 5) {
      render();
      return;
    }

    // Lasso is additive only — select nodes touched, don't deselect any
    for (var i = 0; i < state.nodes.length; i++) {
      var node = state.nodes[i];
      if (circleIntersectsPolygon(node.x, node.y, NODE_RADIUS, pts)) {
        state.selection.add(node.id);
      }
    }

    render();
  }

  function onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    switch (e.key) {
      case '1':
        state.mode = 'NEW_NODE';
        clearSelection();
        break;
      case '2':
        state.mode = 'LASSO_SELECT';
        render();
        break;
      case '3':
        state.mode = 'CLICK_SELECT';
        render();
        break;
      case 'q':
        if (state.display === 'STATE') {
          toggleSpinSelected();
        } else {
          cycleColorSelected();
        }
        break;
      case 'c':
        state.display = 'COLORS';
        render();
        break;
      case 's':
        state.display = 'STATE';
        render();
        break;
      case 'w':
        e.preventDefault();
        toggleConnectSelected();
        break;
      case 'e':
        toggleHideSelected();
        break;
      case 'r':
        e.preventDefault();
        toggleClampSelected();
        break;
      case 'd':
      case 'Backspace':
      case 'Delete':
        e.preventDefault();
        deleteSelected();
        break;
      case 'z':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          restoreUndo();
        }
        break;
      case 'Escape':
        clearSelection();
        break;
    }
  }

  // --- Color count dropdown ---
  var colorCountSelect = document.getElementById('color-count');
  colorCountSelect.addEventListener('change', function () {
    saveUndo();
    state.colorCount = Number(colorCountSelect.value);
    // Clamp any out-of-range colors
    for (var i = 0; i < state.nodes.length; i++) {
      if (state.nodes[i].color >= state.colorCount) {
        state.nodes[i].color = state.nodes[i].color % state.colorCount;
      }
    }
    state.selection.clear();
    colorCountSelect.blur();
    render();
  });

  // --- Init ---
  canvas.addEventListener('mousedown', onMouseDown);
  document.addEventListener('keydown', onKeyDown);
  resizeCanvas();
})();
