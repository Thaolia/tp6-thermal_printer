/* ============================================================
   app.js — TP6-S Web Tool
   Port de tp6s_tool.py (bleak → Web Bluetooth, PIL → Canvas)
   Script classique (pas de module ES — bloqué en file://)
   ============================================================ */

// ─────────────────────────────────────────────────────────────
// CONSTANTES  (tp6s_tool.py : 47-57)
// ─────────────────────────────────────────────────────────────
var CMD_PRINT_IMAGE = 0x00;
var CMD_FEED        = 0x02;
var CMD_SET_DENSITY = 0x04;
var CMD_SET_SPEED   = 0x0A;
var CMD_BLE_TOKENS  = 0x80;

var PRINT_W        = 576;
var BPL            = 72;
var MAX_CHUNK_LINES = 8;
// Chrome/Windows plafonne à 20 o utiles (ATT MTU = 23, sans négociation Web BT)
// Le firmware TP6-S réassemble les trames CUS via le champ LEN → chunk size = transport only
var BLE_CHUNK_SZ   = 20;
var INTER_CHUNK_MS = 4;   // flow control assuré par l'ACK par trame dans doPrint

// ─────────────────────────────────────────────────────────────
// UTILITAIRES
// ─────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function hexStr(arr) {
  return Array.from(arr).map(function(b) {
    return b.toString(16).padStart(2, '0').toUpperCase();
  }).join(' ');
}

// ─────────────────────────────────────────────────────────────
// PROTOCOLE CUS  (tp6s_tool.py : 66-80)
// ─────────────────────────────────────────────────────────────
var _seq = 0;

function makeFrame(cmd, payload) {
  if (!payload) payload = new Uint8Array(0);
  var n = payload.length;
  var frame = new Uint8Array(n + 10); // pré-alloué hors boucle
  frame[0] = 0x64;
  frame[1] = cmd;
  frame[2] = _seq & 0x3F;
  _seq = (_seq + 1) & 0x3F;
  frame[3] = n & 0xFF;
  frame[4] = (n >> 8) & 0xFF;
  if (n) frame.set(payload, 5);
  // octets [5+n .. 8+n] = checksum TX = 0x00 (déjà nuls)
  frame[n + 9] = 0x9B;
  return frame;
}

// Port de _ack_decode (tp6s_tool.py : 317-333)
function ackDecode(raw) {
  if (raw.length < 10) return 'trop court (' + raw.length + 'B)';
  if (raw[0] !== 0x64) return 'magic invalide 0x' + raw[0].toString(16).padStart(2,'0').toUpperCase();
  var cmd = raw[1];
  var n   = raw[3] | (raw[4] << 8);
  var pay = raw.slice(5, 5 + n);
  var parts = ['CMD=0x' + cmd.toString(16).padStart(2,'0').toUpperCase()];
  if (pay.length) {
    parts.push('pay=[' + hexStr(pay) + ']');
    if (cmd === 0xFF && pay.length >= 3)
      parts.push('echo=0x' + pay[2].toString(16).padStart(2,'0').toUpperCase());
    if (pay.length >= 1)
      parts.push('status=0x' + pay[0].toString(16).padStart(2,'0').toUpperCase());
  }
  return parts.join('  ');
}

// ─────────────────────────────────────────────────────────────
// ACK QUEUE  (remplace asyncio.Queue + wait_for)
// ─────────────────────────────────────────────────────────────
function AckQueue() {
  this._buf = [];
  this._res = [];
}
AckQueue.prototype.push = function(data) {
  if (this._res.length) { this._res.shift()(data); }
  else { this._buf.push(data); }
};
AckQueue.prototype.get = function(ms) {
  var self = this;
  return new Promise(function(resolve, reject) {
    if (self._buf.length) { resolve(self._buf.shift()); return; }
    var id = setTimeout(function() {
      var i = self._res.indexOf(fn);
      if (i >= 0) self._res.splice(i, 1);
      reject(new Error('timeout'));
    }, ms);
    var fn = function(v) { clearTimeout(id); resolve(v); };
    self._res.push(fn);
  });
};
AckQueue.prototype.clear = function() { this._buf = []; this._res = []; };

// ─────────────────────────────────────────────────────────────
// ÉTAT BLE
// ─────────────────────────────────────────────────────────────
var bleDevice   = null;
var gattServer  = null;
var gattWrite   = null;
var gattNotify  = null;
var ackQueue    = new AckQueue();
var isConnected = false;
var isPrinting  = false;
var uartHexMode = true;

// Connexion BLE — filtre sur namePrefix "TP6-S" (règle : filtrer par nom, pas UUID)
async function connect() {
  if (!navigator.bluetooth) {
    document.getElementById('no-ble').hidden = false;
    return;
  }
  try {
    bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'TP6-S' }],
      optionalServices: [0xfff0, 0xff00]
    });
    bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
    await connectGatt();
    updateConnUI(true);
    log('Connecté : ' + (bleDevice.name || bleDevice.id));
  } catch (err) {
    if (err.name === 'NotFoundError') { log('Sélection annulée.'); }
    else { log('Erreur connexion : ' + err.message, true); }
  }
}

