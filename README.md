# Doom Entryway 1.5.13

Doom Entryway is a local-first web app for tracking classic DOOM playthroughs. It manages IWADs, PWADs, PK3s, runs, map stats, medals, metadata, titlepics, screenshots, launcher presets, WebDAV sync, and debug logs from a browser-based interface.

The app runs from a small local Python server and stores its data beside the app files unless you configure external folders or WebDAV sync.

## Start

### Linux

```bash
chmod +x start-linux.sh
./start-linux.sh
```

On KDE and many other Linux desktops, you can also mark `start-linux.sh` as executable and double-click it from the file manager.

### Windows

```bat
start-windows.bat
```

After starting the server, open the local address shown by the app, usually:

```text
http://localhost:8000
```

## Main screens

- **Home**: dashboard summary, recent activity, medals, and quick actions.
- **Library**: all WAD cards, folders, filters, sorting, progress, titlepics, tags, and quick-info popups.
- **Stats**: cross-run summary across the library.
- **Settings**: local folders, scan paths, WebDAV settings, launch paths, and refresh behaviour.
- **Log / Debug**: recent server and launcher log history, useful when running without a visible terminal.
- **About**: app version and general app information.

## Core features

- Track IWADs, PWADs, PK3s, single maps, multi-map packs, episodes, and megawads.
- Create virtual folders and browse with breadcrumbs.
- Use card view or compact view with adjustable card width.
- Set play state: Plan to Play, Currently Playing, On Hold, Dropped, or Completed.
- Track multiple runs per WAD.
- Track per-map kills, items, secrets, level time, difficulty, source, author, notes, and medal status.
- Medal support for gold, silver, bronze, no medal, and unplayed maps.
- Manual map editing with either raw counts or percentage entry.
- Manual level time entry accepts normal time formats such as `7:32`, `1:02:15`, `452s`, or raw tics with a `tics` suffix.
- Library quick filters from WAD cards, including play state, IWAD, type, author, source port, difficulty, tags, and stat chips.
- Clickable progress counts that open a map list popup with names, authors, and latest run results.
- Custom tags with search and quick-filter support.

## Metadata and artwork

- Auto-detect WAD/PK3 metadata from UMAPINFO, MAPINFO, ZMAPINFO, and DEHACKED/BEX.
- Auto-fill New WAD fields where metadata is available.
- Pre-seed map lists with level codes, display names, and map authors where detected.
- Parse companion TXT files, including idgames-style text files.
- Show companion TXT files from the library without opening the full WAD page.
- Scan known IWADs and fill known map names, authors, and titlepics.
- Extract DOOM titlepic lumps and convert them to PNG.
- Store titlepics as external PNG files to keep the database smaller.
- Convert non-PNG titlepic inputs into PNG.
- Click titlepics in the library or WAD detail page to open a larger preview.

## Saves, screenshots, and refreshes

- Import `.zds` save data manually.
- Refresh the latest `.zds` for a WAD from its configured save folder.
- Refresh All across configured WADs for saves and screenshots.
- Read `globals.json` data from saves where available.
- Mark WADs as Completed after manual final-map edits as well as save imports. Secret-map slots (`MAP31`/`MAP32` for DOOM II/TNT/Plutonia and `E#M9` for DOOM/Ultimate DOOM) are optional for completion.
- Auto-detect save subfolders from WAD names using fuzzy matching.
- Track save difficulty from the save skill value.
- Show only meaningful changes in Refresh All results instead of listing every unchanged file.
- Optional file checks for missing, moved, and deleted local files.
- Repair moved paths by searching configured root folders.
- Treat missing companion TXT files and unplayed latest saves as normal optional cases instead of noisy errors.
- Manage per-WAD screenshot folders with auto-detection, thumbnail gallery, full-size preview, and permanent screenshot deletion.

## Launcher features

- Launch DOOM directly from WAD entries.
- Configure source port paths and launch-related folders in Settings.
- Use global mods and additional files when launching.
- Collapse or expand Additional files, Mod files, and Command line preview sections in the launch dialog so long mod lists do not push the Launch button out of easy reach.
- Launch output is captured into the Log / Debug page when possible.
- Death tracking is protected against refresh races so live monitor death counts are not overwritten by stale browser state.

## WebDAV sync

- Configure WebDAV connection details in Settings.
- Test the WebDAV connection from the app.
- Enable or disable sync categories.
- Two-way sync database, saves, metadata, media, screenshots, and related files depending on your settings.
- Force upload local data when needed.
- Purge remote data when needed.
- Use temporary transfer files, delete tombstones, hash checks, database backups, and local-wins conflict protection.
- Queue remote cleanup or move actions when files are reorganised locally.

## Log / Debug page

The Log / Debug sidebar page is designed for setups where the server is launched without a visible terminal window.

It shows recent local server history, HTTP requests, launcher activity, captured DOOM output, refresh activity, sync activity, and errors where available. The page includes **Refresh** and **Clear** buttons.

The persistent log file is:

```text
doom_entryway_debug.log
```

It is stored beside `local_server.py`.

## Data files

The main database is stored beside the local server:

```text
doom_tracker_database.json
```

Machine-specific settings are stored separately:

```text
settings.json
```

Keeping settings separate means local paths and WebDAV credentials do not have to be stored inside the synced database.

## Notes

- This is a local-first personal tracking app, not a hosted web service.
- Keep backups of your database, especially before testing sync changes or large library reorganisations.
- Some internal filenames still use the older `doom_tracker` naming for compatibility with existing data, but the user-facing app name is Doom Entryway.


## Default Mods

The Settings page includes a **Default Mods** tab. Scan your configured Mods folder, tick the global mods you usually want, and use the arrow buttons to set their load order. When you open the launch dialog for a WAD that has no saved launcher mod list yet, Doom Entryway preselects those defaults automatically. The launch dialog also includes **Apply Default Mods**, **Select All**, and **Unselect All** controls in the Mod files section.
