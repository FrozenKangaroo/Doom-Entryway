#!/usr/bin/env python3
"""Local server for Doom Run Tracker.

Run:
    python local_server.py

Then open:
    http://localhost:8000

The database is stored as doom_tracker_database.json beside this script.
The server provides both the web UI and localhost-only filesystem access for
refreshing stats from the newest .zds save.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import mimetypes
import os
import subprocess
import re
import struct
import ssl
import time
import zlib
from difflib import SequenceMatcher
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse
from urllib.request import Request, build_opener, HTTPSHandler, HTTPPasswordMgrWithDefaultRealm, HTTPBasicAuthHandler, HTTPDigestAuthHandler
from urllib.error import HTTPError, URLError
from email.utils import parsedate_to_datetime
import xml.etree.ElementTree as ET
from zipfile import BadZipFile, ZipFile

try:
    from PIL import Image
except Exception:  # Pillow is optional; PNG payloads still save without conversion.
    Image = None

HOST = "127.0.0.1"
PORT = 8000
ROOT = Path(__file__).resolve().parent
DATABASE_PATH = ROOT / "doom_tracker_database.json"
SETTINGS_PATH = ROOT / "settings.json"
APP_VERSION = "1.5.3"


TITLEPIC_API_PREFIX = "/api/titlepic"
SCREENSHOT_API_PREFIX = "/api/screenshot"
SCREENSHOT_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
DOOM_MOD_EXTENSIONS = {".wad", ".pk3", ".pk7", ".zip", ".deh", ".bex", ".cfg", ".ini", ".txt"}
SYNC_TEMP_SUFFIX = ".doomtracker-uploading.tmp"
SYNC_ROOT_FOLDERS = {
    "saves": "Saves",
    "screenshots": "Screenshots",
    "pwads": "PWADs",
    "iwads": "IWADs",
    "metadata": "Metadata",
    "titlepics": "Titlepics",
    "mods": "Mods",
    "additionalFiles": "AdditionalFiles",
    "database": "Database",
}



def _create_local_folders(payload: dict) -> dict:
    folders = payload.get("folders")
    if not isinstance(folders, list):
        raise ValueError("folders[] is required.")
    created: list[dict] = []
    existing: list[dict] = []
    skipped: list[dict] = []
    for entry in folders:
        label = str(entry.get("label") if isinstance(entry, dict) else "Folder").strip() or "Folder"
        raw_path = str(entry.get("path") if isinstance(entry, dict) else entry).strip()
        if not raw_path:
            skipped.append({"label": label, "reason": "No path configured."})
            continue
        target = Path(os.path.expanduser(raw_path)).resolve()
        if target.exists():
            if not target.is_dir():
                raise ValueError(f"{label} exists but is not a folder: {target}")
            existing.append({"label": label, "path": str(target)})
            continue
        target.mkdir(parents=True, exist_ok=True)
        created.append({"label": label, "path": str(target)})
    return {"created": created, "existing": existing, "skipped": skipped}


def _launch_game(payload: dict) -> dict:
    executable = str(payload.get("executable") or "").strip()
    iwad_path = str(payload.get("iwadPath") or "").strip()
    pwad_path = str(payload.get("pwadPath") or "").strip()
    raw_file_paths = payload.get("filePaths") or []
    if not isinstance(raw_file_paths, list):
        raw_file_paths = []
    save_dir = str(payload.get("saveDir") or "").strip()
    shot_dir = str(payload.get("shotDir") or save_dir or "").strip()
    wad_id = str(payload.get("wadId") or "").strip()
    monitor_deaths = bool(payload.get("monitorDeaths", True))

    if not executable:
        raise ValueError("Game executable is required.")
    if not iwad_path:
        raise ValueError("IWAD path is required.")
    if not save_dir:
        raise ValueError("Save directory is required.")
    if not shot_dir:
        raise ValueError("Screenshot directory is required.")

    exe_path = Path(os.path.expanduser(executable)).resolve()
    iwad = Path(os.path.expanduser(iwad_path)).resolve()
    file_paths = [str(item or "").strip() for item in raw_file_paths if str(item or "").strip()]
    if not file_paths and pwad_path:
        file_paths = [pwad_path]
    launch_files = [Path(os.path.expanduser(path)).resolve() for path in file_paths]
    pwad = launch_files[0] if launch_files else None
    savedir = Path(os.path.expanduser(save_dir)).resolve()
    shotdir = Path(os.path.expanduser(shot_dir)).resolve()

    if not exe_path.exists():
        raise FileNotFoundError(f"Game executable was not found: {exe_path}")
    if not iwad.is_file():
        raise FileNotFoundError(f"IWAD was not found: {iwad}")
    for launch_file in launch_files:
        if not launch_file.is_file():
            raise FileNotFoundError(f"Launch file was not found: {launch_file}")
    if not savedir.is_dir():
        raise FileNotFoundError(f"Save directory was not found: {savedir}")
    if not shotdir.is_dir():
        raise FileNotFoundError(f"Screenshot directory was not found: {shotdir}")

    if exe_path.suffix.lower() == ".sh":
        command = ["flatpak-spawn", "--host", str(exe_path)]
    else:
        command = [str(exe_path)]
    command += ["-iwad", str(iwad)]
    if launch_files:
        command += ["-file"] + [str(path) for path in launch_files]
    command += ["-savedir", str(savedir), "-shotdir", str(shotdir)]

    proc = subprocess.Popen(
        command,
        cwd=str(exe_path.parent),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        start_new_session=True,
    )
    if monitor_deaths and wad_id:
        _start_death_monitor_thread(proc, wad_id)
    return {"command": command, "pid": proc.pid, "deathMonitor": bool(monitor_deaths and wad_id)}


_DEATH_MONITOR_THREADS = []
_MAP_HEADER_RE = re.compile(r"^\s*((?:MAP\d{2})|(?:E\dM\d))\s*(?:[-:–—].*)?$", re.IGNORECASE)

# Standard GZDoom/ZDoom obituary messages. The player name is configurable,
# and output may include a leading colon, so both are treated as variable.
_DEATH_OBITUARY_RE = re.compile(
    r"^\s*:?.+?\s+(?:"
    r"was killed by a Zombieman\.|"
    r"was shot by a Sergeant\.|"
    r"was perforated by a Chaingunner\.|"
    r"met a Nazi\.|"
    r"was slashed by an Imp\.|"
    r"was burned by an Imp\.|"
    r"was bit by a Demon\.|"
    r"was eaten by a Spectre\.|"
    r"was spooked by a Lost Soul\.|"
    r"was devoured by a Cacodemon\.|"
    r"was smitten by a Cacodemon\.|"
    r"was gutted by a Hell Knight\.|"
    r"was splayed by a Hell Knight\.|"
    r"was ripped open by a Baron of Hell\.|"
    r"was bruised by a Baron of Hell\.|"
    r"let an Arachnotron get (?:him|her|them|it)\.?|"
    r"was punched by a Revenant\.|"
    r"couldn['’]?t evade a Revenant['’]s fireball\.|"
    r"was squashed by a Mancubus\.|"
    r"was incinerated by an Arch-Vile\.|"
    r"stood in awe of the Spider Mastermind\.|"
    r"was splattered by a Cyberdemon\.|"
    r"killed (?:himself|herself|themself|itself)\.?|"
    r"mutated\.|"
    r"was squished\.|"
    r"was telefragged\."
    r")\s*$",
    re.IGNORECASE,
)

def _start_death_monitor_thread(proc: subprocess.Popen, wad_id: str) -> None:
    import threading
    thread = threading.Thread(target=_monitor_doom_output_for_deaths, args=(proc, wad_id), daemon=True)
    thread.start()
    _DEATH_MONITOR_THREADS.append(thread)

def _monitor_doom_output_for_deaths(proc: subprocess.Popen, wad_id: str) -> None:
    current_map = ""
    stream = proc.stdout
    if stream is None:
        return
    for raw_line in stream:
        line = raw_line.strip()
        if not line:
            continue
        map_match = _MAP_HEADER_RE.match(line)
        if map_match:
            current_map = map_match.group(1).upper()
            continue
        if current_map and _is_doom_death_message(line):
            try:
                _increment_map_death_count(wad_id, current_map, line)
            except Exception as exc:
                print(f"Doom Tracker death monitor failed: {exc}", flush=True)
    try:
        proc.wait(timeout=1)
    except Exception:
        pass

def _is_doom_death_message(line: str) -> bool:
    text = line.strip()
    if not text:
        return False
    return bool(_DEATH_OBITUARY_RE.match(text))

def _increment_map_death_count(wad_id: str, level_name: str, message: str) -> None:
    app = _load_database()
    wads = app.get("wads") if isinstance(app.get("wads"), list) else []
    wad = next((entry for entry in wads if str(entry.get("id")) == str(wad_id)), None)
    if not wad:
        return
    runs = wad.get("runs") if isinstance(wad.get("runs"), list) else []
    if not runs:
        return
    run = runs[-1]
    maps = run.get("maps") if isinstance(run.get("maps"), list) else []
    wanted = level_name.upper()
    target = None
    for m in maps:
        candidates = [m.get("levelName"), m.get("displayName")]
        if any(str(value or "").strip().upper() == wanted for value in candidates):
            target = m
            break
    if target is None:
        target = {
            "id": f"death-monitor-{wanted}",
            "levelName": wanted,
            "displayName": wanted,
            "mapAuthor": "",
            "killcount": 0,
            "totalkills": 0,
            "itemcount": 0,
            "totalitems": 0,
            "secretcount": 0,
            "totalsecrets": 0,
            "leveltime": 0,
            "deaths": 0,
            "sourceType": "death-monitor",
            "saveFileName": "",
            "notes": "Created by terminal death monitor.",
        }
        maps.append(target)
        run["maps"] = maps
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    target["deaths"] = int(target.get("deaths") or 0) + 1
    target["updatedAt"] = now
    base_note = str(target.get("notes") or "")
    monitor_note = f"Latest death monitor message: {message[:180]}"
    target["notes"] = monitor_note if not base_note else f"{base_note}\n{monitor_note}"[-1000:]
    run["updatedAt"] = now
    wad["updatedAt"] = now
    _save_database(app)
    print(f"Doom Tracker: counted death for {wad.get('title') or wad_id} {wanted}: {message}", flush=True)

def _safe_slug(value: str, fallback: str = "titlepic") -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip()).strip("._-")
    return slug[:80] or fallback


def _titlepics_folder_from_app(app: dict) -> str:
    settings = app.get("settings") if isinstance(app.get("settings"), dict) else {}
    return str(settings.get("defaultTitlepicsFolder") or "").strip()


def _ensure_titlepics_folder(folder_raw: str) -> Path:
    if not folder_raw:
        raise ValueError("Set the Titlepics folder in Settings first.")
    folder = Path(os.path.expanduser(folder_raw)).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _image_bytes_to_png(image_bytes: bytes) -> bytes:
    """Return real PNG bytes, converting JPEG/WEBP/etc. with Pillow when needed."""
    if not image_bytes:
        raise ValueError("No image data was supplied.")

    # Already a PNG. Keep the exact PNG payload.
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return image_bytes

    if Image is None:
        raise ValueError("This image is not a PNG and Pillow is not installed, so it cannot be converted to PNG.")

    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            # Preserve transparency where possible. Palette/transparency images need RGBA; regular images can be RGB.
            has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
            converted = img.convert("RGBA" if has_alpha else "RGB")
            output = io.BytesIO()
            converted.save(output, format="PNG")
            return output.getvalue()
    except Exception as exc:
        raise ValueError(f"Could not convert titlepic image to PNG: {exc}") from exc


def _decode_data_url_png(data_url: str) -> bytes:
    text = str(data_url or "")
    if not text.startswith("data:image/") or "," not in text:
        raise ValueError("Expected an image data URL.")
    _header, encoded = text.split(",", 1)
    raw = base64.b64decode(encoded)
    return _image_bytes_to_png(raw)


def _save_titlepic_bytes(folder_raw: str, image_bytes: bytes, title_hint: str = "titlepic", existing_name: str = "") -> dict:
    folder = _ensure_titlepics_folder(folder_raw)
    png_bytes = _image_bytes_to_png(image_bytes)
    digest = hashlib.sha1(png_bytes).hexdigest()[:10]
    stem = _safe_slug(Path(existing_name).stem if existing_name else title_hint, "titlepic")
    # Always write true PNG bytes for app-managed titlepics, regardless of the source image format.
    file_name = f"{stem}_{digest}.png"
    target = folder / file_name
    target.write_bytes(png_bytes)
    return {"titlePicFileName": file_name, "titlePicPath": str(target), "titlePicUrl": f"{TITLEPIC_API_PREFIX}?file={file_name}"}


def _remove_embedded_titlepic_fields(wad: dict) -> None:
    wad.pop("titlePicDataUrl", None)


def _migrate_embedded_titlepics(app: dict) -> bool:
    folder_raw = _titlepics_folder_from_app(app)
    if not folder_raw:
        return False
    changed = False
    for wad in app.get("wads", []):
        if not isinstance(wad, dict):
            continue
        data_url = wad.get("titlePicDataUrl")
        if isinstance(data_url, str) and data_url.startswith("data:image/"):
            try:
                info = _save_titlepic_bytes(folder_raw, _decode_data_url_png(data_url), wad.get("title") or wad.get("pwadFileName") or wad.get("id") or "titlepic", wad.get("titlePicFileName") or "")
                wad["titlePicFileName"] = info["titlePicFileName"]
                wad["titlePicPath"] = info["titlePicPath"]
                _remove_embedded_titlepic_fields(wad)
                changed = True
            except Exception:
                # Do not block loading the database if a legacy image is malformed.
                continue
    return changed


def _json_response(handler: SimpleHTTPRequestHandler, status: int, payload: dict) -> bool:
    """Send JSON; ignore harmless disconnects after long requests."""
    try:
        body = json.dumps(payload, indent=2).encode("utf-8")
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(body)))
        handler.send_header("Cache-Control", "no-store")
        handler.end_headers()
        handler.wfile.write(body)
        return True
    except (BrokenPipeError, ConnectionResetError):
        return False


def _read_json_body(handler: SimpleHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length <= 0:
        return {}
    raw = handler.rfile.read(length).decode("utf-8")
    return json.loads(raw or "{}")




def _empty_database() -> dict:
    return {"wads": [], "folders": []}


def _empty_settings() -> dict:
    return {}


def _load_settings() -> dict:
    if not SETTINGS_PATH.exists():
        return _empty_settings()
    try:
        with SETTINGS_PATH.open("r", encoding="utf-8") as fh:
            payload = json.load(fh)
        settings = payload.get("settings") if isinstance(payload, dict) and isinstance(payload.get("settings"), dict) else payload
        return settings if isinstance(settings, dict) else _empty_settings()
    except Exception:
        return _empty_settings()


def _save_settings(settings: dict) -> None:
    if not isinstance(settings, dict):
        settings = {}
    from datetime import datetime, timezone
    payload = {
        "settings": settings,
        "savedAt": datetime.now(timezone.utc).isoformat(),
        "appName": "Doom Run Tracker",
        "version": APP_VERSION,
    }
    tmp_path = SETTINGS_PATH.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    tmp_path.replace(SETTINGS_PATH)


def _split_app_settings(app: dict) -> tuple[dict, dict]:
    if not isinstance(app, dict):
        return app, {}
    database_app = dict(app)
    settings = database_app.pop("settings", {})
    return database_app, settings if isinstance(settings, dict) else {}


def _merge_local_settings(app: dict) -> dict:
    if not isinstance(app, dict):
        app = _empty_database()
    app = dict(app)
    db_settings = app.pop("settings", None)
    local_settings = _load_settings()

    # One-time migration: v1.0.0 and older stored settings inside the synced database.
    # Move them into settings.json so each PC can keep its own paths and WebDAV credentials.
    if isinstance(db_settings, dict) and db_settings:
        if SETTINGS_PATH.exists():
            # Once settings.json exists, the synced database must not back-fill or overwrite
            # machine-specific settings from another PC.
            merged = local_settings
        else:
            # First-run migration from the old inline settings format.
            merged = _merge_settings_preserving_tombstones({}, db_settings)
            _save_settings(merged)
        local_settings = merged
        try:
            _save_database(app)
        except Exception:
            pass

    app["settings"] = local_settings
    return app


def _load_database() -> dict:
    if not DATABASE_PATH.exists():
        return _merge_local_settings(_empty_database())

    with DATABASE_PATH.open("r", encoding="utf-8") as fh:
        payload = json.load(fh)

    app = payload.get("app") if isinstance(payload, dict) and isinstance(payload.get("app"), dict) else payload
    if not isinstance(app, dict):
        return _merge_local_settings(_empty_database())

    if not isinstance(app.get("wads"), list):
        app["wads"] = []

    app = _merge_local_settings(app)

    if _migrate_embedded_titlepics(app):
        _save_database(app)

    return app


def _save_database(app: dict) -> None:
    if not isinstance(app, dict):
        raise ValueError("Database payload must be a JSON object.")

    if not isinstance(app.get("wads"), list):
        raise ValueError("Database payload must include a wads array.")

    database_app, incoming_settings = _split_app_settings(app)
    if incoming_settings:
        current_settings = _load_settings()
        _save_settings(_merge_settings_preserving_tombstones(current_settings, incoming_settings))

    # Keep settings out of doom_tracker_database.json so WebDAV database sync cannot
    # overwrite machine-specific local paths, credentials, or sync state.
    migrate_view = dict(database_app)
    migrate_view["settings"] = _load_settings()
    if _migrate_embedded_titlepics(migrate_view):
        database_app = dict(migrate_view)
        database_app.pop("settings", None)

    from datetime import datetime, timezone

    payload = {
        "app": database_app,
        "savedAt": datetime.now(timezone.utc).isoformat(),
        "appName": "Doom Run Tracker",
        "version": APP_VERSION,
    }

    tmp_path = DATABASE_PATH.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    tmp_path.replace(DATABASE_PATH)




IWAD_MAP_METADATA = {
    "DOOM": {
        "title": "DOOM",
        "author": "id Software",
        "iwad": "DOOM",
        "sourcePort": "Vanilla / Limit-removing",
        "type": "episode",
        "maps": [
            ("E1M1", "Hangar", "John Romero"), ("E1M2", "Nuclear Plant", "John Romero"), ("E1M3", "Toxin Refinery", "John Romero"), ("E1M4", "Command Control", "Tom Hall"), ("E1M5", "Phobos Lab", "John Romero"), ("E1M6", "Central Processing", "John Romero"), ("E1M7", "Computer Station", "John Romero"), ("E1M8", "Phobos Anomaly", "Sandy Petersen"), ("E1M9", "Military Base", "John Romero"),
            ("E2M1", "Deimos Anomaly", "Sandy Petersen and Tom Hall"), ("E2M2", "Containment Area", "Sandy Petersen"), ("E2M3", "Refinery", "Tom Hall"), ("E2M4", "Deimos Lab", "Tom Hall"), ("E2M5", "Command Center", "Sandy Petersen"), ("E2M6", "Halls of the Damned", "Sandy Petersen"), ("E2M7", "Spawning Vats", "Tom Hall"), ("E2M8", "Tower of Babel", "Sandy Petersen"), ("E2M9", "Fortress of Mystery", "Sandy Petersen"),
            ("E3M1", "Hell Keep", "Sandy Petersen"), ("E3M2", "Slough of Despair", "Sandy Petersen"), ("E3M3", "Pandemonium", "Sandy Petersen"), ("E3M4", "House of Pain", "Sandy Petersen"), ("E3M5", "Unholy Cathedral", "Sandy Petersen"), ("E3M6", "Mt. Erebus", "Sandy Petersen"), ("E3M7", "Limbo", "Sandy Petersen"), ("E3M8", "Dis", "Sandy Petersen"), ("E3M9", "Warrens", "Sandy Petersen"),
        ],
    },
    "ULTIMATE_DOOM": {
        "title": "The Ultimate DOOM",
        "author": "id Software",
        "iwad": "DOOM",
        "sourcePort": "Vanilla / Limit-removing",
        "type": "episode",
        "maps": []
    },
    "DOOM2": {
        "title": "DOOM II: Hell on Earth",
        "author": "id Software",
        "iwad": "Doom II",
        "sourcePort": "Vanilla / Limit-removing",
        "type": "megawad",
        "maps": [
            ("MAP01", "Entryway", "Sandy Petersen"), ("MAP02", "Underhalls", "Sandy Petersen"), ("MAP03", "The Gantlet", "American McGee"), ("MAP04", "The Focus", "American McGee"), ("MAP05", "The Waste Tunnels", "American McGee"), ("MAP06", "The Crusher", "American McGee"), ("MAP07", "Dead Simple", "American McGee"), ("MAP08", "Tricks and Traps", "Sandy Petersen"), ("MAP09", "The Pit", "Sandy Petersen"), ("MAP10", "Refueling Base", "Tom Hall and Sandy Petersen"), ("MAP11", "Circle of Death", "John Romero"), ("MAP12", "The Factory", "Sandy Petersen"), ("MAP13", "Downtown", "Sandy Petersen"), ("MAP14", "The Inmost Dens", "American McGee"), ("MAP15", "Industrial Zone", "John Romero"), ("MAP16", "Suburbs", "Sandy Petersen"), ("MAP17", "Tenements", "John Romero"), ("MAP18", "The Courtyard", "Sandy Petersen"), ("MAP19", "The Citadel", "Sandy Petersen"), ("MAP20", "Gotcha!", "John Romero"), ("MAP21", "Nirvana", "Sandy Petersen"), ("MAP22", "The Catacombs", "American McGee"), ("MAP23", "Barrels o' Fun", "Sandy Petersen"), ("MAP24", "The Chasm", "Sandy Petersen"), ("MAP25", "Bloodfalls", "Shawn Green"), ("MAP26", "The Abandoned Mines", "John Romero"), ("MAP27", "Monster Condo", "Sandy Petersen"), ("MAP28", "The Spirit World", "Sandy Petersen"), ("MAP29", "The Living End", "John Romero"), ("MAP30", "Icon of Sin", "Sandy Petersen"), ("MAP31", "Wolfenstein", "Sandy Petersen"), ("MAP32", "Grosse", "Sandy Petersen"),
        ],
    },
    "TNT": {"title": "Final DOOM: TNT Evilution", "author": "TeamTNT / id Software", "iwad": "Final DOOM - TNT", "sourcePort": "Vanilla / Limit-removing", "type": "megawad", "maps": []},
    "PLUTONIA": {"title": "Final DOOM: The Plutonia Experiment", "author": "Dario Casali and Milo Casali / id Software", "iwad": "Final DOOM - Plutonia", "sourcePort": "Vanilla / Limit-removing", "type": "megawad", "maps": []},
}
IWAD_MAP_METADATA["ULTIMATE_DOOM"]["maps"] = IWAD_MAP_METADATA["DOOM"]["maps"] + [
    ("E4M1", "Hell Beneath", "American McGee"), ("E4M2", "Perfect Hatred", "John Romero"), ("E4M3", "Sever the Wicked", "Shawn Green"), ("E4M4", "Unruly Evil", "American McGee"), ("E4M5", "They Will Repent", "John Anderson"), ("E4M6", "Against Thee Wickedly", "John Romero"), ("E4M7", "And Hell Followed", "John Anderson"), ("E4M8", "Unto the Cruel", "Shawn Green"), ("E4M9", "Fear", "Tim Willits"),
]
# Final DOOM map author granularity is messier; use the project authors at entry level.
IWAD_MAP_METADATA["TNT"]["maps"] = [(f"MAP{i:02d}", name, "TeamTNT") for i, name in enumerate([
    "System Control", "Human BBQ", "Power Control", "Wormhole", "Hanger", "Open Season", "Prison", "Metal", "Stronghold", "Redemption", "Storage Facility", "Crater", "Nukage Processing", "Steel Works", "Dead Zone", "Deepest Reaches", "Processing Area", "Mill", "Shipping/Respawning", "Central Processing", "Administration Center", "Habitat", "Lunar Mining Project", "Quarry", "Baron's Den", "Ballistyx", "Mount Pain", "Heck", "River Styx", "Last Call", "Pharaoh", "Caribbean"], 1)]
IWAD_MAP_METADATA["PLUTONIA"]["maps"] = [(f"MAP{i:02d}", name, "Dario Casali and Milo Casali") for i, name in enumerate([
    "Congo", "Well of Souls", "Aztec", "Caged", "Ghost Town", "Baron's Lair", "Caughtyard", "Realm", "Abattoire", "Onslaught", "Hunted", "Speed", "The Crypt", "Genesis", "The Twilight", "The Omen", "Compound", "Neurosphere", "NME", "The Death Domain", "Slayer", "Impossible Mission", "Tombstone", "The Final Frontier", "The Temple of Darkness", "Bunker", "Anti-Christ", "The Sewers", "Odyssey of Noises", "The Gateway of Hell", "Cyberden", "Go 2 It"], 1)]


def _read_wad_lumps(path: Path) -> dict:
    data = path.read_bytes()
    if len(data) < 12:
        raise ValueError("File is too small to be a WAD.")
    magic, lump_count, directory_offset = struct.unpack_from('<4sII', data, 0)
    if magic not in {b'IWAD', b'PWAD'}:
        raise ValueError("Not an IWAD/PWAD file.")
    lumps = {}
    for i in range(lump_count):
        off = directory_offset + i * 16
        if off + 16 > len(data):
            break
        filepos, size, raw_name = struct.unpack_from('<II8s', data, off)
        name = raw_name.rstrip(b'\x00').decode('ascii', errors='ignore').upper()
        lumps.setdefault(name, []).append(data[filepos:filepos + size])
    return lumps


def _png_bytes(width: int, height: int, pixels: bytes, color_type: int = 2) -> bytes:
    """Build a small PNG without external dependencies.

    color_type 2 = RGB, bytes per pixel 3.
    color_type 6 = RGBA, bytes per pixel 4.
    """
    if color_type == 2:
        stride = width * 3
    elif color_type == 6:
        stride = width * 4
    else:
        raise ValueError(f"Unsupported PNG color type: {color_type}")

    expected = stride * height
    if len(pixels) != expected:
        raise ValueError(f"PNG pixel buffer has {len(pixels)} bytes; expected {expected}.")

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return struct.pack('>I', len(payload)) + tag + payload + struct.pack('>I', zlib.crc32(tag + payload) & 0xffffffff)

    raw = b''.join(b'\x00' + pixels[y * stride:(y + 1) * stride] for y in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, color_type, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def _decode_doom_picture_to_rgba(picture: bytes, playpal: bytes) -> tuple[int, int, bytes] | None:
    """Decode Doom's column-major picture/patch format into an RGBA buffer.

    Format:
      int16 width, height, leftoffset, topoffset
      uint32 column_offsets[width]
      posts per column: topdelta, length, unused, pixels[length], unused
      0xFF terminates each column.
    """
    if len(picture) < 8 or len(playpal) < 768:
        return None

    try:
        width, height, _left, _top = struct.unpack_from('<hhhh', picture, 0)
    except struct.error:
        return None

    if width <= 0 or height <= 0 or width > 4096 or height > 4096:
        return None

    pointer_table_end = 8 + (width * 4)
    if pointer_table_end > len(picture):
        return None

    try:
        column_offsets = struct.unpack_from(f'<{width}I', picture, 8)
    except struct.error:
        return None

    if not all(0 <= off < len(picture) for off in column_offsets):
        return None

    palette = [playpal[i:i + 3] for i in range(0, 768, 3)]
    rgba = bytearray([0, 0, 0, 0] * (width * height))

    for x, column_start in enumerate(column_offsets):
        pos = column_start
        guard = 0
        while pos < len(picture):
            topdelta = picture[pos]
            pos += 1
            if topdelta == 0xFF:
                break
            if pos + 2 > len(picture):
                return None
            length = picture[pos]
            pos += 1
            pos += 1  # unused padding byte before pixel data
            if pos + length + 1 > len(picture):
                return None

            for i in range(length):
                y = topdelta + i
                if 0 <= y < height:
                    pal_index = picture[pos + i]
                    out = ((y * width) + x) * 4
                    rgba[out:out + 3] = palette[pal_index]
                    rgba[out + 3] = 255

            pos += length
            pos += 1  # unused padding byte after pixel data
            guard += 1
            if guard > height + 256:
                return None

    return width, height, bytes(rgba)


def _decode_flat_picture_to_rgb(flat: bytes, playpal: bytes, width: int = 320, height: int = 200) -> tuple[int, int, bytes] | None:
    if len(flat) < width * height or len(playpal) < 768:
        return None
    palette = [playpal[i:i + 3] for i in range(0, 768, 3)]
    rgb = bytearray()
    for px in flat[:width * height]:
        rgb.extend(palette[px])
    return width, height, bytes(rgb)


def _titlepic_data_url(lumps: dict, fallback_playpal: bytes | None = None) -> str:
    title = (lumps.get('TITLEPIC') or [b''])[0]
    playpal = (lumps.get('PLAYPAL') or [b''])[0]
    if len(playpal) < 768 and fallback_playpal and len(fallback_playpal) >= 768:
        playpal = fallback_playpal
    if not title or len(playpal) < 768:
        return ''

    decoded_patch = _decode_doom_picture_to_rgba(title, playpal)
    if decoded_patch:
        width, height, rgba = decoded_patch
        png = _png_bytes(width, height, rgba, color_type=6)
        return 'data:image/png;base64,' + base64.b64encode(png).decode('ascii')

    decoded_flat = _decode_flat_picture_to_rgb(title, playpal)
    if decoded_flat:
        width, height, rgb = decoded_flat
        png = _png_bytes(width, height, rgb, color_type=2)
        return 'data:image/png;base64,' + base64.b64encode(png).decode('ascii')

    return ''



def _iwad_key_from_field(value: str) -> str | None:
    """Resolve loose IWAD field text to the base IWAD whose PLAYPAL should be used."""
    text = str(value or '').strip().lower()
    compact = re.sub(r"[^a-z0-9]+", "", text)
    if not compact:
        return None
    if 'plutonia' in compact:
        return 'PLUTONIA'
    if 'tnt' in compact:
        return 'TNT'
    if 'doomii' in compact or 'doom2' in compact:
        return 'DOOM2'
    if compact in {'doom', 'ultimatedoom', 'theultimatedoom'} or ('doom' in compact and 'doom2' not in compact and 'doomii' not in compact):
        return 'ULTIMATE_DOOM'
    return None


def _candidate_iwad_names_for_key(key: str) -> list[str]:
    names = {
        'DOOM': ['doom.wad'],
        'ULTIMATE_DOOM': ['doom.wad'],
        'DOOM2': ['doom2.wad'],
        'TNT': ['tnt.wad'],
        'PLUTONIA': ['plutonia.wad'],
    }
    return names.get(key, [])


def _load_base_iwad_playpal(iwad_field: str = '', iwad_folder: str = '', iwad_path: str = '') -> bytes:
    """Find the selected base IWAD and return its PLAYPAL for PWAD TITLEPIC fallback."""
    key = _iwad_key_from_field(iwad_field)
    candidates: list[Path] = []

    for raw in (iwad_path, iwad_folder):
        raw = str(raw or '').strip()
        if not raw:
            continue
        try:
            p = Path(os.path.expanduser(raw)).resolve()
        except Exception:
            continue
        if p.is_file():
            candidates.append(p)
        elif p.is_dir() and key:
            candidates.extend(p / name for name in _candidate_iwad_names_for_key(key))

    for candidate in candidates:
        try:
            if not candidate.exists() or not candidate.is_file() or candidate.suffix.lower() != '.wad':
                continue
            lumps = _read_wad_lumps(candidate)
            detected = _detect_iwad_key(candidate, lumps)
            if key and detected != key and not (key == 'ULTIMATE_DOOM' and detected == 'DOOM'):
                continue
            playpal = (lumps.get('PLAYPAL') or [b''])[0]
            if len(playpal) >= 768:
                return playpal
        except Exception:
            continue
    return b''

def _detect_iwad_key(path: Path, lumps: dict) -> str | None:
    name = path.name.lower()
    names = set(lumps.keys())

    # Filename checks first. TNT and Plutonia are Doom II-family IWADs and also
    # contain MAP01/MAP30/MAP32, so the broad Doom II signature must not run first.
    if name == 'tnt.wad':
        return 'TNT'
    if name == 'plutonia.wad':
        return 'PLUTONIA'
    if name == 'doom2.wad':
        return 'DOOM2'
    if name == 'doom.wad':
        return 'ULTIMATE_DOOM' if 'E4M1' in names else 'DOOM'

    if {'E1M1', 'E2M1', 'E3M1'} <= names:
        return 'ULTIMATE_DOOM' if 'E4M1' in names else 'DOOM'

    if {'MAP01', 'MAP30', 'MAP32'} <= names:
        return 'DOOM2'

    return None

def _placeholder_map(level_name: str, display_name: str, author: str) -> dict:
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    return {
        "id": f"iwad-{level_name.lower()}", "levelName": level_name, "displayName": display_name, "mapAuthor": author,
        "killcount": 0, "totalkills": 0, "itemcount": 0, "totalitems": 0, "secretcount": 0, "totalsecrets": 0,
        "leveltime": 0, "deaths": 0, "sourceType": "metadata", "saveFileName": "", "notes": "Auto-filled IWAD metadata placeholder.",
        "createdAt": now, "updatedAt": now,
    }


def _scan_iwads(folder: Path) -> dict:
    if not folder.exists():
        raise FileNotFoundError(f"IWAD folder does not exist: {folder}")
    if not folder.is_dir():
        raise NotADirectoryError(f"IWAD path is not a folder: {folder}")
    found, skipped = [], []
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    for path in sorted(folder.iterdir(), key=lambda p: p.name.lower()):
        if not path.is_file() or path.suffix.lower() != '.wad':
            continue
        try:
            lumps = _read_wad_lumps(path)
            key = _detect_iwad_key(path, lumps)
            if not key:
                skipped.append({"fileName": path.name, "reason": "Not one of the supported IWADs."})
                continue
            meta = IWAD_MAP_METADATA[key]
            maps = [_placeholder_map(level, title, author) for level, title, author in meta["maps"]]
            wad = {
                "id": f"iwad-{key.lower()}", "title": meta["title"], "type": meta["type"], "author": meta["author"],
                "iwad": meta["iwad"], "sourcePort": meta["sourcePort"], "saveFolderPath": "", "pwadPath": "", "iwadPath": str(path),
                "totalMaps": len(maps), "notes": f"Auto-scanned from {path.name}. Map names/authors were filled from embedded IWAD metadata.",
                "playState": "plan", "titlePicDataUrl": _titlepic_data_url(lumps), "folderId": None, "createdAt": now,
                "selectedRunId": f"iwad-{key.lower()}-metadata-run",
                "runs": [{"id": f"iwad-{key.lower()}-metadata-run", "name": "Metadata", "mode": "Continuous", "difficulty": "UV", "mods": "", "createdAt": now, "maps": maps}],
                "iwadScanKey": key, "iwadFileName": path.name,
            }
            found.append(wad)
        except Exception as exc:
            skipped.append({"fileName": path.name, "reason": str(exc)})
    return {"found": found, "skipped": skipped}


def _canonical_path(value: str) -> str:
    try:
        return str(Path(os.path.expanduser(str(value))).resolve()).lower()
    except Exception:
        return str(value or '').strip().lower()


def _scan_pwads(folder: Path, associated_paths: list[str] | None = None, associated_files: list[dict] | None = None) -> dict:
    if not folder.exists():
        raise FileNotFoundError(f"PWAD folder does not exist: {folder}")
    if not folder.is_dir():
        raise NotADirectoryError(f"PWAD path is not a folder: {folder}")

    associated = {_canonical_path(path) for path in (associated_paths or []) if str(path or '').strip()}
    associated_names = set()
    associated_relatives = set()
    for item in (associated_files or []):
        if not isinstance(item, dict):
            continue
        p = str(item.get('path') or '').strip()
        rel = str(item.get('relativePath') or '').replace('\\', '/').strip().strip('/')
        name = str(item.get('fileName') or '').strip() or (Path(p).name if p else '')
        if p:
            associated.add(_canonical_path(p))
        if rel:
            associated_relatives.add(rel.lower())
        if name:
            associated_names.add(name.lower())
    found, skipped = [], []
    max_depth = 6

    for root, dirnames, filenames in os.walk(folder):
        root_path = Path(root)
        depth = len(root_path.relative_to(folder).parts)
        if depth >= max_depth:
            dirnames[:] = []

        for filename in sorted(filenames, key=str.lower):
            if not filename.lower().endswith(('.wad', '.pk3')):
                continue
            path = root_path / filename
            canonical = _canonical_path(str(path))
            relative_key = str(path.relative_to(folder)).replace('\\', '/').lower()
            filename_key = filename.lower()
            if canonical in associated or relative_key in associated_relatives or filename_key in associated_names:
                skipped.append({"fileName": filename, "path": str(path), "relativePath": str(path.relative_to(folder)), "reason": "Already associated with a WAD/PK3 card."})
                continue
            try:
                stat = path.stat()
                ext = path.suffix.lower()
                if ext == '.wad':
                    lumps = _read_wad_lumps(path)
                    with path.open('rb') as fh:
                        magic = fh.read(4)
                    if magic != b'PWAD':
                        skipped.append({"fileName": filename, "path": str(path), "reason": "Not a PWAD."})
                        continue
                    marker_maps = _detect_map_slots_from_lumps(lumps)
                    has_titlepic = bool((lumps.get('TITLEPIC') or [b''])[0])
                    file_kind = 'PWAD'
                else:
                    pk3 = _read_pk3_contents(path)
                    marker_maps = _detect_map_slots_from_pk3(pk3)
                    has_titlepic = bool(_pk3_titlepic_data_url(pk3))
                    file_kind = 'PK3'
                found.append({
                    "fileName": filename,
                    "path": str(path),
                    "relativePath": str(path.relative_to(folder)),
                    "size": stat.st_size,
                    "modifiedTime": stat.st_mtime,
                    "mapCount": len(marker_maps),
                    "hasTitlepic": has_titlepic,
                    "fileKind": file_kind,
                })
            except Exception as exc:
                skipped.append({"fileName": filename, "path": str(path), "reason": str(exc)})

    found.sort(key=lambda item: item["relativePath"].lower())
    return {"found": found, "skipped": skipped}



MAP_SLOT_RE = re.compile(r'^(?:MAP\d\d|E\dM\d)$', re.I)

def _decode_lump_text(blob: bytes) -> str:
    return blob.replace(b'\x00', b'').decode('utf-8', errors='ignore')


def _read_pk3_contents(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f'PK3 file does not exist: {path}')
    if not path.is_file():
        raise FileNotFoundError(f'PK3 path is not a file: {path}')
    try:
        with ZipFile(path, 'r') as zf:
            files = []
            for info in zf.infolist():
                if info.is_dir():
                    continue
                try:
                    data = zf.read(info.filename)
                except Exception:
                    continue
                files.append({'name': info.filename, 'lower': info.filename.lower(), 'data': data})
            return {'files': files}
    except BadZipFile as exc:
        raise ValueError('Selected .pk3 is not a valid ZIP/PK3 archive.') from exc


def _pk3_basename_no_ext(name: str) -> str:
    base = Path(name).name
    stem = base.rsplit('.', 1)[0] if '.' in base else base
    return stem.upper()


def _pk3_lumps_for_metadata(pk3: dict) -> dict:
    lumps = {}
    for f in pk3.get('files', []):
        name = str(f.get('name') or '')
        base = Path(name).name
        stem = _pk3_basename_no_ext(base)
        lower = base.lower()
        if lower in {'mapinfo', 'mapinfo.txt', 'zmapinfo', 'zmapinfo.txt', 'umapinfo', 'umapinfo.txt', 'dehacked', 'dehacked.txt'}:
            key = stem
        elif lower.endswith(('.lmp', '.txt', '.deh', '.bex')):
            key = stem
        else:
            continue
        lumps.setdefault(key.upper(), []).append(f.get('data') or b'')
    return lumps


def _detect_map_slots_from_pk3(pk3: dict) -> list[dict]:
    entries = []
    for f in pk3.get('files', []):
        lower = str(f.get('lower') or '')
        if lower.endswith('.wad') and ('/' in lower or '\\' in lower):
            slot = Path(str(f.get('name') or '')).stem.upper()
            if MAP_SLOT_RE.match(slot):
                entries.append({'levelName': slot, 'displayName': slot, 'mapAuthor': ''})
        elif lower.endswith('.map'):
            slot = Path(str(f.get('name') or '')).stem.upper()
            if MAP_SLOT_RE.match(slot):
                entries.append({'levelName': slot, 'displayName': slot, 'mapAuthor': ''})
    return _sort_map_entries(_dedupe_map_entries(entries))


def _data_url_for_image_bytes(blob: bytes, mime: str) -> str:
    if not blob:
        return ''
    return f'data:{mime};base64,' + base64.b64encode(blob).decode('ascii')


def _pk3_titlepic_data_url(pk3: dict, fallback_playpal: bytes | None = None) -> str:
    candidates = []
    for f in pk3.get('files', []):
        lower = str(f.get('lower') or '')
        base = Path(lower).name
        stem = base.rsplit('.', 1)[0]
        if stem == 'titlepic':
            candidates.append(f)
    for f in candidates:
        lower = str(f.get('lower') or '')
        data = f.get('data') or b''
        if lower.endswith('.png'):
            return _data_url_for_image_bytes(data, 'image/png')
        if lower.endswith(('.jpg', '.jpeg')):
            return _data_url_for_image_bytes(data, 'image/jpeg')
        if lower.endswith('.webp'):
            return _data_url_for_image_bytes(data, 'image/webp')
    lumps = _pk3_lumps_for_metadata(pk3)
    return _titlepic_data_url(lumps, fallback_playpal=fallback_playpal)


def _metadata_lump_blobs(lumps: dict, *wanted_names: str) -> list[bytes]:
    """Return metadata blobs using forgiving lump/file-name matching."""
    wanted = set()
    for name in wanted_names:
        raw = str(name or '').upper().strip()
        if not raw:
            continue
        stem = raw.rsplit('.', 1)[0]
        wanted.add(raw)
        wanted.add(stem)
        wanted.add(re.sub(r'[^A-Z0-9]', '', raw))
        wanted.add(re.sub(r'[^A-Z0-9]', '', stem))

    blobs = []
    for key, values in (lumps or {}).items():
        raw_key = str(key or '').upper().strip()
        key_stem = raw_key.rsplit('.', 1)[0]
        normalised = {raw_key, key_stem, re.sub(r'[^A-Z0-9]', '', raw_key), re.sub(r'[^A-Z0-9]', '', key_stem)}
        if 'UMPAINFO' in normalised and ('UMAPINFO' in wanted or 'UMAPINFOTXT' in wanted):
            normalised.add('UMAPINFO')
        if normalised & wanted:
            blobs.extend(values if isinstance(values, list) else [values])
    return blobs

def _strip_c_comments(text: str) -> str:
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    text = re.sub(r'//.*?$', '', text, flags=re.M)
    return text

def _extract_assign_value(block: str, key: str) -> str:
    patterns = [
        rf'^\s*{re.escape(key)}\s*=\s*"([^"]*)"',
        rf'^\s*{re.escape(key)}\s*=\s*([^\n,]+)',
        rf'^\s*{re.escape(key)}\s+"([^"]*)"',
        rf'^\s*{re.escape(key)}\s+([^\n,]+)',
    ]
    for pattern in patterns:
        match = re.search(pattern, block, flags=re.I | re.M)
        if match:
            value = match.group(1).strip().strip(',')
            return '' if value.lower() == 'clear' else value
    return ''

def _map_sort_key(level: str) -> tuple[int, int, str]:
    level = str(level or '').upper()
    m = re.match(r'^MAP(\d\d)$', level)
    if m:
        return (2, int(m.group(1)), level)
    m = re.match(r'^E(\d)M(\d)$', level)
    if m:
        return (1, int(m.group(1))*10 + int(m.group(2)), level)
    return (9, 999, level)

def _sort_map_entries(entries: list[dict]) -> list[dict]:
    return sorted(entries, key=lambda e: _map_sort_key(e.get('levelName', '')))

def _dedupe_map_entries(entries: list[dict]) -> list[dict]:
    merged = {}
    for entry in entries:
        level = str(entry.get('levelName') or '').upper().strip()
        if not level:
            continue
        old = merged.get(level, {})
        merged[level] = {
            'levelName': level,
            'displayName': entry.get('displayName') or old.get('displayName') or level,
            'mapAuthor': entry.get('mapAuthor') or old.get('mapAuthor') or '',
        }
    return list(merged.values())

def _parse_umapinfo_text(text: str) -> list[dict]:
    """Parse UMAPINFO / UMAPINFO.TXT map blocks.

    Tolerates real-world formatting:
      MAP MAP01
      {
          levelname = "In Extrema Res"
      }
    and CRLF line endings.
    """
    text = _strip_c_comments(str(text or '').replace('\r\n', '\n').replace('\r', '\n'))
    results = []
    pattern = re.compile(
        r'(?ims)^\s*map\s+([A-Za-z0-9_]+)\b(?P<body>.*?)(?=^\s*map\s+[A-Za-z0-9_]+\b|\Z)'
    )
    for match in pattern.finditer(text):
        level = match.group(1).upper().strip()
        body = match.group('body') or ''
        display = _extract_assign_value(body, 'levelname') or _extract_assign_value(body, 'name')
        author = _extract_assign_value(body, 'author') or _extract_assign_value(body, 'mapauthor')
        if level and (MAP_SLOT_RE.match(level) or re.match(r'^[A-Z0-9_]+$', level)):
            results.append({'levelName': level, 'displayName': display or level, 'mapAuthor': author})
    return _sort_map_entries(_dedupe_map_entries(results))


def _exact_umapinfo_blobs(lumps: dict) -> list[bytes]:
    """Return only true UMAPINFO blobs, never MAPINFO/DEHACKED."""
    exact_names = {
        'UMAPINFO', 'UMAPINF', 'UMAPINFO.TXT', 'UMAPINFOTXT',
        'UMPAINFO', 'UMPAINF', 'UMPAINFO.TXT', 'UMPAINFOTXT',
    }
    blobs = []
    for key, values in (lumps or {}).items():
        raw = str(key or '').upper().strip()
        stem = raw.rsplit('.', 1)[0]
        compact = re.sub(r'[^A-Z0-9]', '', raw)
        compact_stem = re.sub(r'[^A-Z0-9]', '', stem)
        if {raw, stem, compact, compact_stem} & exact_names:
            blobs.extend(values if isinstance(values, list) else [values])
    return blobs


def _priority_blob_groups(lumps: dict) -> dict:
    """Collect metadata blobs by exact source class.

    This intentionally does not use fuzzy matching between source types. A WAD can
    contain UMAPINFO, MAPINFO, and DEHACKED at the same time, and the lower
    priority compatibility files must never be allowed to overwrite UMAPINFO.
    """
    groups = {'DEHACKED': [], 'MAPINFO': [], 'ZMAPINFO': [], 'UMAPINFO': []}
    for key, values in (lumps or {}).items():
        vals = values if isinstance(values, list) else [values]
        raw = str(key or '').upper().strip()
        stem = raw.rsplit('.', 1)[0]
        compact = re.sub(r'[^A-Z0-9]', '', raw)
        compact_stem = re.sub(r'[^A-Z0-9]', '', stem)
        names = {raw, stem, compact, compact_stem}

        if names & {'UMAPINFO', 'UMAPINF', 'UMAPINFOTXT', 'UMPAINFO', 'UMPAINF', 'UMPAINFOTXT'}:
            groups['UMAPINFO'].extend(vals)
            continue
        if names & {'ZMAPINFO', 'ZMAPINF', 'ZMAPINFOTXT'}:
            groups['ZMAPINFO'].extend(vals)
            continue
        if names & {'MAPINFO', 'MAPINF', 'MAPINFOTXT'}:
            groups['MAPINFO'].extend(vals)
            continue
        if names & {'DEHACKED', 'DEH', 'BEX', 'DEHACKEDTXT'} or compact.startswith('DEH'):
            groups['DEHACKED'].extend(vals)
            continue
    return groups


def _entries_have_real_map_names(entries: list[dict]) -> bool:
    """Return True only when a metadata source supplied actual display names.

    Some UMAPINFO files only define music/episode/sky settings and contain map
    blocks without levelname/name fields. Those blocks are useful for ports but
    should not block lower-priority ZMAPINFO/MAPINFO/DEHACKED files that do
    contain real map titles.
    """
    for entry in entries or []:
        level = str(entry.get('levelName') or '').strip().upper()
        display = str(entry.get('displayName') or '').strip()
        if display and display.upper() != level:
            return True
    return False


def _entry_has_real_map_name(entry: dict) -> bool:
    level = str((entry or {}).get('levelName') or '').strip().upper()
    display = str((entry or {}).get('displayName') or '').strip()
    return bool(display and display.upper() != level)


def _merge_metadata_sources_by_priority(sources: list[tuple[str, list[dict]]]) -> tuple[list[dict], str, bool]:
    """Merge map metadata per map using priority order.

    Priority is UMAPINFO > ZMAPINFO > MAPINFO > DEHACKED, but lower-priority
    real names fill maps that higher-priority sources leave unnamed. Generic
    map blocks from a higher-priority source must not wipe a real title.
    """
    merged: dict[str, dict] = {}
    source_by_level: dict[str, str] = {}

    for source, entries in sources:
        for entry in entries or []:
            level = str(entry.get('levelName') or '').upper().strip()
            if not level:
                continue
            current = merged.get(level)
            incoming_real = _entry_has_real_map_name(entry)
            current_real = _entry_has_real_map_name(current or {})

            if current is None:
                merged[level] = {
                    'levelName': level,
                    'displayName': entry.get('displayName') or level,
                    'mapAuthor': entry.get('mapAuthor') or '',
                }
                source_by_level[level] = source
                continue

            if incoming_real or not current_real:
                merged[level] = {
                    'levelName': level,
                    'displayName': entry.get('displayName') or current.get('displayName') or level,
                    'mapAuthor': entry.get('mapAuthor') or current.get('mapAuthor') or '',
                }
                source_by_level[level] = source
            elif entry.get('mapAuthor') and not current.get('mapAuthor'):
                current['mapAuthor'] = entry.get('mapAuthor') or ''

    entries = _sort_map_entries(list(merged.values()))
    if not entries:
        return ([], '', False)

    if not _entries_have_real_map_names(entries):
        strongest = ''
        for source, source_entries in reversed(sources):
            if source_entries:
                strongest = source
                break
        return (entries, strongest, True)

    final_sources = []
    for entry in entries:
        level = str(entry.get('levelName') or '').upper().strip()
        src = source_by_level.get(level, '')
        if src and src not in final_sources:
            final_sources.append(src)
    return (entries, ' + '.join(final_sources) if final_sources else 'metadata', True)


def _parse_priority_metadata_lumps(lumps: dict) -> tuple[list[dict], str, bool]:
    """Return map metadata merged by source priority.

    UMAPINFO still wins for maps it actually names, but ZMAPINFO/MAPINFO or
    DEHACKED can fill missing map names for the remaining slots.
    """
    groups = _priority_blob_groups(lumps)

    deh_entries = []
    for blob in groups['DEHACKED']:
        deh_entries.extend(_parse_dehacked_text(_decode_lump_text(blob)))
    deh_entries = _sort_map_entries(_dedupe_map_entries(deh_entries))

    mapinfo_entries = []
    for blob in groups['MAPINFO']:
        mapinfo_entries.extend(_parse_mapinfo_text(_decode_lump_text(blob)))
    mapinfo_entries = _sort_map_entries(_dedupe_map_entries(mapinfo_entries))

    zmapinfo_entries = []
    for blob in groups['ZMAPINFO']:
        zmapinfo_entries.extend(_parse_mapinfo_text(_decode_lump_text(blob)))
    zmapinfo_entries = _sort_map_entries(_dedupe_map_entries(zmapinfo_entries))

    umap_entries = []
    for blob in groups['UMAPINFO']:
        umap_entries.extend(_parse_umapinfo_text(_decode_lump_text(blob)))
    umap_entries = _sort_map_entries(_dedupe_map_entries(umap_entries))

    return _merge_metadata_sources_by_priority([
        ('DEHACKED', deh_entries),
        ('MAPINFO', mapinfo_entries),
        ('ZMAPINFO', zmapinfo_entries),
        ('UMAPINFO', umap_entries),
    ])

def _normalise_mapinfo_slot(identifier: str, block: str = '') -> str:
    ident = str(identifier or '').strip().upper()
    if MAP_SLOT_RE.match(ident):
        return ident
    ep = _extract_assign_value(block, 'episodenumber')
    mn = _extract_assign_value(block, 'mapnumber')
    if ep.isdigit() and mn.isdigit():
        return f'E{int(ep)}M{int(mn)}'
    if mn.isdigit():
        return f'MAP{int(mn):02d}'
    return ident if ident else ''

def _parse_mapinfo_text(text: str) -> list[dict]:
    text = _strip_c_comments(str(text or '').replace('\r\n', '\n').replace('\r', '\n'))
    results = []
    map_re = re.compile(r'\bmap\s+([A-Za-z0-9_]+)\s*(?:"([^"]*)")?\s*\{', re.I)
    pos = 0
    while True:
        match = map_re.search(text, pos)
        if not match:
            break
        level = _normalise_mapinfo_slot(match.group(1), '')
        display = (match.group(2) or '').strip()
        i = match.end()
        depth = 1
        while i < len(text) and depth:
            if text[i] == '{':
                depth += 1
            elif text[i] == '}':
                depth -= 1
            i += 1
        block = text[match.end():max(match.end(), i-1)]
        display = _extract_assign_value(block, 'levelname') or _extract_assign_value(block, 'name') or display
        author = _extract_assign_value(block, 'author') or _extract_assign_value(block, 'mapauthor')
        if level:
            results.append({'levelName': level, 'displayName': display, 'mapAuthor': author})
        pos = i
    for match in re.finditer(r'^\s*map\s+([A-Za-z0-9_]+)\s+([^\n\{]+)$', text, flags=re.I | re.M):
        level = _normalise_mapinfo_slot(match.group(1), '')
        if not level:
            continue
        raw = match.group(2).strip().strip(',')
        display = raw.strip('"') if not raw.lower().startswith('lookup') else ''
        if not any(x['levelName'].upper() == level.upper() for x in results):
            results.append({'levelName': level, 'displayName': display, 'mapAuthor': ''})
    return _sort_map_entries(_dedupe_map_entries(results))

def _clean_dehacked_title(value: str) -> str:
    title = str(value or '').replace('\x00', '').strip().strip('"').strip()
    title = re.sub(r'\s+', ' ', title)
    # BEX/DEHEXTRA style string tables often store names as "MAP 01: Name".
    # Keep only the readable map title for the tracker display.
    title = re.sub(r'^(?:MAP|LEVEL)\s*0*(\d+)\s*:\s*', '', title, flags=re.I)
    title = re.sub(r'^E(\d+)M(\d+)\s*:\s*', '', title, flags=re.I)
    return title.strip()


def _map_slot_from_dehacked_old_text(old_text: str) -> str:
    old = str(old_text or '').strip().lower()
    match = re.search(r'\blevel\s+(\d+)\s*:', old, flags=re.I)
    if match:
        return f'MAP{int(match.group(1)):02d}'
    match = re.search(r'\be(\d)m(\d)\b', old, flags=re.I)
    if match:
        return f'E{int(match.group(1))}M{int(match.group(2))}'
    return ''


def _parse_dehacked_text(text: str) -> list[dict]:
    """Extract map titles from DeHackEd/BEX text."""
    text = str(text or '').replace('\r\n', '\n').replace('\r', '\n')
    results = []

    # Doom/Doom II BEX strings normally use HUSTR_*, while some modern
    # DeHackEd/DEHEXTRA exports use THUSTR_* for the same automap level names.
    for match in re.finditer(r'^\s*(?:HUSTR|THUSTR)_(E\dM\d|\d+)\s*=\s*(.+)$', text, flags=re.I | re.M):
        key = match.group(1).upper()
        level = key if key.startswith('E') else f'MAP{int(key):02d}'
        display = _clean_dehacked_title(match.group(2))
        if display:
            results.append({'levelName': level, 'displayName': display, 'mapAuthor': ''})

    lines = text.split('\n')
    i = 0
    while i < len(lines):
        header = re.match(r'^\s*Text\s+(\d+)\s+(\d+)\s*$', lines[i], flags=re.I)
        if not header:
            i += 1
            continue
        old_len = int(header.group(1))
        new_len = int(header.group(2))
        i += 1
        payload_lines = []
        consumed = 0
        target = old_len + new_len
        while i < len(lines):
            candidate = lines[i]
            if consumed == 0 and re.match(r'^\s*(Thing|Frame|Pointer|Text|Sound|Ammo|Weapon|Sprite|Cheat|Misc)\b', candidate, flags=re.I):
                break
            payload_lines.append(candidate)
            consumed += len(candidate) + (1 if i < len(lines) - 1 else 0)
            i += 1
            if consumed >= target:
                break
        payload = '\n'.join(payload_lines)
        if len(payload) < old_len:
            continue
        old_string = payload[:old_len]
        new_string = payload[old_len:old_len + new_len]
        level = _map_slot_from_dehacked_old_text(old_string)
        display = _clean_dehacked_title(new_string)
        if level and display:
            results.append({'levelName': level, 'displayName': display, 'mapAuthor': ''})

    return _sort_map_entries(_dedupe_map_entries(results))

def _detect_map_slots_from_lumps(lumps: dict) -> list[dict]:
    entries = [{'levelName': name, 'displayName': name, 'mapAuthor': ''} for name in lumps.keys() if MAP_SLOT_RE.match(name)]
    return _sort_map_entries(_dedupe_map_entries(entries))

def _classify_pwad_type(map_count: int) -> str:
    if map_count <= 1:
        return 'single'
    if 2 <= map_count <= 7:
        return 'multiple'
    if 8 <= map_count <= 14:
        return 'episode'
    return 'megawad'

def _infer_iwad_from_maps(entries: list[dict], lumps: dict) -> str:
    levels = {str(e.get('levelName') or '').upper() for e in entries}
    if any(level.startswith('E') for level in levels):
        return 'DOOM'
    if any(level.startswith('MAP') for level in levels):
        return 'Doom II'
    return ''



def _txt_section_name(line: str) -> str:
    """Return a normalised README/TXT section name for lines like '* Levels *'."""
    match = re.match(r'^\s*\*+\s*([^*]+?)\s*\*+\s*$', str(line or '').strip())
    if not match:
        return ''
    return re.sub(r'\s+', ' ', match.group(1).strip()).lower()


_TXT_METADATA_FIELD_NAMES = {
    'title', 'filename', 'author', 'email address', 'misc author info',
    'description', 'game', 'map #', 'map', 'single player', 'cooperative',
    'deathmatch', 'difficulty settings', 'new sounds', 'new graphics',
    'new music', 'demos replaced', 'base', 'build time', 'editor(s) used',
    'editors used', 'known bugs', 'may not run with', 'tested with',
    'advanced engine needed', 'primary purpose', 'new levels', 'source port',
}


_TXT_NON_METADATA_SECTIONS = {
    'levels', 'music', 'credits', 'contributor commentary', 'disclaimers',
    'copyright', 'misc', 'testing/qa', 'graphics/textures', 'maps',
}


def _extract_companion_txt_metadata(mod_path: Path, metadata_folder: str = '') -> dict:
    try:
        txt_path, _expected = _companion_txt_path(mod_path, metadata_folder)
    except Exception:
        return {}
    if not txt_path:
        return {}
    text = txt_path.read_text(encoding='utf-8', errors='replace').replace('\r\n', '\n').replace('\r', '\n')
    fields = {}
    current_key = ''
    current_value_lines = []
    current_section = ''
    key_re = re.compile(r'^\s*([A-Za-z][A-Za-z0-9 #/().,\-]+?)\s*:\s*(.*)$')

    def flush():
        nonlocal current_key, current_value_lines
        if current_key:
            value = '\n'.join(line.rstrip() for line in current_value_lines).strip()
            fields[current_key.lower()] = value
        current_key = ''
        current_value_lines = []

    for raw_line in text.split('\n'):
        line = raw_line.rstrip('\n')
        section = _txt_section_name(line)
        if section:
            flush()
            current_section = section
            continue
        if re.match(r'^\s*=+\s*$', line):
            flush()
            continue
        match = key_re.match(line)
        if match and current_section not in _TXT_NON_METADATA_SECTIONS:
            key = re.sub(r'\s+', ' ', match.group(1).strip())
            key_l = key.lower()
            if key_l in _TXT_METADATA_FIELD_NAMES and not line.lstrip().startswith(('-', '*')):
                flush()
                current_key = key
                current_value_lines = [match.group(2).strip()]
                continue
        if current_key and current_section not in _TXT_NON_METADATA_SECTIONS and (line.startswith(' ') or line.startswith('\t')):
            current_value_lines.append(line.strip())
        else:
            flush()
    flush()

    def get(*names):
        for name in names:
            value = fields.get(str(name).lower())
            if value:
                return value.strip()
        return ''

    result = {'txtMetadataFile': str(txt_path), 'txtMetadataFileName': txt_path.name}
    title = get('Title')
    author = get('Author')
    new_levels = get('New levels', 'New Levels')
    game = get('Game')
    source_port = get('Advanced engine needed', 'Source Port')
    description = get('Description')
    map_range = get('Map #', 'Map')

    if title:
        result['title'] = title
    if author:
        result['author'] = author
    if game:
        result['iwad'] = game
    if source_port:
        result['sourcePort'] = source_port
    if description:
        result['notes'] = description

    parsed_map_list = _maps_from_txt_map_list(text)
    total_maps = 0
    parsed_new_levels = _parse_txt_new_levels_count(new_levels)
    if parsed_new_levels:
        total_maps = parsed_new_levels
        result['totalMaps'] = total_maps
        result['type'] = _classify_pwad_type(total_maps)

    if parsed_map_list:
        result['maps'] = parsed_map_list
        result['totalMaps'] = len(parsed_map_list)
        result['type'] = _classify_pwad_type(len(parsed_map_list))
        return result

    return result


def _parse_txt_new_levels_count(value: str) -> int:
    text = str(value or '').strip()
    if not text:
        return 0
    m = re.fullmatch(r'\s*(\d+)\s*', text)
    if m:
        return int(m.group(1))
    m = re.search(r'\bMAP\s*0*(\d{1,2})\s*(?:-|to|through|thru)\s*(?:MAP\s*)?0*(\d{1,2})\b', text, flags=re.I)
    if m:
        start, end = int(m.group(1)), int(m.group(2))
        if start <= end:
            return end - start + 1
    m = re.search(r'\bE(\d+)M(\d+)\s*(?:-|to|through|thru)\s*E(\d+)M(\d+)\b', text, flags=re.I)
    if m:
        ep1, start, ep2, end = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))
        if ep1 == ep2 and start <= end:
            return end - start + 1
    slots = re.findall(r'\b(?:MAP\d{1,2}|E\d+M\d+)\b', text, flags=re.I)
    if slots:
        return len(set(slot.upper() for slot in slots))
    return 0


def _txt_named_section(text: str, *section_names: str) -> str:
    wanted = {str(name or '').strip().lower() for name in section_names if str(name or '').strip()}
    lines = str(text or '').replace('\r\n', '\n').replace('\r', '\n').split('\n')
    collecting = False
    collected: list[str] = []
    for line in lines:
        section = _txt_section_name(line)
        if section:
            if collecting and section not in wanted:
                break
            collecting = section in wanted
            continue
        if collecting:
            collected.append(line)
    return '\n'.join(collected)


def _clean_txt_map_title(value: str) -> str:
    title = str(value or '').strip()
    quoted = re.match(r'^"([^"]+)"', title)
    if quoted:
        return quoted.group(1).strip()
    title = title.strip('"').strip()
    return re.sub(r'\s+', ' ', title).strip()


def _maps_from_txt_map_list(text: str) -> list[dict]:
    section = _txt_named_section(text, 'levels', 'maps')
    if not section:
        return []
    maps = []
    for raw_line in section.split('\n'):
        line = raw_line.strip()
        if not line or re.match(r'^(secret|bonus)\s*:?$', line, flags=re.I):
            continue
        match = re.match(r'^-?\s*(MAP\d{1,2}|E\d+M\d+)\s*[:=-]\s*(.+?)\s*$', line, flags=re.I)
        if not match:
            continue
        slot = match.group(1).upper()
        rest = match.group(2).strip()
        author = ''
        title_part = rest
        split = re.split(r'\s+-{2,}\s+', rest, maxsplit=1)
        if len(split) == 2:
            title_part, author = split[0].strip(), split[1].strip()
        else:
            qsplit = re.match(r'^("[^"]+")\s+-\s+(.+)$', rest)
            if qsplit:
                title_part, author = qsplit.group(1).strip(), qsplit.group(2).strip()
        title = _clean_txt_map_title(title_part) or slot
        author = re.sub(r'\s+', ' ', author).strip()
        maps.append({'levelName': slot, 'displayName': title, 'mapAuthor': author})
    return _sort_map_entries(_dedupe_map_entries(maps))


def _maps_from_txt_map_range(map_range: str, total_maps: int = 0) -> list[dict]:
    text = str(map_range or '').strip()
    if not text:
        return []
    slots = re.findall(r'\b(E\d+M\d+|MAP\d{1,2})\b', text, flags=re.I)
    if len(slots) >= 2:
        start, end = slots[0].upper(), slots[-1].upper()
        m1 = re.match(r'^MAP(\d{1,2})$', start)
        m2 = re.match(r'^MAP(\d{1,2})$', end)
        if m1 and m2:
            a, b = int(m1.group(1)), int(m2.group(1))
            if a <= b:
                return [{'levelName': f'MAP{i:02d}', 'displayName': f'MAP{i:02d}', 'mapAuthor': ''} for i in range(a, b + 1)]
        e1 = re.match(r'^E(\d+)M(\d+)$', start)
        e2 = re.match(r'^E(\d+)M(\d+)$', end)
        if e1 and e2 and e1.group(1) == e2.group(1):
            ep, a, b = int(e1.group(1)), int(e1.group(2)), int(e2.group(2))
            if a <= b:
                return [{'levelName': f'E{ep}M{i}', 'displayName': f'E{ep}M{i}', 'mapAuthor': ''} for i in range(a, b + 1)]
    if total_maps and re.search(r'\bMAP\b', text, flags=re.I):
        return [{'levelName': f'MAP{i:02d}', 'displayName': f'MAP{i:02d}', 'mapAuthor': ''} for i in range(1, total_maps + 1)]
    return []


def _apply_txt_metadata_overlay(result: dict, mod_path: Path, metadata_folder: str = '') -> dict:
    txt = _extract_companion_txt_metadata(mod_path, metadata_folder)
    if not txt:
        return result
    merged = dict(result)
    for key in ('title', 'author', 'iwad', 'sourcePort', 'totalMaps', 'type', 'notes'):
        if key in txt and txt[key] not in (None, ''):
            merged[key] = txt[key]
    txt_maps = txt.get('maps') or []
    has_real_txt_map_names = any(
        str(m.get('displayName') or '').strip() and
        str(m.get('displayName') or '').strip().upper() != str(m.get('levelName') or '').strip().upper()
        for m in txt_maps
    )
    if txt_maps and has_real_txt_map_names:
        merged['maps'] = txt_maps
        merged['totalMaps'] = len(txt_maps)
        merged['type'] = _classify_pwad_type(len(txt_maps))
    source = merged.get('metadataSource') or 'metadata'
    merged['metadataSource'] = f"{source} + TXT" if 'TXT' not in str(source).upper() else str(source)
    merged['txtMetadataFile'] = txt.get('txtMetadataFile', '')
    merged['txtMetadataFileName'] = txt.get('txtMetadataFileName', '')
    return merged

def _extract_pk3_metadata(path: Path, iwad_field: str = '', iwad_folder: str = '', iwad_path: str = '', metadata_folder: str = '') -> dict:
    pk3 = _read_pk3_contents(path)
    lumps = _pk3_lumps_for_metadata(pk3)
    metadata_source = 'PK3 map files'
    maps, priority_source, metadata_found = _parse_priority_metadata_lumps(lumps)
    if metadata_found:
        metadata_source = priority_source or metadata_source
    if not maps:
        maps = _detect_map_slots_from_pk3(pk3)
    map_count = len(maps)
    title = path.stem.replace('_', ' ').replace('-', ' ').strip() or path.stem
    author = ''
    authors = [m.get('mapAuthor', '').strip() for m in maps if m.get('mapAuthor', '').strip()]
    if authors and len(set(authors)) == 1:
        author = authors[0]
    fallback_playpal = _load_base_iwad_playpal(iwad_field=iwad_field, iwad_folder=iwad_folder, iwad_path=iwad_path)
    titlepic = _pk3_titlepic_data_url(pk3, fallback_playpal=fallback_playpal)
    result = {
        'fileName': path.name,
        'path': str(path),
        'title': title,
        'author': author,
        'iwad': _infer_iwad_from_maps(maps, lumps),
        'totalMaps': max(1, map_count or 1),
        'type': _classify_pwad_type(map_count or 1),
        'metadataSource': metadata_source,
        'maps': maps,
        'titlePicDataUrl': titlepic,
        'hasTitlepic': bool(titlepic),
        'fileKind': 'PK3',
    }
    return _apply_txt_metadata_overlay(result, path, metadata_folder)

def _extract_pwad_metadata(path: Path, iwad_field: str = '', iwad_folder: str = '', iwad_path: str = '', metadata_folder: str = '') -> dict:
    if path.suffix.lower() == '.pk3':
        return _extract_pk3_metadata(path, iwad_field=iwad_field, iwad_folder=iwad_folder, iwad_path=iwad_path, metadata_folder=metadata_folder)
    if not path.exists():
        raise FileNotFoundError(f'Mod file does not exist: {path}')
    if not path.is_file():
        raise FileNotFoundError(f'Mod path is not a file: {path}')
    with path.open('rb') as fh:
        magic = fh.read(4)
    if magic != b'PWAD':
        raise ValueError('Selected file is not a PWAD or PK3.')
    lumps = _read_wad_lumps(path)
    metadata_source = 'lump markers'
    maps, priority_source, metadata_found = _parse_priority_metadata_lumps(lumps)
    if metadata_found:
        metadata_source = priority_source or metadata_source
    if not maps:
        maps = _detect_map_slots_from_lumps(lumps)
    map_count = len(maps)
    title = path.stem.replace('_', ' ').replace('-', ' ').strip() or path.stem
    author = ''
    authors = [m.get('mapAuthor', '').strip() for m in maps if m.get('mapAuthor', '').strip()]
    if authors and len(set(authors)) == 1:
        author = authors[0]
    fallback_playpal = _load_base_iwad_playpal(iwad_field=iwad_field, iwad_folder=iwad_folder, iwad_path=iwad_path)
    titlepic = _titlepic_data_url(lumps, fallback_playpal=fallback_playpal)
    result = {
        'fileName': path.name,
        'path': str(path),
        'title': title,
        'author': author,
        'iwad': _infer_iwad_from_maps(maps, lumps),
        'totalMaps': max(1, map_count or 1),
        'type': _classify_pwad_type(map_count or 1),
        'metadataSource': metadata_source,
        'maps': maps,
        'titlePicDataUrl': titlepic,
        'hasTitlepic': bool(titlepic),
        'fileKind': 'PWAD',
    }
    return _apply_txt_metadata_overlay(result, path, metadata_folder)


def _extract_titlepic_from_wad(path: Path, iwad_field: str = '', iwad_folder: str = '', iwad_path: str = '') -> dict:
    if not path.exists():
        raise FileNotFoundError(f"Mod file does not exist: {path}")
    if not path.is_file():
        raise FileNotFoundError(f"Mod path is not a file: {path}")
    lumps = _read_wad_lumps(path)
    has_own_playpal = bool((lumps.get('PLAYPAL') or [b''])[0])
    fallback_playpal = b'' if has_own_playpal else _load_base_iwad_playpal(iwad_field=iwad_field, iwad_folder=iwad_folder, iwad_path=iwad_path)
    data_url = _titlepic_data_url(lumps, fallback_playpal=fallback_playpal)
    if not data_url:
        raise FileNotFoundError("TITLEPIC was not found, or no usable PLAYPAL was found in the WAD/base IWAD.")
    return {"fileName": path.name, "path": str(path), "titlePicDataUrl": data_url, "usedFallbackPalette": bool(fallback_playpal)}

def _normalise_match_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def _compact_match_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def _folder_score(wad_name: str, folder: Path) -> float:
    query_words = _normalise_match_text(wad_name)
    folder_words = _normalise_match_text(folder.name)
    query_compact = _compact_match_text(wad_name)
    folder_compact = _compact_match_text(folder.name)

    if not query_compact or not folder_compact:
        return 0.0

    ratio_words = SequenceMatcher(None, query_words, folder_words).ratio()
    ratio_compact = SequenceMatcher(None, query_compact, folder_compact).ratio()
    score = max(ratio_words, ratio_compact)

    if query_compact in folder_compact or folder_compact in query_compact:
        score = max(score, 0.92)

    query_tokens = set(query_words.split())
    folder_tokens = set(folder_words.split())
    if query_tokens and folder_tokens:
        overlap = len(query_tokens & folder_tokens) / len(query_tokens | folder_tokens)
        score = max(score, 0.65 + (overlap * 0.3))

    try:
        if any(child.is_file() and child.suffix.lower() in {".zds", ".zip"} for child in folder.iterdir()):
            score += 0.04
    except OSError:
        pass

    return min(score, 1.0)


def _detect_save_folder(root: Path, wad_name: str) -> dict:
    if not root.exists():
        raise FileNotFoundError(f"Default root save folder does not exist: {root}")
    if not root.is_dir():
        raise NotADirectoryError(f"Default root save path is not a folder: {root}")
    if not wad_name.strip():
        raise ValueError("wadName is required.")

    candidates = []
    max_depth = 4
    for folder, dirnames, _filenames in os.walk(root):
        folder_path = Path(folder)
        depth = len(folder_path.relative_to(root).parts)
        if depth > max_depth:
            dirnames[:] = []
            continue
        if folder_path == root:
            continue
        score = _folder_score(wad_name, folder_path)
        if score >= 0.45:
            try:
                modified = folder_path.stat().st_mtime
            except OSError:
                modified = 0
            candidates.append({
                "name": folder_path.name,
                "path": str(folder_path),
                "score": round(score, 4),
                "modifiedTime": modified,
            })

    candidates.sort(key=lambda item: (item["score"], item["modifiedTime"]), reverse=True)
    return {"bestMatch": candidates[0] if candidates else None, "candidates": candidates[:8]}

def _latest_zds(folder: Path) -> Path:
    if not folder.exists():
        raise FileNotFoundError(f"Folder does not exist: {folder}")
    if not folder.is_dir():
        raise NotADirectoryError(f"Path is not a folder: {folder}")

    candidates = []
    for suffix in ("*.zds", "*.ZDS", "*.zip", "*.ZIP"):
        candidates.extend(folder.glob(suffix))

    candidates = [path for path in candidates if path.is_file()]
    if not candidates:
        raise FileNotFoundError(f"No .zds files found in: {folder}")

    return max(candidates, key=lambda path: path.stat().st_mtime)


def _read_globals_from_save(save_path: Path) -> dict:
    try:
        with ZipFile(save_path) as archive:
            names = archive.namelist()
            globals_name = "globals.json" if "globals.json" in names else next(
                (name for name in names if name.lower().endswith("/globals.json") or name.lower() == "globals.json"),
                None,
            )
            if not globals_name:
                raise FileNotFoundError("globals.json was not found inside the save archive.")
            with archive.open(globals_name) as fh:
                return json.loads(fh.read().decode("utf-8"))
    except BadZipFile as exc:
        raise ValueError(f"{save_path.name} is not a readable .zds/zip archive.") from exc



def _is_image_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in SCREENSHOT_EXTENSIONS


def _screenshot_folder_score(wad_name: str, folder: Path) -> float:
    score = _folder_score(wad_name, folder)
    try:
        if any(_is_image_file(child) for child in folder.iterdir()):
            score += 0.12
    except Exception:
        pass
    return score


def _detect_screenshot_folder(root: Path, wad_name: str) -> dict:
    if not root.exists():
        raise FileNotFoundError(f"Default screenshot folder does not exist: {root}")
    if not root.is_dir():
        raise NotADirectoryError(f"Default screenshot path is not a folder: {root}")

    candidates: list[dict] = []
    for folder, dirnames, _filenames in os.walk(root):
        folder_path = Path(folder)
        depth = len(folder_path.relative_to(root).parts)
        if depth >= 5:
            dirnames[:] = []
        score = _screenshot_folder_score(wad_name, folder_path)
        if folder_path == root and score < 0.92:
            score = max(score, 0.12)
        if score >= 0.42 or folder_path == root:
            try:
                modified = folder_path.stat().st_mtime
            except OSError:
                modified = 0
            candidates.append({
                "name": folder_path.name,
                "path": str(folder_path),
                "score": round(score, 3),
                "modifiedTime": modified,
            })

    candidates.sort(key=lambda item: (item["score"], item["modifiedTime"]), reverse=True)
    if not candidates:
        raise FileNotFoundError(f"No screenshot folder candidates found under: {root}")
    return {"bestMatch": candidates[0], "candidates": candidates[:10]}



def _setting_path(settings: dict, *keys: str) -> str:
    for key in keys:
        value = str(settings.get(key) or "").strip()
        if value:
            return value
    return ""

def _scan_launch_files(mods_folder_raw: str = "", additional_files_folder_raw: str = "", additional_root_raw: str = "", additional_subfolder: str = "") -> dict:
    local_settings = _load_settings()
    mods_folder_raw = str(mods_folder_raw or "").strip() or _setting_path(local_settings, "modsFolder", "globalModsFolder", "modFolder", "modsPath")
    additional_files_folder_raw = str(additional_files_folder_raw or "").strip()
    if not additional_files_folder_raw:
        root = str(additional_root_raw or "").strip() or _setting_path(local_settings, "additionalFilesFolder", "additionalFilesRoot", "additionalFilesPath", "additionalFiles")
        sub = str(additional_subfolder or "").strip().strip("/\\")
        additional_files_folder_raw = str(Path(os.path.expanduser(root)) / sub) if root and sub else root

    def scan_folder(raw: str, label: str) -> tuple[list[dict], str, list[dict]]:
        raw = str(raw or "").strip()
        if not raw:
            return [], "", [{"folder": label, "reason": "Folder not set."}]
        folder = Path(os.path.expanduser(raw)).resolve()
        if not folder.exists():
            return [], str(folder), [{"folder": label, "reason": f"Folder does not exist: {folder}"}]
        if not folder.is_dir():
            return [], str(folder), [{"folder": label, "reason": f"Path is not a folder: {folder}"}]
        found = []
        max_depth = 8
        for root, dirnames, filenames in os.walk(folder):
            root_path = Path(root)
            depth = len(root_path.relative_to(folder).parts)
            if depth >= max_depth:
                dirnames[:] = []
            for filename in sorted(filenames, key=str.lower):
                path = root_path / filename
                if path.suffix.lower() not in DOOM_MOD_EXTENSIONS:
                    continue
                rel = str(path.relative_to(folder)).replace('\\', '/')
                try:
                    stat = path.stat()
                    found.append({
                        "fileName": filename,
                        "path": str(path),
                        "relativePath": rel,
                        "size": stat.st_size,
                        "modifiedTime": int(stat.st_mtime),
                    })
                except OSError:
                    continue
        found.sort(key=lambda item: item["relativePath"].lower())
        return found, str(folder), []

    global_mods, mods_folder, mod_warnings = scan_folder(mods_folder_raw, "Mods folder")
    additional_files, additional_folder, additional_warnings = scan_folder(additional_files_folder_raw, "Additional files folder")
    return {
        "globalMods": global_mods,
        "additionalFiles": additional_files,
        "modsFolder": mods_folder,
        "additionalFilesFolder": additional_folder,
        "warnings": mod_warnings + additional_warnings,
    }

def _scan_screenshot_folder(folder: Path) -> dict:
    if not folder.exists():
        raise FileNotFoundError(f"Screenshot folder does not exist: {folder}")
    if not folder.is_dir():
        raise NotADirectoryError(f"Screenshot path is not a folder: {folder}")

    screenshots = []
    for child in folder.iterdir():
        if not _is_image_file(child):
            continue
        try:
            stat = child.stat()
        except OSError:
            continue
        screenshots.append({
            "fileName": child.name,
            "filePath": str(child.resolve()),
            "modifiedTime": stat.st_mtime,
            "sizeBytes": stat.st_size,
            "mimeType": mimetypes.guess_type(str(child))[0] or "image/png",
        })
    screenshots.sort(key=lambda item: item["modifiedTime"], reverse=True)
    return {"folderPath": str(folder), "screenshots": screenshots}


def _serve_image_file(handler: SimpleHTTPRequestHandler, raw_path: str) -> None:
    target = Path(os.path.expanduser(raw_path)).resolve()
    if not _is_image_file(target):
        raise FileNotFoundError("Screenshot image was not found or is not a supported image file.")
    data = target.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", mimetypes.guess_type(str(target))[0] or "image/png")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(data)


def _companion_txt_path(mod_path: Path, metadata_folder: str = '') -> tuple[Path | None, str]:
    """Find exact companion TXT, including after it was moved into metadata subfolders."""
    folder_raw = str(metadata_folder or '').strip()
    expected = f"{mod_path.stem}.txt" if mod_path.name else ""
    if not folder_raw or not expected:
        return None, expected

    folder = Path(os.path.expanduser(folder_raw)).resolve()
    if not folder.exists():
        raise FileNotFoundError(f"Metadata TXT folder does not exist: {folder}")
    if not folder.is_dir():
        raise NotADirectoryError(f"Metadata TXT path is not a folder: {folder}")

    exact = folder / expected
    if exact.exists() and exact.is_file():
        return exact.resolve(), expected

    expected_lower = expected.lower()
    try:
        for child in folder.iterdir():
            if child.is_file() and child.name.lower() == expected_lower:
                return child.resolve(), expected
    except OSError:
        pass

    found = _find_file_recursive(folder, expected, {'.txt'})
    if found:
        return found.resolve(), expected
    return None, expected


def _read_companion_txt(mod_path: Path, metadata_folder: str = '') -> dict:
    txt_path, expected = _companion_txt_path(mod_path, metadata_folder)
    if not txt_path:
        return {"found": False, "expectedFileName": expected, "content": ""}
    raw = txt_path.read_bytes()
    content = raw.decode("utf-8", errors="replace")
    return {
        "found": True,
        "expectedFileName": expected,
        "fileName": txt_path.name,
        "filePath": str(txt_path),
        "content": content,
    }


def _safe_delete_file(path: Path) -> dict:
    path = path.resolve()
    if not path.exists():
        return {"path": str(path), "deleted": False, "reason": "not found"}
    if not path.is_file():
        return {"path": str(path), "deleted": False, "reason": "not a file"}
    path.unlink()
    return {"path": str(path), "deleted": True}


def _delete_associated_files(payload: dict) -> dict:
    deleted = []
    errors = []
    wad_raw = str(payload.get("wadPath", "")).strip()
    metadata_folder = str(payload.get("metadataFolder", "")).strip()
    titlepics_folder = str(payload.get("titlepicsFolder", "")).strip()
    titlepic_name = Path(str(payload.get("titlePicFileName", ""))).name

    if wad_raw:
        try:
            wad_path = Path(os.path.expanduser(wad_raw)).resolve()
            # Only delete actual mod containers we explicitly support.
            if wad_path.suffix.lower() in {'.wad', '.pk3'}:
                deleted.append(_safe_delete_file(wad_path))
            if metadata_folder:
                txt_path, _expected = _companion_txt_path(wad_path, metadata_folder)
                if txt_path:
                    deleted.append(_safe_delete_file(txt_path))
        except Exception as exc:
            errors.append(str(exc))

    if titlepics_folder and titlepic_name:
        try:
            folder = _ensure_titlepics_folder(titlepics_folder)
            target = (folder / titlepic_name).resolve()
            if target.parent != folder:
                raise ValueError("Invalid titlepic filename.")
            deleted.append(_safe_delete_file(target))
        except Exception as exc:
            errors.append(str(exc))

    return {"deleted": deleted, "errors": errors}



def _find_file_recursive(root: Path | None, filename: str, extensions: set[str] | None = None) -> Path | None:
    if not root or not filename:
        return None
    try:
        root = Path(root).expanduser().resolve()
        if not root.is_dir():
            return None
        target_name = filename.lower()
        for current, dirnames, filenames in os.walk(root):
            current_path = Path(current)
            try:
                depth = len(current_path.relative_to(root).parts)
            except Exception:
                depth = 0
            if depth >= 8:
                dirnames[:] = []
            for item in filenames:
                if item.lower() != target_name:
                    continue
                candidate = (current_path / item).resolve()
                if extensions and candidate.suffix.lower() not in extensions:
                    continue
                return candidate
    except Exception:
        return None
    return None


def _folder_exists(raw: str) -> bool:
    if not raw:
        return False
    try:
        return Path(os.path.expanduser(raw)).resolve().is_dir()
    except Exception:
        return False


def _find_folder_recursive(root: Path | None, folder_name: str) -> Path | None:
    if not root or not folder_name:
        return None
    try:
        root = Path(root).expanduser().resolve()
        if not root.is_dir():
            return None
        target = folder_name.lower()
        for current, dirnames, _filenames in os.walk(root):
            current_path = Path(current)
            try:
                depth = len(current_path.relative_to(root).parts)
            except Exception:
                depth = 0
            if depth >= 8:
                dirnames[:] = []
            for dirname in list(dirnames):
                if dirname.lower() == target:
                    return (current_path / dirname).resolve()
    except Exception:
        return None
    return None


def _queue_wad_remote_deletes(settings: dict, wad: dict) -> None:
    wad_path = str(wad.get("pwadPath") or wad.get("iwadPath") or "").strip()
    is_pwad = bool(str(wad.get("pwadPath") or "").strip())
    wad_name = Path(wad_path).name if wad_path else str(wad.get("pwadFileName") or wad.get("iwadFileName") or "").strip()
    if wad_name:
        root = _local_folder_for_category(settings, None, "pwads" if is_pwad else "iwads")
        remote = _remote_path_for_local(SYNC_ROOT_FOLDERS["pwads"] if is_pwad else SYNC_ROOT_FOLDERS["iwads"], Path(os.path.expanduser(wad_path)) if wad_path else Path(wad_name), root)
        _append_webdav_delete_tombstone(settings, remote)
        # Also queue the legacy flat remote path so older sync layouts do not resurrect the file.
        _append_webdav_delete_tombstone(settings, _remote_path(SYNC_ROOT_FOLDERS["pwads"] if is_pwad else SYNC_ROOT_FOLDERS["iwads"], wad_name))
        stem = Path(wad_name).stem
        if stem:
            metadata_root = _local_folder_for_category(settings, None, "metadata")
            stored_txt = str(wad.get("txtMetadataFile") or "").strip()
            if stored_txt:
                try:
                    _append_webdav_delete_tombstone(settings, _remote_path_for_local(SYNC_ROOT_FOLDERS["metadata"], Path(os.path.expanduser(stored_txt)), metadata_root))
                except Exception:
                    pass
            _append_webdav_delete_tombstone(settings, _remote_path(SYNC_ROOT_FOLDERS["metadata"], f"{stem}.txt"))
    titlepic = str(wad.get("titlePicFileName") or "").strip()
    if titlepic:
        _append_webdav_delete_tombstone(settings, _remote_path(SYNC_ROOT_FOLDERS["titlepics"], Path(titlepic).name))


def _check_missing_and_deleted_files(payload: dict | None = None) -> dict:
    app = _load_database()
    settings = app.setdefault("settings", {})
    results: list[dict] = []
    wads = [wad for wad in app.get("wads", []) if isinstance(wad, dict)]
    kept_wads = []
    changed = False

    pwad_root = _local_folder_for_category(settings, None, "pwads")
    iwad_root = _local_folder_for_category(settings, None, "iwads")
    metadata_root = _local_folder_for_category(settings, None, "metadata")
    titlepic_root = _local_folder_for_category(settings, None, "titlepics")
    save_root = Path(os.path.expanduser(str(settings.get("defaultRootSaveFolder") or ""))).resolve() if str(settings.get("defaultRootSaveFolder") or "").strip() else None
    screenshot_root = Path(os.path.expanduser(str(settings.get("defaultScreenshotFolder") or ""))).resolve() if str(settings.get("defaultScreenshotFolder") or "").strip() else None

    def result(wad: dict, kind: str, status: str, detail: str) -> None:
        results.append({"title": str(wad.get("title") or "Untitled WAD"), "kind": kind, "status": status, "detail": detail})

    for wad in wads:
        remove_wad = False
        title = str(wad.get("title") or "Untitled WAD")

        # Main WAD/PK3 or IWAD file. Missing mod containers remove the card because it can no longer be launched/refreshed safely.
        path_key = "pwadPath" if str(wad.get("pwadPath") or "").strip() else "iwadPath"
        raw_path = str(wad.get(path_key) or "").strip()
        if raw_path:
            try:
                path = Path(os.path.expanduser(raw_path)).resolve()
                if not path.is_file():
                    root = pwad_root if path_key == "pwadPath" else iwad_root
                    found = _find_file_recursive(root, path.name, {".wad", ".pk3"} if path_key == "pwadPath" else {".wad"})
                    if found:
                        sync_root = SYNC_ROOT_FOLDERS["pwads"] if path_key == "pwadPath" else SYNC_ROOT_FOLDERS["iwads"]
                        old_remote = _remote_path_for_local(sync_root, path, root)
                        new_remote = _remote_path_for_local(sync_root, found, root)
                        if old_remote != new_remote:
                            _append_webdav_move_tombstone(settings, old_remote, new_remote)
                            legacy_flat_remote = _remote_path(sync_root, path.name)
                            if legacy_flat_remote != old_remote and legacy_flat_remote != new_remote:
                                _append_webdav_move_tombstone(settings, legacy_flat_remote, new_remote)
                        wad[path_key] = str(found)
                        changed = True
                        result(wad, "File check", "Updated", f"Updated {path.name} location to {found}.")
                    else:
                        _queue_wad_remote_deletes(settings, wad)
                        remove_wad = True
                        changed = True
                        result(wad, "File check", "Deleted", f"{path.name} was missing and could not be found under the configured root folder. Removed WAD card and queued WebDAV delete.")
            except Exception as exc:
                result(wad, "File check", "Error", str(exc))
        if remove_wad:
            continue

        # Companion TXT: update stored preview/metadata path if the TXT was moved under
        # the metadata root. If it is gone, queue a remote delete.
        mod_path = str(wad.get("pwadPath") or wad.get("iwadPath") or "").strip()
        if mod_path and metadata_root:
            txt_name = f"{Path(mod_path).stem}.txt"
            previous_txt = str(wad.get("txtMetadataFile") or "").strip()
            try:
                found_txt, _expected_txt = _companion_txt_path(Path(os.path.expanduser(mod_path)).resolve(), str(metadata_root))
            except Exception:
                found_txt = None
            if found_txt:
                found_txt = found_txt.resolve()
                if previous_txt and Path(os.path.expanduser(previous_txt)).name.lower() == found_txt.name.lower():
                    previous_path = Path(os.path.expanduser(previous_txt)).resolve()
                    old_remote = _remote_path_for_local(SYNC_ROOT_FOLDERS["metadata"], previous_path, metadata_root)
                    new_remote = _remote_path_for_local(SYNC_ROOT_FOLDERS["metadata"], found_txt, metadata_root)
                    if old_remote != new_remote:
                        _append_webdav_move_tombstone(settings, old_remote, new_remote)
                        legacy_flat_remote = _remote_path(SYNC_ROOT_FOLDERS["metadata"], found_txt.name)
                        if legacy_flat_remote != old_remote and legacy_flat_remote != new_remote:
                            _append_webdav_move_tombstone(settings, legacy_flat_remote, new_remote)
                if wad.get("txtMetadataFile") != str(found_txt) or wad.get("txtMetadataFileName") != found_txt.name:
                    wad["txtMetadataFile"] = str(found_txt)
                    wad["txtMetadataFileName"] = found_txt.name
                    changed = True
                    result(wad, "Metadata TXT", "Updated", f"Updated companion TXT location to {found_txt}.")
                else:
                    result(wad, "Metadata TXT", "Found", f"Found companion TXT at {found_txt}.")
            else:
                # Companion TXT files are optional. Most /idgames uploads have one, but
                # official IWADs/expansions and non-/idgames releases often do not.
                # Only treat this as a real change when a stale TXT path was already
                # stored in the database; otherwise keep Refresh All quiet.
                if previous_txt:
                    _append_webdav_delete_tombstone(settings, _remote_path(SYNC_ROOT_FOLDERS["metadata"], txt_name))
                    if wad.get("txtMetadataFile") or wad.get("txtMetadataFileName"):
                        wad["txtMetadataFile"] = ""
                        wad["txtMetadataFileName"] = ""
                    changed = True
                    result(wad, "Metadata TXT", "Updated", f"Removed stale companion TXT link for {txt_name}; no current TXT was found.")
                else:
                    result(wad, "Metadata TXT", "Optional", f"No companion TXT found for {txt_name}; this is normal for official or non-/idgames WADs.")

        # Titlepic PNG: clear the database reference if the PNG is gone and cannot be found.
        titlepic = str(wad.get("titlePicFileName") or "").strip()
        if titlepic and titlepic_root:
            expected = titlepic_root / Path(titlepic).name
            if not expected.is_file():
                found = _find_file_recursive(titlepic_root, Path(titlepic).name, {".png"})
                if found and found.parent == titlepic_root:
                    result(wad, "Titlepic", "Found", f"Found titlepic PNG at {found}.")
                elif found:
                    # The titlepic endpoint expects root-level PNG filenames, so keep the reference but report the mismatch.
                    result(wad, "Titlepic", "Warning", f"Found {titlepic} in a subfolder, but titlepics must be in the configured Titlepics root folder to display.")
                else:
                    _append_webdav_delete_tombstone(settings, _remote_path(SYNC_ROOT_FOLDERS["titlepics"], Path(titlepic).name))
                    wad["titlePicFileName"] = ""
                    wad["titlePicPath"] = ""
                    changed = True
                    result(wad, "Titlepic", "Deleted", f"{titlepic} was missing. Cleared titlepic reference and queued WebDAV delete.")

        # Save/screenshot folders: update moved folders by folder name; clear missing folders.
        for field, root, label in (("saveFolderPath", save_root, "Local Save Folder"), ("screenshotFolderPath", screenshot_root, "Screenshot Folder")):
            raw_folder = str(wad.get(field) or "").strip()
            if not raw_folder:
                continue
            if _folder_exists(raw_folder):
                continue
            folder_name = Path(raw_folder).name
            found_folder = _find_folder_recursive(root, folder_name)
            if found_folder:
                wad[field] = str(found_folder)
                changed = True
                result(wad, label, "Updated", f"Updated folder location to {found_folder}.")
            else:
                wad[field] = ""
                changed = True
                result(wad, label, "Missing", f"{folder_name} was not found under the configured root folder. Cleared this folder path.")

        kept_wads.append(wad)

    if len(kept_wads) != len(wads):
        app["wads"] = kept_wads
        changed = True
    if changed:
        app["settings"] = settings
        _save_database(app)
    if not results:
        results.append({"title": "File check", "kind": "Missing/deleted files", "status": "Checked", "detail": "No missing or moved linked files were found."})
    return {"results": results, "changed": changed, "app": _load_database()}


def _delete_unassociated_files(payload: dict) -> dict:
    deleted: list[dict] = []
    skipped: list[dict] = []
    errors: list[str] = []
    tombstoned: list[dict] = []
    app = _load_database()
    settings = app.setdefault("settings", {})

    def mark_remote_delete(folder_key: str, file_name: str, local_path: Path) -> None:
        root = None
        if folder_key == "pwads":
            root = Path(os.path.expanduser(str(payload.get("pwadFolder") or ""))).resolve() if str(payload.get("pwadFolder") or "").strip() else None
        elif folder_key == "metadata":
            root = Path(os.path.expanduser(str(payload.get("metadataFolder") or ""))).resolve() if str(payload.get("metadataFolder") or "").strip() else None
        elif folder_key == "titlepics":
            root = Path(os.path.expanduser(str(payload.get("titlepicsFolder") or ""))).resolve() if str(payload.get("titlepicsFolder") or "").strip() else None
        remote = _remote_path_for_local(SYNC_ROOT_FOLDERS[folder_key], local_path, root)
        _append_webdav_delete_tombstone(settings, remote)
        flat_remote = _remote_path(SYNC_ROOT_FOLDERS[folder_key], Path(file_name).name)
        if flat_remote != remote:
            _append_webdav_delete_tombstone(settings, flat_remote)
        tombstoned.append({"remote": remote, "local": str(local_path)})

    associated_wads = {_canonical_path(path) for path in payload.get("associatedWadPaths", []) if str(path or '').strip()}
    associated_titlepics = {Path(str(name)).name.lower() for name in payload.get("associatedTitlepicFiles", []) if str(name or '').strip()}
    associated_txt_names = set()

    metadata_raw = str(payload.get("metadataFolder", "")).strip()
    metadata_folder = Path(os.path.expanduser(metadata_raw)).resolve() if metadata_raw else None

    # Companion TXT files are associated by WAD/PK3 basename, e.g. TNTO.wad -> TNTO.txt.
    for raw in payload.get("associatedWadPaths", []):
        if not str(raw or '').strip():
            continue
        try:
            wad_path = Path(os.path.expanduser(str(raw))).resolve()
            if wad_path.suffix.lower() in {'.wad', '.pk3'}:
                associated_txt_names.add(f"{wad_path.stem.lower()}.txt")
        except Exception:
            continue

    pwad_raw = str(payload.get("pwadFolder", "")).strip()
    if pwad_raw:
        try:
            pwad_folder = Path(os.path.expanduser(pwad_raw)).resolve()
            if pwad_folder.exists() and pwad_folder.is_dir():
                for root, dirnames, filenames in os.walk(pwad_folder):
                    root_path = Path(root)
                    depth = len(root_path.relative_to(pwad_folder).parts)
                    if depth >= 6:
                        dirnames[:] = []
                    for filename in sorted(filenames, key=str.lower):
                        if not filename.lower().endswith(('.wad', '.pk3')):
                            continue
                        path = (root_path / filename).resolve()
                        if _canonical_path(str(path)) in associated_wads:
                            skipped.append({"path": str(path), "reason": "associated WAD/PK3"})
                        else:
                            result = _safe_delete_file(path)
                            deleted.append(result)
                            if result.get("deleted"):
                                mark_remote_delete("pwads", path.name, path)
            else:
                errors.append(f"Default PWAD path is not a folder: {pwad_folder}")
        except Exception as exc:
            errors.append(str(exc))

    if metadata_folder:
        try:
            if metadata_folder.exists() and metadata_folder.is_dir():
                for path in sorted(metadata_folder.rglob('*.txt'), key=lambda item: str(item).lower()):
                    if path.name.lower() in associated_txt_names:
                        skipped.append({"path": str(path), "reason": "associated companion TXT"})
                    else:
                        result = _safe_delete_file(path)
                        deleted.append(result)
                        if result.get("deleted"):
                            mark_remote_delete("metadata", path.name, path)
            else:
                errors.append(f"Metadata TXT folder is not a folder: {metadata_folder}")
        except Exception as exc:
            errors.append(str(exc))

    titlepics_raw = str(payload.get("titlepicsFolder", "")).strip()
    if titlepics_raw:
        try:
            titlepics_folder = Path(os.path.expanduser(titlepics_raw)).resolve()
            if titlepics_folder.exists() and titlepics_folder.is_dir():
                for path in sorted(titlepics_folder.glob('*.png'), key=lambda item: item.name.lower()):
                    if path.name.lower() in associated_titlepics:
                        skipped.append({"path": str(path), "reason": "associated titlepic PNG"})
                    else:
                        result = _safe_delete_file(path)
                        deleted.append(result)
                        if result.get("deleted"):
                            mark_remote_delete("titlepics", path.name, path)
            else:
                errors.append(f"Titlepics folder is not a folder: {titlepics_folder}")
        except Exception as exc:
            errors.append(str(exc))

    if tombstoned:
        app["settings"] = settings
        _save_database(app)

    return {"deleted": deleted, "skipped": skipped, "errors": errors, "tombstoned": tombstoned, "app": app}



def _join_webdav_url(base_url: str, remote_path: str = "") -> str:
    """Join a WebDAV base URL and optional remote path without losing URL parts."""
    base = str(base_url or "").strip()
    extra = str(remote_path or "").strip()
    if not base:
        raise ValueError("WebDAV server URL is not set.")
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("WebDAV server URL must start with http:// or https:// and include a host.")
    base_path = unquote(parsed.path or "")
    parts = [part for part in base_path.split("/") if part]
    parts.extend(part for part in extra.replace("\\", "/").split("/") if part)
    joined_path = "/" + "/".join(quote(part) for part in parts) if parts else ""
    rebuilt = parsed._replace(path=joined_path, params="", query="", fragment="").geturl()
    return rebuilt.rstrip("/")


def _test_webdav_connection(settings: dict | None) -> dict:
    """Verify that the configured WebDAV endpoint is reachable without creating folders."""
    settings = settings or {}
    base_url = _join_webdav_url(settings.get("webdavUrl", ""), settings.get("webdavRemotePath", ""))
    opener = _webdav_opener(
        base_url,
        str(settings.get("webdavUsername") or ""),
        str(settings.get("webdavPassword") or ""),
        settings.get("webdavVerifySsl") is not False,
    )
    test_url = _webdav_folder_url(base_url)
    body = b'<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getlastmodified/></D:prop></D:propfind>'
    headers = {"Depth": "0", "Content-Type": "application/xml; charset=utf-8"}
    try:
        with _webdav_request(opener, test_url, "PROPFIND", data=body, headers=headers, timeout=30) as response:
            return {"ok": True, "method": "PROPFIND", "status": getattr(response, "status", 207), "url": test_url}
    except HTTPError as exc:
        if exc.code in {405, 501}:
            try:
                with _webdav_request(opener, test_url, "HEAD", timeout=20) as response:
                    return {"ok": True, "method": "HEAD", "status": getattr(response, "status", 200), "url": test_url}
            except Exception as head_exc:
                raise ValueError(f"WebDAV test failed: HTTP {exc.code}; HEAD fallback failed: {head_exc}") from head_exc
        raise ValueError(f"WebDAV test failed: HTTP {exc.code} {exc.reason}") from exc
    except URLError as exc:
        raise ValueError(f"WebDAV test failed: {exc.reason}") from exc

def _webdav_opener(url: str, username: str = "", password: str = "", verify_ssl: bool = True):
    handlers = []
    if url.startswith("https://") and not verify_ssl:
        handlers.append(HTTPSHandler(context=ssl._create_unverified_context()))
    if username or password:
        password_mgr = HTTPPasswordMgrWithDefaultRealm()
        password_mgr.add_password(None, url, username, password)
        handlers.extend([HTTPBasicAuthHandler(password_mgr), HTTPDigestAuthHandler(password_mgr)])
    return build_opener(*handlers)


def _webdav_request(opener, url: str, method: str = "GET", data: bytes | None = None, headers: dict | None = None, timeout: int = 30):
    return opener.open(Request(url, data=data, headers=headers or {}, method=method), timeout=timeout)


def _webdav_folder_url(base_url: str, folder: str = "") -> str:
    base = base_url.rstrip("/")
    if not folder:
        return base + "/"
    return base + "/" + "/".join(quote(part) for part in folder.strip("/").split("/") if part) + "/"


def _webdav_file_url(base_url: str, folder: str, filename: str) -> str:
    return _webdav_folder_url(base_url, folder).rstrip("/") + "/" + quote(Path(filename).name)


def _webdav_stat(opener, url: str) -> dict | None:
    try:
        with _webdav_request(opener, url, "HEAD", timeout=20) as response:
            headers = response.headers
            modified = 0.0
            if headers.get("Last-Modified"):
                try:
                    modified = parsedate_to_datetime(headers.get("Last-Modified")).timestamp()
                except Exception:
                    modified = 0.0
            size = None
            if headers.get("Content-Length"):
                try:
                    size = int(headers.get("Content-Length"))
                except Exception:
                    size = None
            return {"exists": True, "size": size, "modified": modified, "etag": headers.get("ETag", "")}
    except HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    except Exception:
        return None


def _webdav_exists(opener, url: str) -> bool:
    return _webdav_stat(opener, url) is not None


def _webdav_mkcol(opener, url: str) -> bool:
    try:
        _webdav_request(opener, url, "MKCOL", timeout=20).close()
        return True
    except HTTPError as exc:
        if exc.code in {405, 301, 302}:
            return False
        raise


def _webdav_delete(opener, url: str) -> bool:
    try:
        _webdav_request(opener, url, "DELETE", timeout=30).close()
        return True
    except HTTPError as exc:
        if exc.code == 404:
            return False
        raise


def _webdav_move(opener, source_url: str, dest_url: str, overwrite: bool = True) -> bool:
    try:
        headers = {"Destination": dest_url, "Overwrite": "T" if overwrite else "F"}
        _webdav_request(opener, source_url, "MOVE", headers=headers, timeout=60).close()
        return True
    except HTTPError as exc:
        if exc.code == 404:
            return False
        raise


def _webdav_list_children(opener, folder_url: str) -> list[str]:
    body = b'''<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>'''
    try:
        with _webdav_request(opener, folder_url, "PROPFIND", data=body, headers={"Depth": "1"}, timeout=30) as response:
            xml_body = response.read()
    except HTTPError as exc:
        if exc.code == 404:
            return []
        raise
    except Exception:
        return []
    try:
        root = ET.fromstring(xml_body)
    except Exception:
        return []
    hrefs = []
    for href_el in root.findall(".//{DAV:}href"):
        href = href_el.text or ""
        if not href:
            continue
        if href.startswith("http://") or href.startswith("https://"):
            full = href
        else:
            parsed_base = urlparse(folder_url)
            full = f"{parsed_base.scheme}://{parsed_base.netloc}{href}"
        if full.rstrip("/") != folder_url.rstrip("/"):
            hrefs.append(full)
    return hrefs


def _webdav_ensure_folder_path(opener, base_url: str, folder_path: str, report: list[dict] | None = None) -> str:
    current = base_url.rstrip("/")
    built = []
    for part in [p for p in folder_path.strip("/").split("/") if p]:
        built.append(part)
        current = current.rstrip("/") + "/" + quote(part) + "/"
        try:
            created = _webdav_mkcol(opener, current)
            if report is not None and created:
                report.append({"action": "created-folder", "remote": "/".join(built)})
        except HTTPError as exc:
            if exc.code == 405:
                continue
            raise
    return _webdav_folder_url(base_url, folder_path)


def _webdav_cleanup_temps(opener, folder_url: str) -> int:
    deleted = 0
    for child_url in _webdav_list_children(opener, folder_url):
        if unquote(child_url).endswith(SYNC_TEMP_SUFFIX):
            if _webdav_delete(opener, child_url):
                deleted += 1
    return deleted


def _local_file_changed(local_path: Path, remote_stat: dict | None) -> bool:
    if remote_stat is None:
        return True
    try:
        size = local_path.stat().st_size
        mtime = local_path.stat().st_mtime
    except OSError:
        return False
    if remote_stat.get("size") is not None and int(remote_stat.get("size") or -1) != size:
        return True
    remote_mtime = float(remote_stat.get("modified") or 0)
    if remote_mtime and mtime > remote_mtime + 1:
        return True
    return False





def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _bytes_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _webdav_read_bytes(opener, url: str, timeout: int = 300) -> bytes:
    with _webdav_request(opener, url, "GET", timeout=timeout) as response:
        return response.read()


def _webdav_remote_sha256(opener, url: str) -> str | None:
    try:
        return _bytes_sha256(_webdav_read_bytes(opener, url))
    except Exception:
        return None


def _local_remote_hash_match(opener, remote_url: str, local_path: Path) -> bool:
    try:
        if not Path(local_path).is_file():
            return False
        remote_hash = _webdav_remote_sha256(opener, remote_url)
        return bool(remote_hash and remote_hash == _file_sha256(Path(local_path)))
    except Exception:
        return False



def _webdav_manifest(settings: dict) -> dict:
    manifest = settings.get("_webdavSyncManifest")
    if not isinstance(manifest, dict):
        manifest = {}
        settings["_webdavSyncManifest"] = manifest
    return manifest


def _safe_remote_relative_name(value: str) -> str:
    raw = str(value or '').replace('\\', '/').strip('/')
    parts = []
    for part in raw.split('/'):
        if not part or part in {'.', '..'}:
            continue
        parts.append(part)
    return '/'.join(parts)


def _manifest_key(folder_path: str, name: str) -> str:
    rel = _safe_remote_relative_name(name) or Path(str(name)).name
    return f"{str(folder_path).strip('/')}/{rel}"


def _relative_name_under_root(root: Path | None, path: Path) -> str:
    try:
        if root:
            root = Path(root).expanduser().resolve()
            path = Path(path).expanduser().resolve()
            return path.relative_to(root).as_posix()
    except Exception:
        pass
    return Path(path).name


def _remote_path_for_local(folder_path: str, local_path: Path, local_root: Path | None = None) -> str:
    return _remote_path(folder_path, _relative_name_under_root(local_root, local_path))


def _manifest_hash(settings: dict, remote_path: str) -> str:
    entry = _webdav_manifest(settings).get(remote_path)
    if isinstance(entry, dict):
        return str(entry.get("hash") or "")
    if isinstance(entry, str):
        return entry
    return ""


def _manifest_set(settings: dict, remote_path: str, file_hash: str, local_path: str = "") -> None:
    if not file_hash:
        return
    _webdav_manifest(settings)[remote_path] = {
        "hash": file_hash,
        "localPath": local_path,
        "syncedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def _manifest_remove(settings: dict, remote_path: str) -> None:
    try:
        _webdav_manifest(settings).pop(remote_path, None)
    except Exception:
        pass


def _remote_path(folder_path: str, name: str) -> str:
    return _manifest_key(folder_path, name)

def _remote_child_name(child_url: str) -> str:
    try:
        path = urlparse(child_url).path.rstrip("/")
        return unquote(Path(path).name)
    except Exception:
        return ""


def _webdav_list_files(opener, folder_url: str, extensions: set[str] | None = None) -> list[dict]:
    results = []
    for child_url in _webdav_list_children(opener, folder_url):
        if child_url.endswith("/"):
            continue
        name = _remote_child_name(child_url)
        if not name or name.endswith(SYNC_TEMP_SUFFIX):
            continue
        if extensions and Path(name).suffix.lower() not in extensions:
            continue
        stat = _webdav_stat(opener, child_url) or {}
        results.append({"url": child_url, "name": name, "stat": stat})
    return results


def _remote_file_newer_or_different(remote_stat: dict | None, local_path: Path) -> bool:
    if not remote_stat:
        return False
    if not local_path.exists():
        return True
    try:
        local_size = local_path.stat().st_size
        local_mtime = local_path.stat().st_mtime
    except OSError:
        return True
    if remote_stat.get("size") is not None and int(remote_stat.get("size") or -1) != local_size:
        return True
    remote_mtime = float(remote_stat.get("modified") or 0)
    if remote_mtime and remote_mtime > local_mtime + 1:
        return True
    return False


def _webdav_download_file_atomic(opener, remote_url: str, local_path: Path, remote_stat: dict | None = None) -> dict:
    local_path = Path(local_path).expanduser().resolve()
    local_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = local_path.with_name(f".{local_path.name}.doomtracker-download.tmp")
    if tmp_path.exists():
        tmp_path.unlink()
    with _webdav_request(opener, remote_url, "GET", timeout=300) as response:
        data = response.read()
    tmp_path.write_bytes(data)
    expected = None
    if remote_stat and remote_stat.get("size") is not None:
        expected = int(remote_stat.get("size"))
    if expected is not None and tmp_path.stat().st_size != expected:
        try:
            tmp_path.unlink()
        except Exception:
            pass
        raise ValueError(f"Download verification failed for {remote_url}.")
    tmp_path.replace(local_path)
    return {"action": "downloaded", "local": str(local_path), "remote": remote_url, "sizeBytes": len(data)}


def _webdav_delete_tombstones(opener, base_url: str, app: dict) -> tuple[list[dict], list[dict]]:
    settings = app.setdefault("settings", {})
    tombstones = settings.get("webdavDeletedFiles") if isinstance(settings.get("webdavDeletedFiles"), list) else []
    remaining = []
    deleted = []
    errors = []
    changed = False
    for entry in tombstones:
        if not isinstance(entry, dict):
            changed = True
            continue
        remote = str(entry.get("remote") or "").strip().strip("/")
        if not remote:
            changed = True
            continue
        try:
            url = base_url.rstrip("/") + "/" + "/".join(quote(part) for part in remote.split("/") if part)
            did_delete = _webdav_delete(opener, url)
            # Only report real remote deletes. If the remote file was already gone,
            # silently clear the tombstone so optional TXT metadata that never
            # existed remotely does not keep cluttering Sync Results.
            if did_delete:
                deleted.append({"action": "remote-deleted", "remote": remote, "deleted": True})
            changed = True
        except Exception as exc:
            errors.append({"remote": remote, "error": str(exc)})
            remaining.append(entry)
    settings["webdavDeletedFiles"] = remaining
    if changed or len(remaining) != len(tombstones):
        _save_database(app)
    return deleted, errors

def _append_webdav_delete_tombstone(settings: dict, remote_path: str) -> None:
    remote = str(remote_path or "").strip().strip("/")
    if not remote:
        return
    tombstones = settings.get("webdavDeletedFiles") if isinstance(settings.get("webdavDeletedFiles"), list) else []
    existing = {str(entry.get("remote") or "").strip().strip("/") for entry in tombstones if isinstance(entry, dict)}
    if remote not in existing:
        tombstones.append({"remote": remote, "deletedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    settings["webdavDeletedFiles"] = tombstones


def _append_webdav_move_tombstone(settings: dict, from_remote: str, to_remote: str) -> None:
    source = str(from_remote or "").strip().strip("/")
    dest = str(to_remote or "").strip().strip("/")
    if not source or not dest or source == dest:
        return
    moves = settings.get("webdavMovedFiles") if isinstance(settings.get("webdavMovedFiles"), list) else []
    existing = {(str(entry.get("from") or "").strip().strip("/"), str(entry.get("to") or "").strip().strip("/")) for entry in moves if isinstance(entry, dict)}
    if (source, dest) not in existing:
        moves.append({"from": source, "to": dest, "movedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    settings["webdavMovedFiles"] = moves


def _webdav_move_tombstones(opener, base_url: str, app: dict) -> tuple[list[dict], list[dict]]:
    settings = app.setdefault("settings", {})
    moves = settings.get("webdavMovedFiles") if isinstance(settings.get("webdavMovedFiles"), list) else []
    remaining = []
    moved = []
    errors = []
    for entry in moves:
        if not isinstance(entry, dict):
            continue
        source = str(entry.get("from") or "").strip().strip("/")
        dest = str(entry.get("to") or "").strip().strip("/")
        if not source or not dest or source == dest:
            continue
        try:
            source_url = base_url.rstrip("/") + "/" + "/".join(quote(part) for part in source.split("/") if part)
            dest_url = base_url.rstrip("/") + "/" + "/".join(quote(part) for part in dest.split("/") if part)
            dest_folder = "/".join(dest.split("/")[:-1])
            if dest_folder:
                _webdav_ensure_folder_path(opener, base_url, dest_folder)
            if _webdav_exists(opener, source_url):
                did_move = _webdav_move(opener, source_url, dest_url, overwrite=True)
                moved.append({"action": "remote-moved", "from": source, "to": dest, "moved": bool(did_move)})
            else:
                moved.append({"action": "remote-move-skipped", "from": source, "to": dest, "reason": "source missing"})
        except Exception as exc:
            errors.append({"from": source, "to": dest, "error": str(exc)})
            remaining.append(entry)
    settings["webdavMovedFiles"] = remaining
    if len(remaining) != len(moves):
        _save_database(app)
    return moved, errors


def _merge_settings_preserving_tombstones(current: dict, incoming: dict | None) -> dict:
    if not isinstance(incoming, dict):
        return current
    current_tombstones = current.get("webdavDeletedFiles") if isinstance(current.get("webdavDeletedFiles"), list) else []
    incoming_tombstones = incoming.get("webdavDeletedFiles") if isinstance(incoming.get("webdavDeletedFiles"), list) else []
    current_moves = current.get("webdavMovedFiles") if isinstance(current.get("webdavMovedFiles"), list) else []
    incoming_moves = incoming.get("webdavMovedFiles") if isinstance(incoming.get("webdavMovedFiles"), list) else []
    merged = {**current, **incoming}
    combined = []
    seen = set()
    for source in (current_tombstones, incoming_tombstones):
        for entry in source:
            if not isinstance(entry, dict):
                continue
            remote = str(entry.get("remote") or "").strip().strip("/")
            if not remote or remote in seen:
                continue
            seen.add(remote)
            combined.append({"remote": remote, "deletedAt": str(entry.get("deletedAt") or "")})
    merged["webdavDeletedFiles"] = combined

    move_combined = []
    move_seen = set()
    for source in (current_moves, incoming_moves):
        for entry in source:
            if not isinstance(entry, dict):
                continue
            source_remote = str(entry.get("from") or "").strip().strip("/")
            dest_remote = str(entry.get("to") or "").strip().strip("/")
            key = (source_remote, dest_remote)
            if not source_remote or not dest_remote or source_remote == dest_remote or key in move_seen:
                continue
            move_seen.add(key)
            move_combined.append({"from": source_remote, "to": dest_remote, "movedAt": str(entry.get("movedAt") or "")})
    merged["webdavMovedFiles"] = move_combined
    return merged


def _local_folder_for_category(settings: dict, wad: dict | None, category: str) -> Path | None:
    if category == "saves" and wad:
        raw = str(wad.get("saveFolderPath") or "").strip()
    elif category == "screenshots" and wad:
        raw = str(wad.get("screenshotFolderPath") or "").strip()
    elif category == "pwads":
        raw = str(settings.get("defaultPwadPath") or "").strip()
    elif category == "iwads":
        raw = str(settings.get("defaultIwadFolder") or settings.get("defaultIwadPath") or "").strip()
        if raw and Path(raw).suffix:
            raw = str(Path(raw).parent)
    elif category == "metadata":
        raw = str(settings.get("defaultMetadataFolder") or "").strip()
    elif category == "titlepics":
        raw = str(settings.get("defaultTitlepicsFolder") or "").strip()
    elif category == "mods":
        raw = str(settings.get("modsFolder") or "").strip()
    elif category == "additionalFiles":
        raw = str(settings.get("additionalFilesFolder") or "").strip()
    else:
        raw = ""
    return Path(os.path.expanduser(raw)).resolve() if raw else None


def _webdav_sync_folder_two_way(opener, base_url: str, folder_path: str, local_folder: Path | None, extensions: set[str], force_upload: bool, uploaded: list, downloaded: list, skipped: list, errors: list, folder_report: list, hash_check: bool = False, settings: dict | None = None, prefer_local_on_conflict: bool = False) -> None:
    settings = settings if isinstance(settings, dict) else {}
    if not local_folder:
        skipped.append({"action": "skipped", "remote": folder_path, "reason": "local folder not set"})
        return
    local_folder.mkdir(parents=True, exist_ok=True)
    _webdav_ensure_folder_path(opener, base_url, folder_path, folder_report)
    remote_url = _webdav_folder_url(base_url, folder_path)
    local_files = {p.name.lower(): p for p in _iter_files_with_ext(str(local_folder), extensions, recursive=False)}
    remote_files = {entry["name"].lower(): entry for entry in _webdav_list_files(opener, remote_url, extensions)}

    # Download missing/remote-only files. For protected folders like Saves, local edits win conflicts.
    for key, entry in remote_files.items():
        target = local_folder / entry["name"]
        rpath = _remote_path(folder_path, entry["name"])
        try:
            if target.exists() and prefer_local_on_conflict and not force_upload:
                last_hash = _manifest_hash(settings, rpath)
                local_hash = _file_sha256(target)
                local_changed = bool(last_hash and local_hash != last_hash) or not last_hash
                if _remote_file_newer_or_different(entry.get("stat"), target):
                    remote_hash = _webdav_remote_sha256(opener, entry["url"]) or ""
                    if remote_hash and remote_hash == local_hash:
                        _manifest_set(settings, rpath, local_hash, str(target))
                        skipped.append({"action": "skipped", "local": str(target), "remote": rpath, "reason": "hash match"})
                    elif local_changed:
                        skipped.append({"action": "skipped", "local": str(target), "remote": rpath, "reason": "local protected; will upload local"})
                    else:
                        downloaded.append(_webdav_download_file_atomic(opener, entry["url"], target, entry.get("stat")))
                        if remote_hash:
                            _manifest_set(settings, rpath, remote_hash, str(target))
                    local_files[key] = target
                else:
                    _manifest_set(settings, rpath, local_hash, str(target))
                    skipped.append({"action": "skipped", "local": str(target), "remote": rpath, "reason": "local current"})
                continue

            if _remote_file_newer_or_different(entry.get("stat"), target):
                if hash_check and target.exists() and _local_remote_hash_match(opener, entry["url"], target):
                    local_hash = _file_sha256(target)
                    _manifest_set(settings, rpath, local_hash, str(target))
                    skipped.append({"action": "skipped", "local": str(target), "remote": rpath, "reason": "hash match"})
                    local_files[key] = target
                else:
                    downloaded.append(_webdav_download_file_atomic(opener, entry["url"], target, entry.get("stat")))
                    remote_hash = _webdav_remote_sha256(opener, entry["url"]) or (_file_sha256(target) if target.exists() else "")
                    _manifest_set(settings, rpath, remote_hash, str(target))
                    local_files[key] = target
            else:
                if target.exists():
                    _manifest_set(settings, rpath, _file_sha256(target), str(target))
                skipped.append({"action": "skipped", "local": str(target), "remote": rpath, "reason": "local current"})
        except Exception as exc:
            errors.append({"local": str(target), "remote": rpath, "error": str(exc)})

    for key, path in local_files.items():
        rpath = _remote_path(folder_path, path.name)
        try:
            result = _webdav_upload_file_atomic(opener, base_url, folder_path, path, None, force=force_upload, hash_check=hash_check)
            if result.get("action") == "uploaded":
                uploaded.append(result)
            else:
                skipped.append(result)
            if result.get("action") in {"uploaded", "skipped"} and path.exists():
                _manifest_set(settings, rpath, _file_sha256(path), str(path))
        except Exception as exc:
            errors.append({"local": str(path), "remote": folder_path, "error": str(exc)})
def _webdav_upload_file_atomic(opener, base_url: str, folder_path: str, local_path: Path, remote_name: str | None = None, force: bool = False, hash_check: bool = False) -> dict:
    local_path = Path(local_path).expanduser().resolve()
    if not local_path.is_file():
        return {"action": "missing", "local": str(local_path), "remote": folder_path, "message": "Local file not found."}
    name = Path(remote_name or local_path.name).name
    _webdav_ensure_folder_path(opener, base_url, folder_path)
    final_url = _webdav_file_url(base_url, folder_path, name)
    tmp_name = f".{name}{SYNC_TEMP_SUFFIX}"
    tmp_url = _webdav_file_url(base_url, folder_path, tmp_name)
    _webdav_delete(opener, tmp_url)
    remote_stat = _webdav_stat(opener, final_url)
    if not force and not _local_file_changed(local_path, remote_stat):
        return {"action": "skipped", "local": str(local_path), "remote": f"{folder_path}/{name}", "reason": "unchanged"}
    if not force and hash_check and remote_stat and _local_remote_hash_match(opener, final_url, local_path):
        return {"action": "skipped", "local": str(local_path), "remote": f"{folder_path}/{name}", "reason": "hash match"}
    data = local_path.read_bytes()
    headers = {"Content-Type": mimetypes.guess_type(str(local_path))[0] or "application/octet-stream"}
    _webdav_request(opener, tmp_url, "PUT", data=data, headers=headers, timeout=300).close()
    tmp_stat = _webdav_stat(opener, tmp_url)
    if not tmp_stat or tmp_stat.get("size") != len(data):
        raise ValueError(f"Upload verification failed for temporary file {folder_path}/{tmp_name}.")
    _webdav_move(opener, tmp_url, final_url, overwrite=True)
    final_stat = _webdav_stat(opener, final_url)
    if not final_stat or final_stat.get("size") != len(data):
        raise ValueError(f"Upload verification failed after rename for {folder_path}/{name}.")
    return {"action": "uploaded", "local": str(local_path), "remote": f"{folder_path}/{name}", "sizeBytes": len(data)}


def _webdav_upload_bytes_atomic(opener, base_url: str, folder_path: str, remote_name: str, data: bytes, force: bool = False, hash_check: bool = False) -> dict:
    _webdav_ensure_folder_path(opener, base_url, folder_path)
    name = Path(remote_name).name
    final_url = _webdav_file_url(base_url, folder_path, name)
    tmp_name = f".{name}{SYNC_TEMP_SUFFIX}"
    tmp_url = _webdav_file_url(base_url, folder_path, tmp_name)
    _webdav_delete(opener, tmp_url)
    remote_stat = _webdav_stat(opener, final_url)
    if not force and remote_stat and remote_stat.get("size") == len(data):
        if not hash_check or _webdav_remote_sha256(opener, final_url) == _bytes_sha256(data):
            return {"action": "skipped", "remote": f"{folder_path}/{name}", "reason": "unchanged" if not hash_check else "hash match"}
    if not force and hash_check and remote_stat and _webdav_remote_sha256(opener, final_url) == _bytes_sha256(data):
        return {"action": "skipped", "remote": f"{folder_path}/{name}", "reason": "hash match"}
    _webdav_request(opener, tmp_url, "PUT", data=data, headers={"Content-Type": "application/json; charset=utf-8"}, timeout=300).close()
    tmp_stat = _webdav_stat(opener, tmp_url)
    if not tmp_stat or tmp_stat.get("size") != len(data):
        raise ValueError(f"Upload verification failed for temporary file {folder_path}/{tmp_name}.")
    _webdav_move(opener, tmp_url, final_url, overwrite=True)
    final_stat = _webdav_stat(opener, final_url)
    if not final_stat or final_stat.get("size") != len(data):
        raise ValueError(f"Upload verification failed after rename for {folder_path}/{name}.")
    return {"action": "uploaded", "remote": f"{folder_path}/{name}", "sizeBytes": len(data)}


def _iter_files_with_ext(folder_raw: str, extensions: set[str], recursive: bool = False) -> list[Path]:
    if not folder_raw:
        return []
    folder = Path(os.path.expanduser(folder_raw)).resolve()
    if not folder.is_dir():
        return []
    iterator = folder.rglob("*") if recursive else folder.iterdir()
    return sorted([p for p in iterator if p.is_file() and p.suffix.lower() in extensions], key=lambda p: str(p).lower())


def _wad_sync_slug(wad: dict) -> str:
    return _safe_slug(wad.get("title") or wad.get("pwadFileName") or wad.get("iwadFileName") or wad.get("id") or "wad", "wad")


def _candidate_companion_txt(settings: dict, wad: dict) -> Path | None:
    folder_raw = str(settings.get("defaultMetadataFolder") or "").strip()
    if not folder_raw:
        return None
    folder = Path(os.path.expanduser(folder_raw)).resolve()
    if not folder.is_dir():
        return None
    stems = []
    for key in ("pwadFileName", "pwadPath", "iwadFileName", "iwadPath", "title"):
        value = str(wad.get(key) or "").strip()
        if not value:
            continue
        stem = Path(value).stem if key.endswith("Path") or "." in value else value
        if stem and stem not in stems:
            stems.append(stem)
    for stem in stems:
        target = folder / f"{stem}.txt"
        if target.is_file():
            return target
        try:
            lower_matches = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() == ".txt" and p.stem.lower() == stem.lower()]
        except OSError:
            lower_matches = []
        if lower_matches:
            return sorted(lower_matches, key=lambda p: p.name.lower())[0]
    return None


def _stable_database_hash(app: dict) -> str:
    def cleanse(value):
        if isinstance(value, dict):
            cleaned = {}
            for k, v in value.items():
                if str(k) == "settings" or str(k).startswith("_webdav") or str(k).startswith("_lastWebdav"):
                    continue
                cleaned[k] = cleanse(v)
            return cleaned
        if isinstance(value, list):
            return [cleanse(v) for v in value]
        return value
    encoded = json.dumps(cleanse(app), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha1(encoded).hexdigest()




def _stable_database_hash_from_bytes(data: bytes) -> str:
    try:
        parsed = json.loads(data.decode("utf-8"))
        if isinstance(parsed, dict):
            return _stable_database_hash(parsed)
    except Exception:
        pass
    return hashlib.sha1(data).hexdigest()


def _remote_database_stable_hash(opener, remote_url: str) -> str | None:
    try:
        return _stable_database_hash_from_bytes(_webdav_read_bytes(opener, remote_url))
    except Exception:
        return None

def _rotate_database_backups(opener, base_url: str, report: list[dict]) -> None:
    folder = SYNC_ROOT_FOLDERS["database"]
    _webdav_ensure_folder_path(opener, base_url, folder, report)
    _webdav_delete(opener, _webdav_file_url(base_url, folder, "doom_tracker_database_backup_5.json"))
    for index in range(4, 0, -1):
        src = _webdav_file_url(base_url, folder, f"doom_tracker_database_backup_{index}.json")
        dst = _webdav_file_url(base_url, folder, f"doom_tracker_database_backup_{index + 1}.json")
        try:
            _webdav_move(opener, src, dst, overwrite=True)
        except Exception:
            pass
    main_url = _webdav_file_url(base_url, folder, "doom_tracker_database.json")
    backup1_url = _webdav_file_url(base_url, folder, "doom_tracker_database_backup_1.json")
    try:
        if _webdav_exists(opener, main_url):
            _webdav_move(opener, main_url, backup1_url, overwrite=True)
            report.append({"action": "rotated-backup", "remote": f"{folder}/doom_tracker_database_backup_1.json"})
    except Exception as exc:
        report.append({"action": "backup-warning", "remote": folder, "message": str(exc)})


def _sync_database_to_webdav(opener, base_url: str, app: dict, report: list[dict]) -> dict:
    folder = SYNC_ROOT_FOLDERS["database"]
    _webdav_ensure_folder_path(opener, base_url, folder, report)
    stable_hash = _stable_database_hash(app)
    settings = app.setdefault("settings", {}) if isinstance(app, dict) else {}
    remote_main = _webdav_file_url(base_url, folder, "doom_tracker_database.json")
    remote_exists = _webdav_exists(opener, remote_main)
    if remote_exists:
        remote_hash = _remote_database_stable_hash(opener, remote_main)
        if remote_hash and remote_hash == stable_hash:
            settings["_lastWebdavDatabaseHash"] = stable_hash
            settings["_lastWebdavSyncAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            _save_database(app)
            return {"action": "skipped", "remote": f"{folder}/doom_tracker_database.json", "reason": "database hash match"}
    if settings.get("_lastWebdavDatabaseHash") == stable_hash and remote_exists:
        return {"action": "skipped", "remote": f"{folder}/doom_tracker_database.json", "reason": "unchanged"}
    if remote_exists:
        _rotate_database_backups(opener, base_url, report)
    settings["_lastWebdavDatabaseHash"] = stable_hash
    settings["_lastWebdavSyncAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    _save_database(app)
    data = DATABASE_PATH.read_bytes()
    return _webdav_upload_bytes_atomic(opener, base_url, folder, "doom_tracker_database.json", data, force=True)



def _webdav_collect_remote_files_recursive(opener, folder_url: str, base_folder_url: str, extensions: set[str] | None = None) -> list[dict]:
    results: list[dict] = []
    for child_url in _webdav_list_children(opener, folder_url):
        if child_url.endswith('/'):
            results.extend(_webdav_collect_remote_files_recursive(opener, child_url, base_folder_url, extensions))
            continue
        name = _remote_child_name(child_url)
        if not name or name.endswith(SYNC_TEMP_SUFFIX):
            continue
        if extensions and Path(name).suffix.lower() not in extensions:
            continue
        rel_url = child_url[len(base_folder_url.rstrip('/') + '/'):] if child_url.startswith(base_folder_url.rstrip('/') + '/') else name
        rel = '/'.join(unquote(part) for part in rel_url.split('/') if part)
        stat = _webdav_stat(opener, child_url) or {}
        results.append({'url': child_url, 'name': name, 'relative': rel, 'stat': stat})
    return results


def _webdav_sync_folder_tree_two_way(opener, base_url: str, folder_path: str, local_folder: Path | None, extensions: set[str], force_upload: bool, uploaded: list, downloaded: list, skipped: list, errors: list, folder_report: list, hash_check: bool = False, settings: dict | None = None, prefer_local_on_conflict: bool = True) -> None:
    settings = settings if isinstance(settings, dict) else {}
    if not local_folder:
        skipped.append({'action': 'skipped', 'remote': folder_path, 'reason': 'local folder not set'})
        return
    local_folder = Path(local_folder).expanduser().resolve()
    local_folder.mkdir(parents=True, exist_ok=True)
    _webdav_ensure_folder_path(opener, base_url, folder_path, folder_report)
    remote_url = _webdav_folder_url(base_url, folder_path)
    local_files: dict[str, Path] = {}
    for path in _iter_files_with_ext(str(local_folder), extensions, recursive=True):
        try:
            rel = _safe_remote_relative_name(path.resolve().relative_to(local_folder).as_posix())
        except Exception:
            rel = _safe_remote_relative_name(path.name)
        if rel:
            local_files[rel.lower()] = path
    remote_files = {str(entry.get('relative') or entry.get('name') or '').lower(): entry for entry in _webdav_collect_remote_files_recursive(opener, remote_url, remote_url, extensions)}

    for key, entry in remote_files.items():
        rel = str(entry.get('relative') or entry.get('name') or '').strip('/').replace('\\', '/')
        if not rel:
            continue
        target = local_folder / Path(rel)
        rpath = _remote_path(folder_path, rel)
        try:
            local_files[key] = target
            if target.exists() and prefer_local_on_conflict and not force_upload:
                last_hash = _manifest_hash(settings, rpath)
                local_hash = _file_sha256(target)
                local_changed = bool(last_hash and local_hash != last_hash) or not last_hash
                if _remote_file_newer_or_different(entry.get('stat'), target):
                    remote_hash = _webdav_remote_sha256(opener, entry['url']) or ''
                    if remote_hash and remote_hash == local_hash:
                        _manifest_set(settings, rpath, local_hash, str(target))
                        skipped.append({'action': 'skipped', 'local': str(target), 'remote': rpath, 'reason': 'hash match'})
                    elif local_changed:
                        skipped.append({'action': 'skipped', 'local': str(target), 'remote': rpath, 'reason': 'local protected; will upload local'})
                    else:
                        downloaded.append(_webdav_download_file_atomic(opener, entry['url'], target, entry.get('stat')))
                        if remote_hash:
                            _manifest_set(settings, rpath, remote_hash, str(target))
                else:
                    _manifest_set(settings, rpath, local_hash, str(target))
                    skipped.append({'action': 'skipped', 'local': str(target), 'remote': rpath, 'reason': 'local current'})
                continue
            if _remote_file_newer_or_different(entry.get('stat'), target):
                if hash_check and target.exists() and _local_remote_hash_match(opener, entry['url'], target):
                    local_hash = _file_sha256(target)
                    _manifest_set(settings, rpath, local_hash, str(target))
                    skipped.append({'action': 'skipped', 'local': str(target), 'remote': rpath, 'reason': 'hash match'})
                else:
                    downloaded.append(_webdav_download_file_atomic(opener, entry['url'], target, entry.get('stat')))
                    remote_hash = _webdav_remote_sha256(opener, entry['url']) or (_file_sha256(target) if target.exists() else '')
                    _manifest_set(settings, rpath, remote_hash, str(target))
            else:
                if target.exists():
                    _manifest_set(settings, rpath, _file_sha256(target), str(target))
                skipped.append({'action': 'skipped', 'local': str(target), 'remote': rpath, 'reason': 'local current'})
        except Exception as exc:
            errors.append({'local': str(target), 'remote': rpath, 'error': str(exc)})

    for key, path in local_files.items():
        try:
            if not path.exists() or path.suffix.lower() not in extensions:
                continue
            rel = _safe_remote_relative_name(path.resolve().relative_to(local_folder).as_posix())
            parent_rel = '/'.join(rel.split('/')[:-1])
            name = rel.split('/')[-1]
            remote_folder = f'{folder_path}/{parent_rel}' if parent_rel else folder_path
            rpath = _remote_path(folder_path, rel)
            _webdav_ensure_folder_path(opener, base_url, remote_folder, folder_report)
            result = _webdav_upload_file_atomic(opener, base_url, remote_folder, path, name, force=force_upload, hash_check=hash_check)
            if result.get('action') == 'uploaded':
                uploaded.append(result)
            else:
                skipped.append(result)
            _manifest_set(settings, rpath, _file_sha256(path), str(path))
        except Exception as exc:
            errors.append({'local': str(path), 'remote': folder_path, 'error': str(exc)})
def _sync_single_library_file(opener, base_url: str, sync_root: str, local_path: Path, local_root: Path | None, extensions: set[str], force_upload: bool, uploaded: list, downloaded: list, skipped: list, errors: list, folder_report: list, hash_check: bool = False, settings: dict | None = None, prefer_local_on_conflict: bool = True) -> None:
    settings = settings if isinstance(settings, dict) else {}
    try:
        local_path = Path(local_path).expanduser().resolve()
        if local_path.suffix.lower() not in extensions:
            skipped.append({"action": "skipped", "local": str(local_path), "remote": sync_root, "reason": "wrong extension"})
            return
        rel = _relative_name_under_root(local_root, local_path)
        rel = _safe_remote_relative_name(rel) or local_path.name
        parent_rel = "/".join(rel.split("/")[:-1])
        name = rel.split("/")[-1]
        remote_folder = f"{sync_root}/{parent_rel}" if parent_rel else sync_root
        rpath = _remote_path(sync_root, rel)
        _webdav_ensure_folder_path(opener, base_url, remote_folder, folder_report)
        remote_url = _webdav_file_url(base_url, remote_folder, name)
        remote_stat = _webdav_stat(opener, remote_url)
        if remote_stat and (not local_path.exists()):
            downloaded.append(_webdav_download_file_atomic(opener, remote_url, local_path, remote_stat))
            if local_path.exists():
                _manifest_set(settings, rpath, _file_sha256(local_path), str(local_path))
            return
        if remote_stat and prefer_local_on_conflict and not force_upload and local_path.exists():
            # If both sides look different, prefer the library's local path so moved local files do not get overwritten.
            if _remote_file_newer_or_different(remote_stat, local_path):
                if hash_check and _local_remote_hash_match(opener, remote_url, local_path):
                    skipped.append({"action": "skipped", "local": str(local_path), "remote": rpath, "reason": "hash match"})
                    _manifest_set(settings, rpath, _file_sha256(local_path), str(local_path))
                    return
                skipped.append({"action": "skipped", "local": str(local_path), "remote": rpath, "reason": "local library file protected; uploading local"})
        result = _webdav_upload_file_atomic(opener, base_url, remote_folder, local_path, name, force=force_upload, hash_check=hash_check)
        if result.get("action") == "uploaded":
            uploaded.append(result)
        else:
            skipped.append(result)
        if local_path.exists():
            _manifest_set(settings, rpath, _file_sha256(local_path), str(local_path))
    except Exception as exc:
        errors.append({"local": str(local_path), "remote": sync_root, "error": str(exc)})


def _webdav_one_way_sync(payload: dict | None = None) -> dict:
    """Run normal two-way sync. The legacy function name is kept for UI/API compatibility."""
    app = _load_database()
    settings = app.get("settings") if isinstance(app.get("settings"), dict) else {}
    if payload and isinstance(payload.get("settings"), dict):
        settings = _merge_settings_preserving_tombstones(settings, payload.get("settings"))
        app["settings"] = settings
    force_upload = bool(payload and payload.get("forceUpload"))
    hash_check = bool(settings.get("webdavHashCheckBeforeOverwrite"))
    if not settings.get("webdavEnabled"):
        raise ValueError("Enable WebDAV sync settings first.")
    base_url = _join_webdav_url(settings.get("webdavUrl", ""), settings.get("webdavRemotePath", ""))
    opener = _webdav_opener(base_url, str(settings.get("webdavUsername") or ""), str(settings.get("webdavPassword") or ""), settings.get("webdavVerifySsl") is not False)
    _test_webdav_connection(settings)

    selected_roots = []
    if settings.get("syncSaves", True): selected_roots.append(SYNC_ROOT_FOLDERS["saves"])
    if settings.get("syncScreenshots", True): selected_roots.append(SYNC_ROOT_FOLDERS["screenshots"])
    if settings.get("syncPwads", True): selected_roots.append(SYNC_ROOT_FOLDERS["pwads"])
    if settings.get("syncIwads", True): selected_roots.append(SYNC_ROOT_FOLDERS["iwads"])
    if settings.get("syncMetadataTxt", True): selected_roots.append(SYNC_ROOT_FOLDERS["metadata"])
    if settings.get("syncTitlepics", True): selected_roots.append(SYNC_ROOT_FOLDERS["titlepics"])
    if settings.get("syncMods", True): selected_roots.append(SYNC_ROOT_FOLDERS["mods"])
    if settings.get("syncAdditionalFiles", True): selected_roots.append(SYNC_ROOT_FOLDERS["additionalFiles"])
    if settings.get("syncDatabase", True): selected_roots.append(SYNC_ROOT_FOLDERS["database"])

    folder_report = []
    for root_folder in selected_roots:
        _webdav_ensure_folder_path(opener, base_url, root_folder, folder_report)

    temp_deleted = 0
    for root_folder in selected_roots:
        root_url = _webdav_folder_url(base_url, root_folder)
        temp_deleted += _webdav_cleanup_temps(opener, root_url)
        for child in _webdav_list_children(opener, root_url):
            if child.endswith("/"):
                temp_deleted += _webdav_cleanup_temps(opener, child)

    moved_remote, move_errors = _webdav_move_tombstones(opener, base_url, app)
    deleted_remote, tombstone_errors = _webdav_delete_tombstones(opener, base_url, app)
    uploaded = []
    downloaded = []
    skipped = []
    errors = list(move_errors) + list(tombstone_errors)
    wads = [w for w in app.get("wads", []) if isinstance(w, dict)]

    if settings.get("syncSaves", True):
        for wad in wads:
            folder = _local_folder_for_category(settings, wad, "saves")
            if not folder:
                continue
            remote_folder = f"{SYNC_ROOT_FOLDERS['saves']}/{_wad_sync_slug(wad)}"
            _webdav_sync_folder_two_way(opener, base_url, remote_folder, folder, {".zds"}, force_upload, uploaded, downloaded, skipped, errors, folder_report, hash_check=hash_check, settings=settings, prefer_local_on_conflict=True)

    if settings.get("syncScreenshots", True):
        for wad in wads:
            folder = _local_folder_for_category(settings, wad, "screenshots")
            if not folder:
                continue
            remote_folder = f"{SYNC_ROOT_FOLDERS['screenshots']}/{_wad_sync_slug(wad)}"
            _webdav_sync_folder_two_way(opener, base_url, remote_folder, folder, SCREENSHOT_EXTENSIONS, force_upload, uploaded, downloaded, skipped, errors, folder_report, hash_check=hash_check, settings=settings)

    if settings.get("syncPwads", True):
        # Sync only PWAD/PK3 files linked in the Library. Preserve subfolders relative to the Default PWAD path.
        pwad_folder = _local_folder_for_category(settings, None, "pwads")
        _webdav_ensure_folder_path(opener, base_url, SYNC_ROOT_FOLDERS["pwads"], folder_report)
        seen = set()
        for wad in wads:
            raw = str(wad.get("pwadPath") or "").strip()
            if not raw:
                continue
            path = Path(os.path.expanduser(raw)).resolve()
            if path.suffix.lower() not in {".wad", ".pk3"} or path in seen:
                continue
            seen.add(path)
            _sync_single_library_file(opener, base_url, SYNC_ROOT_FOLDERS["pwads"], path, pwad_folder, {".wad", ".pk3"}, force_upload, uploaded, downloaded, skipped, errors, folder_report, hash_check=hash_check, settings=settings, prefer_local_on_conflict=True)

    if settings.get("syncIwads", True):
        iwad_folder = _local_folder_for_category(settings, None, "iwads")
        if iwad_folder:
            _webdav_sync_folder_two_way(opener, base_url, SYNC_ROOT_FOLDERS["iwads"], iwad_folder, {".wad"}, force_upload, uploaded, downloaded, skipped, errors, folder_report, hash_check=hash_check, settings=settings)

    if settings.get("syncMetadataTxt", True):
        # Sync companion TXT files linked to Library entries only, preserving subfolders
        # relative to the configured Metadata TXT folder. This matches PWAD/PK3
        # behaviour and prevents old flat remote files from being downloaded back
        # into the metadata root after the user has organised TXT files into
        # subfolders.
        metadata_folder = _local_folder_for_category(settings, None, "metadata")
        _webdav_ensure_folder_path(opener, base_url, SYNC_ROOT_FOLDERS["metadata"], folder_report)
        if metadata_folder:
            seen_metadata: set[Path] = set()
            for wad in wads:
                candidates = []
                stored_txt = str(wad.get("txtMetadataFile") or "").strip()
                if stored_txt:
                    candidates.append(Path(os.path.expanduser(stored_txt)).resolve())
                cand = _candidate_companion_txt(settings, wad)
                if cand:
                    candidates.append(Path(cand).resolve())
                for path in candidates:
                    try:
                        path = Path(path).expanduser().resolve()
                    except Exception:
                        continue
                    if path in seen_metadata or path.suffix.lower() != ".txt" or not path.is_file():
                        continue
                    seen_metadata.add(path)
                    rel = _safe_remote_relative_name(_relative_name_under_root(metadata_folder, path)) or path.name
                    legacy_remote = _remote_path(SYNC_ROOT_FOLDERS["metadata"], path.name)
                    new_remote = _remote_path(SYNC_ROOT_FOLDERS["metadata"], rel)
                    if legacy_remote != new_remote:
                        try:
                            legacy_url = base_url.rstrip("/") + "/" + "/".join(quote(part) for part in legacy_remote.split("/") if part)
                            new_url = base_url.rstrip("/") + "/" + "/".join(quote(part) for part in new_remote.split("/") if part)
                            dest_folder = "/".join(new_remote.split("/")[:-1])
                            if dest_folder:
                                _webdav_ensure_folder_path(opener, base_url, dest_folder, folder_report)
                            if _webdav_exists(opener, legacy_url) and not _webdav_exists(opener, new_url):
                                if _webdav_move(opener, legacy_url, new_url, overwrite=True):
                                    moved_remote.append({"action": "remote-moved", "from": legacy_remote, "to": new_remote, "moved": True, "reason": "metadata subfolder repair"})
                            elif _webdav_exists(opener, legacy_url) and _webdav_exists(opener, new_url):
                                if _webdav_delete(opener, legacy_url):
                                    deleted_remote.append({"action": "remote-deleted", "remote": legacy_remote, "deleted": True, "reason": "duplicate legacy metadata path"})
                        except Exception as exc:
                            errors.append({"remote": legacy_remote, "error": f"metadata legacy move failed: {exc}"})
                    _sync_single_library_file(opener, base_url, SYNC_ROOT_FOLDERS["metadata"], path, metadata_folder, {".txt"}, force_upload, uploaded, downloaded, skipped, errors, folder_report, hash_check=hash_check, settings=settings, prefer_local_on_conflict=True)
        else:
            skipped.append({"action": "skipped", "remote": SYNC_ROOT_FOLDERS["metadata"], "reason": "metadata folder not set"})

    if settings.get("syncTitlepics", True):
        titlepic_folder = _local_folder_for_category(settings, None, "titlepics")
        if titlepic_folder:
            _webdav_sync_folder_two_way(opener, base_url, SYNC_ROOT_FOLDERS["titlepics"], titlepic_folder, {".png"}, force_upload, uploaded, downloaded, skipped, errors, folder_report, hash_check=hash_check, settings=settings)

    if settings.get("syncMods", True):
        mods_folder = _local_folder_for_category(settings, None, "mods")
        if mods_folder:
            _webdav_sync_folder_tree_two_way(opener, base_url, SYNC_ROOT_FOLDERS["mods"], mods_folder, DOOM_MOD_EXTENSIONS, force_upload, uploaded, downloaded, skipped, errors, folder_report, hash_check=hash_check, settings=settings, prefer_local_on_conflict=True)
        else:
            skipped.append({"action": "skipped", "remote": SYNC_ROOT_FOLDERS["mods"], "reason": "mods folder not set"})

    if settings.get("syncAdditionalFiles", True):
        additional_folder = _local_folder_for_category(settings, None, "additionalFiles")
        if additional_folder:
            _webdav_sync_folder_tree_two_way(opener, base_url, SYNC_ROOT_FOLDERS["additionalFiles"], additional_folder, DOOM_MOD_EXTENSIONS, force_upload, uploaded, downloaded, skipped, errors, folder_report, hash_check=hash_check, settings=settings, prefer_local_on_conflict=True)
        else:
            skipped.append({"action": "skipped", "remote": SYNC_ROOT_FOLDERS["additionalFiles"], "reason": "additional files folder not set"})

    if settings.get("syncDatabase", True):
        # Database is protected: local edits win conflicts. Remote only overwrites local if local is missing or unchanged since the last sync.
        folder = SYNC_ROOT_FOLDERS["database"]
        remote_name = "doom_tracker_database.json"
        rpath = _remote_path(folder, remote_name)
        _webdav_ensure_folder_path(opener, base_url, folder, folder_report)
        remote_url = _webdav_file_url(base_url, folder, remote_name)
        remote_stat = _webdav_stat(opener, remote_url)
        try:
            local_exists = DATABASE_PATH.is_file()
            local_db_hash = _stable_database_hash_from_bytes(DATABASE_PATH.read_bytes()) if local_exists else ""
            remote_db_hash = _remote_database_stable_hash(opener, remote_url) if remote_stat else ""
            last_hash = _manifest_hash(settings, rpath) or str(settings.get("_lastWebdavDatabaseHash") or "")

            if force_upload:
                data = DATABASE_PATH.read_bytes()
                result = _webdav_upload_bytes_atomic(opener, base_url, folder, remote_name, data, force=True)
                uploaded.append(result)
                _manifest_set(settings, rpath, local_db_hash or _stable_database_hash_from_bytes(data), str(DATABASE_PATH))
            elif remote_stat and not local_exists:
                downloaded.append(_webdav_download_file_atomic(opener, remote_url, DATABASE_PATH, remote_stat))
                app = _load_database()
                settings = app.setdefault("settings", settings)
                if remote_db_hash:
                    _manifest_set(settings, rpath, remote_db_hash, str(DATABASE_PATH))
                    settings["_lastWebdavDatabaseHash"] = remote_db_hash
                    _save_database(app)
            elif remote_stat and remote_db_hash and local_db_hash and remote_db_hash == local_db_hash:
                skipped.append({"action": "skipped", "local": str(DATABASE_PATH), "remote": rpath, "reason": "database hash match"})
                _manifest_set(settings, rpath, local_db_hash, str(DATABASE_PATH))
                settings["_lastWebdavDatabaseHash"] = local_db_hash
                _save_database(app)
            else:
                local_changed = bool(local_db_hash and (not last_hash or local_db_hash != last_hash))
                remote_changed = bool(remote_db_hash and last_hash and remote_db_hash != last_hash)
                remote_wants_download = bool(remote_stat and _remote_file_newer_or_different(remote_stat, DATABASE_PATH))

                if remote_wants_download and remote_changed and not local_changed:
                    downloaded.append(_webdav_download_file_atomic(opener, remote_url, DATABASE_PATH, remote_stat))
                    app = _load_database()
                    settings = app.setdefault("settings", settings)
                    if remote_db_hash:
                        _manifest_set(settings, rpath, remote_db_hash, str(DATABASE_PATH))
                        settings["_lastWebdavDatabaseHash"] = remote_db_hash
                        _save_database(app)
                else:
                    if remote_wants_download and local_changed:
                        skipped.append({"action": "skipped", "local": str(DATABASE_PATH), "remote": rpath, "reason": "local database protected; uploading local"})
                    result = _sync_database_to_webdav(opener, base_url, app, folder_report)
                    (uploaded if result.get("action") == "uploaded" else skipped).append(result)
                    if DATABASE_PATH.is_file():
                        db_hash_after = _stable_database_hash_from_bytes(DATABASE_PATH.read_bytes())
                        _manifest_set(settings, rpath, db_hash_after, str(DATABASE_PATH))
        except Exception as exc:
            errors.append({"remote": rpath, "error": str(exc)})

    try:
        app["settings"] = settings
        _save_database(app)
    except Exception as exc:
        errors.append({"remote": "sync-manifest", "error": str(exc)})

    return {
        "ok": not errors,
        "baseUrl": base_url,
        "mode": "two-way-force-upload" if force_upload else "two-way",
        "folders": folder_report,
        "tempFilesDeleted": temp_deleted,
        "deletedRemote": deleted_remote,
        "movedRemote": moved_remote,
        "uploaded": uploaded,
        "downloaded": downloaded,
        "skipped": skipped,
        "errors": errors,
        "summary": {
            "uploaded": len(uploaded),
            "downloaded": len(downloaded),
            "deletedRemote": len(deleted_remote),
            "movedRemote": len(moved_remote),
            "skipped": len(skipped),
            "errors": len(errors),
            "foldersCreated": len([x for x in folder_report if x.get("action") == "created-folder"]),
            "tempFilesDeleted": temp_deleted,
        },
        "app": app,
    }


def _webdav_purge(payload: dict | None = None) -> dict:
    app = _load_database()
    settings = app.get("settings") if isinstance(app.get("settings"), dict) else {}
    if payload and isinstance(payload.get("settings"), dict):
        settings = _merge_settings_preserving_tombstones(settings, payload.get("settings"))
    if not settings.get("webdavEnabled"):
        raise ValueError("Enable WebDAV sync settings first.")
    base_url = _join_webdav_url(settings.get("webdavUrl", ""), settings.get("webdavRemotePath", ""))
    opener = _webdav_opener(base_url, str(settings.get("webdavUsername") or ""), str(settings.get("webdavPassword") or ""), settings.get("webdavVerifySsl") is not False)
    _test_webdav_connection(settings)
    deleted = []
    errors = []
    for folder in SYNC_ROOT_FOLDERS.values():
        try:
            did_delete = _webdav_delete(opener, _webdav_folder_url(base_url, folder))
            deleted.append({"remote": folder, "deleted": bool(did_delete)})
        except Exception as exc:
            errors.append({"remote": folder, "error": str(exc)})
    return {"ok": not errors, "baseUrl": base_url, "deleted": deleted, "errors": errors, "summary": {"deleted": len([d for d in deleted if d.get("deleted")]), "errors": len(errors)}}

class DoomTrackerHandler(SimpleHTTPRequestHandler):
    server_version = "DoomTrackerLocal/1.0"

    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        clean = parsed.path.lstrip("/") or "index.html"
        target = (ROOT / clean).resolve()
        if ROOT not in target.parents and target != ROOT:
            return str(ROOT / "index.html")
        return str(target)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler name
        parsed = urlparse(self.path)
        if parsed.path == "/api/status":
            _json_response(self, 200, {"ok": True, "root": str(ROOT), "databasePath": str(DATABASE_PATH), "settingsPath": str(SETTINGS_PATH)})
            return
        if parsed.path == "/api/database":
            try:
                _json_response(self, 200, {"ok": True, "app": _load_database(), "databasePath": str(DATABASE_PATH), "settingsPath": str(SETTINGS_PATH)})
            except Exception as exc:
                _json_response(self, 500, {"error": str(exc)})
            return
        if parsed.path == SCREENSHOT_API_PREFIX:
            try:
                from urllib.parse import parse_qs
                raw_path = parse_qs(parsed.query).get("path", [""])[0]
                if not raw_path:
                    raise FileNotFoundError("Missing screenshot path.")
                _serve_image_file(self, raw_path)
            except Exception as exc:
                _json_response(self, 404, {"error": str(exc)})
            return
        if parsed.path == TITLEPIC_API_PREFIX:
            try:
                from urllib.parse import parse_qs
                app = _load_database()
                folder_raw = _titlepics_folder_from_app(app)
                folder = _ensure_titlepics_folder(folder_raw)
                file_name = Path(parse_qs(parsed.query).get("file", [""])[0]).name
                if not file_name:
                    raise FileNotFoundError("Missing titlepic filename.")
                target = (folder / file_name).resolve()
                if target.parent != folder or not target.exists():
                    raise FileNotFoundError("Titlepic file was not found.")
                data = target.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", mimetypes.guess_type(str(target))[0] or "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
            except Exception as exc:
                _json_response(self, 404, {"error": str(exc)})
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler name
        parsed = urlparse(self.path)

        if parsed.path == "/api/database":
            try:
                payload = _read_json_body(self)
                app = payload.get("app") if isinstance(payload.get("app"), dict) else payload
                _save_database(app)
                _json_response(self, 200, {"ok": True, "databasePath": str(DATABASE_PATH), "settingsPath": str(SETTINGS_PATH), "app": _load_database()})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path == "/api/test-webdav":
            try:
                payload = _read_json_body(self)
                result = _test_webdav_connection(payload)
                _json_response(self, 200, {"ok": True, **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path == "/api/webdav-sync-one-way":
            try:
                payload = _read_json_body(self)
                result = _webdav_one_way_sync(payload)
                _json_response(self, 200 if result.get("ok") else 207, result)
            except Exception as exc:
                _json_response(self, 400, {"ok": False, "error": str(exc)})
            return

        if parsed.path == "/api/webdav-purge":
            try:
                payload = _read_json_body(self)
                result = _webdav_purge(payload)
                _json_response(self, 200 if result.get("ok") else 207, result)
            except Exception as exc:
                _json_response(self, 400, {"ok": False, "error": str(exc)})
            return

        if parsed.path == "/api/detect-save-folder":
            try:
                payload = _read_json_body(self)
                root_raw = str(payload.get("rootFolder", "")).strip()
                wad_name = str(payload.get("wadName", "")).strip()
                if not root_raw:
                    raise ValueError("rootFolder is required.")
                root = Path(os.path.expanduser(root_raw)).resolve()
                result = _detect_save_folder(root, wad_name)
                _json_response(self, 200, {"ok": True, "rootFolder": str(root), **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path == "/api/scan-iwads":
            try:
                payload = _read_json_body(self)
                folder_raw = str(payload.get("iwadFolder", "")).strip()
                if not folder_raw:
                    raise ValueError("iwadFolder is required.")
                folder = Path(os.path.expanduser(folder_raw)).resolve()
                result = _scan_iwads(folder)
                _json_response(self, 200, {"ok": True, "iwadFolder": str(folder), **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return


        if parsed.path == "/api/scan-pwads":
            try:
                payload = _read_json_body(self)
                folder_raw = str(payload.get("pwadFolder", "")).strip()
                if not folder_raw:
                    raise ValueError("pwadFolder is required.")
                associated_paths = payload.get("associatedPaths") if isinstance(payload.get("associatedPaths"), list) else []
                associated_files = payload.get("associatedFiles") if isinstance(payload.get("associatedFiles"), list) else []
                folder = Path(os.path.expanduser(folder_raw)).resolve()
                result = _scan_pwads(folder, associated_paths, associated_files)
                _json_response(self, 200, {"ok": True, "pwadFolder": str(folder), **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path == "/api/extract-pwad-metadata":
            try:
                payload = _read_json_body(self)
                wad_raw = str(payload.get("wadPath", "")).strip()
                if not wad_raw:
                    raise ValueError("wadPath is required.")
                path = Path(os.path.expanduser(wad_raw)).resolve()
                result = _extract_pwad_metadata(
                    path,
                    iwad_field=str(payload.get("iwadField", "")),
                    iwad_folder=str(payload.get("iwadFolder", "")),
                    iwad_path=str(payload.get("iwadPath", "")),
                    metadata_folder=str(payload.get("metadataFolder", "")),
                )
                _json_response(self, 200, {"ok": True, **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return


        if parsed.path == "/api/read-companion-txt":
            try:
                payload = _read_json_body(self)
                txt_raw = str(payload.get("txtPath", "")).strip()
                if txt_raw:
                    txt_path = Path(os.path.expanduser(txt_raw)).resolve()
                    if not txt_path.is_file() or txt_path.suffix.lower() != ".txt":
                        raise ValueError("Stored TXT path was not found or is not a .txt file.")
                    content = txt_path.read_bytes().decode("utf-8", errors="replace")
                    _json_response(self, 200, {"ok": True, "found": True, "fileName": txt_path.name, "filePath": str(txt_path), "content": content})
                    return
                wad_raw = str(payload.get("wadPath", "")).strip()
                metadata_folder = str(payload.get("metadataFolder", "")).strip()
                if not wad_raw:
                    raise ValueError("wadPath is required.")
                if not metadata_folder:
                    raise ValueError("metadataFolder is required.")
                path = Path(os.path.expanduser(wad_raw)).resolve()
                result = _read_companion_txt(path, metadata_folder)
                _json_response(self, 200, {"ok": True, **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return
        if parsed.path == "/api/extract-titlepic":
            try:
                payload = _read_json_body(self)
                wad_raw = str(payload.get("wadPath", "")).strip()
                if not wad_raw:
                    raise ValueError("wadPath is required.")
                path = Path(os.path.expanduser(wad_raw)).resolve()
                if path.suffix.lower() == '.pk3':
                    pk3 = _read_pk3_contents(path)
                    fallback_playpal = _load_base_iwad_playpal(
                        iwad_field=str(payload.get("iwadField", "")),
                        iwad_folder=str(payload.get("iwadFolder", "")),
                        iwad_path=str(payload.get("iwadPath", "")),
                    )
                    data_url = _pk3_titlepic_data_url(pk3, fallback_playpal=fallback_playpal)
                    if not data_url:
                        raise FileNotFoundError("TITLEPIC was not found in the PK3.")
                    result = {"titlePicDataUrl": data_url, "hasTitlepic": True}
                else:
                    result = _extract_titlepic_from_wad(
                        path,
                        iwad_field=str(payload.get("iwadField", "")),
                        iwad_folder=str(payload.get("iwadFolder", "")),
                        iwad_path=str(payload.get("iwadPath", "")),
                    )
                folder_raw = str(payload.get("titlepicsFolder", "")).strip()
                if folder_raw and result.get("titlePicDataUrl"):
                    image_bytes = _decode_data_url_png(result["titlePicDataUrl"])
                    saved = _save_titlepic_bytes(folder_raw, image_bytes, payload.get("titleHint") or path.stem, payload.get("existingFileName") or "")
                    result.update(saved)
                    result.pop("titlePicDataUrl", None)
                _json_response(self, 200, {"ok": True, **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return


        if parsed.path == "/api/save-titlepic":
            try:
                payload = _read_json_body(self)
                folder_raw = str(payload.get("titlepicsFolder", "")).strip()
                data_url = str(payload.get("dataUrl", ""))
                image_bytes = _decode_data_url_png(data_url)
                result = _save_titlepic_bytes(
                    folder_raw,
                    image_bytes,
                    title_hint=str(payload.get("titleHint", "titlepic")),
                    existing_name=str(payload.get("existingFileName", "")),
                )
                _json_response(self, 200, {"ok": True, **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path == "/api/delete-titlepic":
            try:
                payload = _read_json_body(self)
                folder_raw = str(payload.get("titlepicsFolder", "")).strip()
                file_name = Path(str(payload.get("titlePicFileName", ""))).name
                if not file_name:
                    raise ValueError("titlePicFileName is required.")
                folder = _ensure_titlepics_folder(folder_raw)
                target = (folder / file_name).resolve()
                if target.parent != folder:
                    raise ValueError("Invalid titlepic filename.")
                if target.exists():
                    target.unlink()
                _json_response(self, 200, {"ok": True})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path == "/api/delete-associated-files":
            try:
                payload = _read_json_body(self)
                result = _delete_associated_files(payload)
                _json_response(self, 200, {"ok": True, **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path == "/api/check-missing-files":
            try:
                payload = _read_json_body(self)
                result = _check_missing_and_deleted_files(payload)
                _json_response(self, 200, {"ok": True, **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path == "/api/delete-unassociated-files":
            try:
                payload = _read_json_body(self)
                result = _delete_unassociated_files(payload)
                _json_response(self, 200, {"ok": True, **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path == "/api/detect-screenshot-folder":
            try:
                payload = _read_json_body(self)
                root_raw = str(payload.get("rootFolder", "")).strip()
                wad_name = str(payload.get("wadName", "")).strip()
                if not root_raw:
                    raise ValueError("rootFolder is required.")
                root = Path(os.path.expanduser(root_raw)).resolve()
                result = _detect_screenshot_folder(root, wad_name)
                _json_response(self, 200, {"ok": True, "rootFolder": str(root), **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path == "/api/scan-screenshots":
            try:
                payload = _read_json_body(self)
                folder_raw = str(payload.get("folderPath", "")).strip()
                if not folder_raw:
                    raise ValueError("folderPath is required.")
                folder = Path(os.path.expanduser(folder_raw)).resolve()
                result = _scan_screenshot_folder(folder)
                _json_response(self, 200, {"ok": True, **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return



        if parsed.path == "/api/create-folders":
            try:
                payload = _read_json_body(self)
                result = _create_local_folders(payload)
                _json_response(self, 200, {"ok": True, **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path == "/api/scan-launch-files":
            try:
                payload = _read_json_body(self)
                result = _scan_launch_files(
                    payload.get("modsFolder", ""),
                    payload.get("additionalFilesFolder", ""),
                    payload.get("additionalFilesRoot", ""),
                    payload.get("additionalSubfolder", ""),
                )
                _json_response(self, 200, {"ok": True, **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path == "/api/launch-game":
            try:
                payload = _read_json_body(self)
                result = _launch_game(payload)
                _json_response(self, 200, {"ok": True, **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path == "/api/delete-screenshot":
            try:
                payload = _read_json_body(self)
                raw_path = str(payload.get("filePath", "")).strip()
                if not raw_path:
                    raise ValueError("filePath is required.")
                target = Path(os.path.expanduser(raw_path)).resolve()
                if target.suffix.lower() not in SCREENSHOT_EXTENSIONS:
                    raise ValueError("Only supported screenshot image files can be deleted.")
                result = _safe_delete_file(target)
                _json_response(self, 200, {"ok": True, **result})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return

        if parsed.path != "/api/refresh-stats":
            _json_response(self, 404, {"error": "Unknown API endpoint."})
            return

        try:
            payload = _read_json_body(self)
            folder_raw = str(payload.get("folderPath", "")).strip()
            if not folder_raw:
                raise ValueError("folderPath is required.")

            folder = Path(os.path.expanduser(folder_raw)).resolve()
            save_path = _latest_zds(folder)
            globals_json = _read_globals_from_save(save_path)
            levels = globals_json.get("statistics", {}).get("levels")
            if not isinstance(levels, list):
                raise ValueError("statistics.levels[] was missing from globals.json.")

            stat = save_path.stat()
            _json_response(
                self,
                200,
                {
                    "ok": True,
                    "folderPath": str(folder),
                    "fileName": save_path.name,
                    "filePath": str(save_path),
                    "modifiedTime": stat.st_mtime,
                    "statistics": {"levels": levels},
                    "servercvars": globals_json.get("servercvars", {}),
                    "skill": globals_json.get("servercvars", {}).get("skill", ""),
                },
            )
        except Exception as exc:  # keep localhost tool friendly
            _json_response(self, 400, {"error": str(exc)})


def main() -> None:
    mimetypes.add_type("application/javascript", ".js")
    if not DATABASE_PATH.exists():
        _save_database(_empty_database())
    os.chdir(ROOT)
    httpd = ThreadingHTTPServer((HOST, PORT), DoomTrackerHandler)
    print(f"Doom Run Tracker local server running at http://localhost:{PORT}")
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