async function connectGatt() {
  gattServer = await bleDevice.gatt.connect();
  var svc;
  try { svc = await gattServer.getPrimaryService(0xfff0); }
  catch (_) { svc = await gattServer.getPrimaryService(0xff00); }

  try { gattWrite = await svc.getCharacteristic(0xfff2); }
  catch (_) { gattWrite = await svc.getCharacteristic(0xff02); }

  try { gattNotify = await svc.getCharacteristic(0xfff1); }
  catch (_) {
    try { gattNotify = await svc.getCharacteristic(0xff01); }
    catch (_2) { gattNotify = null; }
  }

  if (gattNotify) {
    await gattNotify.startNotifications();
    gattNotify.addEventListener('characteristicvaluechanged', onNotification);
  }
  isConnected = true;
}

function onDisconnected() {
  isConnected = false;
  if (isPrinting) {
    log('Déconnexion BLE pendant impression !', true);
    return;
  }
  updateConnUI(false);
  log('Déconnexion BLE, reconnexion…');
  sleep(600).then(function() {
    return connectGatt();
  }).then(function() {
    updateConnUI(true);
    log('Reconnecté.');
  }).catch(function(err) {
    log('Reconnexion échouée : ' + err.message, true);
  });
}

function disconnect() {
  if (bleDevice && bleDevice.gatt.connected) bleDevice.gatt.disconnect();
  gattWrite = null; gattNotify = null; isConnected = false;
  updateConnUI(false);
  log('Déconnecté.');
}

