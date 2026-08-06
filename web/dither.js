/* ============================================================
   dither.js — Algorithmes de tramage noir & blanc
   Matrices et noyaux portés depuis ditherpunk
   (unoriginal02.github.io/ditherpunk, worker.js — constantes
   numériques publiées : Floyd–Steinberg 1976, Bayer 1973,
   Jarvis-Judice-Ninke 1976, Stucki 1981, Atkinson, Sierra).
   Réécriture mono-canal 1bpp — pas de copie de la logique
   couleur/objet {r,g,b} par pixel de la source.
   Script classique (pas de module ES — bloqué en file://)
   ============================================================ */

// ─────────────────────────────────────────────────────────────
// MATRICES DE TRAMAGE ORDONNÉ
// ─────────────────────────────────────────────────────────────
var BAYER2 = [
  [ 0,  2],
  [ 3,  1]
];

var BAYER4 = [
  [ 0,  8,  2, 10],
  [12,  4, 14,  6],
  [ 3, 11,  1,  9],
  [15,  7, 13,  5]
];

var BAYER8 = [
  [ 0, 32,  8, 40,  2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44,  4, 36, 14, 46,  6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [ 3, 35, 11, 43,  1, 33,  9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47,  7, 39, 13, 45,  5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21]
];

// Bayer 16×16 (le fichier source l'appelle « void-and-cluster » mais c'est
// exactement la construction récursive de Bayer — vérifié numériquement,
// identique bit à bit à bayer(16) avec quadrants [[0,2],[3,1]])
var BAYER16 = [
  [  0,128, 32,160,  8,136, 40,168,  2,130, 34,162, 10,138, 42,170],
  [ 64,192, 96,224, 72,200,104,232, 66,194, 98,226, 74,202,106,234],
  [ 16,144, 48,176, 24,152, 56,184, 18,146, 50,178, 26,154, 58,186],
  [ 80,208,112,240, 88,216,120,248, 82,210,114,242, 90,218,122,250],
  [  4,132, 36,164, 12,140, 44,172,  6,134, 38,166, 14,142, 46,174],
  [ 68,196,100,228, 76,204,108,236, 70,198,102,230, 78,206,110,238],
  [ 20,148, 52,180, 28,156, 60,188, 22,150, 54,182, 30,158, 62,190],
  [ 84,212,116,244, 92,220,124,252, 86,214,118,246, 94,222,126,254],
  [  1,129, 33,161,  9,137, 41,169,  3,131, 35,163, 11,139, 43,171],
  [ 65,193, 97,225, 73,201,105,233, 67,195, 99,227, 75,203,107,235],
  [ 17,145, 49,177, 25,153, 57,185, 19,147, 51,179, 27,155, 59,187],
  [ 81,209,113,241, 89,217,121,249, 83,211,115,243, 91,219,123,251],
  [  5,133, 37,165, 13,141, 45,173,  7,135, 39,167, 15,143, 47,175],
  [ 69,197,101,229, 77,205,109,237, 71,199,103,231, 79,207,111,239],
  [ 21,149, 53,181, 29,157, 61,189, 23,151, 55,183, 31,159, 63,191],
  [ 85,213,117,245, 93,221,125,253, 87,215,119,247, 95,223,127,255]
];

// Halton 64×64 (le fichier source l'appelle « blue noise » mais c'est une
// séquence de Halton base-2/base-3 résolue par sondage linéaire — vérifié,
// aucune propriété spectrale de bruit bleu). Auto-générée, aucun fichier
// externe requis.
var HALTON64 = (function() {
  var size = 64, n = size * size;
  function halton(i, b) {
    var f = 1, r = 0;
    for (; i > 0; i = Math.floor(i / b)) { f /= b; r += f * (i % b); }
    return r;
  }
  var flat = new Int16Array(n).fill(-1);
  for (var i = 0; i < n; i++) {
    var idx = Math.floor(halton(i, 2) * size) + Math.floor(halton(i, 3) * size) * size;
    while (flat[idx] !== -1) idx = (idx + 1) % n;
    flat[idx] = i;
  }
  var m = [];
  for (var y = 0; y < size; y++) {
    m[y] = [];
    for (var x = 0; x < size; x++) m[y][x] = flat[y * size + x];
  }
  return m;
})();

// ─────────────────────────────────────────────────────────────
// NOYAUX DE DIFFUSION D'ERREUR — [dx, dy, poids]
// ─────────────────────────────────────────────────────────────
var KERNELS = {
  'floyd-steinberg': {
    divisor: 16,
    offsets: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]]
  },
  'stucki': {
    divisor: 42,
    offsets: [
      [1, 0, 8], [2, 0, 4],
      [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
      [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]
    ]
  },
  'atkinson': {
    divisor: 8, // 6 poids de 1 → 2/8 de l'erreur volontairement perdue (contraste préservé)
    offsets: [
      [1, 0, 1], [2, 0, 1],
      [-1, 1, 1], [0, 1, 1], [1, 1, 1],
      [0, 2, 1]
    ]
  },
  'jjn': {
    divisor: 48,
    offsets: [
      [1, 0, 7], [2, 0, 5],
      [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
      [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]
    ]
  },
  'burkes': {
    divisor: 32,
    offsets: [
      [1, 0, 8], [2, 0, 4],
      [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]
    ]
  },
  'sierra': {
    divisor: 32,
    offsets: [
      [1, 0, 5], [2, 0, 3],
      [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2],
      [-1, 2, 2], [0, 2, 3], [1, 2, 2]
    ]
  },
  'sierra2': {
    divisor: 16,
    offsets: [
      [1, 0, 4], [2, 0, 3],
      [-2, 1, 1], [-1, 1, 2], [0, 1, 3], [1, 1, 2], [2, 1, 1]
    ]
  },
  'sierra-lite': {
    divisor: 4,
    offsets: [
      [1, 0, 2],
      [-1, 1, 1], [0, 1, 1]
    ]
  }
};

// ─────────────────────────────────────────────────────────────
// REGISTRE DES ALGORITHMES — pilote le <select> et les lignes
// de réglage conditionnelles (kind → syncAlgoRows dans app.js)
// ─────────────────────────────────────────────────────────────
var DITHER_ALGOS = {
  'threshold':       { label: 'Seuil simple',           group: 'Simple',    kind: 'threshold' },

  'floyd-steinberg': { label: 'Floyd-Steinberg',        group: 'Diffusion', kind: 'diffusion', kernel: 'floyd-steinberg' },
  'stucki':          { label: 'Stucki',                 group: 'Diffusion', kind: 'diffusion', kernel: 'stucki' },
  'atkinson':        { label: 'Atkinson',                group: 'Diffusion', kind: 'diffusion', kernel: 'atkinson' },
  'jjn':             { label: 'Jarvis-Judice-Ninke',    group: 'Diffusion', kind: 'diffusion', kernel: 'jjn' },
  'burkes':          { label: 'Burkes',                 group: 'Diffusion', kind: 'diffusion', kernel: 'burkes' },
  'sierra':          { label: 'Sierra',                 group: 'Diffusion', kind: 'diffusion', kernel: 'sierra' },
  'sierra2':         { label: 'Sierra Two-Row',         group: 'Diffusion', kind: 'diffusion', kernel: 'sierra2' },
  'sierra-lite':     { label: 'Sierra Lite',            group: 'Diffusion', kind: 'diffusion', kernel: 'sierra-lite' },

  'bayer2':          { label: 'Bayer 2×2',              group: 'Ordonné',   kind: 'ordered', matrix: 'BAYER2',  matSize: 2 },
  'bayer4':          { label: 'Bayer 4×4',              group: 'Ordonné',   kind: 'ordered', matrix: 'BAYER4',  matSize: 4 },
  'bayer8':          { label: 'Bayer 8×8',              group: 'Ordonné',   kind: 'ordered', matrix: 'BAYER8',  matSize: 8 },
  'bayer16':         { label: 'Bayer 16×16',            group: 'Ordonné',   kind: 'ordered', matrix: 'BAYER16', matSize: 16 },
  'halton64':        { label: 'Halton 64×64',           group: 'Ordonné',   kind: 'ordered', matrix: 'HALTON64', matSize: 64 },

  'halftone':        { label: 'Similigravure',          group: 'Ordonné',   kind: 'halftone' }
};

var DITHER_MATRICES = { BAYER2: BAYER2, BAYER4: BAYER4, BAYER8: BAYER8, BAYER16: BAYER16, HALTON64: HALTON64 };

// Ordre d'affichage dans le <select>, groupé par famille
var DITHER_ORDER = [
  'threshold',
  'floyd-steinberg', 'stucki', 'atkinson', 'jjn', 'burkes', 'sierra', 'sierra2', 'sierra-lite',
  'bayer2', 'bayer4', 'bayer8', 'bayer16', 'halton64', 'halftone'
];

// ─────────────────────────────────────────────────────────────
// PIPELINE — RGBA → luminance → pixelisation → tonalité →
//            décalage de seuil → tramage → packing 1bpp
// ─────────────────────────────────────────────────────────────

// Luminance Rec.601 (cohérent avec l'ancien packBitmap et tp6s_tool.py)
function toLuminance(rgbaData, width, height) {
  var lum = new Float32Array(width * height);
  for (var i = 0; i < width * height; i++) {
    lum[i] = 0.299 * rgbaData[i * 4] + 0.587 * rgbaData[i * 4 + 1] + 0.114 * rgbaData[i * 4 + 2];
  }
  return lum;
}

// Réduction par moyenne de bloc bs×bs → { lum, width, height }. bs=1 = no-op.
function pixelateDown(lum, width, height, bs) {
  if (bs <= 1) return { lum: lum, width: width, height: height };
  var dw = Math.ceil(width / bs), dh = Math.ceil(height / bs);
  var out = new Float32Array(dw * dh);
  for (var dy = 0; dy < dh; dy++) {
    for (var dx = 0; dx < dw; dx++) {
      var x0 = dx * bs, y0 = dy * bs;
      var x1 = Math.min(x0 + bs, width), y1 = Math.min(y0 + bs, height);
      var sum = 0, count = 0;
      for (var y = y0; y < y1; y++) {
        for (var x = x0; x < x1; x++) { sum += lum[y * width + x]; count++; }
      }
      out[dy * dw + dx] = sum / count;
    }
  }
  return { lum: out, width: dw, height: dh };
}

// Courbe tonale (article ditherpunk) : bias=0.5 neutre, <0.5 assombrit, >0.5 éclaircit
function applyBias(lum, bias) {
  if (bias === 0.5) return; // neutre, no-op
  var exponent = Math.log(bias) / Math.log(0.5);
  for (var i = 0; i < lum.length; i++) {
    lum[i] = 255 * Math.pow(Math.max(0, Math.min(255, lum[i])) / 255, exponent);
  }
}

// Décalage de seuil en amont : équivalent à comparer contre `threshold` au
// lieu de 128 pour TOUS les algorithmes (seuil simple : lum+128-t < 128 ⟺ lum < t).
// Ne clampe PAS le buffer ici — la diffusion d'erreur a besoin des valeurs
// hors [0,255] pour accumuler correctement ; le clamp se fait à la décision.
function applyThresholdShift(lum, threshold) {
  var shift = 128 - threshold;
  if (shift === 0) return;
  for (var i = 0; i < lum.length; i++) lum[i] += shift;
}

// Écrit un pixel binaire (isBlack) dans le buffer 1bpp packé, en répliquant
// sur un bloc bs×bs (fusion du upscale + packing — pas de RGBA intermédiaire)
function writeBlock(result, bpl, fullW, fullH, bx, by, bs, isBlack) {
  if (!isBlack) return; // le buffer est déjà à 0 (blanc)
  var x0 = bx * bs, y0 = by * bs;
  var x1 = Math.min(x0 + bs, fullW), y1 = Math.min(y0 + bs, fullH);
  for (var y = y0; y < y1; y++) {
    var row = y * bpl;
    for (var x = x0; x < x1; x++) {
      result[row + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
}

// Seuil simple / diffusion d'erreur / ordonné / similigravure sur la grille
// (éventuellement réduite par pixelisation), écriture directe en 1bpp plein format.
function ditherGrid(lum, gw, gh, fullW, fullH, bs, opts) {
  var bpl = Math.ceil(fullW / 8);
  var result = new Uint8Array(bpl * fullH);
  var algo = DITHER_ALGOS[opts.algo] || DITHER_ALGOS['floyd-steinberg'];

  if (algo.kind === 'threshold') {
    for (var y = 0; y < gh; y++) {
      for (var x = 0; x < gw; x++) {
        var isBlack = lum[y * gw + x] < 128;
        writeBlock(result, bpl, fullW, fullH, x, y, bs, isBlack);
      }
    }

  } else if (algo.kind === 'diffusion') {
    var kernel = KERNELS[algo.kernel];
    var offsets = kernel.offsets, divisor = kernel.divisor;
    var serpentine = !!opts.serpentine;
    for (var y = 0; y < gh; y++) {
      var leftToRight = !serpentine || (y % 2 === 0);
      var xStart = leftToRight ? 0 : gw - 1;
      var xEnd   = leftToRight ? gw : -1;
      var xStep  = leftToRight ? 1 : -1;
      for (var x = xStart; x !== xEnd; x += xStep) {
        var idx = y * gw + x;
        var val = Math.max(0, Math.min(255, lum[idx])); // clamp à la décision seulement
        var isBlack = val < 128;
        var newVal = isBlack ? 0 : 255;
        var err = val - newVal;
        for (var k = 0; k < offsets.length; k++) {
          var dx = leftToRight ? offsets[k][0] : -offsets[k][0];
          var dy = offsets[k][1], w = offsets[k][2];
          var nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
          lum[ny * gw + nx] += err * w / divisor;
        }
        writeBlock(result, bpl, fullW, fullH, x, y, bs, isBlack);
      }
    }

  } else if (algo.kind === 'ordered') {
    var matrix = DITHER_MATRICES[algo.matrix];
    var matSize = algo.matSize;
    var matMax = matSize * matSize;
    for (var y = 0; y < gh; y++) {
      for (var x = 0; x < gw; x++) {
        var val = Math.max(0, Math.min(255, lum[y * gw + x])); // clamp après décalage
        var thr = (matrix[y % matSize][x % matSize] + 0.5) * 255 / matMax;
        writeBlock(result, bpl, fullW, fullH, x, y, bs, val < thr);
      }
    }

  } else { // halftone (similigravure)
    var cell = Math.max(2, opts.cell || 8);
    for (var y = 0; y < gh; y++) {
      for (var x = 0; x < gw; x++) {
        var val = Math.max(0, Math.min(255, lum[y * gw + x]));
        var cx = (Math.floor(x / cell) + 0.5) * cell;
        var cy = (Math.floor(y / cell) + 0.5) * cell;
        var distDot = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
        var maxRadius = (cell / 2) * Math.SQRT2;
        var radius = (1 - val / 255) * maxRadius;
        writeBlock(result, bpl, fullW, fullH, x, y, bs, distDot <= radius);
      }
    }
  }

  return result;
}

// Point d'entrée public : RGBA → Uint8Array 1bpp (bit=1 = encre, MSB-first)
// opts = { algo, threshold, pixel, bias, serpentine, cell }
function ditherToBits(rgbaData, width, height, opts) {
  opts = opts || {};
  var threshold  = (opts.threshold != null) ? opts.threshold : 128;
  var pixel      = (opts.pixel != null) ? opts.pixel : 1;
  var bias       = (opts.bias != null) ? opts.bias : 0.5;

  var lum = toLuminance(rgbaData, width, height);
  var grid = pixelateDown(lum, width, height, pixel);
  applyBias(grid.lum, bias);
  applyThresholdShift(grid.lum, threshold);
  return ditherGrid(grid.lum, grid.width, grid.height, width, height, pixel, opts);
}
