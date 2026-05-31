#!/usr/bin/env python3
"""
tp6s_tool.py — Outil PC pour imprimante thermique TP6-S via BLE (bleak)

Usage :
  python3.exe tools/tp6s_tool.py scan
  python3.exe tools/tp6s_tool.py info  <addr>
  python3.exe tools/tp6s_tool.py uart  <addr>
  python3.exe tools/tp6s_tool.py test  <addr> [black|bars|white] [--px] [--before HH,HH] [--after HH,HH]
  python3.exe tools/tp6s_tool.py print <addr> "Texte a imprimer"
  python3.exe tools/tp6s_tool.py image <addr> fichier.jpg [--nodither] [--threshold 128] [--rotate 90]
  python3.exe tools/tp6s_tool.py image <addr> fichier.png [--nodither] [--threshold 128]
  python3.exe tools/tp6s_tool.py image <addr> fichier.pbm
  python3.exe tools/tp6s_tool.py feed  <addr>

Installation : python3.exe -mpip install bleak

Mode UART (terminal BLE interactif sur FFF2/FFF1) :
  Commandes disponibles dans le terminal :
    XX XX XX ...        Envoyer des octets bruts (hex, separes par espaces)
    cus CMD [HH HH ...] Envoyer une trame CUS encapsulee (CMD en hex)
    speed N             CMD_SET_SPEED (1-5)
    density N           CMD_SET_DENSITY (1-15)
    feed [N]            Avancer de N lignes (defaut 85)
    hex                 Basculer affichage hex/ascii des notifications
    quit / q            Quitter

  Exemples :
    > cus 02 55 00   -> CMD_FEED 85 lignes
    > cus 09 08      -> CMD_SET_DENSITY a 8
    > cus 0A 03      -> CMD_SET_SPEED a 3

Protocole CUS :
  [0x64][CMD][SEQ_6bit][LEN_LO][LEN_HI][PAYLOAD...][0x00 x4][0x9B]

UUIDs reels TP6-S (detectes par bleak) :
  Service : 0000fff0-0000-1000-8000-00805f9b34fb  (0xFFF0)
  Write   : 0000fff2-0000-1000-8000-00805f9b34fb  (0xFFF2)
  Notify  : 0000fff1-0000-1000-8000-00805f9b34fb  (0xFFF1)
"""

import asyncio
import sys
import struct
from bleak import BleakScanner, BleakClient

CMD_PRINT_IMAGE = 0x00
CMD_FEED        = 0x02
CMD_SET_DENSITY = 0x04
CMD_SET_SPEED   = 0x0A
CMD_BLE_TOKENS  = 0x80

PRINT_W         = 576
BPL             = 72
MAX_CHUNK_LINES = 8
BLE_CHUNK_SZ    = 244
INTER_CHUNK_MS  = 0.020

_seq = 0


# ---------------------------------------------------------------------------
# Protocole CUS
# ---------------------------------------------------------------------------

def _make_frame(cmd, payload=b""):
    global _seq
    n = len(payload)
    frame = bytearray(n + 10)
    frame[0] = 0x64
    frame[1] = cmd
    frame[2] = _seq & 0x3F
    _seq = (_seq + 1) & 0x3F
    frame[3] = n & 0xFF
    frame[4] = (n >> 8) & 0xFF
    if n:
        frame[5:5 + n] = payload
    # octets [5+n .. 8+n] = checksum TX = 0x00000000 (deja nuls)
    frame[n + 9] = 0x9B
    return bytes(frame)


async def _send(client, write_uuid, cmd, payload=b"", chunk_sz=BLE_CHUNK_SZ):
    frame = _make_frame(cmd, payload)
    for off in range(0, len(frame), chunk_sz):
        await client.write_gatt_char(write_uuid, frame[off:off + chunk_sz],
                                     response=False)
        if off + chunk_sz < len(frame):
            await asyncio.sleep(INTER_CHUNK_MS)


async def _check_tokens(client, write_uuid, ack_q, chunk_sz):
    """Flow control BLE : interroge CMD 0x80, attend si buffer imprimante plein."""
    token_frame = _make_frame(CMD_BLE_TOKENS)
    await client.write_gatt_char(write_uuid, token_frame, response=False)
    try:
        resp = await asyncio.wait_for(ack_q.get(), timeout=0.5)
        # Trame RX : [0x64][type][seq][len_lo][len_hi][payload...][checksum x4][0x9B]
        if len(resp) >= 6 and resp[0] == 0x64:
            pl_len = resp[3] | (resp[4] << 8)
            if pl_len > 0 and len(resp) >= 5 + pl_len:
                tokens = resp[5]
                if tokens < chunk_sz:
                    await asyncio.sleep(0.2)
    except asyncio.TimeoutError:
        pass


