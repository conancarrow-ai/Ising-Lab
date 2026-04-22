(function () {
  'use strict';

  // --- Constants ---
  var NODE_RADIUS = 16;
  var LATTICE_SPACING = 120;
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
    model_text: '#336699',
  };

  // --- State ---
  var state = {
    mode: 'NEW_NODE',
    nodes: [],       // { id, x, y, color, spin, bias, clamped, hidden }
    edges: new Set(),
    weights: new Map(), // edgeKey -> number
    nextNodeId: 0,
    colorCount: 2,
    display: 'COLORS',          // 'COLORS' | 'STATE' | 'MODEL'
    coloringStatus: 'UNCHECKED', // 'UNCHECKED' | 'VALID' | 'INVALID'
    selection: new Set(),
    lasso: { active: false, points: [] },
    drag: { active: false, lastPos: null },
    updateColorIndex: 0, // which color to update next in Glauber dynamics
  };

  // Running statistics: ring buffer of spin snapshots
  var statsWindow = 30;
  var statsHistory = []; // array of { nodeSpins: Map<id, spin>, edgeProducts: Map<edgeKey, product> }

  function recordSnapshot() {
    var nodeSpins = new Map();
    for (var i = 0; i < state.nodes.length; i++) {
      nodeSpins.set(state.nodes[i].id, state.nodes[i].spin);
    }
    var edgeProducts = new Map();
    state.edges.forEach(function (key) {
      var pair = parseEdge(key);
      var a = getNodeById(pair[0]);
      var b = getNodeById(pair[1]);
      if (a && b) edgeProducts.set(key, a.spin * b.spin);
    });
    statsHistory.push({ nodeSpins: nodeSpins, edgeProducts: edgeProducts });
    while (statsHistory.length > statsWindow) statsHistory.shift();
  }

  function nodeAvg(nodeId) {
    if (statsHistory.length === 0) return null;
    var sum = 0, count = 0;
    for (var i = 0; i < statsHistory.length; i++) {
      var v = statsHistory[i].nodeSpins.get(nodeId);
      if (v !== undefined) { sum += v; count++; }
    }
    return count > 0 ? sum / count : null;
  }

  function edgeAvg(key) {
    if (statsHistory.length === 0) return null;
    var sum = 0, count = 0;
    for (var i = 0; i < statsHistory.length; i++) {
      var v = statsHistory[i].edgeProducts.get(key);
      if (v !== undefined) { sum += v; count++; }
    }
    return count > 0 ? sum / count : null;
  }

  var nodeMap = new Map();
  var undoSnapshot = null;
  var entryMode = false;
  var entryInputs = []; // { element, type, key/nodeId, origValue }
  var showLattice = false;
  var latticeOrigin = { x: 0, y: 0 }; // fixed in absolute canvas coords

  // --- Formatting ---
  function formatSig(n) {
    if (n === 0) return '0.0';
    var s = n.toPrecision(2);
    if (s.indexOf('e') !== -1) s = n.toFixed(1);
    return s;
  }

  // --- Undo ---
  function saveUndo() {
    undoSnapshot = {
      nodes: state.nodes.map(function (n) {
        return { id: n.id, x: n.x, y: n.y, color: n.color, spin: n.spin, bias: n.bias, clamped: n.clamped, hidden: n.hidden };
      }),
      edges: new Set(state.edges),
      weights: new Map(state.weights),
      nextNodeId: state.nextNodeId,
      colorCount: state.colorCount,
      coloringStatus: state.coloringStatus,
      selection: new Set(state.selection),
    };
  }

  function restoreUndo() {
    if (!undoSnapshot) return;
    state.nodes = undoSnapshot.nodes;
    state.edges = undoSnapshot.edges;
    state.weights = undoSnapshot.weights;
    state.nextNodeId = undoSnapshot.nextNodeId;
    state.colorCount = undoSnapshot.colorCount;
    state.coloringStatus = undoSnapshot.coloringStatus;
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
    if (a !== b) {
      var key = edgeKey(a, b);
      if (!state.edges.has(key)) {
        state.edges.add(key);
        state.weights.set(key, 0.0);
      }
    }
  }

  function removeEdge(a, b) {
    var key = edgeKey(a, b);
    state.edges.delete(key);
    state.weights.delete(key);
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

  function circleIntersectsPolygon(cx, cy, r, polygon) {
    if (pointInPolygon(cx, cy, polygon)) return true;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      if (distToSegment(cx, cy, polygon[j].x, polygon[j].y, polygon[i].x, polygon[i].y) <= r) {
        return true;
      }
    }
    return false;
  }

  // --- Coloring validation ---
  function checkColoring() {
    var valid = true;
    state.edges.forEach(function (key) {
      var pair = parseEdge(key);
      var a = getNodeById(pair[0]);
      var b = getNodeById(pair[1]);
      if (a && b && a.color === b.color) valid = false;
    });
    state.coloringStatus = valid ? 'VALID' : 'INVALID';
  }

  function updateColoringStatus() {
    var el = document.getElementById('coloring-status');
    if (state.coloringStatus === 'VALID') {
      el.textContent = '\u2705';
    } else if (state.coloringStatus === 'INVALID') {
      el.textContent = '\u26D4';
    } else {
      el.textContent = '\u26A0\uFE0F';
    }
  }

  // --- Model display: compute label positions ---
  function edgeLabelPos(key) {
    var pair = parseEdge(key);
    var a = getNodeById(pair[0]);
    var b = getNodeById(pair[1]);
    if (!a || !b) return null;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 10 };
  }

  function biasLabelPos(node) {
    return { x: node.x + NODE_RADIUS + 4, y: node.y };
  }

  // --- Entry mode: overlay input fields on all weights and biases ---
  function openEntryMode() {
    if (entryMode) return;
    entryMode = true;
    saveUndo();

    function makeInput(x, y, value, rec) {
      var input = document.createElement('input');
      input.type = 'text';
      input.value = formatSig(value);
      input.style.position = 'fixed';
      input.style.left = (x - 28) + 'px';
      input.style.top = (y - 10) + 'px';
      input.style.width = '56px';
      input.style.height = '18px';
      input.style.font = '10px monospace';
      input.style.textAlign = 'center';
      input.style.padding = '1px 2px';
      input.style.border = '1px solid ' + COLORS.model_text;
      input.style.borderRadius = '2px';
      input.style.background = '#fff';
      input.style.color = COLORS.model_text;
      input.style.zIndex = '100';
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          ev.stopPropagation();
          var idx = entryInputs.indexOf(rec);
          if (idx < entryInputs.length - 1) {
            entryInputs[idx + 1].element.focus();
            entryInputs[idx + 1].element.select();
          } else {
            closeEntryMode();
          }
        } else if (ev.key === 'Escape' || ev.key === 'q') {
          ev.preventDefault();
          ev.stopPropagation();
          closeEntryMode();
        } else if (ev.key === 'Tab') {
          ev.preventDefault();
          ev.stopPropagation();
          var idx = entryInputs.indexOf(rec);
          var next = ev.shiftKey ? idx - 1 : idx + 1;
          if (next >= 0 && next < entryInputs.length) {
            entryInputs[next].element.focus();
            entryInputs[next].element.select();
          }
        } else {
          ev.stopPropagation();
        }
      });
      document.body.appendChild(input);
      rec.element = input;
      return input;
    }

    // Collect edge label positions and separate overlapping ones
    var edgeEntries = [];
    state.edges.forEach(function (key) {
      var pos = edgeLabelPos(key);
      if (!pos) return;
      edgeEntries.push({ x: pos.x, y: pos.y, key: key });
    });
    separateLabels(edgeEntries, 22);

    // Edge weight inputs at separated positions
    for (var ei = 0; ei < edgeEntries.length; ei++) {
      var entry = edgeEntries[ei];
      var w = state.weights.get(entry.key) || 0;
      var rec = { type: 'weight', key: entry.key, origValue: w };
      makeInput(entry.x, entry.y, w, rec);
      entryInputs.push(rec);
    }

    // Node bias inputs
    for (var i = 0; i < state.nodes.length; i++) {
      var node = state.nodes[i];
      var pos = biasLabelPos(node);
      var rec = { type: 'bias', nodeId: node.id, origValue: node.bias };
      makeInput(pos.x + 14, pos.y, node.bias, rec);
      entryInputs.push(rec);
    }

    if (entryInputs.length > 0) {
      var firstInput = entryInputs[0].element;
      setTimeout(function () {
        firstInput.focus();
        firstInput.select();
      }, 0);
    }
  }

  function closeEntryMode() {
    if (!entryMode) return;
    // Read all values and apply
    for (var i = 0; i < entryInputs.length; i++) {
      var rec = entryInputs[i];
      var val = parseFloat(rec.element.value);
      if (isNaN(val)) val = rec.origValue;
      if (rec.type === 'weight') {
        state.weights.set(rec.key, val);
      } else {
        var node = getNodeById(rec.nodeId);
        if (node) node.bias = val;
      }
      if (rec.element.parentNode) rec.element.parentNode.removeChild(rec.element);
    }
    entryInputs = [];
    entryMode = false;
    render();
  }

  // --- Rendering ---
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (showLattice) drawLatticePoints();
    drawEdges();
    drawNodes();
    if (state.display === 'MODEL' && !entryMode) drawModelLabels();
    if (state.display === 'STATE' && statsHistory.length > 0) {
      drawStateStats();
      drawHistoryGrid();
    }
    drawLasso();
    updateHUD();
    updateColoringStatus();
  }

  function drawLatticePoints() {
    var h = LATTICE_SPACING;
    var sqrt3_2 = Math.sqrt(3) / 2;
    var ox = latticeOrigin.x;
    var oy = latticeOrigin.y;

    ctx.fillStyle = '#d4d4d4';
    var margin = 20;
    var n2min = Math.floor((-margin - oy) / (h * sqrt3_2)) - 1;
    var n2max = Math.ceil((canvas.height + margin - oy) / (h * sqrt3_2)) + 1;
    for (var n2 = n2min; n2 <= n2max; n2++) {
      var py = oy + n2 * h * sqrt3_2;
      var rowXOff = n2 * h / 2;
      var n1min = Math.floor((-margin - ox - rowXOff) / h) - 1;
      var n1max = Math.ceil((canvas.width + margin - ox - rowXOff) / h) + 1;
      for (var n1 = n1min; n1 <= n1max; n1++) {
        var px = ox + n1 * h + rowXOff;
        if (px < -margin || px > canvas.width + margin) continue;
        if (py < -margin || py > canvas.height + margin) continue;
        ctx.beginPath();
        ctx.arc(px, py, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
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
        ctx.fillStyle = '#FFD0B5';
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

      // State arrow (in State display)
      if (state.display === 'STATE') {
        var dir = node.spin === 1 ? -1 : 1; // -1 = up, 1 = down
        var r = NODE_RADIUS * 0.45;
        var headLen = NODE_RADIUS * 0.5;
        var headW = NODE_RADIUS * 0.5;
        var tipY = node.y + (r + headLen) * dir;
        var tailY = node.y - r * dir;
        var shaftW = 2;

        ctx.fillStyle = '#1a1a1a';
        ctx.lineJoin = 'miter';
        ctx.beginPath();
        // Shaft as a filled rectangle
        ctx.moveTo(node.x - shaftW, tailY);
        ctx.lineTo(node.x + shaftW, tailY);
        ctx.lineTo(node.x + shaftW, node.y + r * dir);
        // Arrowhead
        ctx.lineTo(node.x + headW, node.y + r * dir);
        ctx.lineTo(node.x, tipY);
        ctx.lineTo(node.x - headW, node.y + r * dir);
        ctx.lineTo(node.x - shaftW, node.y + r * dir);
        ctx.closePath();
        ctx.fill();
      }

      // Clamp indicator to the left, surrounding the node number
      if (node.clamped) {
        ctx.font = Math.round(NODE_RADIUS * 0.6) + 'px serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText('\u{1F5DC}', node.x - NODE_RADIUS - 1, node.y + 8);
      }

      // Node number to the left
      ctx.font = '11px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.border;
      ctx.fillText(String(i + 1), node.x - NODE_RADIUS - 4, node.y);
    }
  }

  function separateLabels(labels, minDist) {
    // Push overlapping labels apart iteratively
    for (var iter = 0; iter < 10; iter++) {
      var moved = false;
      for (var i = 0; i < labels.length; i++) {
        for (var j = i + 1; j < labels.length; j++) {
          var dx = labels[j].x - labels[i].x;
          var dy = labels[j].y - labels[i].y;
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d < minDist && d > 0) {
            var push = (minDist - d) / 2;
            var nx = dx / d, ny = dy / d;
            labels[i].x -= nx * push;
            labels[i].y -= ny * push;
            labels[j].x += nx * push;
            labels[j].y += ny * push;
            moved = true;
          } else if (d === 0) {
            // Coincident — push apart arbitrarily
            labels[j].y += minDist;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  }

  function drawModelLabels() {
    // Collect edge weight labels
    var edgeLabels = [];
    state.edges.forEach(function (key) {
      var pos = edgeLabelPos(key);
      if (!pos) return;
      var w = state.weights.get(key);
      if (w === undefined) w = 0;
      edgeLabels.push({ x: pos.x, y: pos.y, text: formatSig(w) });
    });

    separateLabels(edgeLabels, 16);

    ctx.font = '10px monospace';
    ctx.fillStyle = COLORS.model_text;

    for (var i = 0; i < edgeLabels.length; i++) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(edgeLabels[i].text, edgeLabels[i].x, edgeLabels[i].y);
    }

    // Node biases to the right (these don't overlap with each other typically)
    for (var i = 0; i < state.nodes.length; i++) {
      var node = state.nodes[i];
      var pos = biasLabelPos(node);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatSig(node.bias), pos.x, pos.y);
    }
  }

  function drawStateStats() {
    var statsColor = '#885522';

    // Edge correlation labels
    var edgeLabels = [];
    state.edges.forEach(function (key) {
      var avg = edgeAvg(key);
      if (avg === null) return;
      var pos = edgeLabelPos(key);
      if (!pos) return;
      edgeLabels.push({ x: pos.x, y: pos.y, text: formatSig(avg) });
    });

    separateLabels(edgeLabels, 16);

    ctx.font = '10px monospace';
    ctx.fillStyle = statsColor;

    for (var i = 0; i < edgeLabels.length; i++) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(edgeLabels[i].text, edgeLabels[i].x, edgeLabels[i].y);
    }

    // Node average labels to the right
    for (var i = 0; i < state.nodes.length; i++) {
      var node = state.nodes[i];
      var avg = nodeAvg(node.id);
      if (avg === null) continue;
      var pos = biasLabelPos(node);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatSig(avg), pos.x, pos.y);
    }
  }

  function drawHistoryGrid() {
    if (statsHistory.length === 0 || state.nodes.length === 0) return;
    var cellSize = 15;
    var padding = 16;
    var nNodes = state.nodes.length;
    var nRows = statsHistory.length;
    var gridW = nNodes * cellSize;
    var gridH = nRows * cellSize;
    var x0 = canvas.width - padding - gridW;
    var y0 = padding;

    // Border
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeRect(x0 - 1, y0 - 1, gridW + 2, gridH + 2);

    // Draw cells
    for (var row = 0; row < nRows; row++) {
      var snap = statsHistory[row];
      for (var col = 0; col < nNodes; col++) {
        var nodeId = state.nodes[col].id;
        var spin = snap.nodeSpins.get(nodeId);
        ctx.fillStyle = (spin === 1) ? '#ffffff' : '#1a1a1a';
        ctx.fillRect(x0 + col * cellSize, y0 + row * cellSize, cellSize, cellSize);
      }
    }

    // Grid lines
    ctx.strokeStyle = '#cccccc';
    ctx.lineWidth = 0.5;
    for (var col = 0; col <= nNodes; col++) {
      ctx.beginPath();
      ctx.moveTo(x0 + col * cellSize, y0);
      ctx.lineTo(x0 + col * cellSize, y0 + gridH);
      ctx.stroke();
    }
    for (var row = 0; row <= nRows; row++) {
      ctx.beginPath();
      ctx.moveTo(x0, y0 + row * cellSize);
      ctx.lineTo(x0 + gridW, y0 + row * cellSize);
      ctx.stroke();
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
    var qLabel = document.getElementById('q-label');
    if (state.display === 'STATE') qLabel.textContent = 'q \u2014 State';
    else if (state.display === 'COLORS') qLabel.textContent = 'q \u2014 Color';
    else if (state.display === 'MODEL') qLabel.textContent = 'q \u2014 Entry';

    var updateLabel = document.getElementById('update-label');
    updateLabel.style.display = state.display === 'STATE' ? '' : 'none';

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
      bias: 0.0,
      clamped: false,
      hidden: false,
    };
    state.nodes.push(node);
    nodeMap.set(node.id, node);
    statsHistory = [];
    render();
  }

  function cycleColorSelected() {
    saveUndo();
    state.selection.forEach(function (id) {
      var node = getNodeById(id);
      if (node) node.color = (node.color + 1) % state.colorCount;
    });
    state.coloringStatus = 'UNCHECKED';
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
    // Collect unlike-color pairs
    var pairs = [];
    for (var i = 0; i < ids.length; i++) {
      var a = getNodeById(ids[i]);
      if (!a) continue;
      for (var j = i + 1; j < ids.length; j++) {
        var b = getNodeById(ids[j]);
        if (!b) continue;
        if (a.color !== b.color) pairs.push([ids[i], ids[j]]);
      }
    }
    // If every unlike-color pair is already connected, disconnect them; else connect them
    var allConnected = pairs.length > 0;
    for (var k = 0; k < pairs.length && allConnected; k++) {
      if (!state.edges.has(edgeKey(pairs[k][0], pairs[k][1]))) allConnected = false;
    }
    if (allConnected) {
      for (var k = 0; k < pairs.length; k++) removeEdge(pairs[k][0], pairs[k][1]);
    } else {
      for (var k = 0; k < pairs.length; k++) addEdge(pairs[k][0], pairs[k][1]);
    }
    state.coloringStatus = 'UNCHECKED';
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
    var toDelete = new Set(state.selection);
    state.edges.forEach(function (key) {
      var pair = parseEdge(key);
      if (toDelete.has(pair[0]) || toDelete.has(pair[1])) {
        state.edges.delete(key);
        state.weights.delete(key);
      }
    });
    state.nodes = state.nodes.filter(function (n) { return !toDelete.has(n.id); });
    toDelete.forEach(function (id) { nodeMap.delete(id); });
    state.selection.clear();
    if (state.coloringStatus === 'INVALID') state.coloringStatus = 'UNCHECKED';
    statsHistory = [];
    render();
  }

  function cleanUpSelected() {
    if (state.selection.size === 0) return;
    saveUndo();
    var h = LATTICE_SPACING;
    var sqrt3_2 = Math.sqrt(3) / 2;
    var ox = latticeOrigin.x;
    var oy = latticeOrigin.y;

    // For each selected node, collect candidate lattice points sorted by distance
    var candidates = [];
    state.selection.forEach(function (id) {
      var n = getNodeById(id);
      if (!n) return;
      var rx = n.x - ox;
      var ry = n.y - oy;
      // Lattice basis: e1 = (h, 0), e2 = (h/2, h*sqrt3_2)
      var n2f = ry / (h * sqrt3_2);
      var n1f = rx / h - n2f / 2;
      var ci = Math.round(n1f);
      var cj = Math.round(n2f);
      var snaps = [];
      for (var di = -2; di <= 2; di++) {
        for (var dj = -2; dj <= 2; dj++) {
          var i = ci + di, j = cj + dj;
          var px = ox + i * h + j * h / 2;
          var py = oy + j * h * sqrt3_2;
          var dist = Math.hypot(n.x - px, n.y - py);
          snaps.push({ i: i, j: j, x: px, y: py, dist: dist });
        }
      }
      snaps.sort(function (a, b) { return a.dist - b.dist; });
      candidates.push({ node: n, snaps: snaps });
    });

    // Greedy assignment: snap the most-constrained node first (nearest snap distance smallest)
    candidates.sort(function (a, b) { return a.snaps[0].dist - b.snaps[0].dist; });
    var used = new Set();
    for (var k = 0; k < candidates.length; k++) {
      var cand = candidates[k];
      for (var s = 0; s < cand.snaps.length; s++) {
        var snap = cand.snaps[s];
        var key = snap.i + ',' + snap.j;
        if (!used.has(key)) {
          used.add(key);
          cand.node.x = snap.x;
          cand.node.y = snap.y;
          break;
        }
      }
    }
    render();
  }

  function clearSelection() {
    state.selection.clear();
    render();
  }

  // --- Glauber dynamics ---
  function glauberUpdate() {
    saveUndo();
    var color = state.updateColorIndex;

    // Build adjacency: for each node, list of { neighborId, edgeKey }
    for (var i = 0; i < state.nodes.length; i++) {
      var node = state.nodes[i];
      if (node.color !== color || node.clamped) continue;

      // Compute local field h_i = b_i + Σ_j J_ij * s_j
      var h = node.bias;
      state.edges.forEach(function (key) {
        var pair = parseEdge(key);
        var neighborId = null;
        if (pair[0] === node.id) neighborId = pair[1];
        else if (pair[1] === node.id) neighborId = pair[0];
        if (neighborId === null) return;
        var neighbor = getNodeById(neighborId);
        if (!neighbor) return;
        var w = state.weights.get(key) || 0;
        h += w * neighbor.spin;
      });

      // P(s_i = +1) = sigmoid(2 * h)
      var p = 1 / (1 + Math.exp(-2 * h));
      node.spin = Math.random() < p ? 1 : -1;
    }

    // Advance to next color
    state.updateColorIndex = (color + 1) % state.colorCount;
    recordSnapshot();
    render();
  }

  function randomizeSpins() {
    saveUndo();
    for (var i = 0; i < state.nodes.length; i++) {
      if (!state.nodes[i].clamped) {
        state.nodes[i].spin = Math.random() < 0.5 ? 1 : -1;
      }
    }
    recordSnapshot();
    render();
  }

  function wipeStats() {
    statsHistory = [];
    render();
  }

  // --- Mouse helpers ---
  function getMousePos(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function nodeAtPos(x, y) {
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
      if (!nodeAtPos(pos.x, pos.y)) createNode(pos.x, pos.y);
      return;
    }

    if (state.mode === 'CLICK_SELECT') {
      var hitNode = nodeAtPos(pos.x, pos.y);
      if (hitNode) {
        var wasSelected = state.selection.has(hitNode.id);
        if (!wasSelected) {
          state.selection.add(hitNode.id);
          render();
        }
        state.drag.active = true;
        state.drag.lastPos = pos;
        state.drag.didMove = false;
        state.drag.hitId = hitNode.id;
        state.drag.wasSelected = wasSelected;
        saveUndo();
        window.addEventListener('mousemove', onDragMove);
        window.addEventListener('mouseup', onDragUp);
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

    if (bbox.width < 5 && bbox.height < 5) {
      render();
      return;
    }

    for (var i = 0; i < state.nodes.length; i++) {
      var node = state.nodes[i];
      if (circleIntersectsPolygon(node.x, node.y, NODE_RADIUS, pts)) {
        state.selection.add(node.id);
      }
    }

    render();
  }

  function onDragMove(e) {
    var pos = getMousePos(e);
    var dx = pos.x - state.drag.lastPos.x;
    var dy = pos.y - state.drag.lastPos.y;
    if (dx !== 0 || dy !== 0) state.drag.didMove = true;
    state.selection.forEach(function (id) {
      var node = getNodeById(id);
      if (node) {
        node.x += dx;
        node.y += dy;
      }
    });
    state.drag.lastPos = pos;
    render();
  }

  function onDragUp(e) {
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragUp);
    state.drag.active = false;
    if (!state.drag.didMove) {
      undoSnapshot = null;
      // Only deselect if the node was already selected before this click
      if (state.drag.wasSelected && state.selection.has(state.drag.hitId)) {
        state.selection.delete(state.drag.hitId);
      }
      render();
    }
  }

  // --- Context menu ---
  var contextMenuEl = null;

  function closeContextMenu() {
    if (contextMenuEl && contextMenuEl.parentNode) {
      contextMenuEl.parentNode.removeChild(contextMenuEl);
    }
    contextMenuEl = null;
  }

  function buildContextMenuItems() {
    var hasSel = state.selection.size > 0;
    var items = [];

    // q action — varies by display
    if (state.display === 'COLORS') {
      items.push({ label: 'Cycle color', key: 'q', action: cycleColorSelected, enabled: hasSel });
    } else if (state.display === 'STATE') {
      items.push({ label: 'Toggle spin', key: 'q', action: toggleSpinSelected, enabled: hasSel });
    } else if (state.display === 'MODEL') {
      items.push({ label: 'Edit values', key: 'q', action: openEntryMode, enabled: state.edges.size > 0 || state.nodes.length > 0 });
    }
    items.push({ label: 'Connect', key: 'w', action: toggleConnectSelected, enabled: hasSel });
    items.push({ label: 'Hide', key: 'e', action: toggleHideSelected, enabled: hasSel });
    items.push({ label: 'Clamp', key: 'r', action: toggleClampSelected, enabled: hasSel });
    items.push({ label: 'Clean up', key: 'a', action: cleanUpSelected, enabled: hasSel });
    items.push({ label: 'Delete', key: 'd', action: deleteSelected, enabled: hasSel });

    if (state.display === 'STATE') {
      items.push({ separator: true });
      items.push({ label: 'Update', key: '→', action: glauberUpdate, enabled: true });
      items.push({ label: 'Random init', key: '!', action: randomizeSpins, enabled: true });
      items.push({ label: 'Wipe stats', key: '@', action: wipeStats, enabled: true });
    }

    items.push({ separator: true });
    items.push({ label: 'Deselect', key: 'Esc', action: clearSelection, enabled: hasSel });
    items.push({ label: 'Undo', key: '⌃Z', action: restoreUndo, enabled: undoSnapshot !== null });

    return items;
  }

  function showContextMenu(x, y) {
    closeContextMenu();
    var menu = document.createElement('div');
    menu.id = 'context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    var items = buildContextMenuItems();
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.separator) {
        var sep = document.createElement('div');
        sep.className = 'menu-sep';
        menu.appendChild(sep);
        continue;
      }
      var row = document.createElement('div');
      row.className = 'menu-item' + (it.enabled ? '' : ' disabled');
      var label = document.createElement('span');
      label.textContent = it.label;
      var key = document.createElement('span');
      key.className = 'menu-key';
      key.textContent = it.key;
      row.appendChild(label);
      row.appendChild(key);
      if (it.enabled) {
        (function (action) {
          row.addEventListener('mousedown', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            closeContextMenu();
            action();
          });
        })(it.action);
      }
      menu.appendChild(row);
    }

    document.body.appendChild(menu);

    // Position adjustment if menu goes off screen
    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = (window.innerHeight - rect.height - 4) + 'px';
    }
    contextMenuEl = menu;
  }

  function onContextMenu(e) {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY);
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
        if (state.display === 'MODEL') {
          if (entryMode) closeEntryMode(); else openEntryMode();
        } else if (state.display === 'STATE') {
          toggleSpinSelected();
        } else if (state.display === 'COLORS') {
          cycleColorSelected();
        }
        break;
      case 'c':
        if (entryMode) closeEntryMode();
        state.display = 'COLORS';
        render();
        break;
      case 's':
        if (entryMode) closeEntryMode();
        state.display = 'STATE';
        render();
        break;
      case 'm':
        state.display = 'MODEL';
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
      case 'a':
        cleanUpSelected();
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
      case 'ArrowRight':
        if (state.display === 'STATE') {
          e.preventDefault();
          glauberUpdate();
        }
        break;
      case '!':
        if (state.display === 'STATE') {
          randomizeSpins();
        }
        break;
      case '@':
        if (state.display === 'STATE') {
          wipeStats();
        }
        break;
      case 'Escape':
        if (contextMenuEl) closeContextMenu();
        else clearSelection();
        break;
      case ' ':
        e.preventDefault();
        if (!showLattice) {
          showLattice = true;
          render();
        }
        break;
    }
  }

  // --- Color count dropdown ---
  var colorCountSelect = document.getElementById('color-count');
  colorCountSelect.addEventListener('change', function () {
    saveUndo();
    state.colorCount = Number(colorCountSelect.value);
    for (var i = 0; i < state.nodes.length; i++) {
      if (state.nodes[i].color >= state.colorCount) {
        state.nodes[i].color = state.nodes[i].color % state.colorCount;
      }
    }
    state.coloringStatus = 'UNCHECKED';
    state.selection.clear();
    colorCountSelect.blur();
    render();
  });

  // --- Coloring check button ---
  document.getElementById('coloring-check').addEventListener('click', function () {
    checkColoring();
    render();
  });

  // --- History size input ---
  var historySizeInput = document.getElementById('history-size');
  historySizeInput.addEventListener('change', function () {
    var val = parseInt(historySizeInput.value);
    if (isNaN(val) || val < 1) val = 1;
    statsWindow = val;
    historySizeInput.value = val;
    while (statsHistory.length > statsWindow) statsHistory.shift();
    historySizeInput.blur();
    render();
  });

  // --- Initial graph ---
  function initGraph() {
    var cx = canvas.width / 2;
    var cy = canvas.height / 2;
    var h = LATTICE_SPACING;
    var rowH = h * Math.sqrt(3) / 2; // triangular-lattice row spacing

    // Fix the lattice origin so both rows of the initial graph are real
    // lattice rows and the graph is visually centered on the canvas.
    latticeOrigin = { x: cx, y: cy - rowH / 2 };

    // Whites: centered (unstaggered) row at n2 = 0, n1 in {-1, 0, 1}
    var whiteY = latticeOrigin.y;
    var whiteXs = [latticeOrigin.x - h, latticeOrigin.x, latticeOrigin.x + h];
    var whites = [];
    for (var i = 0; i < 3; i++) {
      var node = {
        id: state.nextNodeId++,
        x: whiteXs[i],
        y: whiteY,
        color: 0,
        spin: 1,
        bias: 0.0,
        clamped: false,
        hidden: false,
      };
      state.nodes.push(node);
      nodeMap.set(node.id, node);
      whites.push(node);
    }

    // Blacks: staggered row at n2 = 1, n1 in {-1, 0}
    var blackY = latticeOrigin.y + rowH;
    var blackXs = [latticeOrigin.x - h / 2, latticeOrigin.x + h / 2];
    var blacks = [];
    for (var i = 0; i < 2; i++) {
      var node = {
        id: state.nextNodeId++,
        x: blackXs[i],
        y: blackY,
        color: 1,
        spin: 1,
        bias: 0.0,
        clamped: false,
        hidden: true,
      };
      state.nodes.push(node);
      nodeMap.set(node.id, node);
      blacks.push(node);
    }

    // Fully connect white to black
    for (var i = 0; i < whites.length; i++) {
      for (var j = 0; j < blacks.length; j++) {
        var key = edgeKey(whites[i].id, blacks[j].id);
        state.edges.add(key);
        state.weights.set(key, Math.random() * 2 - 1);
      }
    }
  }

  // --- Init ---
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  initGraph();
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', function (e) {
    if (e.key === ' ' && showLattice) {
      showLattice = false;
      render();
    }
  });
  // Close context menu on any mousedown outside it
  document.addEventListener('mousedown', function (e) {
    if (contextMenuEl && !contextMenuEl.contains(e.target)) closeContextMenu();
  }, true);
  render();
})();
