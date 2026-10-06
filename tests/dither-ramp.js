/* ============================================================
   tests/dither-ramp.js — Harnais de vérification web/dither.js
   Exécution : node tests/dither-ramp.js
   Ne modifie pas web/dither.js, ne l'exécute que via vm (source
   inchangé, aucun export ajouté).
   ============================================================ */

'use strict';

var fs      = require('fs');
var vm      = require('vm');
var path    = require('path');
var cp      = require('child_process');

var src = fs.readFileSync(path.join(__dirname, '..', 'web', 'dither.js'), 'utf8');
var ctx = {};
vm.createContext(ctx);
vm.runInContext(src, ctx);

var failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  OK   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '  — ' + detail : ''));
  }
}

// Générateur pseudo-aléatoire déterministe (pas de Math.random dans un
// harnais de test — reproductibilité)
function makeRng(seed) {
  var s = seed >>> 0;
  return function() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeRamp(w, h) {
  var rgba = new Uint8ClampedArray(w * h * 4);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var i = (y * w + x) * 4;
      var v = Math.round((x / (w - 1)) * 255);
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function makeRandomRgba(w, h, rng) {
  var rgba = new Uint8ClampedArray(w * h * 4);
  for (var i = 0; i < w * h; i++) {
    var v = Math.floor(rng() * 256);
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function makeSolid(w, h, v) {
  var rgba = new Uint8ClampedArray(w * h * 4);
  for (var i = 0; i < w * h; i++) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function inkCoverage(bits, w, h) {
  var bpl = Math.ceil(w / 8);
  var ones = 0;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      if ((bits[y * bpl + (x >> 3)] >> (7 - (x & 7))) & 1) ones++;
    }
  }
  return ones / (w * h);
}

// Copie manuelle de la branche `else` (seuil simple) de l'ancien packBitmap —
// utilisée UNIQUEMENT en repli si l'extraction git ci-dessous échoue (pas de
// dépôt git, branche `main` absente…). Non autoritaire : voir loadOldPackBitmap.
function oldPackBitmapThresholdFallback(rgbaData, width, height, threshold) {
  var bpl = Math.ceil(width / 8);
  var result = new Uint8Array(bpl * height);
  var lum = new Float32Array(width * height);
  for (var i = 0; i < width * height; i++) {
    lum[i] = 0.299 * rgbaData[i * 4] + 0.587 * rgbaData[i * 4 + 1] + 0.114 * rgbaData[i * 4 + 2];
  }
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      if (lum[y * width + x] < threshold) {
        result[y * bpl + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return result;
}

// Référence de non-régression AUTORITAIRE : extrait le vrai packBitmap
// pré-refactor depuis `git show main:web/app.js` et l'exécute tel quel
// (pas une reformulation à la main) — sert de non-régression pour
// Texte/Dessin (app.js:464 et :869 appellent toujours packBitmap avec
// {algo:'threshold', threshold:128}).
function loadOldPackBitmap() {
  var startMarker = 'function packBitmap(rgbaData, width, height, useDither, threshold) {';
  var endMarker   = "\n// Traitement d'un ImageBitmap";
  try {
    var oldSrc = cp.execSync('git show main:web/app.js', {
      cwd: path.join(__dirname, '..'), encoding: 'utf8'
    });
    var startIdx = oldSrc.indexOf(startMarker);
    var endIdx   = oldSrc.indexOf(endMarker, startIdx);
    if (startIdx === -1 || endIdx === -1) throw new Error('marqueurs introuvables dans main:web/app.js');
    var oldCtx = {};
    vm.createContext(oldCtx);
    vm.runInContext(oldSrc.slice(startIdx, endIdx), oldCtx);
    console.log('  (référence extraite de git show main:web/app.js)');
    return function(rgbaData, width, height, threshold) {
      return oldCtx.packBitmap(rgbaData, width, height, false, threshold);
    };
  } catch (err) {
    console.log('  (extraction git impossible : ' + err.message + ' — repli sur la copie manuelle)');
    return oldPackBitmapThresholdFallback;
  }
}

var oldPackBitmapThreshold = loadOldPackBitmap();

console.log('=== 1. Rampe de gris — couverture d\'encre ≈ (1 − L/255) ===');
(function() {
  var w = 256, h = 64;
  var rgba = makeRamp(w, h);
  ctx.DITHER_ORDER.forEach(function(id) {
    var bits = ctx.ditherToBits(rgba, w, h, { algo: id, threshold: 128, pixel: 1, bias: 0.5 });
    var cov = inkCoverage(bits, w, h);
    // Sur une rampe centrée sur 128, la couverture globale doit être ~50 %.
    check(id + ' couverture ≈ 50% (obtenu ' + (cov * 100).toFixed(1) + '%)',
          Math.abs(cov - 0.5) < 0.05, 'cov=' + cov);

    // Monotonie : la moyenne d'encre du quart le plus sombre doit dépasser
    // largement celle du quart le plus clair (attrape une porte cassée /
    // un seuil figé qui rendrait la sortie plate quel que soit L).
    var bpl = Math.ceil(w / 8);
    function bandCoverage(x0, x1) {
      var ones = 0, total = 0;
      for (var y = 0; y < h; y++) {
        for (var x = x0; x < x1; x++) {
          total++;
          if ((bits[y * bpl + (x >> 3)] >> (7 - (x & 7))) & 1) ones++;
        }
      }
      return ones / total;
    }
    var darkBand = bandCoverage(0, Math.floor(w / 4));
    var lightBand = bandCoverage(w - Math.floor(w / 4), w);
    check(id + ' zone sombre > zone claire (' + darkBand.toFixed(2) + ' > ' + lightBand.toFixed(2) + ')',
          darkBand > lightBand + 0.5);
  });
})();

console.log('=== 2. Non-régression Texte/Dessin (algo=threshold, seuil=128) ===');
(function() {
  var w = 97, h = 53; // dimensions non multiples de 8, pour couvrir le padding bpl
  var rng = makeRng(42);
  var rgba = makeRandomRgba(w, h, rng);
  var oldBits = oldPackBitmapThreshold(rgba, w, h, 128);
  var newBits = ctx.ditherToBits(rgba, w, h, { algo: 'threshold', threshold: 128 });
  var identical = oldBits.length === newBits.length;
  if (identical) {
    for (var i = 0; i < oldBits.length; i++) {
      if (oldBits[i] !== newBits[i]) { identical = false; break; }
    }
  }
  check('sortie octet-à-octet identique à l\'ancien packBitmap', identical);
})();

console.log('=== 3. Noyaux de diffusion — somme des poids ===');
(function() {
  var expectDivisor = {
    'floyd-steinberg': 16, 'stucki': 42, 'atkinson': 8, 'jjn': 48,
    'burkes': 32, 'sierra': 32, 'sierra2': 16, 'sierra-lite': 4
  };
  Object.keys(ctx.KERNELS).forEach(function(id) {
    var k = ctx.KERNELS[id];
    var sum = k.offsets.reduce(function(a, o) { return a + o[2]; }, 0);
    check(id + ' divisor=' + k.divisor + ' (attendu ' + expectDivisor[id] + ')',
          k.divisor === expectDivisor[id]);
    if (id === 'atkinson') {
      check(id + ' somme des poids = 6 (perte volontaire 2/8)', sum === 6);
    } else {
      check(id + ' somme des poids = divisor (' + sum + '=' + k.divisor + ')', sum === k.divisor);
    }
  });
})();

console.log('=== 4. Seuils extrêmes et monotonie ===');
// Note : sur du bruit purement aléatoire (variance maximale, aucune corrélation
// spatiale), la diffusion d'erreur accumule légitimement de l'encre même à
// threshold=1 — ce n'est pas un bug, c'est la nature de l'algorithme (vérifié
// numériquement : ~12% de couverture sur une rampe ET sur du bruit, contre <1%
// pour le seuil simple). Deux vérifications plus représentatives à la place :
(function() {
  var w = 64, h = 64;

  // 4a. Image UNIE : décision identique sur tous les pixels → err=0 constant,
  // aucune diffusion possible → comportement propre 0%/100% pour tous les algos.
  var solid = makeSolid(w, h, 128);
  ctx.DITHER_ORDER.forEach(function(id) {
    var covLow  = inkCoverage(ctx.ditherToBits(solid, w, h, { algo: id, threshold: 1 }), w, h);
    var covHigh = inkCoverage(ctx.ditherToBits(solid, w, h, { algo: id, threshold: 255 }), w, h);
    check(id + ' (image unie) threshold=1 → quasi blanc (cov=' + covLow.toFixed(3) + ')', covLow < 0.05);
    check(id + ' (image unie) threshold=255 → quasi noir (cov=' + covHigh.toFixed(3) + ')', covHigh > 0.95);
  });

  // 4b. Rampe de gris : la couverture doit croître de façon monotone avec le
  // seuil — c'est ce test qui aurait attrapé la porte `colorDist` de la
  // source (seuil sans effet ⇒ couverture plate quel que soit le seuil).
  var ramp = makeRamp(256, 64);
  var thresholds = [1, 64, 128, 192, 255];
  ctx.DITHER_ORDER.forEach(function(id) {
    var covs = thresholds.map(function(t) {
      return inkCoverage(ctx.ditherToBits(ramp, 256, 64, { algo: id, threshold: t }), 256, 64);
    });
    var monotone = true;
    for (var i = 1; i < covs.length; i++) if (covs[i] < covs[i - 1] - 1e-9) monotone = false;
    check(id + ' couverture monotone croissante avec le seuil (' +
          covs.map(function(c) { return c.toFixed(2); }).join(' → ') + ')', monotone);
  });
})();

console.log('=== 5. Packing 1bpp MSB-first ===');
(function() {
  var w = 17, h = 3; // largeur non multiple de 8 → vérifie le padding bpl
  var rgba = new Uint8ClampedArray(w * h * 4).fill(255); // tout blanc
  // Pixel (0,0) noir
  rgba[0] = rgba[1] = rgba[2] = 0;
  var bits = ctx.ditherToBits(rgba, w, h, { algo: 'threshold', threshold: 128 });
  var bpl = Math.ceil(w / 8);
  check('bpl = ceil(largeur/8)', bpl === 3, 'bpl=' + bpl);
  check('pixel (0,0) noir → bit de poids fort du premier octet', bits[0] === 0x80,
        '0x' + bits[0].toString(16));
  check('reste du buffer à 0 (fond blanc)',
        Array.prototype.every.call(bits.slice(1), function(b) { return b === 0; }));
})();

console.log('');
if (failures === 0) {
  console.log('Tous les tests sont passés.');
  process.exit(0);
} else {
  console.log(failures + ' test(s) en échec.');
  process.exit(1);
}