# ---------------------------------------------------------------------------
# Decouverte des UUIDs reels (cherche FFF0/FFF1/FFF2 ou FF00/FF01/FF02)
# ---------------------------------------------------------------------------

def _find_uuids(client):
    """Cherche les UUIDs write/notify dans tous les services GATT."""
    write_uuid = None
    notif_uuid = None
    svc_uuid   = None

    for svc in client.services:
        u = str(svc.uuid).lower()
        # Service FFF0 (TP6-S reel) ou FF00 (documente)
        if "fff0" in u or "ff00" in u:
            svc_uuid = svc.uuid
            for c in svc.characteristics:
                cu = str(c.uuid).lower()
                props = set(c.properties)
                # Write : FFF2 ou FF02
                if ("fff2" in cu or "ff02" in cu) and props & {"write", "write-without-response"}:
                    write_uuid = c.uuid
                # Notify : FFF1 ou FF01
                elif ("fff1" in cu or "ff01" in cu) and props & {"notify", "indicate"}:
                    notif_uuid = c.uuid

    return svc_uuid, write_uuid, notif_uuid


# ---------------------------------------------------------------------------
# Commandes
# ---------------------------------------------------------------------------

async def cmd_scan():
    print("Scan BLE 10s...")
    devices = await BleakScanner.discover(timeout=10.0, return_adv=True)
    if not devices:
        print("Aucun peripherique trouve.")
        return
    print(f"\n{'Adresse':<20} {'Nom':<28} {'RSSI':>5}  Services")
    print("-" * 80)
    for addr, (dev, adv) in sorted(devices.items(),
                                    key=lambda kv: kv[1][1].rssi, reverse=True):
        name = (dev.name or "?")[:27]
        rssi = adv.rssi
        svcs = [str(u).lower() for u in adv.service_uuids]
        tp6  = " <<< TP6-S" if any(("fff0" in s or "ff00" in s) for s in svcs) else ""
        svc_s = " ".join(s[-8:] for s in svcs[:3])
        print(f"{addr:<20} {name:<28} {rssi:>5}  {svc_s}{tp6}")


async def cmd_info(addr):
    print(f"Connexion a {addr}...")
    async with BleakClient(addr, timeout=10.0) as client:
        print(f"Connecte : {client.is_connected}\n")
        print("Services GATT :")
        for svc in client.services:
            u = str(svc.uuid).lower()
            tag = ""
            if "fff0" in u: tag = " <<< SERVICE TP6-S (FFF0)"
            elif "ff00" in u: tag = " <<< SERVICE TP6-S (FF00)"
            print(f"  {svc.uuid}{tag}")
            for c in svc.characteristics:
                cu = str(c.uuid).lower()
                props = ",".join(c.properties)
                tag2 = ""
                if "fff1" in cu or "ff01" in cu: tag2 = " <<< NOTIFY"
                if "fff2" in cu or "ff02" in cu: tag2 = " <<< WRITE"
                print(f"    {c.uuid}  [{props}]{tag2}")
        print()
        svc_u, w_u, n_u = _find_uuids(client)
        print("Resultat detection automatique :")
        print(f"  Service : {svc_u}")
        print(f"  Write   : {w_u}")
        print(f"  Notify  : {n_u}")


