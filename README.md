# Doom Run Tracker 1.0.2

Doom Run Tracker is a local-first web app for tracking DOOM IWADs, PWADs, PK3s, runs, map stats, medals, metadata, titlepics, screenshots, and WebDAV sync.

## Start

Linux:

```bash
chmod +x start-linux.sh
./start-linux.sh
```

Windows:

```bat
start-windows.bat
```

Then open the local address shown by the server, usually `http://localhost:8000`.

## Main features

- Library entries for IWADs, PWADs, PK3s, single maps, multi-map packs, episodes, and megawads.
- Editable WAD info: title, author, source port, total maps, type, IWAD, notes, state, paths, and refresh exclusion.
- Virtual folders, breadcrumbs, card view, compact view, and adjustable card width.
- Automatic metadata extraction from WAD/PK3 files using UMAPINFO, MAPINFO, ZMAPINFO, and DEHACKED/BEX.
- Companion TXT metadata folder support for idgames-style text files.
- IWAD scanning with known map names, authors, and titlepics.
- Multiple runs per WAD.
- Manual `.zds` import and local save folder refresh using `globals.json`.
- Per-map kills, items, secrets, level time, difficulty, source, author, notes, and medal status.
- Per-map difficulty support using the save skill value from `globals.json`.
- Gold, silver, bronze, no medal, and unplayed state handling.
- Manual map editing with count or percentage entry.
- Titlepics stored as external PNG files, including migration from older embedded database images.
- Conversion of non-PNG titlepic inputs into PNG.
- Per-WAD screenshot folders, auto-detection, thumbnail gallery, full-size preview, and permanent screenshot deletion.
- Refresh All for saves and screenshots across configured WADs.
- Settings for default save, PWAD/PK3, IWAD, metadata TXT, titlepic, and screenshot folders.
- Optional deletion of associated files when deleting a WAD card.
- Unassociated local file cleanup.
- WebDAV settings, test connection, sync category toggles, two-way sync, force upload, purge remote, temporary transfer files, delete tombstones, hash checks, database backups, and local-wins conflict protection for database and saves.

## Notes

The app stores its main data in `doom_tracker_database.json` next to the local server. Titlepics and other media can be stored externally in configured folders to keep the database small.


## v1.0.2 settings storage

Settings are stored in `settings.json` beside the local server instead of inside `doom_tracker_database.json`. This keeps local paths, WebDAV credentials, and sync settings machine-specific when multiple PCs use the same WebDAV database. Existing embedded settings are migrated automatically on first launch.


## v1.0.2 missing/moved file check

Refresh All can now optionally check linked files and folders, repair moved paths by searching configured root folders, remove missing WAD cards, and queue WebDAV cleanup/move actions for the next sync.
