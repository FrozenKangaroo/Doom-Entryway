# Doom Run Tracker 1.2.4

## v1.2.1 Library quick filters
- Click a WAD card play state to filter to that state.
- Click IWAD, type, author, source port, or latest-run difficulty on a library card to apply that filter.
- Click Avg Kills, Avg Items, or Avg Secrets chips to sort by that metric.
- Added active quick-filter chips with one-click clearing.
- README and About version text updated to 1.2.1.


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

## v1.0.6 Refresh All delta results

Refresh All now reports only changes since the previous Refresh All run. Unchanged save scans, unchanged screenshot scans, excluded WADs, and normal file-check confirmations are hidden from the results dialog. Errors and real changes such as updated map stats, changed screenshot galleries, missing files, moved files, and warnings are still shown.


## v1.0.7 Companion TXT map-list parsing

Companion TXT parsing now reads explicit map names and map authors only from dedicated Levels/Maps sections. This prevents Music, Credits, and Contributor Commentary sections from being mistaken for WAD titles or map names. TNT2-style lines such as `- MAP01: "Obituary" -------- mouldy / Luisinho` now import as the map title plus author instead of accidentally pulling soundtrack titles or commentary text.



## v1.2.0 Refresh All noise cleanup

- Missing companion TXT files are now treated as optional, not as Refresh All errors or warnings. This keeps official IWADs, official expansions, and non-/idgames WADs from cluttering the results when no TXT exists.
- If a stale companion TXT path was previously stored but the file is gone, Refresh All now reports one cleanup entry and removes the stale link.
- Missing latest `.zds` files are treated as unplayed WADs and are silently skipped during Refresh All instead of appearing as a long error list.

## v1.2.0 Reliability polish and quick-info fixes

- Refresh All results now only list actual changes, warnings, errors, missing files, or moved files since the previous Refresh All.
- New WAD creation preserves companion TXT paths detected during metadata extraction, so the Library Show TXT button appears immediately when a TXT exists.
- Companion TXT preview prefers the stored TXT path and falls back to exact/recursive companion matching under the metadata folder.
- File checking updates moved WAD/PK3 and companion TXT paths, queues WebDAV remote moves/deletes, and avoids redownloading old flat metadata TXT files after files are organised into subfolders.
- Added clearer status text for metadata extraction and Refresh All change reports.

## v1.1.0 Library quick-info popups

- The library progress count is now clickable and opens a popup with every map name, map author, and the latest run results.
- WAD cards with a detected companion TXT now show a **Show TXT** button so the WAD text file can be read without opening the card.

## v1.2.4 Custom tags

- Add comma-separated custom tags to WAD entries.
- Show a compact tag preview on library cards with a +x popup for extra tags.
- Click any tag to quick-filter the library.
- Live search now matches tags.

## v1.2.2 Clickable titlepics

- Clickable titlepics in the Library and WAD detail views.
- Titlepics now open in the same full-size popup style used by screenshots.