async def cmd_uart(addr):
    """Terminal BLE interactif — envoie sur FFF2, affiche les notifications FFF1."""
    print(f"Connexion a {addr}...")
    loop = asyncio.get_event_loop()
    rx_queue = asyncio.Queue()
    show_hex = [True]

    async with BleakClient(addr, timeout=10.0) as client:
        svc_u, w_u, n_u = _find_uuids(client)
        if w_u is None:
            print("ERREUR : UUID write introuvable (lancez 'info' pour diagnostiquer)")
            return

        print(f"Connecte  Service:{svc_u}")
        print(f"  Write  : {w_u}")
        print(f"  Notify : {n_u}")
        print()
        print("Commandes : XX XX ...  |  cus CMD [HH ...]  |  speed N  |  density N  |  feed [N]  |  hex  |  quit")
        print("-" * 70)

        def _notif_handler(handle, data: bytearray):
            rx_queue.put_nowait(bytes(data))

        if n_u:
            await client.start_notify(n_u, _notif_handler)
            print(f"[notifications actives sur {n_u}]")
        else:
            print("[ATTENTION : UUID notify introuvable, pas de reception]")

        async def _rx_printer():
            while True:
                try:
                    data = await asyncio.wait_for(rx_queue.get(), timeout=0.1)
                    if show_hex[0]:
                        print(f"\r<< {data.hex(' ').upper()}")
                    else:
                        safe = "".join(chr(b) if 0x20 <= b < 0x7F else "." for b in data)
                        print(f"\r<< [{len(data)}B] {safe}")
                    print("> ", end="", flush=True)
                except asyncio.TimeoutError:
                    pass

        rx_task = asyncio.create_task(_rx_printer())

        try:
            while True:
                print("> ", end="", flush=True)
                line = await loop.run_in_executor(None, sys.stdin.readline)
                line = line.strip()
                if not line:
                    continue

                parts = line.split()
                cmd_str = parts[0].lower()

                if cmd_str in ("quit", "q", "exit"):
                    break

                elif cmd_str == "hex":
                    show_hex[0] = not show_hex[0]
                    print(f"[affichage {'hex' if show_hex[0] else 'ascii'}]")

                elif cmd_str == "speed" and len(parts) >= 2:
                    n = max(1, min(5, int(parts[1])))
                    frame = _make_frame(CMD_SET_SPEED, bytes([n]))
                    await client.write_gatt_char(w_u, frame, response=False)
                    print(f">> CMD_SET_SPEED={n}  {frame.hex(' ').upper()}")

                elif cmd_str == "density" and len(parts) >= 2:
                    n = max(1, min(15, int(parts[1])))
                    frame = _make_frame(CMD_SET_DENSITY, bytes([n]))
                    await client.write_gatt_char(w_u, frame, response=False)
                    print(f">> CMD_SET_DENSITY={n}  {frame.hex(' ').upper()}")

                elif cmd_str == "feed":
                    n = int(parts[1]) if len(parts) >= 2 else 85
                    frame = _make_frame(CMD_FEED, bytes([n & 0xFF, 0x00]))
                    await client.write_gatt_char(w_u, frame, response=False)
                    print(f">> CMD_FEED={n}  {frame.hex(' ').upper()}")

                elif cmd_str == "cus" and len(parts) >= 2:
                    # cus CMD [HH HH ...]  — encapsule dans une trame CUS
                    try:
                        c_id   = int(parts[1], 16)
                        p_data = bytes(int(x, 16) for x in parts[2:])
                        frame  = _make_frame(c_id, p_data)
                        # envoyer par chunks de BLE_CHUNK_SZ
                        for off in range(0, len(frame), BLE_CHUNK_SZ):
                            await client.write_gatt_char(
                                w_u, frame[off:off + BLE_CHUNK_SZ], response=False)
                            if off + BLE_CHUNK_SZ < len(frame):
                                await asyncio.sleep(INTER_CHUNK_MS)
                        print(f">> CUS cmd=0x{c_id:02X} payload={len(p_data)}B  {frame.hex(' ').upper()}")
                    except ValueError as e:
                        print(f"[erreur hex : {e}]")

                else:
                    # Octets bruts en hex : "64 03 01 ..."
                    try:
                        raw = bytes(int(x, 16) for x in parts)
                        for off in range(0, len(raw), BLE_CHUNK_SZ):
                            await client.write_gatt_char(
                                w_u, raw[off:off + BLE_CHUNK_SZ], response=False)
                            if off + BLE_CHUNK_SZ < len(raw):
                                await asyncio.sleep(INTER_CHUNK_MS)
                        print(f">> RAW {len(raw)}B  {raw.hex(' ').upper()}")
                    except ValueError:
                        print(f"[commande inconnue : {line!r}]")

        finally:
            rx_task.cancel()
            if n_u:
                try:
                    await client.stop_notify(n_u)
                except Exception:
                    pass

    print("Deconnecte.")