function onNotification(event) {
  var data = new Uint8Array(event.target.value.buffer);
  ackQueue.push(data);
  // Affichage UART (toujours, même hors onglet UART — utile pour le debug)
  if (uartHexMode) {
    uartAppend('<< ' + hexStr(data));
  } else {
    var ascii = Array.from(data).map(function(b) {
      return (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.';
    }).join('');
    uartAppend('<< [' + data.length + 'B] ' + ascii);
  }
}

// ─────────────────────────────────────────────────────────────
// ENVOI BLE  (tp6s_tool.py : _send 83-89)
// ─────────────────────────────────────────────────────────────

// Helper centralisé — remplace les boucles de chunking dupliquées.
// Fallback adaptatif : sur erreur GATT, divise BLE_CHUNK_SZ par 2 (plancher 20)
// et rejoue le même chunk (sûr car throw = 0 octet livré, pas de corruption CUS).
async function bleWrite(data) {
  if (!gattWrite) throw new Error('Non connecté au périphérique BLE');
  var off = 0;
  while (off < data.length) {
    var end = Math.min(off + BLE_CHUNK_SZ, data.length);
    try {
      await gattWrite.writeValueWithoutResponse(data.slice(off, end));
      off = end;
      if (off < data.length && INTER_CHUNK_MS > 0) await sleep(INTER_CHUNK_MS);
    } catch (err) {
      if (BLE_CHUNK_SZ > 20) {
        BLE_CHUNK_SZ = Math.max(20, BLE_CHUNK_SZ >> 1);
        log('MTU trop grand — chunk réduit → ' + BLE_CHUNK_SZ + ' o, retry…');
        continue; // rejoue le même chunk avec la nouvelle taille
      }
      throw err; // déjà au plancher de 20 o : remonter l'erreur
    }
  }
}

async function sendFrame(cmd, payload) {
  return bleWrite(makeFrame(cmd, payload));
}

// Alias pour le terminal UART (envoi d'octets bruts)
var sendRaw = bleWrite;

// ─────────────────────────────────────────────────────────────
// PIPELINE D'IMPRESSION  (tp6s_tool.py : _do_print 391-545)
// ─────────────────────────────────────────────────────────────
async function doPrint(data, bpl, height, opts) {
  opts = Object.assign({ density: 10, speed: 3, feed: 85, minHeight: 64, invert: false }, opts);

  if (!gattWrite) throw new Error('Non connecté au périphérique BLE');

  // Diagnostic
  var nonzero = data.reduce(function(s, b) { return s + (b ? 1 : 0); }, 0);
  log('Bitmap : ' + data.length + ' o  ' + bpl + ' o/lig  ' + height + ' lig  actifs=' +
      nonzero + '/' + data.length + ' (' + Math.round(nonzero * 100 / Math.max(data.length, 1)) + '%)');

  if (nonzero === 0 && !opts.invert) {
    log('ATTENTION : bitmap entièrement blanc — rien à imprimer !', true);
    return;
  }

  var printData = data;
  if (opts.invert) {
    printData = new Uint8Array(data.length);
    for (var i = 0; i < data.length; i++) printData[i] = data[i] ^ 0xFF;
  }

  // Padding hauteur minimale (tp6s_tool.py : 409-413)
  var printHeight = height;
  if (height < opts.minHeight) {
    var padded = new Uint8Array(bpl * opts.minHeight);
    padded.set(printData);
    printData  = padded;
    printHeight = opts.minHeight;
    log('Padding : ' + height + ' → ' + printHeight + ' lignes (minimum impression)');
  }

  isPrinting = true;
  setPrintBtnsDisabled(true);
  setProgressVisible(true);

  try {
    ackQueue.clear();

    await sendFrame(CMD_SET_SPEED,   new Uint8Array([Math.max(1, Math.min(5,  opts.speed))]));
    await sleep(150);
    await sendFrame(CMD_SET_DENSITY, new Uint8Array([Math.max(1, Math.min(15, opts.density))]));
    await sleep(150);

    var lpb = MAX_CHUNK_LINES;
    var nb  = Math.ceil(printHeight / lpb);
    log('Vitesse=' + opts.speed + '  Densité=' + opts.density +
        '  ' + printHeight + ' lig  [' + nb + ' trames de ' + lpb + ']');

    for (var y0 = 0, bloc = 0; y0 < printHeight; y0 += lpb, bloc++) {
      var y1      = Math.min(y0 + lpb, printHeight);
      var payload = printData.slice(y0 * bpl, y1 * bpl);
      var frame   = makeFrame(CMD_PRINT_IMAGE, payload);

      if (bloc === 0) {
        var preview = frame.slice(0, Math.min(28, frame.length));
        log('  [frame début] ' + hexStr(preview) + (frame.length > 28 ? '…' : '') +
            ' (' + frame.length + 'B)');
      }

      // Envoi chunké via bleWrite (centralisé, fallback adaptatif)
      await bleWrite(frame);

      // Attente ACK (max 5 s)
      var ackHex = '--';
      try {
        var ack = await ackQueue.get(5000);
        ackHex = ackDecode(ack);
      } catch (_) { ackHex = 'TIMEOUT'; }

      var pct = Math.round(y1 * 100 / printHeight);
      setProgress(pct);
      log('  bloc ' + (bloc + 1) + '/' + nb + '  ' + pct + '%  ACK=' + ackHex);
    }

    // Feed final
    log('Avance papier (' + opts.feed + ' lignes)…');
    await sendFrame(CMD_FEED, new Uint8Array([opts.feed & 0xFF, 0x00]));
    await sleep(1000);
    log('Impression terminée !');
    setProgress(100);

  } finally {
    isPrinting = false;
    setPrintBtnsDisabled(false);
    setTimeout(function() { setProgressVisible(false); }, 2000);
  }
}

// ─────────────────────────────────────────────────────────────
// IMAGERIE — Canvas → 1bpp  (tp6s_tool.py : cmd_print_raster 691)
// ─────────────────────────────────────────────────────────────

// Floyd-Steinberg ou seuil → Uint8Array 1bpp, bit=1 = imprimé (noir)
// Équivalent du XOR 0xFF de tp6s_tool.py:727 (PIL mode '1' inversé)
function packBitmap(rgbaData, width, height, useDither, threshold) {
  var bpl    = Math.ceil(width / 8);
  var result = new Uint8Array(bpl * height); // pré-alloué

  // Extraction luminance
  var lum = new Float32Array(width * height);
  for (var i = 0; i < width * height; i++) {
    lum[i] = 0.299 * rgbaData[i * 4] + 0.587 * rgbaData[i * 4 + 1] + 0.114 * rgbaData[i * 4 + 2];
  }

  if (useDither) {
    // Floyd-Steinberg
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var idx     = y * width + x;
        var isBlack = lum[idx] < 128;
        var newVal  = isBlack ? 0 : 255;
        var err     = lum[idx] - newVal;
        if (x + 1 < width)          lum[y * width + x + 1]           += err * 7 / 16;
        if (y + 1 < height) {
          if (x > 0)                lum[(y + 1) * width + x - 1]     += err * 3 / 16;
                                    lum[(y + 1) * width + x]          += err * 5 / 16;
          if (x + 1 < width)        lum[(y + 1) * width + x + 1]     += err * 1 / 16;
        }
        if (isBlack) result[y * bpl + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  } else {
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        if (lum[y * width + x] < threshold) {
          result[y * bpl + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    }
  }
  return result;
}

// Traitement d'un ImageBitmap → {data, bpl, height}  (tp6s_tool.py : 700-729)
async function processImageBitmap(bitmap, rotDeg, useDither, threshold) {
  // Rotation sur canvas temporaire
  var sw = bitmap.width, sh = bitmap.height;
  if (rotDeg === 90 || rotDeg === 270) { var tmp = sw; sw = sh; sh = tmp; }

  var rotC = document.createElement('canvas');
  rotC.width = sw; rotC.height = sh;
  var rotX = rotC.getContext('2d');
  rotX.translate(sw / 2, sh / 2);
  rotX.rotate(rotDeg * Math.PI / 180);
  rotX.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);

  // Redimensionnement à PRINT_W
  var newH = Math.max(1, Math.round(sh * PRINT_W / sw));
  var wc   = document.createElement('canvas');
  wc.width = PRINT_W; wc.height = newH;
  var wx   = wc.getContext('2d');
  wx.fillStyle = '#ffffff'; // fond blanc pour les PNG transparents
  wx.fillRect(0, 0, PRINT_W, newH);
  wx.drawImage(rotC, 0, 0, PRINT_W, newH);

  var idata = wx.getImageData(0, 0, PRINT_W, newH);
  var packed = packBitmap(idata.data, PRINT_W, newH, useDither, threshold);
  return { data: packed, bpl: BPL, height: newH };
}

// Parser PBM P4 (binaire)  (tp6s_tool.py : cmd_print_pbm 657)
async function parsePbm(file) {
  var buf  = await file.arrayBuffer();
  var view = new Uint8Array(buf);
  var pos  = 0;

  var readLine = function() {
    var s = '';
    while (pos < view.length && view[pos] !== 0x0A) s += String.fromCharCode(view[pos++]);
    pos++;
    return s;
  };

  var magic = readLine();
  if (magic.trim() !== 'P4') throw new Error('Format PBM P4 (binaire) requis — obtenu : ' + magic);

  var sizeLine = readLine();
  while (sizeLine.startsWith('#')) sizeLine = readLine();
  var parts = sizeLine.trim().split(/\s+/);
  var w = parseInt(parts[0]), h = parseInt(parts[1]);
  var bpl = Math.ceil(w / 8);
  var raw = view.slice(pos, pos + bpl * h);

  // Resize à PRINT_W si nécessaire (tp6s_tool.py : 674-685)
  if (w !== PRINT_W) {
    var dst = new Uint8Array(BPL * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < PRINT_W; x++) {
        var sx  = Math.floor(x * w / PRINT_W);
        var sb  = raw[y * bpl + (sx >> 3)];
        var bit = (sb >> (7 - (sx & 7))) & 1;
        if (bit) dst[y * BPL + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return { data: dst, bpl: BPL, height: h };
  }
  return { data: new Uint8Array(raw), bpl: bpl, height: h };
}

// Rendu texte → {data, bpl, height}  (tp6s_tool.py : cmd_print_text 601)
function renderText(text, fontSize) {
  var scale = Math.max(1, Math.floor(fontSize / 8));
  var charH = 8 * scale;
  var cpl   = Math.floor(PRINT_W / charH);

  // Découpage identique au Python
  var rawLines = text.replace(/\r/g, '').split('\n');
  var lines = [];
  for (var i = 0; i < rawLines.length; i++) {
    var raw = rawLines[i];
    if (!raw) { lines.push(''); continue; }
    while (raw.length > cpl) { lines.push(raw.slice(0, cpl)); raw = raw.slice(cpl); }
    lines.push(raw);
  }

  var totalH = lines.length * charH;
  if (totalH === 0) return null;

  var c  = document.createElement('canvas');
  c.width = PRINT_W; c.height = totalH;
  var cx = c.getContext('2d');
  cx.fillStyle = '#ffffff';
  cx.fillRect(0, 0, PRINT_W, totalH);
  cx.fillStyle = '#000000';
  cx.font = charH + 'px monospace';
  cx.textBaseline = 'top';
  for (var li = 0; li < lines.length; li++) {
    cx.fillText(lines[li], 0, li * charH);
  }

  var idata = cx.getImageData(0, 0, PRINT_W, totalH);
  return { data: packBitmap(idata.data, PRINT_W, totalH, false, 128), bpl: BPL, height: totalH };
}

// Génération motifs test  (tp6s_tool.py : cmd_test_print 548)
function buildTestPattern(pattern, bpl, n) {
  var data;
  if (pattern === 'black') {
    data = new Uint8Array(bpl * n).fill(0xFF);
  } else if (pattern === 'white') {
    data = new Uint8Array(bpl * n); // déjà 0x00
  } else { // bars
    data = new Uint8Array(bpl * n);
    for (var y = 0; y < n; y++) {
      if (Math.floor(y / 4) % 2 === 0) {
        data.fill(0xFF, y * bpl, y * bpl + bpl);
      }
    }
  }
  return data;
}

// ─────────────────────────────────────────────────────────────
// AFFICHAGE APERÇU IMAGE (reconstruit 1bpp → canvas visible)
// ─────────────────────────────────────────────────────────────
var imgData = null;

function updateImgPreview() {
  if (!imgData) return;
  var d = imgData.data, bpl = imgData.bpl, h = imgData.height;
  var W = bpl * 8;
  var canvas = document.getElementById('img-preview');
  canvas.width = W; canvas.height = h;
  var cx = canvas.getContext('2d');
  var id = cx.createImageData(W, h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < W; x++) {
      var bit = (d[y * bpl + (x >> 3)] >> (7 - (x & 7))) & 1;
      var v   = bit ? 0 : 255;
      var pi  = (y * W + x) * 4;
      id.data[pi] = id.data[pi+1] = id.data[pi+2] = v;
      id.data[pi+3] = 255;
    }
  }
  cx.putImageData(id, 0, 0);

  var nonzero = Array.from(d).filter(function(b) { return b; }).length;
  document.getElementById('img-info').textContent =
    d.length + ' o  ' + bpl + ' o/lig  ' + h + ' lig  actifs=' +
    nonzero + '/' + d.length + ' (' + Math.round(nonzero * 100 / Math.max(d.length, 1)) + '%)';
}

function updateTxtPreview(tdata) {
  if (!tdata) { document.getElementById('txt-preview').hidden = true; return; }
  var d = tdata.data, bpl = tdata.bpl, h = tdata.height;
  var W = bpl * 8;
  var canvas = document.getElementById('txt-preview');
  canvas.width = W; canvas.height = h;
  canvas.hidden = false;
  var cx = canvas.getContext('2d');
  var id = cx.createImageData(W, h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < W; x++) {
      var bit = (d[y * bpl + (x >> 3)] >> (7 - (x & 7))) & 1;
      var v   = bit ? 0 : 255;
      var pi  = (y * W + x) * 4;
      id.data[pi] = id.data[pi+1] = id.data[pi+2] = v;
      id.data[pi+3] = 255;
    }
  }
  cx.putImageData(id, 0, 0);
}

// ─────────────────────────────────────────────────────────────
// MODAL CONFIRMATION
// ─────────────────────────────────────────────────────────────
function showConfirm(msg, okLabel, cancelLabel) {
  return new Promise(function(resolve) {
    document.getElementById('modal-msg').textContent = msg;
    document.getElementById('modal-ok').textContent     = okLabel     || 'OK';
    document.getElementById('modal-cancel').textContent = cancelLabel || 'Annuler';
    var modal = document.getElementById('modal');
    modal.hidden = false;
    document.getElementById('modal-ok').onclick = function() {
      modal.hidden = true; resolve(true);
    };
    document.getElementById('modal-cancel').onclick = function() {
      modal.hidden = true; resolve(false);
    };
  });
}

function confirmPrint(details) {
  return showConfirm(details, 'Imprimer', 'Annuler');
}

// ─────────────────────────────────────────────────────────────
// LOG / PROGRESS
// ─────────────────────────────────────────────────────────────
var _logOut  = null;
var _progBar = null;
var _progPct = null;
var _progW   = null;

function log(msg, isErr) {
  if (!_logOut) return;
  var line = document.createElement('div');
  line.className = 'log-line' + (isErr ? ' err' : '');
  line.textContent = msg;
  _logOut.appendChild(line);
  _logOut.scrollTop = _logOut.scrollHeight;
}

function uartAppend(msg) {
  var ul = document.getElementById('uart-log');
  ul.textContent += msg + '\n';
  ul.scrollTop = ul.scrollHeight;
}

function setProgress(pct) {
  _progBar.value = pct;
  _progPct.textContent = pct + '%';
}

function setProgressVisible(v) {
  _progW.hidden = !v;
  if (!v) setProgress(0);
}

function setPrintBtnsDisabled(disabled) {
  ['btn-img-print','btn-txt-print','btn-draw-print','btn-test-print'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.disabled = disabled || !isConnected || el.dataset.noContent;
  });
}

function updateConnUI(connected) {
  isConnected = connected;
  document.getElementById('ble-dot').className  = 'dot ' + (connected ? 'on' : 'off');
  document.getElementById('ble-name').textContent = connected ? (bleDevice && bleDevice.name ? bleDevice.name : 'Connecté') : 'Non connecté';
  document.getElementById('btn-connect').hidden    =  connected;
  document.getElementById('btn-disconnect').hidden = !connected;

  var toggle = ['btn-feed','btn-test-print','btn-info','btn-uart-send'];
  toggle.forEach(function(id) { document.getElementById(id).disabled = !connected; });
  document.getElementById('uart-input').disabled = !connected;

  if (connected) {
    if (imgData) document.getElementById('btn-img-print').disabled = false;
    if (txtData)  document.getElementById('btn-txt-print').disabled = false;
    document.getElementById('btn-draw-print').disabled = false;
  } else {
    ['btn-img-print','btn-txt-print','btn-draw-print'].forEach(function(id) {
      document.getElementById(id).disabled = true;
    });
  }
}

// ─────────────────────────────────────────────────────────────
// SLIDERS — mise à jour valeur affichée
// ─────────────────────────────────────────────────────────────
function wireSlider(sid, vid) {
  var s = document.getElementById(sid);
  var v = document.getElementById(vid);
  s.addEventListener('input', function() { v.textContent = s.value; });
}

// ─────────────────────────────────────────────────────────────
// ONGLETS — navigation
// ─────────────────────────────────────────────────────────────
var drawingDirty = false;

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach(function(p) {
    p.hidden = p.id !== 'tab-' + tabId;
  });
}