async def cmd_feed(addr, lines=140):
    async with BleakClient(addr, timeout=10.0) as client:
        _, w_u, _ = _find_uuids(client)
        if w_u is None:
            print("ERREUR : UUID write introuvable (lancez 'info' pour diagnostiquer)")
            return
        print(f"Avance papier ({lines} lignes)...")
        await _send(client, w_u, CMD_FEED, bytes([lines & 0xFF, 0x00]))
        await asyncio.sleep(0.5)
        print("OK")


def _ack_decode(raw):
    """Decode un ACK CUS recu de l'imprimante."""
    if len(raw) < 10:
        return f"trop court ({len(raw)}B)"
    if raw[0] != 0x64:
        return f"magic invalide 0x{raw[0]:02X}"
    cmd = raw[1]
    n   = raw[3] | (raw[4] << 8)
    pay = raw[5:5 + n] if len(raw) >= 5 + n else raw[5:]
    parts = [f"CMD=0x{cmd:02X}"]
    if pay:
        parts.append("pay=[" + " ".join(f"{b:02X}" for b in pay) + "]")
        if cmd == 0xFF and len(pay) >= 3:
            parts.append(f"echo_cmd=0x{pay[2]:02X}")
        if len(pay) >= 1:
            parts.append(f"status=0x{pay[0]:02X}")
    return "  ".join(parts)


def _ack_temp(raw):
    """Extrait la temperature (byte[6] du payload) d'un ACK CUS, ou None."""
    if len(raw) < 12:
        return None
    n = raw[3] | (raw[4] << 8)
    if len(raw) < 5 + n:
        return None
    pay = raw[5:5 + n]
    return pay[6] if len(pay) >= 7 else None


def _build_hdr_fn(tmpl):
    """Compile un template de header image CUS en callable (nlines, width) -> bytes.

    Tokens speciaux dans la chaine hex :
      NN  = nlines en uint16 little-endian (2 octets)
      WW  = width  en uint16 little-endian (2 octets)
    Le reste est du hex literal paire par paire.

    Exemples :
      ""          -> header vide (pixels bruts uniquement)
      "NN"        -> [nlines_lo nlines_hi]   (2 octets)
      "NNWW"      -> [nlines_lo nlines_hi width_lo width_hi]  (4 octets)
      "NNWW0000"  -> format par defaut a 6 octets
      "WWNN"      -> width en premier, puis nlines
      "01004800"  -> literal [01 00 48 00]
    """
    segments = []
    s = tmpl.upper().replace(' ', '')
    i = 0
    while i < len(s):
        if s[i:i+2] == 'NN':
            segments.append('n')
            i += 2
        elif s[i:i+2] == 'WW':
            segments.append('w')
            i += 2
        elif i + 1 < len(s) and all(c in '0123456789ABCDEF' for c in s[i:i+2]):
            segments.append(int(s[i:i+2], 16))
            i += 2
        else:
            i += 1
    def build(nlines, width):
        out = bytearray()
        for seg in segments:
            if seg == 'n':
                out += bytes([nlines & 0xFF, (nlines >> 8) & 0xFF])
            elif seg == 'w':
                out += bytes([width & 0xFF, (width >> 8) & 0xFF])
            else:
                out.append(seg)
        return bytes(out)
    return build


async def _do_print(addr, data, width_bytes, height, density=10, speed=3, feed=140,
                    min_height=64, invert=False, force=False, header_px=False,
                    before_cmds=(), after_cmds=(), n_lines=None,
                    lines_per_frame=None, img_cmd=None, img_hdr_fn=None):
    # Diagnostic bitmap
    nonzero = sum(1 for b in data if b)
    print(f"Bitmap : {len(data)} octets  {width_bytes} octets/ligne  {height} lignes  "
          f"pixels_actifs={nonzero}/{len(data)} ({nonzero*100//max(len(data),1)}%)")
    if nonzero == 0 and not invert and not force:
        print("ATTENTION : bitmap entierement blanc — rien a imprimer !")
        return

    # Inversion optionnelle des pixels (test polarite)
    if invert:
        data = bytes(b ^ 0xFF for b in data)
        nonzero2 = sum(1 for b in data if b)
        print(f"Bitmap inverse : pixels_actifs={nonzero2}/{len(data)}")

    # Padding minimum pour activer la tete thermique
    if height < min_height:
        pad = bytearray(width_bytes * (min_height - height))
        data = bytes(data) + bytes(pad)
        print(f"Padding : {height} → {min_height} lignes (minimum impression)")
        height = min_height

    print(f"Connexion a {addr}...")
    async with BleakClient(addr, timeout=15.0) as client:
        _, w_u, n_u = _find_uuids(client)
        if w_u is None:
            print("ERREUR : UUID write introuvable — lancez d'abord :")
            print(f"  python3.exe tools/tp6s_tool.py info {addr}")
            return

        chunk_sz = max(20, client.mtu_size - 3)
        print(f"Write UUID : {w_u}  MTU={client.mtu_size}  chunk={chunk_sz}")

        _cmd = img_cmd if img_cmd is not None else CMD_PRINT_IMAGE
        if _cmd != CMD_PRINT_IMAGE:
            print(f"CMD_PRINT override : 0x{_cmd:02X}  (defaut=0x{CMD_PRINT_IMAGE:02X})")
        if img_hdr_fn is not None:
            sample_hdr = img_hdr_fn(1, width_bytes * 8 if header_px else width_bytes)
            print(f"HDR override ({len(sample_hdr)}B) : {sample_hdr.hex(' ').upper() or '(vide)'}")
        else:
            print("Payload image : raw 1bpp, pas de header (defaut)")

        # lignes par trame CUS : 4 par defaut (cusPkgImgSlice envoie par tranches)
        lpb = lines_per_frame if lines_per_frame and lines_per_frame > 0 else MAX_CHUNK_LINES
        nb  = (height + lpb - 1) // lpb
        mode_str = f"{nb} trame(s) de {lpb} lig" if nb > 1 else "1 trame unique"
        print(f"Vitesse={speed}  Densite={density}  {height} lignes  [{mode_str}]")

        # Notifications : ACK de l'imprimante
        ack_q = asyncio.Queue()
        def _notif(handle, raw):
            ack_q.put_nowait(bytes(raw))
        if n_u:
            await client.start_notify(n_u, _notif)
            print(f"[notify FFF1 actif]")
        else:
            print("[ATTENTION : UUID notify introuvable — pas d'ACK]")

        await _send(client, w_u, CMD_SET_SPEED,   bytes([max(1, min(5,  speed))]), chunk_sz)
        await asyncio.sleep(0.15)
        await _send(client, w_u, CMD_SET_DENSITY, bytes([max(1, min(15, density))]), chunk_sz)
        await asyncio.sleep(0.15)

        bpl  = width_bytes
        h    = height
        bloc = 0
        # header_px=True : largeur en pixels (bpl*8), sinon en octets (bpl).
        w_hdr = bpl * 8 if header_px else bpl

        # Vider la queue des eventuels ACKs des commandes speed/density
        if n_u and before_cmds:
            while True:
                try:
                    stale = await asyncio.wait_for(ack_q.get(), timeout=0.3)
                    t = _ack_temp(stale)
                    print(f"  [drain speed/density ACK] {stale.hex(' ').upper()}  T={t}°C")
                except asyncio.TimeoutError:
                    break

        # --- before_cmds : envoyer avant les blocs image ---
        for c in before_cmds:
            await _send(client, w_u, c, b"", chunk_sz)
            await asyncio.sleep(0.4)
            if n_u:
                try:
                    ack = await asyncio.wait_for(ack_q.get(), timeout=3.0)
                    t = _ack_temp(ack)
                    print(f"  [BEFORE CMD=0x{c:02X}] ACK={ack.hex(' ').upper()}  T={t}°C")
                except asyncio.TimeoutError:
                    print(f"  [BEFORE CMD=0x{c:02X}] TIMEOUT (pas d'ACK)")

        for y0 in range(0, h, lpb):
            y1     = min(y0 + lpb, h)
            nlines = y1 - y0
            bloc  += 1

            if img_hdr_fn is not None:
                hdr = img_hdr_fn(nlines, w_hdr)
                payload = bytes(hdr) + bytes(data[y0 * bpl : y1 * bpl])
            else:
                payload = bytes(data[y0 * bpl : y1 * bpl])
            frame   = _make_frame(_cmd, payload)

            if bloc == 1:
                preview = frame[:min(28, len(frame))]
                print(f"  [frame debut] {preview.hex(' ').upper()}"
                      f"{'...' if len(frame) > 28 else ''}  ({len(frame)}B total)")

            for off in range(0, len(frame), chunk_sz):
                await client.write_gatt_char(w_u, frame[off:off + chunk_sz],
                                             response=False)
                if off + chunk_sz < len(frame):
                    await asyncio.sleep(INTER_CHUNK_MS)

            # Attendre ACK imprimante (max 5s)
            ack_hex = "--"
            if n_u:
                try:
                    ack = await asyncio.wait_for(ack_q.get(), timeout=5.0)
                    ack_hex = ack.hex(' ').upper()
                except asyncio.TimeoutError:
                    ack_hex = "TIMEOUT"
            else:
                await asyncio.sleep(0.15)

            pct = y1 * 100 // h
            print(f"  bloc {bloc:4d}/{nb}  {pct:3d}%  ACK={ack_hex}")

        # --- after_cmds : envoyer apres les blocs image ---
        if after_cmds:
            await asyncio.sleep(0.5)   # laisser l'imprimante finir le traitement
        for c in after_cmds:
            await _send(client, w_u, c, b"", chunk_sz)
            await asyncio.sleep(0.4)
            if n_u:
                try:
                    ack = await asyncio.wait_for(ack_q.get(), timeout=5.0)
                    t = _ack_temp(ack)
                    print(f"  [AFTER  CMD=0x{c:02X}] ACK={ack.hex(' ').upper()}  T={t}°C")
                except asyncio.TimeoutError:
                    print(f"  [AFTER  CMD=0x{c:02X}] TIMEOUT (pas d'ACK)")

        if n_u:
            try:
                await client.stop_notify(n_u)
            except Exception:
                pass

        print(f"\nAvance papier ({feed} lignes)...")
        await _send(client, w_u, CMD_FEED, bytes([feed & 0xFF, 0x00]), chunk_sz)
        await asyncio.sleep(1.0)
        print("Impression terminee !")