// ─────────────────────────────────────────────────────────────
// ONGLET IMAGE
// ─────────────────────────────────────────────────────────────
var lastBitmap = null; // ImageBitmap mis en cache pour retraitement
var _threshTimer = null;

function getImgOpts() {
  return {
    rotate:    parseInt(document.getElementById('img-rotate').value) || 0,
    dither:    document.getElementById('img-dither').checked,
    threshold: parseInt(document.getElementById('img-thresh').value),
    density:   parseInt(document.getElementById('img-density').value),
    speed:     parseInt(document.getElementById('img-speed').value),
    feed:      parseInt(document.getElementById('img-feed').value)
  };
}

async function reprocessImg() {
  if (!lastBitmap) return;
  var o = getImgOpts();
  try {
    imgData = await processImageBitmap(lastBitmap, o.rotate, o.dither, o.threshold);
    updateImgPreview();
  } catch (err) { log('Retraitement image : ' + err.message, true); }
}

function initImageTab() {
  wireSlider('img-thresh',  'img-thresh-v');
  wireSlider('img-density', 'img-density-v');
  wireSlider('img-speed',   'img-speed-v');
  wireSlider('img-feed',    'img-feed-v');

  // Masquer le seuil quand Floyd-Steinberg est activé
  var dCheck  = document.getElementById('img-dither');
  var rowThr  = document.getElementById('row-thresh');
  var syncRow = function() { rowThr.style.visibility = dCheck.checked ? 'hidden' : 'visible'; };
  syncRow();
  dCheck.addEventListener('change', function() { syncRow(); reprocessImg(); });

  document.getElementById('img-rotate').addEventListener('change', reprocessImg);

  document.getElementById('img-thresh').addEventListener('input', function() {
    clearTimeout(_threshTimer);
    _threshTimer = setTimeout(reprocessImg, 350);
  });

  document.getElementById('img-file').addEventListener('change', async function(e) {
    var file = e.target.files[0];
    if (!file) return;
    imgData = null; lastBitmap = null;
    document.getElementById('btn-img-print').disabled = true;
    try {
      if (file.name.toLowerCase().endsWith('.pbm')) {
        imgData = await parsePbm(file);
      } else {
        lastBitmap = await createImageBitmap(file);
        var o = getImgOpts();
        imgData = await processImageBitmap(lastBitmap, o.rotate, o.dither, o.threshold);
      }
      updateImgPreview();
      if (isConnected) document.getElementById('btn-img-print').disabled = false;
    } catch (err) { log('Erreur chargement image : ' + err.message, true); }
  });

  document.getElementById('btn-img-print').addEventListener('click', async function() {
    if (!imgData) return;
    var o = getImgOpts();
    var ok = await confirmPrint(
      'Imprimer ' + imgData.height + ' lignes\n' +
      'Densité ' + o.density + '  Vitesse ' + o.speed + '  Feed ' + o.feed + ' lig'
    );
    if (!ok) return;
    try { await doPrint(imgData.data, imgData.bpl, imgData.height, o); }
    catch (err) {
      var hint = err.message.toLowerCase().includes('gatt operation failed')
        ? ' (écriture BLE refusée — rechargez la page et réessayez)' : '';
      log('Erreur impression : ' + err.message + hint, true);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// ONGLET TEXTE
// ─────────────────────────────────────────────────────────────
var txtData = null;
var _txtTimer = null;

function getTxtOpts() {
  return {
    size:    parseInt(document.getElementById('txt-size').value),
    density: parseInt(document.getElementById('txt-density').value),
    speed:   parseInt(document.getElementById('txt-speed').value),
    feed:    parseInt(document.getElementById('txt-feed').value)
  };
}

function refreshTxt() {
  var text = document.getElementById('txt-input').value.trim();
  if (!text) {
    txtData = null;
    document.getElementById('txt-preview').hidden = true;
    document.getElementById('btn-txt-print').disabled = true;
    return;
  }
  var o = getTxtOpts();
  txtData = renderText(text, o.size);
  updateTxtPreview(txtData);
  if (isConnected && txtData) document.getElementById('btn-txt-print').disabled = false;
}

function initTextTab() {
  wireSlider('txt-density', 'txt-density-v');
  wireSlider('txt-speed',   'txt-speed-v');
  wireSlider('txt-feed',    'txt-feed-v');

  document.getElementById('txt-input').addEventListener('input', function() {
    clearTimeout(_txtTimer);
    _txtTimer = setTimeout(refreshTxt, 400);
  });
  document.getElementById('txt-size').addEventListener('change', refreshTxt);

  document.getElementById('btn-txt-print').addEventListener('click', async function() {
    var text = document.getElementById('txt-input').value.trim();
    if (!text) return;
    var o   = getTxtOpts();
    txtData = renderText(text, o.size); // re-rendu au dernier contenu
    if (!txtData) return;
    var ok = await confirmPrint(
      'Imprimer le texte (' + txtData.height + ' lignes)\n' +
      'Densité ' + o.density + '  Vitesse ' + o.speed + '  Feed ' + o.feed + ' lig'
    );
    if (!ok) return;
    try { await doPrint(txtData.data, txtData.bpl, txtData.height, o); }
    catch (err) {
      var hint = err.message.toLowerCase().includes('gatt operation failed')
        ? ' (écriture BLE refusée — rechargez la page et réessayez)' : '';
      log('Erreur impression : ' + err.message + hint, true);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// ONGLET DESSIN
// ─────────────────────────────────────────────────────────────
var drawCanvas = null;
var drawCtx    = null;
var drawing    = false;
var lastX = 0, lastY = 0;

function getDrawPos(e) {
  var r = drawCanvas.getBoundingClientRect();
  return [
    (e.clientX - r.left) * drawCanvas.width  / r.width,
    (e.clientY - r.top)  * drawCanvas.height / r.height
  ];
}

function clearDrawCanvas() {
  drawCtx.fillStyle = '#ffffff';
  drawCtx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);
  drawingDirty = false;
}

function initDrawTab() {
  wireSlider('draw-sz',      'draw-sz-v');
  wireSlider('draw-density', 'draw-density-v');
  wireSlider('draw-speed',   'draw-speed-v');
  wireSlider('draw-feed',    'draw-feed-v');

  drawCanvas = document.getElementById('draw-canvas');
  drawCtx    = drawCanvas.getContext('2d');
  clearDrawCanvas(); // fond blanc initial

  drawCtx.lineCap  = 'round';
  drawCtx.lineJoin = 'round';

  drawCanvas.addEventListener('pointerdown', function(e) {
    drawing = true;
    drawCanvas.setPointerCapture(e.pointerId);
    var pos = getDrawPos(e);
    lastX = pos[0]; lastY = pos[1];
    var sz    = parseInt(document.getElementById('draw-sz').value);
    var color = document.querySelector('input[name="draw-tool"]:checked').value === 'black' ? '#000' : '#fff';
    drawCtx.fillStyle = color;
    drawCtx.beginPath();
    drawCtx.arc(lastX, lastY, sz / 2, 0, Math.PI * 2);
    drawCtx.fill();
    drawingDirty = true;
  });

  drawCanvas.addEventListener('pointermove', function(e) {
    if (!drawing) return;
    var pos   = getDrawPos(e);
    var sz    = parseInt(document.getElementById('draw-sz').value);
    var color = document.querySelector('input[name="draw-tool"]:checked').value === 'black' ? '#000' : '#fff';
    drawCtx.strokeStyle = color;
    drawCtx.lineWidth   = sz;
    drawCtx.beginPath();
    drawCtx.moveTo(lastX, lastY);
    drawCtx.lineTo(pos[0], pos[1]);
    drawCtx.stroke();
    lastX = pos[0]; lastY = pos[1];
    drawingDirty = true;
  });

  drawCanvas.addEventListener('pointerup',     function() { drawing = false; });
  drawCanvas.addEventListener('pointercancel', function() { drawing = false; });

  document.getElementById('btn-draw-clear').addEventListener('click', function() {
    clearDrawCanvas();
  });

  document.getElementById('btn-draw-print').addEventListener('click', async function() {
    var density = parseInt(document.getElementById('draw-density').value);
    var speed   = parseInt(document.getElementById('draw-speed').value);
    var feed    = parseInt(document.getElementById('draw-feed').value);

    var ok = await confirmPrint(
      'Imprimer le dessin (' + drawCanvas.height + ' lignes)\n' +
      'Densité ' + density + '  Vitesse ' + speed + '  Feed ' + feed + ' lig'
    );
    if (!ok) return;

    // Packing depuis le canvas de dessin
    var idata  = drawCtx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
    var packed = packBitmap(idata.data, drawCanvas.width, drawCanvas.height, false, 128);
    try {
      await doPrint(packed, Math.ceil(drawCanvas.width / 8), drawCanvas.height,
                    { density: density, speed: speed, feed: feed, minHeight: 0 });
      drawingDirty = false;
    } catch (err) {
      var hint = err.message.toLowerCase().includes('gatt operation failed')
        ? ' (écriture BLE refusée — rechargez la page et réessayez)' : '';
      log('Erreur impression : ' + err.message + hint, true);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// ONGLET TEST / FEED
// ─────────────────────────────────────────────────────────────
function initTestTab() {
  wireSlider('feed-lines',   'feed-lines-v');
  wireSlider('test-h',       'test-h-v');
  wireSlider('test-density', 'test-density-v');
  wireSlider('test-speed',   'test-speed-v');

  document.getElementById('btn-feed').addEventListener('click', async function() {
    var n = parseInt(document.getElementById('feed-lines').value);
    log('Avance papier (' + n + ' lignes)…');
    try {
      await sendFrame(CMD_FEED, new Uint8Array([n & 0xFF, 0x00]));
      await sleep(800);
      log('Feed OK');
    } catch (err) { log('Erreur feed : ' + err.message, true); }
  });

  document.getElementById('btn-test-print').addEventListener('click', async function() {
    var pattern = document.getElementById('test-pattern').value;
    var bpl     = parseInt(document.getElementById('test-bpl').value);
    var n       = parseInt(document.getElementById('test-h').value);
    var density = parseInt(document.getElementById('test-density').value);
    var speed   = parseInt(document.getElementById('test-speed').value);

    var ok = await confirmPrint(
      'Imprimer motif ' + pattern.toUpperCase() + '\n' +
      bpl + ' o/lig  ' + n + ' lignes  Densité ' + density + '  Vitesse ' + speed
    );
    if (!ok) return;

    var data   = buildTestPattern(pattern, bpl, n);
    var invert = pattern === 'white';
    log('Motif ' + pattern + ' bpl=' + bpl + ' n=' + n);
    try {
      await doPrint(data, bpl, n,
        { density: density, speed: speed, feed: 40, minHeight: 0, invert: invert, force: true });
    } catch (err) {
      var hint = err.message.toLowerCase().includes('gatt operation failed')
        ? ' (écriture BLE refusée — rechargez la page et réessayez)' : '';
      log('Erreur impression : ' + err.message + hint, true);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// ONGLET DIAGNOSTIC / UART  (tp6s_tool.py : cmd_uart 185, cmd_info 159)
// ─────────────────────────────────────────────────────────────
function initUartTab() {
  // Info services GATT
  document.getElementById('btn-info').addEventListener('click', async function() {
    if (!gattServer) { uartAppend('[Non connecté]'); return; }
    uartAppend('--- Services GATT ---');
    try {
      var services = await gattServer.getPrimaryServices();
      for (var i = 0; i < services.length; i++) {
        var svc = services[i];
        var u   = svc.uuid;
        var tag = u.includes('fff0') ? ' <<< SERVICE TP6-S (FFF0)' :
                  u.includes('ff00') ? ' <<< SERVICE TP6-S (FF00)' : '';
        uartAppend('  ' + u + tag);
        var chars = await svc.getCharacteristics();
        for (var j = 0; j < chars.length; j++) {
          var c  = chars[j];
          var cu = c.uuid;
          var ct = cu.includes('fff1') || cu.includes('ff01') ? ' <<< NOTIFY' :
                   cu.includes('fff2') || cu.includes('ff02') ? ' <<< WRITE'  : '';
          var props = charPropsStr(c.properties);
          uartAppend('    ' + cu + '  [' + props + ']' + ct);
        }
      }
    } catch (err) { uartAppend('[Erreur : ' + err.message + ']'); }
  });

  // Terminal
  var uInput = document.getElementById('uart-input');
  document.getElementById('btn-uart-send').addEventListener('click', function() {
    processUartCmd(uInput.value); uInput.value = '';
  });
  uInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { processUartCmd(uInput.value); uInput.value = ''; }
  });
}

function charPropsStr(props) {
  var p = [];
  if (props.broadcast)               p.push('broadcast');
  if (props.read)                    p.push('read');
  if (props.writeWithoutResponse)    p.push('write-without-response');
  if (props.write)                   p.push('write');
  if (props.notify)                  p.push('notify');
  if (props.indicate)                p.push('indicate');
  return p.join(',') || '?';
}

// Traitement des commandes UART (tp6s_tool.py : cmd_uart boucle 235-292)
function processUartCmd(line) {
  line = line.trim();
  if (!line) return;
  uartAppend('> ' + line);

  var parts = line.split(/\s+/);
  var cmd   = parts[0].toLowerCase();

  if (cmd === 'hex') {
    uartHexMode = !uartHexMode;
    uartAppend('[affichage ' + (uartHexMode ? 'hex' : 'ascii') + ']');
    return;
  }

  if (!isConnected || !gattWrite) { uartAppend('[Erreur : non connecté]'); return; }

  if (cmd === 'speed' && parts.length >= 2) {
    var n = Math.max(1, Math.min(5, parseInt(parts[1])));
    var f = makeFrame(CMD_SET_SPEED, new Uint8Array([n]));
    sendRaw(f).then(function() { uartAppend('>> CMD_SET_SPEED=' + n + '  ' + hexStr(f)); })
              .catch(function(e) { uartAppend('[Erreur : ' + e.message + ']'); });

  } else if (cmd === 'density' && parts.length >= 2) {
    var n = Math.max(1, Math.min(15, parseInt(parts[1])));
    var f = makeFrame(CMD_SET_DENSITY, new Uint8Array([n]));
    sendRaw(f).then(function() { uartAppend('>> CMD_SET_DENSITY=' + n + '  ' + hexStr(f)); })
              .catch(function(e) { uartAppend('[Erreur : ' + e.message + ']'); });

  } else if (cmd === 'feed') {
    var n = parts.length >= 2 ? parseInt(parts[1]) : 85;
    var f = makeFrame(CMD_FEED, new Uint8Array([n & 0xFF, 0x00]));
    sendRaw(f).then(function() { uartAppend('>> CMD_FEED=' + n + '  ' + hexStr(f)); })
              .catch(function(e) { uartAppend('[Erreur : ' + e.message + ']'); });

  } else if (cmd === 'cus' && parts.length >= 2) {
    try {
      var cId     = parseInt(parts[1], 16);
      var payload = new Uint8Array(parts.slice(2).map(function(x) { return parseInt(x, 16); }));
      var f       = makeFrame(cId, payload);
      var label   = '>> CUS cmd=0x' + cId.toString(16).padStart(2,'0').toUpperCase() +
                    ' payload=' + payload.length + 'B  ';
      sendRaw(f).then(function() { uartAppend(label + hexStr(f)); })
                .catch(function(e) { uartAppend('[Erreur : ' + e.message + ']'); });
    } catch (e) { uartAppend('[Erreur hex : ' + e.message + ']'); }

  } else {
    // Octets bruts
    try {
      var raw = new Uint8Array(parts.map(function(x) { return parseInt(x, 16); }));
      sendRaw(raw).then(function() { uartAppend('>> RAW ' + raw.length + 'B  ' + hexStr(raw)); })
                  .catch(function(e) { uartAppend('[Erreur : ' + e.message + ']'); });
    } catch (e) { uartAppend('[Commande inconnue : ' + line + ']'); }
  }
}

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {

  // Caches DOM fréquents
  _logOut  = document.getElementById('log-out');
  _progBar = document.getElementById('prog-bar');
  _progPct = document.getElementById('prog-pct');
  _progW   = document.getElementById('prog-wrap');

  // Web Bluetooth absent ?
  if (!navigator.bluetooth) {
    document.getElementById('no-ble').hidden = false;
  }

  // Boutons header
  document.getElementById('btn-connect').addEventListener('click', connect);
  document.getElementById('btn-disconnect').addEventListener('click', disconnect);

  // Effacer log
  document.getElementById('btn-clrlog').addEventListener('click', function() {
    _logOut.innerHTML = '';
  });

  // Navigation onglets (avec confirmation si dessin non imprimé)
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      var targetTab = btn.dataset.tab;
      var activeTab = (document.querySelector('.tab-btn.active') || {}).dataset || {};

      if (activeTab.tab === 'draw' && drawingDirty && targetTab !== 'draw') {
        var ok = await showConfirm(
          'Le dessin en cours n\'a pas été imprimé.\nQuitter l\'onglet Dessin ?',
          'Quitter', 'Rester'
        );
        if (!ok) return;
        drawingDirty = false; // L'utilisateur a explicitement accepté
      }

      switchTab(targetTab);
    });
  });

  // Initialisation de chaque onglet
  initImageTab();
  initTextTab();
  initDrawTab();
  initTestTab();
  initUartTab();

  // Prévient avant de quitter la page si connecté ou impression en cours
  window.addEventListener('beforeunload', function(e) {
    if (isConnected || isPrinting) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  log('TP6-S Web Tool prêt. Cliquez sur "Connecter" pour démarrer.');
  log('Requis : Chrome ou Edge (desktop/Android).');
});