async def cmd_test_print(addr, pattern="black", density=12, speed=3, feed=40,
                         bpl_override=None, n=64, header_px=False,
                         before_cmds=(), after_cmds=(), lines_per_frame=None,
                         img_cmd=None, img_hdr_fn=None):
    """Motif de test : 'black' (plein), 'bars' (rayures 4px), 'white' (0x00 force).
    bpl_override   : 72 (576px, 80mm) ou 48 (384px, 58mm) — defaut BPL=72.
    header_px      : True = header width en pixels, False = en octets (defaut).
    before_cmds    : liste de CMD IDs (int) a envoyer avant les blocs image.
    after_cmds     : liste de CMD IDs (int) a envoyer apres les blocs image.
    lines_per_frame: lignes max par trame CUS (1-2 = 1 write BLE, 48 = multi-write).
    img_cmd        : octet de commande CUS pour les blocs image (defaut=CMD_PRINT_IMAGE=0x00).
    img_hdr_fn     : callable (nlines, width) -> bytes pour le header image (defaut=6 octets).
    """
    bpl = bpl_override if bpl_override else BPL
    w   = bpl * 8
    if pattern == "black":
        data = bytes([0xFF] * (bpl * n))
    elif pattern in ("inv", "white"):
        data = bytes([0x00] * (bpl * n))
    elif pattern == "bars":
        row_on  = bytes([0xFF] * bpl)
        row_off = bytes(bpl)
        buf = bytearray()
        for y in range(n):
            buf += row_on if (y // 4) % 2 == 0 else row_off
        data = bytes(buf)
    else:
        print(f"Pattern inconnu : {pattern!r}  (black | bars | white)")
        return
    nonzero = sum(1 for b in data if b)
    hdr_mode = f"header_px={w}" if header_px else f"header_bpl={bpl}"
    print(f"Test pattern={pattern!r}  bpl={bpl} ({w}px)  {hdr_mode} : {n} lignes  "
          f"{nonzero}/{len(data)} bytes actifs")
    if before_cmds:
        print(f"  before_cmds : {[f'0x{c:02X}' for c in before_cmds]}")
    if after_cmds:
        print(f"  after_cmds  : {[f'0x{c:02X}' for c in after_cmds]}")
    if lines_per_frame:
        hdr_bytes = len(img_hdr_fn(1, bpl)) if img_hdr_fn is not None else 0
        print(f"  lines_per_frame={lines_per_frame}  (frame={10 + hdr_bytes + bpl * lines_per_frame}B)")
    if img_cmd is not None:
        print(f"  img_cmd=0x{img_cmd:02X}  (defaut=0x{CMD_PRINT_IMAGE:02X})")
    if img_hdr_fn is not None:
        sample = img_hdr_fn(lines_per_frame or 1, bpl)
        print(f"  img_hdr ({len(sample)}B) : {sample.hex(' ').upper() or '(vide)'}")
    force = pattern in ("white", "inv")
    await _do_print(addr, data, bpl, n, density=density, speed=speed, feed=feed,
                    min_height=0, force=force, header_px=header_px,
                    before_cmds=before_cmds, after_cmds=after_cmds,
                    lines_per_frame=lines_per_frame,
                    img_cmd=img_cmd, img_hdr_fn=img_hdr_fn)


async def cmd_print_text(addr, text, font_size=32, density=12, speed=3, feed=85):
    try:
        from PIL import Image, ImageDraw, ImageFont
        _pil = True
    except ImportError:
        _pil = False

    scale = max(1, font_size // 8)
    cw    = 8 * scale
    cpl   = PRINT_W // cw

    lines = []
    for raw in text.replace('\r', '').split('\n'):
        if not raw:
            lines.append('')
        else:
            while len(raw) > cpl:
                lines.append(raw[:cpl])
                raw = raw[cpl:]
            lines.append(raw)

    total_h = len(lines) * (8 * scale)
    if total_h == 0:
        print("Texte vide.")
        return

    data = bytearray(BPL * total_h)

    if _pil:
        img  = Image.new('1', (PRINT_W, total_h), 0)
        draw = ImageDraw.Draw(img)
        try:
            fnt = ImageFont.truetype("arial.ttf", 8 * scale)
        except Exception:
            fnt = ImageFont.load_default()
        for li, line in enumerate(lines):
            draw.text((0, li * 8 * scale), line, fill=1, font=fnt)
        px = img.load()
        for y in range(total_h):
            for xb in range(BPL):
                byte = 0
                for bit in range(8):
                    x = xb * 8 + bit
                    if x < PRINT_W and px[x, y]:
                        byte |= (0x80 >> bit)
                data[y * BPL + xb] = byte
    else:
        print("PIL non disponible — installez-le : python3.exe -mpip install pillow")
        print("Impression avec rendu basique (lignes horizontales)...")
        for y in range(total_h):
            for xb in range(BPL):
                data[y * BPL + xb] = 0xFF if y % (8 * scale) == 0 else 0x00

    await _do_print(addr, bytes(data), BPL, total_h, density, speed, feed)


async def cmd_print_pbm(addr, path, density=8, speed=3, feed=85):
    with open(path, 'rb') as f:
        magic = f.readline().strip()
        if magic != b'P4':
            raise ValueError("Format PBM P4 (binaire) requis")
        while True:
            line = f.readline()
            if not line.startswith(b'#'):
                break
        parts = line.split()
        w   = int(parts[0])
        h   = int(parts[1])
        bpl = (w + 7) // 8
        raw = f.read(bpl * h)

    print(f"PBM : {w}x{h} pixels")

    if w != PRINT_W:
        print(f"Redimensionnement {w} -> {PRINT_W}px...")
        dst = bytearray(BPL * h)
        for y in range(h):
            for x in range(PRINT_W):
                sx  = x * w // PRINT_W
                sb  = raw[y * bpl + (sx >> 3)]
                bit = (sb >> (7 - (sx & 7))) & 1
                if bit:
                    di = y * BPL + (x >> 3)
                    dst[di] |= 0x80 >> (x & 7)
        raw = bytes(dst)
        bpl = BPL

    await _do_print(addr, raw, bpl, h, density, speed, feed)


async def cmd_print_raster(addr, path, density=14, speed=5, feed=150,
                           threshold=128, dither=True, rotate=0):
    """Imprime un fichier JPG/PNG (tout format PIL) converti en 1bpp."""
    try:
        from PIL import Image
    except ImportError:
        print("PIL requis : python3.exe -mpip install pillow")
        return

    img = Image.open(path)
    print(f"Image : {path}  {img.size[0]}x{img.size[1]}  mode={img.mode}")

    if rotate:
        img = img.rotate(rotate, expand=True)
        print(f"Rotation {rotate}°  → {img.size[0]}x{img.size[1]}")

    img = img.convert('L')  # niveaux de gris

    w, h = img.size
    new_h = max(1, round(h * PRINT_W / w))
    if w != PRINT_W:
        img = img.resize((PRINT_W, new_h), Image.LANCZOS)
        print(f"Redim : {w}x{h} → {PRINT_W}x{new_h}")
    else:
        new_h = h

    if dither:
        img1 = img.convert('1')  # Floyd-Steinberg par defaut
        mode_str = "Floyd-Steinberg"
    else:
        img1 = img.point(lambda p: 0 if p < threshold else 255).convert('1', dither=0)
        mode_str = f"seuil {threshold}"
    print(f"1bpp ({mode_str}) → {BPL}×{new_h}={BPL * new_h} octets")

    # PIL mode '1' : bit=0 → noir (imprime), printer : bit=1 → imprime → XOR 0xFF
    raw1 = img1.tobytes()
    data = bytes(b ^ 0xFF for b in raw1)

    await _do_print(addr, data, BPL, new_h, density, speed, feed)


# ---------------------------------------------------------------------------
# Point d'entree
# ---------------------------------------------------------------------------

def _usage():
    print(__doc__)
    sys.exit(1)


def main():
    args = sys.argv[1:]
    if not args:
        _usage()

    cmd = args[0]

    if cmd == "scan":
        asyncio.run(cmd_scan())

    elif cmd == "info" and len(args) >= 2:
        asyncio.run(cmd_info(args[1]))

    elif cmd == "uart" and len(args) >= 2:
        asyncio.run(cmd_uart(args[1]))

    elif cmd == "feed" and len(args) >= 2:
        lines = int(args[2]) if len(args) >= 3 else 85
        asyncio.run(cmd_feed(args[1], lines))

    elif cmd == "test" and len(args) >= 2:
        def _parse_cmds(flag):
            try:
                i = args.index(flag)
                return [int(x, 16) for x in args[i + 1].split(",")]
            except (ValueError, IndexError):
                return []
        def _parse_int_flag(flag):
            try:
                i = args.index(flag)
                return int(args[i + 1])
            except (ValueError, IndexError):
                return None
        def _parse_str_flag(flag, default=None):
            try:
                i = args.index(flag)
                return args[i + 1]
            except (ValueError, IndexError):
                return default
        before_cmds     = _parse_cmds("--before")
        after_cmds      = _parse_cmds("--after")
        lines_per_frame = _parse_int_flag("--lines")
        hdr_str         = _parse_str_flag("--hdr")     # None = default 6-byte
        cmd_str         = _parse_str_flag("--cmd")     # None = CMD_PRINT_IMAGE
        img_hdr_fn = _build_hdr_fn(hdr_str) if hdr_str is not None else None
        img_cmd    = int(cmd_str, 16) if cmd_str is not None else None
        # Exclure les flags ET leurs valeurs de la liste positionnelle
        flag_vals = set()
        for flag in ("--before", "--after", "--lines", "--hdr", "--cmd"):
            try:
                i = args.index(flag)
                if i + 1 < len(args):
                    flag_vals.add(args[i + 1])
            except ValueError:
                pass
        rest         = [a for a in args[2:] if not a.startswith("--") and a not in flag_vals]
        pattern      = rest[0] if len(rest) >= 1 else "black"
        bpl_override = int(rest[1]) if len(rest) >= 2 else None
        header_px    = "--px" in args
        asyncio.run(cmd_test_print(args[1], pattern, bpl_override=bpl_override,
                                   header_px=header_px,
                                   before_cmds=before_cmds, after_cmds=after_cmds,
                                   lines_per_frame=lines_per_frame,
                                   img_cmd=img_cmd, img_hdr_fn=img_hdr_fn))

    elif cmd == "print" and len(args) >= 3:
        text    = " ".join(args[2:])
        asyncio.run(cmd_print_text(args[1], text))

    elif cmd == "image" and len(args) >= 3:
        path = args[2]
        ext  = path.lower().rsplit('.', 1)[-1] if '.' in path else ''
        if ext == "pbm":
            asyncio.run(cmd_print_pbm(args[1], path))
        else:
            def _parse_int_flag(flag, default=None):
                try:
                    i = args.index(flag)
                    return int(args[i + 1])
                except (ValueError, IndexError):
                    return default
            dither    = "--nodither" not in args
            threshold = _parse_int_flag("--threshold", 128)
            rotate    = _parse_int_flag("--rotate", 0)
            asyncio.run(cmd_print_raster(args[1], path,
                                         dither=dither, threshold=threshold,
                                         rotate=rotate))

    else:
        _usage()


if __name__ == "__main__":
    main()
