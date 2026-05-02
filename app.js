const APP_VERSION = "1.5.12";
const DATABASE_API = '/api/database';

const LIBRARY_SORT_OPTIONS = [
  { key: 'title', label: 'Alphabetical', hint: 'A-Z by WAD title' },
  { key: 'lastPlayed', label: 'Last played', hint: 'Newest known .zds modified date' },
  { key: 'dateAdded', label: 'Date added', hint: 'WAD card creation date' },
  { key: 'completion', label: 'Completion %', hint: 'Latest run maps complete / total maps' },
  { key: 'avgKills', label: 'Average kills %', hint: 'Latest run average kill percentage' },
  { key: 'avgItems', label: 'Average items %', hint: 'Latest run average item percentage' },
  { key: 'avgSecrets', label: 'Average secrets %', hint: 'Latest run average secret percentage' },
  { key: 'goldMedals', label: 'Gold medals', hint: 'Latest run full-clear medal count' },
  { key: 'totalTime', label: 'Total time', hint: 'Latest run total level time' },
  { key: 'deaths', label: 'Total deaths', hint: 'Latest run death count' },
  { key: 'mapCount', label: 'Map count', hint: 'Total map slots' },
  { key: 'playState', label: 'Play state', hint: 'Plan, current, hold, dropped, completed' },
  { key: 'author', label: 'Author', hint: 'WAD author name' },
  { key: 'iwad', label: 'IWAD', hint: 'Base game / IWAD field' },
  { key: 'updated', label: 'Recently changed', hint: 'WAD card metadata update time' },
];

const state = {
  app: { wads: [], folders: [], settings: {} },
  currentView: 'home',
  currentWadId: null,
  displayMode: 'both',
  alerts: [],
  currentMapContext: null,
  libraryFilter: 'all',
  libraryQuickFilters: {},
  librarySearch: '',
  libraryViewMode: 'card',
  libraryDensity: 680,
  librarySortKey: 'title',
  librarySortDirection: 'asc',
  currentFolderId: null,
  mapInputMode: 'counts',
  databaseReady: false,
  pendingNewWadMetadata: null,
  launchDialog: { wadId: '', globalMods: [], additionalFiles: [], selectedMods: [], selectedAdditionalFiles: [], sectionOrder: ['map', 'additional', 'mods'], modsFolder: '', additionalFilesFolder: '', collapsedSections: { additional: true, mods: true, command: true } },
  debug: { lines: [], logPath: '', loadedAt: '', loading: false, error: '' },
  defaultModsManager: { files: [], scannedFolder: '', loading: false, error: '' },
};

const pageTitle = document.getElementById('pageTitle');
const pageSubtitle = document.getElementById('pageSubtitle');
const homeView = document.getElementById('homeView');
const libraryView = document.getElementById('libraryView');
const wadDetailView = document.getElementById('wadDetailView');
const statsView = document.getElementById('statsView');
const settingsView = document.getElementById('settingsView');
const debugView = document.getElementById('debugView');
const aboutView = document.getElementById('aboutView');
const alertsEl = document.getElementById('alerts');
const wadDialog = document.getElementById('wadDialog');
const mapDialog = document.getElementById('mapDialog');
const editWadDialog = document.getElementById('editWadDialog');
const wadForm = document.getElementById('wadForm');
const editWadForm = document.getElementById('editWadForm');
const mapForm = document.getElementById('mapForm');
const deleteMapButton = document.getElementById('deleteMapButton');
const importDbInput = document.getElementById('importDbInput');

initApp();

async function initApp() {
  await loadState();
  wireEvents();
  activateNav(state.currentView === 'home' ? 'home' : state.currentView);
  if (state.currentView === 'home') {
    [homeView, libraryView, wadDetailView, statsView, settingsView, debugView, aboutView].forEach((view) => view?.classList.remove('active'));
    homeView?.classList.add('active');
    pageTitle.textContent = 'Home';
    pageSubtitle.textContent = 'At-a-glance progress, recent play, and quick launch points.';
  }
  render();
}

function wireEvents() {
  document.querySelectorAll('.nav-button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.nav-button').forEach((b) => b.classList.remove('active'));
      button.classList.add('active');
      showView(button.dataset.view);
    });
  });

  document.getElementById('newWadButton').addEventListener('click', openNewWadDialog);
  document.getElementById('scanIwadsButton')?.addEventListener('click', scanIwadsFromSettings);
  document.getElementById('refreshAllButton')?.addEventListener('click', refreshAllTrackedData);
  document.getElementById('syncButton')?.addEventListener('click', () => runWebdavOneWaySync(false));
  document.getElementById('exportDbButton').addEventListener('click', exportDatabase);
  document.getElementById('importDbButton').addEventListener('click', () => importDbInput?.click());
  importDbInput?.addEventListener('change', handleDatabaseImport);
  document.getElementById('chooseNewPwadButton')?.addEventListener('click', choosePwadForNewWad);
  mapForm.elements.leveltime?.addEventListener('input', updateLevelTimePreview);

  wadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(wadForm);
    const metadata = state.pendingNewWadMetadata || null;
    const run = createRun(metadata?.maps?.length ? 'Metadata' : 'Default Run');
    if (metadata?.maps?.length) {
      run.maps = metadata.maps.map((entry) => createMetadataPlaceholderMap(entry, metadata.metadataSource || 'metadata'));
      sortRunMaps(run);
    }
    const wad = {
      id: crypto.randomUUID(),
                           title: String(formData.get('title')).trim(),
                           type: String(formData.get('type')),
                           author: String(formData.get('author') || '').trim(),
                           iwad: String(formData.get('iwad') || getAppSetting('defaultIwadPath') || '').trim(),
                           sourcePort: String(formData.get('sourcePort') || '').trim(),
                           saveFolderPath: '',
                           screenshotFolderPath: '',
                           additionalFilesPath: '',
                           screenshots: [],
                           pwadPath: metadata?.path || '',
                           pwadFileName: metadata?.fileName || '',
                           pwadRelativePath: metadata?.relativePath || metadata?.fileName || '',
                           fileKind: metadata?.fileKind || '',
                           iwadPath: getAppSetting('defaultIwadPath'),
                           totalMaps: Math.max(1, Number(formData.get('totalMaps')) || metadata?.totalMaps || 1),
                           notes: String(formData.get('notes') || '').trim(),
                           tags: parseTags(formData.get('tags')),
                           playState: String(formData.get('playState') || 'plan'),
                           titlePicDataUrl: metadata?.titlePicDataUrl || '',
                           titlePicFileName: metadata?.titlePicFileName || '',
                           titlePicPath: metadata?.titlePicPath || '',
                           folderId: state.currentFolderId,
                           createdAt: new Date().toISOString(),
                           selectedRunId: run.id,
                           metadataSource: metadata?.metadataSource || '',
                           txtMetadataFile: metadata?.txtMetadataFile || '',
                           txtMetadataFileName: metadata?.txtMetadataFileName || '',
                           runs: [run],
    };
    let folderSummary = '';
    if (formData.get('createMissingFolders') === 'on') {
      try {
        const folderResult = await createFoldersForWadIfRequested(wad, { metadata, onlyWhenUnset: true });
        folderSummary = summarizeFolderCreation(folderResult);
      } catch (error) {
        showAlert('error', error.message || 'Created WAD, but folder creation failed.');
      }
    } else {
      wad.saveFolderPath = getAppSetting('defaultRootSaveFolder');
      wad.screenshotFolderPath = getAppSetting('defaultScreenshotFolder');
    }
    state.app.wads.unshift(wad);
    await saveState();
    wadForm.reset();
    state.pendingNewWadMetadata = null;
    updateNewWadMetadataStatus();
    wadDialog.close();
    state.currentWadId = wad.id;
    showAlert('success', `Created ${wad.title}. Time to start farming medals.${folderSummary}`);
    showWadDetail(wad.id);
  });

  editWadForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(editWadForm);
    const wadId = String(formData.get('wadId') || '');
    const wad = state.app.wads.find((entry) => entry.id === wadId);
    if (!wad) {
      showAlert('error', 'Could not find that WAD entry to edit.');
      return;
    }

    wad.title = String(formData.get('title') || '').trim() || wad.title || 'Untitled WAD';
    wad.author = String(formData.get('author') || '').trim();
    wad.sourcePort = String(formData.get('sourcePort') || '').trim();
    wad.totalMaps = Math.max(1, Number(formData.get('totalMaps')) || 1);
    wad.type = String(formData.get('type') || 'megawad');
    wad.iwad = String(formData.get('iwad') || '').trim();
    wad.notes = String(formData.get('notes') || '').trim();
    wad.tags = parseTags(formData.get('tags'));
    wad.excludeFromRefreshAll = formData.get('excludeFromRefreshAll') === 'on';
    wad.updatedAt = new Date().toISOString();

    let folderSummary = '';
    if (formData.get('createMissingFolders') === 'on') {
      try {
        const folderResult = await createFoldersForWadIfRequested(wad, { onlyWhenUnset: true });
        folderSummary = summarizeFolderCreation(folderResult);
      } catch (error) {
        showAlert('error', error.message || 'WAD info was updated, but folder creation failed.');
      }
    }

    const latestRun = getLatestRun(wad);
    const stateChange = latestRun ? applyAutomaticPlayStateFromManualEdit(wad, latestRun) : '';

    await saveState();
    editWadDialog?.close();
    if (state.currentWadId === wad.id) {
      pageTitle.textContent = wad.title;
      pageSubtitle.textContent = `${capitalize(wad.type)} overview, run summary, medals, imports, and manual editing.`;
    }
    showAlert('success', `${wad.title} info updated.${folderSummary}${stateChange ? ` ${stateChange}` : ''}`);
    render();
  });

  document.querySelectorAll('.close-modal').forEach((button) => {
    button.addEventListener('click', () => {
      const dialogId = button.dataset.close;
      document.getElementById(dialogId).close();
    });
  });

  mapForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(mapForm);
    const wad = getCurrentWad();
    if (!wad) return;
    const run = wad.runs.find((r) => r.id === formData.get('runId'));
    if (!run) return;

    let payload;
    try {
      payload = mapFormDataToMapResult(formData);
    } catch (error) {
      showAlert('error', error.message || 'Level time could not be parsed.');
      return;
    }
    const existingIndex = run.maps.findIndex((m) => m.id === payload.id);

    if (existingIndex >= 0) {
      const existing = run.maps[existingIndex];
      run.maps[existingIndex] = { ...existing, ...payload, updatedAt: new Date().toISOString() };
      showAlert('success', `${payload.levelName} updated.`);
    } else {
      run.maps.push(payload);
      showAlert('success', `${payload.levelName} added.`);
    }

    sortRunMaps(run);
    const stateChange = applyAutomaticPlayStateFromManualEdit(wad, run);
    saveState();
    mapDialog.close();
    if (stateChange) showAlert('success', `${payload.levelName} saved. ${stateChange}`);
    render();
  });

  deleteMapButton.addEventListener('click', () => {
    const runId = mapForm.elements.runId.value;
    const mapId = mapForm.elements.mapId.value;
    const wad = getCurrentWad();
    if (!wad || !runId || !mapId) return;
    const run = wad.runs.find((r) => r.id === runId);
    if (!run) return;
    run.maps = run.maps.filter((m) => m.id !== mapId);
    if (String(wad.playState || '') === 'completed' && !isRunCompleteForWad(wad, run)) {
      wad.playState = 'current';
      wad.updatedAt = new Date().toISOString();
    }
    saveState();
    mapDialog.close();
    showAlert('success', 'Map entry deleted. Straight into the lava pit.');
    render();
  });

  // Wire input mode toggle
  document.querySelectorAll('[data-input-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      state.mapInputMode = button.dataset.inputMode;
      updateInputModeUI();
    });
  });

  // Wire live computed hints for percent mode
  ['killPctInput', 'itemPctInput', 'secretPctInput'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateComputedHints);
  });
  ['totalkills', 'totalitems', 'totalsecrets'].forEach((name) => {
    getNamedFormInputs(name).forEach((el) => {
      el.addEventListener('input', () => {
        syncMirroredNamedInputs(name, el);
        updateComputedHints();
      });
    });
  });
}


function openNewWadDialog() {
  wadForm.reset();
  state.pendingNewWadMetadata = null;
  if (wadForm.elements.totalMaps) wadForm.elements.totalMaps.value = '32';
  updateNewWadMetadataStatus();
  wadDialog.showModal();
}

async function choosePwadForNewWad() {
  const pwadFolder = getAppSetting('defaultPwadPath');
  if (!pwadFolder) {
    showAlert('error', 'Set the Default PWAD/PK3 path in Settings first. That folder is used for New WAD metadata detection.');
    return;
  }

  const associatedFiles = getAssociatedModFiles();
  const associatedPaths = associatedFiles.map((entry) => entry.path).filter(Boolean);

  try {
    updateNewWadMetadataStatus('Scanning PWAD/PK3 folder...');
    const response = await fetch('/api/scan-pwads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pwadFolder, associatedPaths, associatedFiles }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'PWAD scan failed.');

    const found = Array.isArray(payload.found) ? payload.found : [];
    if (!found.length) {
      updateNewWadMetadataStatus('No unassociated PWAD/PK3 files were found.');
      return;
    }

    const listText = found.slice(0, 40).map((file, index) => {
      const maps = Number(file.mapCount) ? ` [${file.mapCount} maps]` : '';
      const titlepic = file.hasTitlepic ? ' [TITLEPIC]' : '';
      return `${index + 1}. ${file.relativePath || file.fileName}${maps}${titlepic}`;
    }).join('\n');
    const moreText = found.length > 40 ? `\n\nShowing first 40 of ${found.length} matches.` : '';
    const choice = prompt(`Select a PWAD for the new card:\n\n${listText}${moreText}\n\nEnter a number:`, '1');
    if (choice === null) {
      updateNewWadMetadataStatus();
      return;
    }

    const selectedIndex = Number.parseInt(choice, 10) - 1;
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= found.length) {
      updateNewWadMetadataStatus('Invalid PWAD/PK3 selection.');
      return;
    }

    const selected = found[selectedIndex];
    await loadPwadMetadataIntoNewWadForm(selected);
  } catch (error) {
    console.error(error);
    updateNewWadMetadataStatus(error.message || 'PWAD/PK3 metadata scan failed.');
  }
}

async function loadPwadMetadataIntoNewWadForm(selected) {
  updateNewWadMetadataStatus(`Reading metadata from ${selected.relativePath || selected.fileName}...`);
  const response = await fetch('/api/extract-pwad-metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wadPath: selected.path,
      iwadField: wadForm.elements.iwad?.value || getAppSetting('defaultIwadPath') || '',
      iwadFolder: getAppSetting('defaultIwadFolder') || getAppSetting('defaultIwadPath') || '',
      iwadPath: getAppSetting('defaultIwadPath') || '',
      metadataFolder: getAppSetting('defaultMetadataFolder') || '',
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Metadata extraction failed.');

  state.pendingNewWadMetadata = {
    ...payload,
    relativePath: selected.relativePath || payload.fileName || '',
  };

  if (wadForm.elements.title) wadForm.elements.title.value = payload.title || selected.fileName?.replace(/\.(wad|pk3)$/i, '') || '';
  if (wadForm.elements.author && payload.author) wadForm.elements.author.value = payload.author;
  if (wadForm.elements.sourcePort && payload.sourcePort) wadForm.elements.sourcePort.value = payload.sourcePort;
  if (wadForm.elements.iwad && payload.iwad) wadForm.elements.iwad.value = payload.iwad;
  if (wadForm.elements.type && payload.type) wadForm.elements.type.value = payload.type;
  if (wadForm.elements.totalMaps) wadForm.elements.totalMaps.value = String(payload.totalMaps || 1);
  if (wadForm.elements.notes && payload.notes) wadForm.elements.notes.value = payload.notes;

  updateNewWadMetadataStatus();
}

function updateNewWadMetadataStatus(message = '') {
  const status = document.getElementById('newWadMetadataStatus');
  if (!status) return;
  const metadata = state.pendingNewWadMetadata;
  if (message) {
    status.textContent = message;
    return;
  }
  if (!metadata) {
    status.textContent = 'No PWAD/PK3 selected yet. You can save manually, or choose a mod file to auto-fill fields.';
    return;
  }
  const mapText = `${metadata.totalMaps || metadata.maps?.length || 1} map${Number(metadata.totalMaps || metadata.maps?.length || 1) === 1 ? '' : 's'}`;
  const sourceText = metadata.metadataSource ? ` via ${metadata.metadataSource}` : '';
  const txtText = metadata.txtMetadataFileName ? " Companion TXT: " + metadata.txtMetadataFileName + "." : "";
  status.textContent = `Selected ${metadata.relativePath || metadata.fileName}. Detected ${mapText}${sourceText}.${txtText} Check the fields, then Save.`;
}


function getAssociatedModFiles(excludeWadId = '') {
  return (state.app?.wads || [])
    .filter((entry) => !excludeWadId || entry.id !== excludeWadId)
    .map((entry) => ({
      path: entry.pwadPath || '',
      fileName: entry.pwadFileName || (entry.pwadPath ? entry.pwadPath.split(/[\\/]/).pop() : ''),
      relativePath: entry.pwadRelativePath || '',
      id: entry.id || '',
    }))
    .filter((entry) => entry.path || entry.fileName || entry.relativePath);
}

function createMetadataPlaceholderMap(entry, sourceType = 'metadata') {
  return {
    id: crypto.randomUUID(),
    levelName: String(entry.levelName || '').trim(),
    displayName: String(entry.displayName || entry.levelName || '').trim(),
    mapAuthor: String(entry.mapAuthor || '').trim(),
    killcount: 0,
    totalkills: 0,
    itemcount: 0,
    totalitems: 0,
    secretcount: 0,
    totalsecrets: 0,
    leveltime: 0,
    deaths: 0,
    sourceType: sourceType.toLowerCase(),
    saveFileName: '',
    metadataFileName: state.pendingNewWadMetadata?.fileName || '',
    notes: 'Auto-filled PWAD metadata placeholder.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}


function getNamedFormInputs(name) {
  return Array.from(mapForm.querySelectorAll(`[name="${name}"]`));
}

function getActiveNamedInput(name) {
  return getNamedFormInputs(name).find((input) => !input.disabled) || getNamedFormInputs(name)[0] || null;
}

function setNamedInputValues(name, value) {
  getNamedFormInputs(name).forEach((input) => {
    input.value = value;
  });
}

function syncMirroredNamedInputs(name, sourceInput = null) {
  const inputs = getNamedFormInputs(name);
  if (!inputs.length) return;
  const source = sourceInput || inputs.find((input) => document.activeElement === input) || inputs.find((input) => !input.disabled) || inputs[0];
  const value = source?.value ?? '';
  inputs.forEach((input) => {
    if (input !== source) input.value = value;
  });
}

function syncAllMirroredTotalInputs() {
  ['totalkills', 'totalitems', 'totalsecrets'].forEach((name) => syncMirroredNamedInputs(name));
}

function updateInputModeUI() {
  const mode = state.mapInputMode;

  document.querySelectorAll('[data-input-mode]').forEach((button) => {
    button.classList.toggle('active', button.dataset.inputMode === mode);
  });

  const countsFields = document.getElementById('countsFields');
  const percentFields = document.getElementById('percentFields');

  syncAllMirroredTotalInputs();

  if (countsFields) {
    countsFields.style.display = mode === 'counts' ? '' : 'none';
    countsFields.querySelectorAll('input, select, textarea, button').forEach((el) => {
      el.disabled = mode !== 'counts';
    });
  }

  if (percentFields) {
    percentFields.style.display = mode === 'percent' ? '' : 'none';
    percentFields.querySelectorAll('input, select, textarea, button').forEach((el) => {
      el.disabled = mode !== 'percent';
    });
  }

  if (mode === 'percent') {
    updateComputedHints();
  }
}

function updateComputedHints() {
  const pairs = [
    { pctId: 'killPctInput', totalName: 'totalkills', hintId: 'killComputed' },
    { pctId: 'itemPctInput', totalName: 'totalitems', hintId: 'itemComputed' },
    { pctId: 'secretPctInput', totalName: 'totalsecrets', hintId: 'secretComputed' },
  ];

  for (const pair of pairs) {
    const pctEl = document.getElementById(pair.pctId);
    const totalEl = getActiveNamedInput(pair.totalName);
    const hintEl = document.getElementById(pair.hintId);
    if (!pctEl || !totalEl || !hintEl) continue;

    const pct = Number(pctEl.value) || 0;
    const total = Number(totalEl.value) || 0;
    const computed = Math.round(total * pct / 100);
    hintEl.textContent = `= ${computed} / ${total}`;
  }
}

function showView(viewName) {
  state.currentView = viewName;
  [homeView, libraryView, wadDetailView, statsView, settingsView, debugView, aboutView].forEach((view) => view.classList.remove('active'));

  if (viewName === 'home') {
    homeView.classList.add('active');
    pageTitle.textContent = 'Home';
    pageSubtitle.textContent = 'At-a-glance progress, recent play, and quick launch points.';
  } else if (viewName === 'library') {
    libraryView.classList.add('active');
    pageTitle.textContent = 'Library';
    pageSubtitle.textContent = 'Track megawads, single maps, medals, imports, and map metadata.';
  } else if (viewName === 'stats') {
    statsView.classList.add('active');
    pageTitle.textContent = 'Overall Stats';
    pageSubtitle.textContent = 'Cross-run summary across everything you have logged.';
  } else if (viewName === 'settings') {
    settingsView.classList.add('active');
    pageTitle.textContent = 'Settings';
    pageSubtitle.textContent = 'Default paths for new WAD/PK3 entries and future automation.';
  } else if (viewName === 'debug') {
    debugView.classList.add('active');
    pageTitle.textContent = 'Log / Debug';
    pageSubtitle.textContent = 'Server, launcher, sync, and Doom output history from this local server.';
    loadDebugLogs();
  } else if (viewName === 'about') {
    aboutView.classList.add('active');
    pageTitle.textContent = 'About Doom Entryway';
    pageSubtitle.textContent = 'Feature overview and release information.';
  }
  render();
}

function showWadDetail(wadId) {
  state.currentWadId = wadId;
  state.currentView = 'wad';
  [homeView, libraryView, wadDetailView, statsView, settingsView, debugView, aboutView].forEach((view) => view.classList.remove('active'));
  wadDetailView.classList.add('active');
  const wad = getCurrentWad();
  if (wad) {
    pageTitle.textContent = wad.title;
    pageSubtitle.textContent = `${capitalize(wad.type)} overview, run summary, medals, imports, and manual editing.`;
  }
  document.querySelectorAll('.nav-button').forEach((b) => b.classList.remove('active'));
  render();
}

function render() {
  renderAlerts();
  const renderers = [
    ['home', renderHome],
    ['library', renderLibrary],
    ['wad', renderWadDetail],
    ['stats', renderStats],
    ['settings', renderSettings],
    ['debug', renderDebug],
    ['about', renderAbout],
  ];
  for (const [name, renderer] of renderers) {
    try {
      renderer();
    } catch (error) {
      console.error(`Render failed for ${name}:`, error);
      if (name === 'home' && state.currentView === 'home') renderHomeFallback(error);
      else if (state.currentView === name) showAlert('error', `${capitalize(name)} view failed to render: ${error.message || error}`);
    }
  }
  if (state.currentView === 'home' && homeView && !homeView.innerHTML.trim()) {
    renderHomeFallback();
  }
}

function renderHomeFallback(error = null) {
  if (!homeView) return;
  const wads = Array.isArray(state.app?.wads) ? state.app.wads : [];
  const currentCount = wads.filter((wad) => (wad.playState || '') === 'current').length;
  const completedCount = wads.filter((wad) => (wad.playState || '') === 'completed').length;
  homeView.innerHTML = `
    <div class="home-dashboard section-stack">
      <section class="home-hero">
        <div>
          <p class="eyebrow">Doom Entryway ${escapeHtml(APP_VERSION)}</p>
          <h3>Your Doom command center</h3>
          <p class="muted-text">Home dashboard fallback loaded. The app is running, and you can jump into the library or stats from here.</p>
          ${error ? `<p class="alert error" style="margin-top:0.8rem;">Home dashboard error: ${escapeHtml(error.message || error)}</p>` : ''}
        </div>
        <div class="home-hero-actions">
          <button class="primary-button" onclick="window.appActions.goLibrary()">Open Library</button>
          <button class="secondary-button" onclick="window.appActions.openTestWadDialog()">Test WAD</button>
        <button class="secondary-button" onclick="window.appActions.goStats()">Overall Stats</button>
          <button class="secondary-button" onclick="document.getElementById('refreshAllButton')?.click()">Refresh All</button>
          <button class="secondary-button" onclick="document.getElementById('newWadButton')?.click()">New WAD</button>
        </div>
      </section>
      <section class="stat-shell">
        <h3>Collection Snapshot</h3>
        <div class="kpi-grid" style="margin-top:0.8rem;">
          <div class="kpi-card"><div class="label">Tracked WADs</div><div class="value">${wads.length}</div></div>
          <div class="kpi-card"><div class="label">Currently Playing</div><div class="value">${currentCount}</div></div>
          <div class="kpi-card"><div class="label">Completed</div><div class="value">${completedCount}</div></div>
        </div>
      </section>
    </div>`;
}

function renderDebug() {
  if (!debugView || state.currentView !== 'debug') return;
  const lines = Array.isArray(state.debug.lines) ? state.debug.lines : [];
  const body = lines.length
    ? lines.map((line) => escapeHtml(line)).join('\n')
    : 'No log lines yet. Launch the app, refresh stats, sync, or start Doom and this page will fill in like a mini terminal.';
  debugView.innerHTML = `
    <section class="stat-shell debug-shell">
      <div class="section-title-row">
        <div>
          <h3>Terminal Log History</h3>
          <p class="muted-text">Showing recent lines from the local server log${state.debug.logPath ? ` at <code>${escapeHtml(state.debug.logPath)}</code>` : ''}.</p>
        </div>
        <div class="button-row">
          <button type="button" class="secondary-button" onclick="window.appActions.refreshDebugLogs()">Refresh</button>
          <button type="button" class="danger-button" onclick="window.appActions.clearDebugLogs()">Clear</button>
        </div>
      </div>
      ${state.debug.error ? `<div class="alert error">${escapeHtml(state.debug.error)}</div>` : ''}
      <div class="debug-toolbar muted-text">
        <span>${lines.length} line${lines.length === 1 ? '' : 's'}</span>
        <span>${state.debug.loadedAt ? `Last loaded ${escapeHtml(state.debug.loadedAt)}` : 'Not loaded yet'}</span>
      </div>
      <pre class="debug-log-box" id="debugLogBox">${body}</pre>
    </section>`;
  const box = document.getElementById('debugLogBox');
  if (box) box.scrollTop = box.scrollHeight;
}

async function loadDebugLogs() {
  if (state.debug.loading) return;
  state.debug.loading = true;
  try {
    const response = await fetch('/api/logs?limit=900');
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not load debug logs.');
    state.debug.lines = Array.isArray(payload.lines) ? payload.lines : [];
    state.debug.logPath = payload.logPath || '';
    state.debug.loadedAt = new Date().toLocaleTimeString();
    state.debug.error = '';
  } catch (error) {
    state.debug.error = error.message || String(error);
  } finally {
    state.debug.loading = false;
    if (state.currentView === 'debug') renderDebug();
  }
}

async function clearDebugLogs() {
  const ok = confirm('Clear the visible debug log history? This also clears doom_entryway_debug.log.');
  if (!ok) return;
  try {
    const response = await fetch('/api/clear-logs', { method: 'POST' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not clear debug logs.');
    state.debug.lines = Array.isArray(payload.lines) ? payload.lines : [];
    state.debug.logPath = payload.logPath || state.debug.logPath || '';
    state.debug.loadedAt = new Date().toLocaleTimeString();
    state.debug.error = '';
    renderDebug();
  } catch (error) {
    state.debug.error = error.message || String(error);
    renderDebug();
  }
}

function renderAlerts() {
  alertsEl.innerHTML = state.alerts
  .map((alert) => `<div class="alert ${alert.type}">${escapeHtml(alert.message)}</div>`)
  .join('');
}

function renderHome() {
  if (state.currentView !== 'home') return;
  ensureFolderState();
  const wads = Array.isArray(state.app?.wads) ? state.app.wads : [];
  const allRuns = wads.flatMap((wad) => (wad.runs || []).map((run) => ({ wad, run })));
  const allMaps = allRuns.flatMap(({ wad, run }) => (run.maps || []).map((map) => ({ wad, run, map })));
  const playedMaps = allMaps.filter(({ map }) => !isUnplayedPlaceholderMap(map));
  const totals = computeMapCollectionTotals(playedMaps.map(({ map }) => map));
  const medalTotals = allMaps.reduce((acc, entry) => {
    const tier = getMedal(entry.map).tier;
    acc[tier] += 1;
    return acc;
  }, { gold: 0, silver: 0, bronze: 0, none: 0, unplayed: 0 });

  const currentWads = wads.filter((wad) => (wad.playState || 'plan') === 'current');
  const continueList = (currentWads.length ? currentWads : wads)
    .slice()
    .sort((a, b) => (getLastPlayedTimestamp(b) || Date.parse(b.updatedAt || b.createdAt || '') || 0) - (getLastPlayedTimestamp(a) || Date.parse(a.updatedAt || a.createdAt || '') || 0))
    .slice(0, 4);
  const recentAdded = wads.slice().sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0)).slice(0, 5);
  const recentlyPlayed = wads.slice().filter((wad) => getLastPlayedTimestamp(wad) > 0).sort((a, b) => getLastPlayedTimestamp(b) - getLastPlayedTimestamp(a)).slice(0, 5);
  const completedCount = wads.filter((wad) => (wad.playState || '') === 'completed').length;
  const currentCount = wads.filter((wad) => (wad.playState || '') === 'current').length;
  const plannedCount = wads.filter((wad) => (wad.playState || 'plan') === 'plan').length;
  const totalMapSlots = sum(wads.map((wad) => Number(wad.totalMaps) || 0));
  const completionPercent = totalMapSlots ? (playedMaps.length / totalMapSlots) * 100 : 0;

  homeView.innerHTML = `
  <div class="home-dashboard section-stack">
    <section class="home-hero">
      <div>
        <p class="eyebrow">Doom Entryway ${escapeHtml(APP_VERSION)}</p>
        <h3>Your Doom command center</h3>
        <p class="muted-text">Jump back into current WADs, check collection progress, and spot what changed without digging through the library.</p>
      </div>
      <div class="home-hero-actions">
        <button class="primary-button" onclick="window.appActions.goLibrary()">Open Library</button>
        <button class="secondary-button" onclick="window.appActions.openTestWadDialog()">Test WAD</button>
        <button class="secondary-button" onclick="window.appActions.goStats()">Overall Stats</button>
        <button class="secondary-button" onclick="document.getElementById('refreshAllButton')?.click()">Refresh All</button>
        <button class="secondary-button" onclick="document.getElementById('newWadButton')?.click()">New WAD</button>
      </div>
    </section>

    <section class="stat-shell">
      <h3>Collection Snapshot</h3>
      <div class="kpi-grid" style="margin-top:0.8rem;">
        <div class="kpi-card"><div class="label">Tracked WADs</div><div class="value">${wads.length}</div></div>
        <div class="kpi-card"><div class="label">Currently Playing</div><div class="value">${currentCount}</div></div>
        <div class="kpi-card"><div class="label">Completed</div><div class="value">${completedCount}</div></div>
        <div class="kpi-card"><div class="label">Plan to Play</div><div class="value">${plannedCount}</div></div>
        <div class="kpi-card"><div class="label">Maps Logged</div><div class="value">${playedMaps.length} / ${totalMapSlots}</div></div>
        <div class="kpi-card"><div class="label">Completion</div><div class="value">${formatPercent(completionPercent)}</div></div>
        <div class="kpi-card"><div class="label">Tracked Time</div><div class="value">${formatTics(totals.totalTimeTics)}</div></div>
        <div class="kpi-card"><div class="label">Kills / Min</div><div class="value">${formatNumber(totals.averageKillsPerMinute, 2)}</div></div>
      </div>
    </section>

    <div class="home-grid">
      <section class="stat-shell home-panel">
        <div class="section-title-row"><h3>Continue Playing</h3><button class="ghost-button" onclick="window.appActions.openLibraryPreset('playState','current')">View current</button></div>
        ${continueList.length ? `<div class="home-card-list">${continueList.map(renderHomeWadMiniCard).join('')}</div>` : renderHomeEmpty('No current WADs yet. Mark something as Currently Playing and it will show here.')}
      </section>

      <section class="stat-shell home-panel">
        <h3>Medal Haul</h3>
        <div class="home-medal-grid">
          <div class="home-medal gold">🥇<strong>${medalTotals.gold}</strong><span>Gold</span></div>
          <div class="home-medal silver">🥈<strong>${medalTotals.silver}</strong><span>Silver</span></div>
          <div class="home-medal bronze">🥉<strong>${medalTotals.bronze}</strong><span>Bronze</span></div>
        </div>
        <div class="home-totals-list">
          <div><span>Total demons slain</span><strong>${formatInteger(totals.totalKills)}</strong></div>
          <div><span>Total items collected</span><strong>${formatInteger(totals.totalItems)}</strong></div>
          <div><span>Total secrets found</span><strong>${formatInteger(totals.totalSecrets)}</strong></div>
        </div>
      </section>
    </div>

    <div class="home-grid">
      <section class="stat-shell home-panel">
        <h3>Recently Played</h3>
        ${recentlyPlayed.length ? `<div class="home-list">${recentlyPlayed.map((wad) => renderHomeListRow(wad, formatLastPlayedRelative(getLastPlayedTimestamp(wad)))).join('')}</div>` : renderHomeEmpty('No imported save stats yet.')}
      </section>
      <section class="stat-shell home-panel">
        <h3>Recently Added</h3>
        ${recentAdded.length ? `<div class="home-list">${recentAdded.map((wad) => renderHomeListRow(wad, `Added ${formatLibraryDate(Date.parse(wad.createdAt || '') || 0)}`)).join('')}</div>` : renderHomeEmpty('Create your first WAD card to begin.')}
      </section>
    </div>

    <section class="stat-shell">
      <h3>Quick Filters</h3>
      <div class="quick-action-row">
        <button class="filter-pill" onclick="window.appActions.openLibraryPreset('playState','current')">Currently Playing</button>
        <button class="filter-pill" onclick="window.appActions.openLibraryPreset('playState','plan')">Plan to Play</button>
        <button class="filter-pill" onclick="window.appActions.openLibraryPreset('playState','completed')">Completed</button>
        ${renderHomeTypeButtons(wads)}
        ${renderHomeTagButtons(wads)}
      </div>
    </section>
  </div>`;
}

function renderHomeWadMiniCard(wad) {
  const latestRun = getLatestRun(wad);
  const summary = latestRun ? computeRunSummary(latestRun, wad.totalMaps, wad) : createEmptySummary(wad.totalMaps);
  return `<article class="home-wad-mini">
    ${getTitlePicSrc(wad) ? `<button type="button" class="home-mini-thumb-button" onclick="window.appActions.openTitlepic('${escapeJsString(getTitlePicSrc(wad))}', '${escapeJsString(wad.title || 'TITLEPIC')}')"><img src="${getTitlePicSrc(wad)}" alt="${escapeHtml(wad.title)} titlepic"></button>` : `<div class="home-mini-thumb-placeholder">TITLEPIC</div>`}
    <div class="home-mini-body">
      <button class="inline-link-button home-mini-title" onclick="window.appActions.openWad('${escapeJsString(wad.id)}')">${escapeHtml(wad.title || 'Untitled')}</button>
      <div class="card-meta"><span>${escapeHtml(capitalize(wad.type || 'wad'))}</span><span>${escapeHtml(wad.iwad || 'IWAD not set')}</span><span>${escapeHtml(latestRun?.difficulty || 'UV')}</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${summary.progressPercent}%"></div></div>
      <div class="card-meta"><span>${summary.completedMaps} / ${Number(wad.totalMaps) || 0} maps</span><span>${formatPercent(summary.avgKillPercent)} kills</span><span>${formatTics(summary.totalTimeTics)}</span></div>
    </div>
  </article>`;
}

function renderHomeListRow(wad, metaText) {
  const latestRun = getLatestRun(wad);
  const summary = latestRun ? computeRunSummary(latestRun, wad.totalMaps, wad) : createEmptySummary(wad.totalMaps);
  return `<div class="home-list-row">
    <button class="inline-link-button" onclick="window.appActions.openWad('${escapeJsString(wad.id)}')">${escapeHtml(wad.title || 'Untitled')}</button>
    <span>${escapeHtml(metaText)}</span>
    <span>${summary.completedMaps}/${Number(wad.totalMaps) || 0} maps</span>
  </div>`;
}

function renderHomeEmpty(text) {
  return `<div class="empty-state small-empty">${escapeHtml(text)}</div>`;
}

function renderHomeTypeButtons(wads) {
  const types = Array.from(new Set(wads.map((wad) => wad.type).filter(Boolean))).slice(0, 4);
  return types.map((type) => `<button class="filter-pill" onclick="window.appActions.openLibraryPreset('type','${escapeJsString(type)}')">${escapeHtml(capitalize(type))}</button>`).join('');
}

function renderHomeTagButtons(wads) {
  const counts = new Map();
  for (const wad of wads) for (const tag of getWadTags(wad)) counts.set(tag, (counts.get(tag) || 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)
    .map(([tag, count]) => `<button class="filter-pill" onclick="window.appActions.openLibraryPreset('tag','${escapeJsString(tag)}')">#${escapeHtml(tag)} ${count}</button>`).join('');
}

function activateNav(viewName) {
  document.querySelectorAll('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === viewName));
}

function openLibraryPreset(key, value) {
  state.libraryFilter = 'all';
  state.libraryQuickFilters = {};
  if (key === 'playState') state.libraryQuickFilters.playState = value;
  else if (key) state.libraryQuickFilters[key] = value;
  activateNav('library');
  showView('library');
}

function renderLibrary() {
  if (state.currentView !== 'library') return;

  ensureFolderState();
  if (state.currentFolderId && !getFolderById(state.currentFolderId)) state.currentFolderId = null;

  const hasSearch = state.librarySearch.trim().length > 0;
  const folderScopeWads = hasSearch
    ? state.app.wads
    : state.app.wads.filter((wad) => normalizeFolderId(wad.folderId) === state.currentFolderId);

  const stateFilteredWads = state.libraryFilter === 'all'
    ? folderScopeWads
    : folderScopeWads.filter((wad) => (wad.playState || 'plan') === state.libraryFilter);

  const quickFilteredWads = stateFilteredWads.filter((wad) => matchesLibraryQuickFilters(wad));
  const filteredWads = quickFilteredWads.filter((wad) => matchesLibrarySearch(wad, state.librarySearch));
  const childFolders = hasSearch ? [] : getChildFolders(state.currentFolderId);
  const sortedFolders = sortLibraryFolders(childFolders);
  const sortedWads = sortLibraryWads(filteredWads);

  const folderCards = sortedFolders.map((folder) => {
    const directCount = state.app.wads.filter((wad) => normalizeFolderId(wad.folderId) === folder.id).length;
    const totalCount = getDescendantFolderIds(folder.id).reduce((count, folderId) => {
      return count + state.app.wads.filter((wad) => normalizeFolderId(wad.folderId) === folderId).length;
    }, directCount);
    return `
    <article class="folder-card">
      <button class="folder-card-open" onclick="window.appActions.openFolder('${folder.id}')">
        <div class="folder-icon">📁</div>
        <div>
          <h3>${escapeHtml(folder.name)}</h3>
          <p class="subtle">${directCount} direct WAD${directCount === 1 ? '' : 's'}${totalCount !== directCount ? ` • ${totalCount} including subfolders` : ''}</p>
        </div>
      </button>
      <div class="control-row folder-card-actions">
        <button class="ghost-button" onclick="window.appActions.renameFolder('${folder.id}')">Rename</button>
        <button class="danger-button" onclick="window.appActions.deleteFolder('${folder.id}')">Delete</button>
      </div>
    </article>`;
  }).join('');

  const wadEntries = sortedWads.map((wad) => state.libraryViewMode === 'compact'
    ? renderCompactWadRow(wad)
    : renderLibraryWadCard(wad)
  ).join('');
  const densityStyle = state.libraryViewMode === 'compact'
    ? `--library-density-scale:${getLibraryDensityScale()};`
    : `--library-card-min:${state.libraryDensity}px;`;
  const wadListClass = state.libraryViewMode === 'compact' ? 'compact-list' : 'grid-cards library-card-grid';


  libraryView.innerHTML = `
  <div class="section-stack">
  <section class="summary-card folder-toolbar">
    <div class="breadcrumb-row">${renderFolderBreadcrumb()}</div>
    <div class="section-bar">
      <div>
        <h3>${escapeHtml(getCurrentFolderName())}</h3>
        <p class="subtle">Virtual folders only organise the library database. They do not move files on disk.</p>
      </div>
      <div class="control-row">
        <button class="secondary-button" onclick="window.appActions.createFolder()">New Folder</button>
        ${state.currentFolderId ? `<button class="danger-button" onclick="window.appActions.deleteFolder('${state.currentFolderId}')">Delete This Folder</button>` : ''}
      </div>
    </div>
  </section>

  <section class="summary-card">
  <div class="section-bar">
  <h3>Filters</h3>
  <div class="filter-pill-row">
  ${renderLibraryFilterButton('all', 'All')}
  ${renderLibraryFilterButton('plan', 'Plan to Play')}
  ${renderLibraryFilterButton('current', 'Currently Playing')}
  ${renderLibraryFilterButton('hold', 'On Hold')}
  ${renderLibraryFilterButton('dropped', 'Dropped')}
  ${renderLibraryFilterButton('completed', 'Completed')}
  </div>
  </div>
  <div class="library-search-row">
  <label class="library-search-label" for="librarySearchInput">Live search</label>
  <input id="librarySearchInput" class="library-search-input" type="search" placeholder="Search title, author, map name, map author, or tag…" value="${escapeHtml(state.librarySearch)}" oninput="window.appActions.setLibrarySearch(this.value)" />
  ${hasSearch ? `<button class="ghost-button" onclick="window.appActions.clearLibrarySearch()">Clear</button>` : ''}
  </div>
  ${renderActiveLibraryQuickFilters()}
  ${renderLibraryViewControls()}
  ${renderLibrarySortControls()}
  <p class="subtle library-search-hint">Folders stay pinned first. Showing ${sortedWads.length} WAD card${sortedWads.length === 1 ? '' : 's'} sorted by ${escapeHtml(getLibrarySortLabel(state.librarySortKey))} (${state.librarySortDirection === 'asc' ? 'ascending' : 'descending'}).</p>
  ${hasSearch ? `<p class="subtle library-search-hint">Search ignores folder scope. Showing ${filteredWads.length} of ${quickFilteredWads.length} entries for “${escapeHtml(state.librarySearch.trim())}”.</p>` : ''}
  </section>
  ${folderCards ? `<div class="folder-grid">${folderCards}</div>` : ''}
  ${filteredWads.length ? `<div class="${wadListClass}" style="${densityStyle}">${wadEntries}</div>` : `<div class="empty-state"><div class="empty-icon">📁</div><h3>No WADs match ${hasSearch ? 'this search' : 'this folder/filter'}</h3><p>${hasSearch ? 'Try a different title, author, map name, map author, or tag.' : 'Create a folder, move cards here, or add a new entry.'}</p></div>`}
  </div>
  `;
}


function getTitlePicSrc(wad) {
  if (!wad) return '';
  if (wad.titlePicFileName) return `/api/titlepic?file=${encodeURIComponent(wad.titlePicFileName)}&v=${encodeURIComponent(wad.updatedAt || wad.createdAt || '')}`;
  return wad.titlePicDataUrl || '';
}

function hasTitlePic(wad) {
  return Boolean(getTitlePicSrc(wad));
}

async function saveManagedTitlepic(wad, dataUrl) {
  const folder = getAppSetting('defaultTitlepicsFolder');
  if (!folder) throw new Error('Set the Titlepics folder in Settings first.');
  const response = await fetch('/api/save-titlepic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      titlepicsFolder: folder,
      dataUrl,
      titleHint: wad?.title || wad?.pwadFileName || 'titlepic',
      existingFileName: wad?.titlePicFileName || '',
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Could not save titlepic PNG.');
  return payload;
}

function renderWadDetail() {
  if (state.currentView !== 'wad') return;

  const wad = getCurrentWad();
  if (!wad) {
    wadDetailView.innerHTML = document.getElementById('emptyStateTemplate').innerHTML;
    return;
  }

  const selectedRun = getLatestRun(wad) || createRun('Default Run');
  if (!wad.runs.length) wad.runs.push(selectedRun);
  const summary = computeRunSummary(selectedRun, wad.totalMaps, wad);

  wadDetailView.innerHTML = `
  <div class="section-stack">
  <section class="detail-shell">
  <div class="detail-head">
  <div class="detail-head-main">
  <div class="titlepic-shell">
  ${getTitlePicSrc(wad) ? `<button type="button" class="titlepic-open-button" onclick="window.appActions.openTitlepic('${escapeJsString(getTitlePicSrc(wad))}', '${escapeJsString(wad.title || 'TITLEPIC')}')" title="Open titlepic for ${escapeHtml(wad.title || 'this WAD')}"><img src="${getTitlePicSrc(wad)}" alt="${escapeHtml(wad.title)} titlepic" class="titlepic-preview" /></button>` : `<div class="titlepic-placeholder">TITLEPIC</div>`}
  </div>
  <div>
  <h3>${escapeHtml(wad.title)}</h3>
  <p class="muted">${escapeHtml(wad.author || 'Unknown author')} • ${escapeHtml(wad.iwad || 'IWAD not set')} • ${escapeHtml(wad.sourcePort || 'Source port not set')}</p>
  <div class="tag-row" style="margin-top:0.6rem;">
  <span class="tag-chip">State: ${playStateLabel(wad.playState || 'plan')}</span>
  <span class="tag-chip">Difficulty: ${escapeHtml(selectedRun.difficulty || 'UV')}</span>
  ${wad.excludeFromRefreshAll ? `<span class="tag-chip">Excluded from Refresh All</span>` : ''}
  ${wad.pwadPath ? `<span class="tag-chip">WAD: ${escapeHtml(wad.pwadPath.split(/[\/]/).pop())}</span>` : `<span class="tag-chip">WAD file: not associated</span>`}
  </div>
  </div>
  </div>
  <div class="control-row">
  <button class="primary-button" onclick="window.appActions.openLaunchDialog('${escapeJsString(wad.id)}')">▶ Play</button>
  <button class="secondary-button" onclick="window.appActions.goLibrary()">Back to Library</button>
  <button class="secondary-button" onclick="window.appActions.editWad('${wad.id}')">Edit WAD Info</button>
  <button class="danger-button" onclick="window.appActions.deleteWad('${wad.id}')">Delete WAD</button>
  <button class="primary-button" onclick="window.appActions.addRun('${wad.id}')">New Run</button>
  </div>
  </div>

  <div class="section-bar">
  <div class="control-row">
  <label class="muted">State</label>
  <select id="wadPlayState">${renderPlayStateOptions(wad.playState || 'plan')}</select>
  <input type="file" id="titlePicInput" accept="image/*" hidden />
  <button class="secondary-button" id="uploadTitlePicButton" type="button">Set Titlepic</button>
  ${hasTitlePic(wad) ? `<button class="secondary-button" id="removeTitlePicButton" type="button">Remove Titlepic</button>` : ''}
  <button class="secondary-button" id="setWadFileButton" type="button">Set WAD</button>
  ${wad.pwadPath ? `<button class="secondary-button" id="extractTitlepicButton" type="button">Extract Titlepic from WAD</button>` : ''}
  </div>
  <div class="control-row">
  <label class="muted">Run</label>
  <select id="runSelector">${wad.runs.map((run) => `<option value="${run.id}" ${run.id === selectedRun.id ? 'selected' : ''}>${escapeHtml(run.name)} • ${formatDate(run.createdAt)}</option>`).join('')}</select>
  <button class="danger-button" id="deleteRunButton" type="button">Delete Run</button>
  <label class="muted">Difficulty</label>
  <select id="runDifficulty">${renderDifficultyOptions(selectedRun.difficulty || 'UV')}</select>
  </div>
  <div class="toggle-group" aria-label="Display mode">
  <button class="${state.displayMode === 'counts' ? 'active' : ''}" data-display-mode="counts">Counts</button>
  <button class="${state.displayMode === 'percent' ? 'active' : ''}" data-display-mode="percent">Percent</button>
  <button class="${state.displayMode === 'both' ? 'active' : ''}" data-display-mode="both">Both</button>
  </div>
  </div>

  <div class="kpi-grid">
  <div class="kpi-card"><div class="label">Maps Completed</div><div class="value">${summary.completedMaps} / ${wad.totalMaps}</div></div>
  <div class="kpi-card"><div class="label">Average Kill %</div><div class="value">${formatPercent(summary.avgKillPercent)}</div></div>
  <div class="kpi-card"><div class="label">Average Item %</div><div class="value">${formatPercent(summary.avgItemPercent)}</div></div>
  <div class="kpi-card"><div class="label">Average Secret %</div><div class="value">${formatPercent(summary.avgSecretPercent)}</div></div>
  <div class="kpi-card"><div class="label">Total Deaths</div><div class="value">${summary.totalDeaths}</div></div>
  <div class="kpi-card"><div class="label">Total Time</div><div class="value">${formatTics(summary.totalTimeTics)}</div></div>
  <div class="kpi-card"><div class="label">Demons Slain</div><div class="value">${formatInteger(summary.totalKills)}</div></div>
  <div class="kpi-card"><div class="label">Items Collected</div><div class="value">${formatInteger(summary.totalItems)}</div></div>
  <div class="kpi-card"><div class="label">Secrets Found</div><div class="value">${formatInteger(summary.totalSecrets)}</div></div>
  <div class="kpi-card"><div class="label">Average Kills / Min</div><div class="value">${formatNumber(summary.averageKillsPerMinute, 2)}</div></div>
  </div>

  <div class="kpi-grid" style="margin-top:0.85rem;">
  <div class="kpi-card"><div class="label">Gold Medals</div><div class="value">🥇 ${summary.medals.gold}</div></div>
  <div class="kpi-card"><div class="label">Silver Medals</div><div class="value">🥈 ${summary.medals.silver}</div></div>
  <div class="kpi-card"><div class="label">Bronze Medals</div><div class="value">🥉 ${summary.medals.bronze}</div></div>
  <div class="kpi-card"><div class="label">No Medal</div><div class="value">⚫ ${summary.medals.none}</div></div>
  <div class="kpi-card"><div class="label">Unplayed</div><div class="value">— ${summary.medals.unplayed}</div></div>
  <div class="kpi-card"><div class="label">Weighted Kill %</div><div class="value">${formatPercent(summary.weightedKillPercent)}</div></div>
  <div class="kpi-card"><div class="label">Full Clears</div><div class="value">${summary.medals.gold}</div></div>
  </div>
  </section>

  <section class="dual-grid">
  <div class="table-shell">
  <div class="section-bar">
  <h3>Map Breakdown</h3>
  <div class="control-row">
  <button class="secondary-button" onclick="window.appActions.addManualMap('${selectedRun.id}')">Add Final / Manual Map</button>
  </div>
  </div>
  ${renderMapTable(selectedRun)}
  </div>

  <div class="section-stack">
  <section class="summary-card">
  <div class="section-bar">
  <h4>Local Save Folder</h4>
  </div>
  <div class="upload-callout">
  Paste the folder path where this WAD's <code>.zds</code> saves live. The Python local server can find the newest save and refresh this run automatically. Manual import is still available here for one-off <code>.zds</code> files.
  </div>
  <div class="control-row local-save-row" style="margin-top:0.8rem;">
    <input id="saveFolderPathInput" class="local-save-input" type="text" placeholder="/home/damo/.config/gzdoom/savegames/..." value="${escapeHtml(wad.saveFolderPath || '')}" />
    <button type="button" class="secondary-button" id="autoDetectSaveFolderButton">Auto Detect</button>
    <button type="button" class="secondary-button" id="saveFolderPathButton">Save Folder</button>
    <button type="button" class="primary-button" id="refreshLatestSaveButton">Refresh Latest .zds</button>
    <button type="button" class="secondary-button" id="manualZdsImportButton">Manual Import</button>
    <input type="file" id="fileInput" accept=".zds,.zip" hidden />
  </div>
  <div id="saveFolderDetectResult" class="auto-detect-result"></div>
  <div class="subtle" style="margin-top:0.7rem;">Auto Detect searches the Settings default root save folder for a subfolder that fuzzy-matches this WAD name, ignoring case. This requires launching the app with <code>python local_server.py</code>.</div>
  <div class="subtle" style="margin-top:0.5rem;">Associated WAD/PK3: ${wad.pwadPath ? `<code>${escapeHtml(wad.pwadPath)}</code>` : 'not set'}</div>
  <div class="metadata-txt-panel" style="margin-top:0.85rem;">
    <div class="section-bar compact-section-bar">
      <h4>Companion TXT</h4>
      <button type="button" class="secondary-button" id="refreshCompanionTxtButton">Refresh TXT Preview</button>
    </div>
    <div id="companionTxtStatus" class="subtle">Checking metadata TXT folder...</div>
    <pre id="companionTxtPreview" class="metadata-txt-preview">No TXT loaded.</pre>
  </div>
  </section>

  <section class="summary-card">
  <h4>Run Notes</h4>
  <p class="muted">Current run mode: ${escapeHtml(selectedRun.mode || 'Continuous')}</p>
  <p class="muted">Difficulty: ${escapeHtml(selectedRun.difficulty || 'UV')}</p>
  <p class="muted">Mods: ${escapeHtml(selectedRun.mods || 'Not set')}</p>
  <p class="muted">Tip: WAD/PK3 and companion TXT metadata are handled automatically when adding or refreshing metadata.</p>
  </section>
  </div>
  </section>

  <section class="summary-card screenshot-section">
    <div class="section-bar">
      <div>
        <h3>Screenshot Gallery</h3>
        <p class="muted">Auto-detect or manually set this WAD's screenshot folder, then refresh to show thumbnails.</p>
      </div>
      <div class="control-row">
        <button type="button" class="secondary-button" id="autoDetectScreenshotFolderButton">Auto Detect</button>
        <button type="button" class="secondary-button" id="saveScreenshotFolderButton">Save Folder</button>
        <button type="button" class="primary-button" id="refreshScreenshotsButton">Refresh Screenshots</button>
      </div>
    </div>
    <div class="control-row local-save-row" style="margin-top:0.8rem;">
      <input id="screenshotFolderPathInput" class="local-save-input" type="text" placeholder="/home/damo/Games/Doom/screenshots/..." value="${escapeHtml(wad.screenshotFolderPath || getAppSetting('defaultScreenshotFolder') || '')}" />
    </div>
    <div id="screenshotFolderDetectResult" class="auto-detect-result"></div>
    <div id="screenshotGalleryStatus" class="subtle" style="margin-top:0.65rem;">${screenshotGalleryStatus(wad)}</div>
    <div id="screenshotGallery" class="screenshot-gallery">${renderScreenshotGallery(wad)}</div>
  </section>
  </div>
  `;

  const runSelector = document.getElementById('runSelector');
  runSelector.addEventListener('change', async (event) => {
    const newRunId = event.target.value;
    const liveWad = state.app.wads.find((entry) => entry.id === wad.id);
    if (!liveWad) return;
    liveWad.selectedRunId = newRunId;
    liveWad.updatedAt = new Date().toISOString();
    await saveState();
    const refreshedWad = state.app.wads.find((entry) => entry.id === wad.id);
    if (refreshedWad) refreshedWad.selectedRunId = newRunId;
    render();
  });

  const runDifficulty = document.getElementById('runDifficulty');
  runDifficulty?.addEventListener('change', async (event) => {
    const newDifficulty = event.target.value;
    const liveWad = state.app.wads.find((entry) => entry.id === wad.id);
    const liveRun = liveWad?.runs.find((entry) => entry.id === selectedRun.id);
    if (!liveRun) return;

    // saveState() replaces state.app from the server response. Use the live
    // state object, not the stale render-time selectedRun closure.
    liveRun.difficulty = newDifficulty;
    await saveState();
    render();
  });

  const deleteRunButton = document.getElementById('deleteRunButton');
  deleteRunButton?.addEventListener('click', () => {
    window.appActions.deleteRun(wad.id, selectedRun.id);
  });

  const wadPlayState = document.getElementById('wadPlayState');
  wadPlayState?.addEventListener('change', async (event) => {
    const newPlayState = event.target.value;
    const liveWad = state.app.wads.find((entry) => entry.id === wad.id);
    if (!liveWad) return;
    liveWad.playState = newPlayState;
    liveWad.updatedAt = new Date().toISOString();
    await saveState();
    const refreshedWad = state.app.wads.find((entry) => entry.id === wad.id);
    if (refreshedWad) refreshedWad.playState = newPlayState;
    render();
  });

  const titlePicInput = document.getElementById('titlePicInput');
  const uploadTitlePicButton = document.getElementById('uploadTitlePicButton');
  const removeTitlePicButton = document.getElementById('removeTitlePicButton');
  const setWadFileButton = document.getElementById('setWadFileButton');
  const extractTitlepicButton = document.getElementById('extractTitlepicButton');
  uploadTitlePicButton?.addEventListener('click', () => titlePicInput?.click());
  titlePicInput?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const saved = await saveManagedTitlepic(wad, await fileToDataUrl(file));
      wad.titlePicFileName = saved.titlePicFileName || '';
      wad.titlePicPath = saved.titlePicPath || '';
      delete wad.titlePicDataUrl;
      wad.updatedAt = new Date().toISOString();
      await saveState();
      showAlert('success', `Titlepic saved as PNG in the titlepics folder (${saved.titlePicFileName || 'image'}).`);
      render();
    } catch (error) {
      console.error(error);
      showAlert('error', error.message || 'Titlepic update failed.');
    } finally {
      event.target.value = '';
    }
  });
  removeTitlePicButton?.addEventListener('click', async () => {
    const oldFile = wad.titlePicFileName || '';
    if (oldFile) tombstoneTitlepic(oldFile);
    if (oldFile && getAppSetting('defaultTitlepicsFolder')) {
      fetch('/api/delete-titlepic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titlepicsFolder: getAppSetting('defaultTitlepicsFolder'), titlePicFileName: oldFile }),
      }).catch(() => {});
    }
    wad.titlePicFileName = '';
    wad.titlePicPath = '';
    delete wad.titlePicDataUrl;
    wad.updatedAt = new Date().toISOString();
    await saveState();
    showAlert('success', 'Titlepic removed.');
    render();
  });

  setWadFileButton?.addEventListener('click', () => associateWadFile(wad.id));
  extractTitlepicButton?.addEventListener('click', () => extractTitlepicFromAssociatedWad(wad.id));

  const saveFolderPathInput = document.getElementById('saveFolderPathInput');
  const saveFolderPathButton = document.getElementById('saveFolderPathButton');
  const autoDetectSaveFolderButton = document.getElementById('autoDetectSaveFolderButton');
  const refreshLatestSaveButton = document.getElementById('refreshLatestSaveButton');
  const manualZdsImportButton = document.getElementById('manualZdsImportButton');
  const fileInput = document.getElementById('fileInput');
  const refreshCompanionTxtButton = document.getElementById('refreshCompanionTxtButton');

  autoDetectSaveFolderButton?.addEventListener('click', () => {
    autoDetectSaveFolder(wad.id);
  });

  saveFolderPathButton?.addEventListener('click', async () => {
    const liveWad = state.app.wads.find((entry) => entry.id === wad.id);
    if (!liveWad) return;
    liveWad.saveFolderPath = String(saveFolderPathInput?.value || '').trim();
    await saveState();
    showAlert('success', liveWad.saveFolderPath ? 'Save folder saved for this WAD.' : 'Save folder cleared.');
    render();
  });

  refreshLatestSaveButton?.addEventListener('click', () => {
    refreshLatestSaveFromFolder(wad.id, getSelectedRunIdForWad(wad.id));
  });

  manualZdsImportButton?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (file) await importZdsFile(file, getSelectedRunIdForWad(wad.id));
    fileInput.value = '';
  });

  refreshCompanionTxtButton?.addEventListener('click', () => loadCompanionTxtPreview(wad.id));
  loadCompanionTxtPreview(wad.id);

  const screenshotFolderPathInput = document.getElementById('screenshotFolderPathInput');
  document.getElementById('saveScreenshotFolderButton')?.addEventListener('click', async () => {
    wad.screenshotFolderPath = String(screenshotFolderPathInput?.value || '').trim();
    await saveState();
    showAlert('success', wad.screenshotFolderPath ? 'Screenshot folder saved for this WAD.' : 'Screenshot folder cleared.');
    render();
  });
  document.getElementById('autoDetectScreenshotFolderButton')?.addEventListener('click', () => autoDetectScreenshotFolder(wad.id));
  document.getElementById('refreshScreenshotsButton')?.addEventListener('click', () => refreshScreenshotsForWad(wad.id));

  document.querySelectorAll('[data-display-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      state.displayMode = button.dataset.displayMode;
      render();
    });
  });

}

function renderMapTable(run) {
  const maps = [...run.maps].sort(compareMapSlots);
  if (!maps.length) {
    return `<div class="empty-state"><div class="empty-icon">🗺</div><h3>No maps logged for this run yet</h3><p>Use Manual Import, Refresh Latest .zds, or add a manual entry for a final map.</p></div>`;
  }

  return `
  <table>
  <thead>
  <tr>
  <th>Map</th>
  <th>Medal</th>
  <th>Difficulty</th>
  <th>Kills</th>
  <th>Items</th>
  <th>Secrets</th>
  <th>Time</th>
  <th>Deaths</th>
  <th>Source</th>
  <th></th>
  </tr>
  </thead>
  <tbody>
  ${maps.map((map) => {
    const medal = getMedal(map);
    return `
    <tr>
    <td>
    <div class="map-name">
    <strong>${escapeHtml(map.levelName)}</strong>
    <span class="subtle">${escapeHtml(map.displayName || map.levelName)}</span>
    ${map.mapAuthor ? `<span class="subtle">By ${escapeHtml(map.mapAuthor)}</span>` : ''}
    </div>
    </td>
    <td>${renderMedalBadge(medal)}</td>
    <td><span class="tag-chip compact-chip">${escapeHtml(getMapDifficulty(map, run))}</span></td>
    <td class="stat-pair">${renderStatValue(map.killcount, map.totalkills)}</td>
    <td class="stat-pair">${renderStatValue(map.itemcount, map.totalitems)}</td>
    <td class="stat-pair">${renderStatValue(map.secretcount, map.totalsecrets)}</td>
    <td>${formatTics(map.leveltime)}</td>
    <td>${map.deaths || 0}</td>
    <td><span class="source-chip">${sourceLabel(map.sourceType)}</span></td>
    <td><button class="small-button" onclick="window.appActions.editMap('${run.id}', '${map.id}')">Details</button></td>
    </tr>
    `;
  }).join('')}
  </tbody>
  </table>
  `;
}

function screenshotGalleryStatus(wad) {
  const count = Array.isArray(wad?.screenshots) ? wad.screenshots.length : 0;
  const folder = String(wad?.screenshotFolderPath || '').trim();
  if (!folder) return 'No screenshot folder set for this WAD yet.';
  if (!count) return 'No screenshots loaded yet. Click Refresh Screenshots.';
  return count + ' screenshot' + (count === 1 ? '' : 's') + ' loaded from ' + escapeHtml(folder) + '.';
}

function screenshotUrl(filePath) {
  return '/api/screenshot?path=' + encodeURIComponent(filePath) + '&v=' + Date.now();
}

function renderScreenshotGallery(wad) {
  const screenshots = Array.isArray(wad?.screenshots) ? wad.screenshots : [];
  if (!screenshots.length) {
    return '<div class="empty-state screenshot-empty"><div class="empty-icon">📸</div><h3>No screenshots yet</h3><p>Set or auto-detect the screenshot folder, then click Refresh Screenshots.</p></div>';
  }
  return screenshots.map((shot, index) => {
    const path = String(shot.filePath || '');
    const name = String(shot.fileName || path.split(/[\/]/).pop() || ('Screenshot ' + (index + 1)));
    const url = screenshotUrl(path);
    return `
      <div class="screenshot-thumb-card">
        <button type="button" class="screenshot-thumb-button" onclick="window.appActions.openScreenshot('${escapeJsString(path)}', '${escapeJsString(name)}')" title="Open ${escapeHtml(name)}">
          <img src="${url}" alt="${escapeHtml(name)}" loading="lazy" />
        </button>
        <button type="button" class="screenshot-delete-button" onclick="window.appActions.deleteScreenshot('${escapeJsString(path)}')" title="Permanently delete screenshot">🗑</button>
        <div class="screenshot-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      </div>`;
  }).join('');
}

async function autoDetectScreenshotFolder(wadId) {
  const wad = state.app.wads.find((entry) => entry.id === wadId);
  const resultEl = document.getElementById('screenshotFolderDetectResult');
  if (!wad) return;
  const rootFolder = getAppSetting('defaultScreenshotFolder');
  if (!rootFolder) {
    showAlert('error', 'Set the Default Screenshot folder in Settings first.');
    return;
  }
  if (resultEl) resultEl.textContent = 'Scanning screenshot folders...';
  try {
    const response = await fetch('/api/detect-screenshot-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootFolder, wadName: wad.title || wad.pwadFileName || '' }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Screenshot folder auto-detect failed.');
    const best = payload.bestMatch;
    if (!best?.path) throw new Error('No screenshot folder match was returned.');
    wad.screenshotFolderPath = best.path;
    await saveState();
    const input = document.getElementById('screenshotFolderPathInput');
    if (input) input.value = best.path;
    if (resultEl) resultEl.innerHTML = 'Best match: <code>' + escapeHtml(best.path) + '</code> <span class="subtle">score ' + escapeHtml(best.score) + '</span>';
    showAlert('success', 'Screenshot folder auto-detected. Refreshing gallery...');
    await refreshScreenshotsForWad(wad.id, false);
  } catch (error) {
    console.error(error);
    if (resultEl) resultEl.textContent = error.message || 'Screenshot folder auto-detect failed.';
    showAlert('error', error.message || 'Screenshot folder auto-detect failed.');
  }
}

async function refreshScreenshotsForWad(wadId, showSuccess = true) {
  const wad = state.app.wads.find((entry) => entry.id === wadId);
  if (!wad) return;
  const input = document.getElementById('screenshotFolderPathInput');
  const folderPath = String(input?.value || wad.screenshotFolderPath || getAppSetting('defaultScreenshotFolder') || '').trim();
  if (!folderPath) {
    showAlert('error', 'Set a screenshot folder first.');
    return;
  }
  wad.screenshotFolderPath = folderPath;
  const statusEl = document.getElementById('screenshotGalleryStatus');
  if (statusEl) statusEl.textContent = 'Scanning screenshots...';
  try {
    const response = await fetch('/api/scan-screenshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Screenshot scan failed.');
    wad.screenshots = Array.isArray(payload.screenshots) ? payload.screenshots : [];
    wad.screenshotFolderPath = payload.folderPath || folderPath;
    await saveState();
    if (showSuccess) showAlert('success', 'Loaded ' + wad.screenshots.length + ' screenshot' + (wad.screenshots.length === 1 ? '' : 's') + ' for ' + wad.title + '.');
    render();
  } catch (error) {
    console.error(error);
    if (statusEl) statusEl.textContent = error.message || 'Screenshot scan failed.';
    showAlert('error', error.message || 'Screenshot scan failed.');
  }
}

async function deleteScreenshotFile(filePath) {
  const wad = getCurrentWad();
  if (!wad) return;
  const name = String(filePath || '').split(/[\/]/).pop() || 'this screenshot';
  if (!confirm('Permanently delete ' + name + ' from disk?\n\nThis cannot be undone.')) return;
  try {
    const response = await fetch('/api/delete-screenshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Screenshot delete failed.');
    wad.screenshots = (wad.screenshots || []).filter((shot) => String(shot.filePath) !== String(filePath));
    tombstoneScreenshot(wad, filePath);
    await saveState();
    showAlert('success', name + ' deleted.');
    render();
  } catch (error) {
    console.error(error);
    showAlert('error', error.message || 'Could not delete screenshot.');
  }
}

function openScreenshotPopup(filePath, fileName = 'Screenshot') {
  const dialog = document.getElementById('screenshotDialog');
  const img = document.getElementById('screenshotDialogImage');
  const title = document.getElementById('screenshotDialogTitle');
  if (!dialog || !img || !title) return;
  title.textContent = fileName || 'Screenshot';
  img.src = screenshotUrl(filePath);
  img.alt = fileName || 'Screenshot';
  dialog.showModal();
}

function openTitlepicPopup(src, wadTitle = 'TITLEPIC') {
  const dialog = document.getElementById('screenshotDialog');
  const img = document.getElementById('screenshotDialogImage');
  const title = document.getElementById('screenshotDialogTitle');
  if (!dialog || !img || !title || !src) return;
  title.textContent = (wadTitle || 'WAD') + ' TITLEPIC';
  img.src = src;
  img.alt = (wadTitle || 'WAD') + ' TITLEPIC';
  dialog.showModal();
}

function escapeJsString(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '&quot;').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

function renderStats() {
  if (state.currentView !== 'stats') return;
  const allRuns = state.app.wads.flatMap((wad) => wad.runs.map((run) => ({ wad, run })));
  const mapEntries = allRuns.flatMap(({ wad, run }) => run.maps.map((map) => ({ wad, run, map })));
  const playedMapEntries = mapEntries.filter(({ map }) => !isUnplayedPlaceholderMap(map));

  const averages = {
    kill: average(playedMapEntries.map(({ map }) => calcPercent(map.killcount, map.totalkills))),
    item: average(playedMapEntries.map(({ map }) => calcPercent(map.itemcount, map.totalitems))),
    secret: average(playedMapEntries.map(({ map }) => calcPercent(map.secretcount, map.totalsecrets))),
  };

  const totals = computeMapCollectionTotals(playedMapEntries.map(({ map }) => map));

  const medalTotals = mapEntries.reduce((acc, entry) => {
    const medal = getMedal(entry.map).tier;
    acc[medal] += 1;
    return acc;
  }, { gold: 0, silver: 0, bronze: 0, none: 0, unplayed: 0 });

  statsView.innerHTML = `
  <div class="section-stack">
  <section class="stat-shell">
  <h3>Collection Snapshot</h3>
  <div class="kpi-grid" style="margin-top:0.8rem;">
  <div class="kpi-card"><div class="label">Tracked WADs</div><div class="value">${state.app.wads.length}</div></div>
  <div class="kpi-card"><div class="label">Tracked Runs</div><div class="value">${allRuns.length}</div></div>
  <div class="kpi-card"><div class="label">Logged Maps</div><div class="value">${mapEntries.length}</div></div>
  <div class="kpi-card"><div class="label">Total Tracked Time</div><div class="value">${formatTics(totals.totalTimeTics)}</div></div>
  <div class="kpi-card"><div class="label">Total Demons Slain</div><div class="value">${formatInteger(totals.totalKills)}</div></div>
  <div class="kpi-card"><div class="label">Total Items Collected</div><div class="value">${formatInteger(totals.totalItems)}</div></div>
  <div class="kpi-card"><div class="label">Total Secrets Found</div><div class="value">${formatInteger(totals.totalSecrets)}</div></div>
  <div class="kpi-card"><div class="label">Average Kills / Min</div><div class="value">${formatNumber(totals.averageKillsPerMinute, 2)}</div></div>
  <div class="kpi-card"><div class="label">Average Kill %</div><div class="value">${formatPercent(averages.kill)}</div></div>
  <div class="kpi-card"><div class="label">Average Item %</div><div class="value">${formatPercent(averages.item)}</div></div>
  <div class="kpi-card"><div class="label">Average Secret %</div><div class="value">${formatPercent(averages.secret)}</div></div>
  </div>
  </section>

  <section class="stat-shell">
  <h3>Medal Totals</h3>
  <div class="kpi-grid" style="margin-top:0.8rem;">
  <div class="kpi-card"><div class="label">Gold</div><div class="value">🥇 ${medalTotals.gold}</div></div>
  <div class="kpi-card"><div class="label">Silver</div><div class="value">🥈 ${medalTotals.silver}</div></div>
  <div class="kpi-card"><div class="label">Bronze</div><div class="value">🥉 ${medalTotals.bronze}</div></div>
  <div class="kpi-card"><div class="label">None</div><div class="value">⚫ ${medalTotals.none}</div></div>
  <div class="kpi-card"><div class="label">Unplayed</div><div class="value">— ${medalTotals.unplayed}</div></div>
  </div>
  </section>
  </div>
  `;
}


function normalizeDefaultMods(value = []) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).map((entry) => String(entry || '').trim()).filter((entry) => {
    const key = launchFileKey(entry);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getDefaultMods() {
  const settings = normalizeImportedSettings(state.app?.settings || {});
  state.app.settings = settings;
  return normalizeDefaultMods(settings.defaultMods || []);
}

function setDefaultMods(paths, { persist = true } = {}) {
  if (!state.app || typeof state.app !== 'object') state.app = { wads: [], folders: [], settings: {} };
  state.app.settings = normalizeImportedSettings({
    ...(state.app.settings || {}),
    defaultMods: normalizeDefaultMods(paths),
  });
  if (persist) saveState();
}

function renderDefaultModsManager() {
  const manager = state.defaultModsManager || { files: [], scannedFolder: '', loading: false, error: '' };
  const defaultMods = getDefaultMods();
  const scannedFiles = Array.isArray(manager.files) ? manager.files : [];
  if (manager.loading) return '<p class="muted">Scanning the Mods folder...</p>';
  const status = manager.error ? `<div class="launch-warning"><strong>Could not scan mods:</strong> ${escapeHtml(manager.error)}</div>` : '';
  if (!scannedFiles.length) {
    const savedList = defaultMods.length
      ? `<div class="launch-file-list">${defaultMods.map((path, index) => `<div class="launch-file-row selected"><strong>${index + 1}. ${escapeHtml(launchFileLabel(path))}</strong><code title="${escapeHtml(path)}">${escapeHtml(path)}</code><div></div></div>`).join('')}</div>`
      : '<p class="muted">No default mods selected yet. Scan the Mods folder, then tick the mods you want and arrange the order.</p>';
    return `${status}${savedList}`;
  }
  return `${status}
    <div class="section-bar compact-section-bar">
      <p class="muted">${uniqueExistingOrder(defaultMods, scannedFiles).length} of ${scannedFiles.length} mod file${scannedFiles.length === 1 ? '' : 's'} selected as defaults.</p>
      <div class="button-row">
        <button type="button" class="secondary-button mini-button" onclick="window.appActions.selectAllDefaultMods()">Select All</button>
        <button type="button" class="secondary-button mini-button" onclick="window.appActions.clearDefaultMods()">Unselect All</button>
      </div>
    </div>
    ${renderDefaultModsPicker(scannedFiles, defaultMods)}`;
}

function renderDefaultModsPicker(files, selectedPaths) {
  const normalizedSelected = uniqueExistingOrder(selectedPaths, files);
  const selected = new Set(normalizedSelected.map(launchFileKey));
  const ordered = [
    ...normalizedSelected.map((path) => files.find((file) => launchFileKey(file.path) === launchFileKey(path))).filter(Boolean),
    ...files.filter((file) => !selected.has(launchFileKey(file.path))),
  ];
  return `<div class="launch-file-list default-mods-list">${ordered.map((file) => {
    const checked = selected.has(launchFileKey(file.path));
    const selectedIndex = normalizedSelected.findIndex((path) => launchFileKey(path) === launchFileKey(file.path));
    return `<div class="launch-file-row ${checked ? 'selected' : ''}">
      <label class="checkbox-line launch-file-check"><span><input type="checkbox" ${checked ? 'checked' : ''} onchange="window.appActions.toggleDefaultMod('${escapeJsString(file.path)}', this.checked)" /> ${escapeHtml(launchFileLabel(file))}</span></label>
      <code title="${escapeHtml(file.path)}">${escapeHtml(file.relativePath || file.path)}</code>
      <div class="launch-file-actions">
        <button type="button" class="secondary-button mini-button" ${!checked || selectedIndex <= 0 ? 'disabled' : ''} onclick="window.appActions.moveDefaultMod('${escapeJsString(file.path)}', -1)">↑</button>
        <button type="button" class="secondary-button mini-button" ${!checked || selectedIndex < 0 || selectedIndex >= normalizedSelected.length - 1 ? 'disabled' : ''} onclick="window.appActions.moveDefaultMod('${escapeJsString(file.path)}', 1)">↓</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function refreshDefaultModsManager() {
  const container = document.getElementById('defaultModsManager');
  if (container) container.innerHTML = renderDefaultModsManager();
}

async function scanDefaultModsForSettings() {
  state.defaultModsManager = { ...(state.defaultModsManager || {}), loading: true, error: '' };
  refreshDefaultModsManager();
  try {
    const settings = normalizeImportedSettings(state.app?.settings || {});
    const response = await fetch('/api/scan-launch-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modsFolder: settings.modsFolder || '', additionalFilesFolder: '__doom_entryway_skip_additional_scan__' }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not scan Mods folder.');
    state.defaultModsManager = {
      files: Array.isArray(payload.globalMods) ? payload.globalMods : [],
      scannedFolder: payload.modsFolder || settings.modsFolder || '',
      loading: false,
      error: '',
    };
    setDefaultMods(uniqueExistingOrder(getDefaultMods(), state.defaultModsManager.files), { persist: true });
  } catch (error) {
    state.defaultModsManager = { files: [], scannedFolder: '', loading: false, error: error.message || 'Could not scan Mods folder.' };
  }
  refreshDefaultModsManager();
}

function renderSettings() {
  if (state.currentView !== 'settings') return;
  const settings = normalizeImportedSettings(state.app?.settings || {});
  state.app.settings = settings;
  settingsView.innerHTML = `
  <div class="section-stack">
  <section class="about-shell settings-shell">
    <div class="section-bar">
      <div>
        <h3>Settings</h3>
        <p class="muted">Settings are split into main tracker defaults and WebDAV sync connection details.</p>
      </div>
      <button class="secondary-button" onclick="window.appActions.resetSettingsForm()">Reset Form</button>
    </div>

    <form id="settingsForm" class="settings-form" onsubmit="window.appActions.saveSettings(event)">
      <div class="settings-tabs" role="tablist" aria-label="Settings sections">
        <button type="button" id="settingsMainTab" class="settings-tab active" role="tab" aria-selected="true" aria-controls="settingsMainPanel" onclick="window.appActions.showSettingsTab('main')">Main Settings</button>
        <button type="button" id="settingsDefaultModsTab" class="settings-tab" role="tab" aria-selected="false" aria-controls="settingsDefaultModsPanel" onclick="window.appActions.showSettingsTab('defaultMods')">Default Mods</button>
        <button type="button" id="settingsWebdavTab" class="settings-tab" role="tab" aria-selected="false" aria-controls="settingsWebdavPanel" onclick="window.appActions.showSettingsTab('webdav')">WebDAV Sync</button>
      </div>

      <div id="settingsMainPanel" class="settings-tab-panel active" role="tabpanel" aria-labelledby="settingsMainTab">
        <div class="section-bar compact-section-bar">
          <div>
            <h3>Main Settings</h3>
            <p class="muted">Default folders, file cleanup, and tracker-wide paths.</p>
          </div>
        </div>
        <label>
          Default root save folder
          <input name="defaultRootSaveFolder" placeholder="e.g. /home/damo/Games/Doom/Saves" value="${escapeHtml(settings.defaultRootSaveFolder)}" />
          <span class="field-help">Refresh tools can use this as the top-level save location.</span>
        </label>
        <label>
          Default PWAD path
          <input name="defaultPwadPath" placeholder="e.g. /home/damo/Games/Doom/WADs" value="${escapeHtml(settings.defaultPwadPath)}" />
          <span class="field-help">Used as the default folder/path for custom WAD and PK3 files.</span>
        </label>
        <label>
          Default metadata TXT folder
          <input name="defaultMetadataFolder" placeholder="e.g. /home/damo/Games/Doom/idgames-txt" value="${escapeHtml(settings.defaultMetadataFolder)}" />
          <span class="field-help">New WAD metadata checks this folder for an exact companion TXT match, such as D2IRO.wad → D2IRO.txt.</span>
        </label>
        <label>
          Default Titlepics folder
          <input name="defaultTitlepicsFolder" placeholder="e.g. /home/damo/Games/Doom/titlepics" value="${escapeHtml(settings.defaultTitlepicsFolder)}" />
          <span class="field-help">Used as the shared folder for TITLEPIC PNGs. Manual/extracted titlepics are saved here instead of being embedded in the JSON database.</span>
        </label>
        <label>
          Default Screenshot folder
          <input name="defaultScreenshotFolder" placeholder="e.g. /home/damo/Games/Doom/screenshots" value="${escapeHtml(settings.defaultScreenshotFolder)}" />
          <span class="field-help">Used as the top-level folder for per-WAD screenshot auto-detection and galleries.</span>
        </label>
        <label>
          Default IWAD folder
          <input name="defaultIwadFolder" placeholder="e.g. /home/damo/Games/Doom/IWADs" value="${escapeHtml(settings.defaultIwadFolder)}" />
          <span class="field-help">Scan IWADs reads .wad files from this folder and imports supported IWADs automatically.</span>
        </label>
        <label>
          Default IWAD path/name for manual entries
          <input name="defaultIwadPath" placeholder="e.g. DOOM2.WAD or /home/damo/Games/Doom/IWADs/DOOM2.WAD" value="${escapeHtml(settings.defaultIwadPath)}" />
          <span class="field-help">Used as the default location or label for manual WAD entries.</span>
        </label>

        <section class="settings-subsection">
          <div class="section-bar compact-section-bar">
            <div>
              <h3>Launch Settings</h3>
              <p class="muted">Source port, global mod folder, and WAD-specific additional file folder used by the launch dialog.</p>
            </div>
          </div>
          <label>
            Game executable
            <input name="gameExecutable" placeholder="e.g. /home/damo/Games/Doom/gzdoom or C:\\Games\\GZDoom\\gzdoom.exe" value="${escapeHtml(settings.gameExecutable)}" />
            <span class="field-help">Recommended: a GZDoom-family source port that writes <code>.zds</code> saves, so tracking and launching stay aligned.</span>
          </label>
          <label>
            Mods folder
            <input name="modsFolder" placeholder="e.g. /home/damo/Games/Doom/Mods" value="${escapeHtml(settings.modsFolder)}" />
            <span class="field-help">Shared/global mods that can be reused with any WAD, such as gameplay mods, visual packs, music packs, or UI patches.</span>
          </label>
          <label>
            Additional files folder
            <input name="additionalFilesFolder" placeholder="e.g. /home/damo/Games/Doom/AdditionalFiles" value="${escapeHtml(settings.additionalFilesFolder)}" />
            <span class="field-help">WAD-specific extras live in subfolders here. Example: <code>AdditionalFiles/eternal/eternal_ws.wad</code> for <code>eternal.wad</code>.</span>
          </label>
        </section>
        <label class="danger-setting">
          <span>
            <input type="checkbox" name="deleteAssociatedFilesOnWadDelete" ${settings.deleteAssociatedFilesOnWadDelete ? 'checked' : ''} />
            Delete associated WAD/PK3, companion TXT, and titlepic PNG when deleting a WAD card
          </span>
          <span class="field-help warning-text">Warning: this permanently deletes files from disk and cannot be undone.</span>
        </label>

        <label class="checkbox-line">
          <span>
            <input type="checkbox" name="checkMissingDeletedFilesOnRefreshAll" ${settings.checkMissingDeletedFilesOnRefreshAll ? 'checked' : ''} />
            Check for missing and moved files during Refresh All
          </span>
          <span class="field-help">When Refresh All runs, Doom Entryway verifies linked WAD/PK3, IWAD, save, screenshot, metadata TXT, and titlepic files/folders. Missing files are searched for under their configured root folders; deleted files are removed from the database and queued for WebDAV cleanup.</span>
        </label>

        <section class="settings-subsection danger-zone-inline">
          <div class="section-bar compact-section-bar">
            <div>
              <h3>Unassociated File Cleanup</h3>
              <p class="muted">Scan the configured PWAD/PK3, metadata TXT, and titlepic folders for files that are not linked to any WAD card.</p>
            </div>
            <button class="danger-button" type="button" onclick="window.appActions.cleanupUnassociatedFiles()">Scan & Delete Unassociated Files</button>
          </div>
          <p class="field-help warning-text">Warning: this permanently deletes unassociated .wad/.pk3 files, companion .txt files, and titlepic .png files from disk. This cannot be undone.</p>
        </section>
      </div>

      <div id="settingsDefaultModsPanel" class="settings-tab-panel" role="tabpanel" aria-labelledby="settingsDefaultModsTab">
        <div class="section-bar compact-section-bar">
          <div>
            <h3>Default Mods</h3>
            <p class="muted">Choose and order the global mods Doom Entryway should use as the starting loadout for WADs with no saved launcher mod list.</p>
          </div>
          <div class="button-row">
            <button type="button" class="secondary-button" onclick="window.appActions.scanDefaultModsForSettings()">Scan Mods Folder</button>
            <button type="button" class="secondary-button" onclick="window.appActions.clearDefaultMods()">Clear Defaults</button>
          </div>
        </div>
        <div class="upload-callout">Using Mods folder: <code>${escapeHtml(settings.modsFolder || 'not set')}</code>. Change the folder in Main Settings, save, then scan again.</div>
        <div id="defaultModsManager">
          ${renderDefaultModsManager()}
        </div>
      </div>

      <div id="settingsWebdavPanel" class="settings-tab-panel" role="tabpanel" aria-labelledby="settingsWebdavTab">
        <div class="section-bar compact-section-bar">
          <div>
            <h3>WebDAV Sync Settings</h3>
            <p class="muted">Connection settings, sync-scope options, safety tools, and two-way WebDAV sync controls.</p>
          </div>
          <div class="button-row">
            <button type="button" class="secondary-button" onclick="window.appActions.testWebdavConnection()">Test Connection</button>
            <button type="button" class="primary-button" onclick="window.appActions.syncNow()">Sync Now</button>
            <button type="button" class="secondary-button" onclick="window.appActions.forceUploadWebdav()">Force Upload</button>
            <button type="button" class="danger-button" onclick="window.appActions.purgeWebdav()">Purge WebDAV</button>
          </div>
        </div>
        <label class="checkbox-line">
          <span>
            <input type="checkbox" name="webdavEnabled" ${settings.webdavEnabled ? 'checked' : ''} />
            Enable WebDAV sync settings
          </span>
        </label>
        <label>
          WebDAV server URL
          <input name="webdavUrl" placeholder="e.g. https://nas.example.com:5006/doom-tracker" value="${escapeHtml(settings.webdavUrl)}" />
          <span class="field-help">Use the base WebDAV folder URL that Doom Entryway should sync to.</span>
        </label>
        <label>
          Remote sync folder/path
          <input name="webdavRemotePath" placeholder="e.g. /DoomTracker" value="${escapeHtml(settings.webdavRemotePath)}" />
          <span class="field-help">Optional subfolder under the server URL. Leave blank if your URL already points at the exact folder.</span>
        </label>
        <label>
          Username
          <input name="webdavUsername" autocomplete="username" placeholder="WebDAV username" value="${escapeHtml(settings.webdavUsername)}" />
        </label>
        <label>
          Password / app password
          <input type="password" name="webdavPassword" autocomplete="current-password" placeholder="Stored locally in settings.json" value="${escapeHtml(settings.webdavPassword)}" />
          <span class="field-help warning-text">For NAS services, an app password or dedicated WebDAV user is safer than your main account password.</span>
        </label>
        <label class="checkbox-line">
          <span>
            <input type="checkbox" name="webdavVerifySsl" ${settings.webdavVerifySsl ? 'checked' : ''} />
            Verify HTTPS certificates
          </span>
          <span class="field-help">Keep enabled unless testing against a self-signed local server.</span>
        </label>

        <section class="settings-subsection sync-scope-section">
          <div class="section-bar compact-section-bar">
            <div>
              <h3>What to sync</h3>
              <p class="muted">Choose which Doom Entryway folders and files should be included in WebDAV sync.</p>
            </div>
          </div>
          <div class="settings-toggle-grid">
            <label class="checkbox-line"><span><input type="checkbox" name="syncSaves" ${settings.syncSaves ? 'checked' : ''} /> Saves</span></label>
            <label class="checkbox-line"><span><input type="checkbox" name="syncPwads" ${settings.syncPwads ? 'checked' : ''} /> PWADs / PK3s</span></label>
            <label class="checkbox-line"><span><input type="checkbox" name="syncIwads" ${settings.syncIwads ? 'checked' : ''} /> IWADs</span></label>
            <label class="checkbox-line"><span><input type="checkbox" name="syncMetadataTxt" ${settings.syncMetadataTxt ? 'checked' : ''} /> Metadata TXT</span></label>
            <label class="checkbox-line"><span><input type="checkbox" name="syncTitlepics" ${settings.syncTitlepics ? 'checked' : ''} /> Titlepics</span></label>
            <label class="checkbox-line"><span><input type="checkbox" name="syncScreenshots" ${settings.syncScreenshots ? 'checked' : ''} /> Screenshots</span></label>
            <label class="checkbox-line"><span><input type="checkbox" name="syncMods" ${settings.syncMods ? 'checked' : ''} /> Mods folder</span></label>
            <label class="checkbox-line"><span><input type="checkbox" name="syncAdditionalFiles" ${settings.syncAdditionalFiles ? 'checked' : ''} /> Additional files</span></label>
            <label class="checkbox-line"><span><input type="checkbox" name="syncDatabase" ${settings.syncDatabase ? 'checked' : ''} /> Database</span></label>
          </div>
          <span class="field-help">Database files are always verified by hash so backup/version checks do not ping-pong identical JSON.</span>
        </section>

        <section class="settings-subsection sync-scope-section">
          <div class="section-bar compact-section-bar">
            <div>
              <h3>Sync accuracy</h3>
              <p class="muted">Use this when WebDAV timestamps make unchanged files look newer on both sides.</p>
            </div>
          </div>
          <label class="checkbox-line">
            <span><input type="checkbox" name="webdavHashCheckBeforeOverwrite" ${settings.webdavHashCheckBeforeOverwrite ? 'checked' : ''} /> Hash check before overwriting files</span>
            <span class="field-help">Slower but more accurate. Doom Entryway only hashes when normal size/time checks say a file may need upload/download. If both hashes match, the file is skipped.</span>
          </label>
        </section>
        <div id="webdavTestResult" class="field-help"></div>
      </div>

      <div class="modal-actions settings-actions">
        <button type="submit" class="primary-button">Save Settings</button>
      </div>
    </form>
  </section>

  <section class="about-shell">
    <h3>More settings later</h3>
    <p class="muted">This page is now wired as the home for future defaults like preferred source port, default difficulty, mod presets, and import behaviour.</p>
  </section>
  </div>
  `;
}

function renderAbout() {
  if (state.currentView !== 'about') return;
  aboutView.innerHTML = `
  <div class="section-stack">
    <section class="about-shell">
      <h3>Doom Entryway ${APP_VERSION}</h3>
      <p class="muted">Initial stable release: <strong>${APP_VERSION}</strong></p>
      <p>Doom Entryway is a local-first tracker for DOOM, DOOM II, Final DOOM, IWADs, PWADs, PK3s, runs, map stats, screenshots, metadata, and WebDAV sync.</p>
    </section>

    <section class="about-shell">
      <h3>Library and organisation</h3>
      <ul class="list-tight">
        <li>Create WAD/PK3 entries for single maps, multiple-map packs, episodes, megawads, and IWADs.</li>
        <li>Track WAD title, author, source port, total maps, type, IWAD, notes, state, paths, and associated files.</li>
        <li>Edit WAD information after creation, including refreshing metadata from associated files.</li>
        <li>Use virtual nested folders to organise the library, with clickable breadcrumbs.</li>
        <li>Switch between resizable card view and compact directory view.</li>
        <li>Filter and manage WAD states, including Plan to Play, Currently Playing, On Hold, Dropped, and Completed.</li>
        <li>Click library card fields to quick-filter by state, IWAD, type, author, source port, difficulty, or custom tag; click average stat chips to sort by kills, items, or secrets.</li>
        <li>Add comma-separated custom tags to WAD entries, show a compact tag preview on cards, open a +x tag popup, and search/filter by tag.</li>
        <li>Automatically change dormant WADs to Currently Playing when new played maps are detected, and Completed when the final unplayed map is played.</li>
        <li>Exclude selected WADs from Refresh All.</li>
      </ul>
    </section>

    <section class="about-shell">
      <h3>Metadata support</h3>
      <ul class="list-tight">
        <li>Auto-detect metadata when adding or refreshing WAD/PK3 entries.</li>
        <li>Read map names and metadata from UMAPINFO, MAPINFO, ZMAPINFO, and DEHACKED/BEX formats.</li>
        <li>Merge partial metadata safely: higher-priority sources win for maps they name, while lower-priority sources can fill missing names.</li>
        <li>Support embedded <code>dehacked.txt</code>, <code>umapinfo.txt</code>, <code>mapinfo.txt</code>, and <code>zmapinfo.txt</code> files.</li>
        <li>Use exact companion TXT files from the metadata folder as WAD-level metadata overrides.</li>
        <li>Parse idgames-style TXT fields including Title, Author, New Levels, Game, and Advanced engine needed.</li>
        <li>Handle numeric and range-based New Levels values such as <code>32</code>, <code>MAP01-32</code>, and episode ranges.</li>
        <li>Preview matched companion TXT files in the WAD detail view.</li>
        <li>Scan IWADs and populate known IWAD metadata, maps, authors, and titlepics.</li>
      </ul>
    </section>

    <section class="about-shell">
      <h3>Runs, saves, stats, and medals</h3>
      <ul class="list-tight">
        <li>Track multiple runs per WAD.</li>
        <li>Import <code>.zds</code> saves manually or refresh from the newest save in a configured local save folder.</li>
        <li>Auto-detect local save folders by fuzzy matching WAD names against the default root save folder.</li>
        <li>Read <code>globals.json</code> from saves to update kills, items, secrets, level time, map state, and skill.</li>
        <li>Track per-map kills, items, secrets, level time, difficulty, source type, map author, and notes.</li>
        <li>Support per-map difficulty, including pistol-start or cheat-based mixed-difficulty runs.</li>
        <li>Treat untouched maps with 0/0 kills, 0/0 items, 0/0 secrets, and 0 time as Unplayed rather than No Medal.</li>
        <li>Calculate gold, silver, and bronze medals based on 100% category completion.</li>
        <li>Show average percentages, totals, medal counts, and run summaries.</li>
        <li>Allow manual map creation and manual map edits, including entering found stats as counts or percentages.</li>
        <li>Refresh All updates saves for every non-excluded WAD with a local save folder and shows a results report.</li>
      </ul>
    </section>

    <section class="about-shell">
      <h3>Images and screenshots</h3>
      <ul class="list-tight">
        <li>Store titlepics as external PNG files in the configured Titlepics folder instead of embedding images in the JSON database.</li>
        <li>Migrate older embedded base64 titlepics into PNG files automatically when a Titlepics folder is configured.</li>
        <li>Extract or manually set titlepics, converting non-PNG images into real PNG files.</li>
        <li>Display full titlepic images in library cards without cropping, including 4:3 and 16:9 artwork.</li>
        <li>Set per-WAD screenshot folders manually or auto-detect them from the default screenshot folder.</li>
        <li>Refresh screenshot galleries per WAD or via Refresh All.</li>
        <li>Show screenshots as thumbnail galleries at the bottom of the WAD detail page.</li>
        <li>Open screenshots in a full-size popup by clicking thumbnails.</li>
        <li>Permanently delete unwanted screenshots from the gallery.</li>
      </ul>
    </section>

    <section class="about-shell">
      <h3>Settings and local file management</h3>
      <ul class="list-tight">
        <li>Settings are split into Main Settings and WebDAV Sync tabs.</li>
        <li>Settings are stored in local <code>settings.json</code> instead of the synced database, so each PC can keep its own paths and WebDAV credentials.</li>
        <li>Older databases with embedded settings are migrated into <code>settings.json</code> automatically on first launch.</li>
        <li>Configure default root save folder, PWAD/PK3 folder, IWAD folder, metadata TXT folder, Titlepics folder, and Screenshot folder.</li>
        <li>Optionally delete associated WAD/PK3, companion TXT, and titlepic PNG files when deleting a WAD card, with a permanent-delete warning.</li>
        <li>Scan and delete unassociated local files from configured folders.</li>
        <li>Track deletions made through the web interface so WebDAV sync can delete those files remotely instead of downloading them again.</li>
        <li>Import and export the database manually.</li>
      </ul>
    </section>

    <section class="about-shell">
      <h3>WebDAV sync</h3>
      <ul class="list-tight">
        <li>Configure WebDAV URL, username, password, remote root folder, and sync categories.</li>
        <li>Test the WebDAV connection from Settings.</li>
        <li>Choose what to sync: Saves, PWADs/PK3s, IWADs, metadata TXT, Titlepics, Screenshots, and Database.</li>
        <li>Run normal two-way sync from the top bar or Settings.</li>
        <li>Force Upload from Settings when the local machine should overwrite remote files.</li>
        <li>Purge the configured WebDAV remote root when a full remote reset is needed.</li>
        <li>Create remote folders automatically for enabled sync categories.</li>
        <li>Use temporary files for uploads and downloads so half-completed transfers are not treated as valid files.</li>
        <li>Delete stale temporary files before sync starts.</li>
        <li>Use per-WAD subfolders for saves and screenshots.</li>
        <li>Keep five database backup versions and only create a new backup when the database changed.</li>
        <li>Only sync files with the expected extensions for each category.</li>
        <li>Only sync PWAD/PK3 files that are linked to library entries.</li>
        <li>Skip unchanged files using size/time checks, with database hash checks always enabled.</li>
        <li>Optional hash checking before overwriting files when normal checks disagree.</li>
        <li>Use a local sync manifest so local database and save changes win conflicts instead of being overwritten by WebDAV timestamp/version mismatches.</li>
      </ul>
    </section>
  </div>
  `;
}

function wireDropzone(runId) {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const pickFileButton = document.getElementById('pickFileButton');
  const umapinfoInput = document.getElementById('umapinfoInput');
  const pickUmapinfoButton = document.getElementById('pickUmapinfoButton');
  const mapinfoInput = document.getElementById('mapinfoInput');
  const pickMapinfoButton = document.getElementById('pickMapinfoButton');
  const dehackedInput = document.getElementById('dehackedInput');
  const pickDehackedButton = document.getElementById('pickDehackedButton');
  if (!dropzone || !fileInput || !pickFileButton) return;

  pickFileButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (file) await importZdsFile(file, runId);
    fileInput.value = '';
  });

  pickUmapinfoButton?.addEventListener('click', () => umapinfoInput?.click());
  umapinfoInput?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (file) await importUmapinfoFile(file, runId);
    umapinfoInput.value = '';
  });

  pickMapinfoButton?.addEventListener('click', () => mapinfoInput?.click());
  mapinfoInput?.addEventListener('change', async (event) => {
    const [file] = event.target.files || [];
    if (file) await importMapinfoFile(file, runId);
    mapinfoInput.value = '';
  });

  pickDehackedButton?.addEventListener('click', () => dehackedInput?.click());
  dehackedInput?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (file) await importDehackedFile(file, runId);
    dehackedInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add('active');
  }));
  ['dragleave', 'drop'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove('active');
  }));
  dropzone.addEventListener('drop', async (event) => {
    const [file] = event.dataTransfer.files;
    if (file) await importZdsFile(file, runId);
  });
}

async function importZdsFile(file, runId) {
  const wad = getCurrentWad();
  if (!wad) return;
  const run = wad.runs.find((r) => r.id === runId);
  if (!run) return;

  try {
    const zip = await JSZip.loadAsync(file);
    const globalsFile = zip.file('globals.json');
    if (!globalsFile) throw new Error('globals.json was not found inside the save archive.');

    const raw = await globalsFile.async('string');
    const parsed = JSON.parse(raw);
    const levels = parsed?.statistics?.levels;
    if (!Array.isArray(levels)) throw new Error('statistics.levels[] was missing from globals.json.');
    const saveDifficulty = skillFlagToDifficulty(parsed?.servercvars?.skill);

    const mergeResult = mergeImportedLevelsIntoRun(run, levels, file.name, saveDifficulty);
    const imported = Number(mergeResult?.imported ?? mergeResult) || 0;
    const newlyPlayed = Number(mergeResult?.newlyPlayed) || 0;
    const stateChange = applyAutomaticPlayStateFromRefresh(wad, run, newlyPlayed);
    saveState();
    showAlert('success', `Imported ${imported} map record${imported === 1 ? '' : 's'} from ${file.name}.${stateChange ? ` ${stateChange}` : ''}`);
    render();

    const importList = document.getElementById('importList');
    if (importList) {
      importList.innerHTML = `
      <div class="import-item">
      <strong>${escapeHtml(file.name)}</strong>
      <div class="subtle" style="margin-top:0.35rem;">Imported ${imported} level entries from <code>globals.json</code>.</div>
      </div>
      ` + importList.innerHTML;
    }
  } catch (error) {
    console.error(error);
    showAlert('error', error.message || 'Import failed.');
    renderAlerts();
  }
}


function refreshStatSignature(map) {
  if (!map) return '';
  return [
    String(map.levelName || '').trim().toUpperCase(),
    Number(map.killcount) || 0,
    Number(map.totalkills) || 0,
    Number(map.itemcount) || 0,
    Number(map.totalitems) || 0,
    Number(map.secretcount) || 0,
    Number(map.totalsecrets) || 0,
    Number(map.leveltime) || 0,
    String(map.difficulty || '').trim(),
  ].join('|');
}

function mergeImportedLevelsIntoRun(run, levels, fileName, saveDifficulty = '') {
  let imported = 0;
  let newlyPlayed = 0;
  let changedMaps = 0;
  let addedMaps = 0;
  let unchangedMaps = 0;
  const changedLevelNames = [];
  if (!Array.isArray(run.maps)) run.maps = [];

  for (const level of levels) {
    if (!level?.levelname) continue;
    const levelKey = String(level.levelname || '').trim().toUpperCase();
    const existingMap = run.maps.find((map) => String(map.levelName || '').trim().toUpperCase() === levelKey);
    const wasUnplayed = existingMap ? isUnplayedPlaceholderMap(existingMap) : true;
    const incoming = normalizeImportedLevel(level, fileName, existingMap, saveDifficulty);
    const isNowPlayed = !isUnplayedPlaceholderMap(incoming);
    const existingIndex = run.maps.findIndex((map) => String(map.levelName || '').trim().toUpperCase() === incoming.levelName.toUpperCase());
    const beforeSignature = existingIndex >= 0 ? refreshStatSignature(run.maps[existingIndex]) : '';
    const incomingSignature = refreshStatSignature(incoming);

    if (existingIndex >= 0) {
      const existing = run.maps[existingIndex];
      const changed = beforeSignature !== incomingSignature;
      if (changed) {
        run.maps[existingIndex] = {
          ...existing,
          ...incoming,
          id: existing.id,
          displayName: existing.displayName || incoming.displayName,
          mapAuthor: existing.mapAuthor || incoming.mapAuthor,
          sourceType: existing.sourceType === 'manual' ? 'edited' : 'imported',
          updatedAt: new Date().toISOString(),
        };
        changedMaps += 1;
        changedLevelNames.push(incoming.levelName);
      } else {
        unchangedMaps += 1;
      }
    } else {
      run.maps.push(incoming);
      addedMaps += 1;
      changedMaps += 1;
      changedLevelNames.push(incoming.levelName);
    }

    if (wasUnplayed && isNowPlayed) newlyPlayed += 1;
    imported += 1;
  }

  sortRunMaps(run);
  return { imported, newlyPlayed, changedMaps, addedMaps, unchangedMaps, changedLevelNames };
}


function applyAutomaticPlayStateFromRefresh(wad, run, newlyPlayed = 0) {
  if (!wad || !run || !newlyPlayed) return '';
  return applyAutomaticPlayStateFromRun(wad, run, { allowCurrentFallback: true });
}

function applyAutomaticPlayStateFromManualEdit(wad, run) {
  if (!wad || !run) return '';
  return applyAutomaticPlayStateFromRun(wad, run, { allowCurrentFallback: false });
}

function applyAutomaticPlayStateFromRun(wad, run, { allowCurrentFallback = false } = {}) {
  if (!wad || !run) return '';
  const previousState = String(wad.playState || 'plan');

  if (isRunCompleteForWad(wad, run)) {
    if (previousState !== 'completed') {
      wad.playState = 'completed';
      wad.updatedAt = new Date().toISOString();
      return 'State changed to Completed.';
    }
    return '';
  }

  if (allowCurrentFallback && ['plan', 'hold', 'dropped'].includes(previousState)) {
    wad.playState = 'current';
    wad.updatedAt = new Date().toISOString();
    return 'State changed to Currently Playing.';
  }

  return '';
}

function isRunCompleteForWad(wad, run) {
  const maps = Array.isArray(run?.maps) ? run.maps : [];
  const requiredMaps = maps.filter((map) => !isOptionalCompletionMap(wad, map));
  const playedRequiredMaps = requiredMaps.filter((map) => !isUnplayedPlaceholderMap(map));
  if (!playedRequiredMaps.length) return false;

  const unplayedRequiredMaps = requiredMaps.filter((map) => isUnplayedPlaceholderMap(map));
  if (unplayedRequiredMaps.length > 0) return false;

  const expectedRequiredCount = getExpectedRequiredMapCount(wad, maps);
  if (expectedRequiredCount > 0 && playedRequiredMaps.length < expectedRequiredCount) return false;

  return true;
}

function getExpectedRequiredMapCount(wad, maps = []) {
  const totalMaps = Math.max(0, Number(wad?.totalMaps) || 0);
  const actualRequiredSlots = Array.isArray(maps)
    ? maps.filter((map) => !isOptionalCompletionMap(wad, map)).length
    : 0;

  if (!totalMaps) return actualRequiredSlots;

  const optionalCount = getExpectedOptionalCompletionMapCount(wad, maps, totalMaps);
  const expectedRequired = Math.max(0, totalMaps - optionalCount);
  return Math.max(expectedRequired, actualRequiredSlots);
}

function getExpectedOptionalCompletionMapCount(wad, maps = [], totalMaps = 0) {
  const family = getCompletionIwadFamily(wad);
  const levelNames = new Set((Array.isArray(maps) ? maps : []).map((map) => normalizeLevelName(map?.levelName)).filter(Boolean));

  if (family === 'doom2') {
    const presentSecretSlots = ['MAP31', 'MAP32'].filter((name) => levelNames.has(name)).length;
    if (presentSecretSlots) return presentSecretSlots;
    return totalMaps >= 32 ? 2 : 0;
  }

  if (family === 'doom') {
    const doomSecretSlots = ['E1M9', 'E2M9', 'E3M9', 'E4M9'];
    const presentSecretSlots = doomSecretSlots.filter((name) => levelNames.has(name)).length;
    if (presentSecretSlots) return presentSecretSlots;
    if (totalMaps >= 36) return 4;
    if (totalMaps >= 27) return 3;
    if (totalMaps >= 18) return 2;
    if (totalMaps >= 9) return 1;
  }

  return 0;
}

function isOptionalCompletionMap(wad, map) {
  const levelName = normalizeLevelName(map?.levelName);
  const family = getCompletionIwadFamily(wad);
  if (family === 'doom2') return levelName === 'MAP31' || levelName === 'MAP32';
  if (family === 'doom') return /^E[1-4]M9$/.test(levelName);
  return false;
}

function getCompletionIwadFamily(wad) {
  const values = [
    wad?.iwadScanKey,
    wad?.iwad,
    wad?.iwadFileName,
    wad?.iwadPath,
  ];
  const text = values.map((value) => normalizeIwadFieldForLaunch(value)).filter(Boolean).join(' ');
  if (!text) return '';
  if (text.includes('doom2') || text.includes('doomii') || text.includes('doomtwo') || text.includes('tnt') || text.includes('evilution') || text.includes('plutonia')) return 'doom2';
  if (text === 'doom' || text.includes('ultimatedoom') || (text.includes('doom') && !text.includes('doom2') && !text.includes('doomii'))) return 'doom';
  return '';
}

function normalizeLevelName(value) {
  return String(value || '').trim().toUpperCase();
}



async function associateWadFile(wadId) {
  const wad = state.app.wads.find((entry) => entry.id === wadId);
  if (!wad) return;

  const pwadFolder = getAppSetting('defaultPwadPath');
  if (!pwadFolder) {
    showAlert('error', 'Set the Default PWAD/PK3 path in Settings first. That should be the folder containing your custom .wad or .pk3 files.');
    return;
  }

  const associatedFiles = getAssociatedModFiles(wad.id);
  const associatedPaths = associatedFiles.map((entry) => entry.path).filter(Boolean);

  try {
    showAlert('success', `Scanning PWAD folder: ${pwadFolder}`);
    const response = await fetch('/api/scan-pwads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pwadFolder, associatedPaths, associatedFiles }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'PWAD scan failed.');

    const found = Array.isArray(payload.found) ? payload.found : [];
    if (!found.length) {
      showAlert('error', 'No unassociated PWAD files were found in the Default PWAD path.');
      return;
    }

    const bestGuessIndex = findBestWadFileMatch(wad.title, found);
    const listText = found.slice(0, 40).map((file, index) => {
      const marker = index === bestGuessIndex ? ' ← best guess' : '';
      const titlepic = file.hasTitlepic ? ' [TITLEPIC]' : '';
      return `${index + 1}. ${file.relativePath || file.fileName}${titlepic}${marker}`;
    }).join('\n');
    const moreText = found.length > 40 ? `\n\nShowing first 40 of ${found.length} matches.` : '';
    const defaultChoice = bestGuessIndex >= 0 ? String(bestGuessIndex + 1) : '1';
    const choice = prompt(`Select the WAD file to associate with "${wad.title}":\n\n${listText}${moreText}\n\nEnter a number:`, defaultChoice);
    if (choice === null) return;

    const selectedIndex = Number.parseInt(choice, 10) - 1;
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= found.length) {
      showAlert('error', 'Invalid WAD selection.');
      return;
    }

    const selected = found[selectedIndex];
    wad.pwadPath = selected.path;
    wad.pwadFileName = selected.fileName || '';
    wad.pwadRelativePath = selected.relativePath || selected.fileName || '';
    await saveState();
    showAlert('success', `Associated ${selected.relativePath || selected.fileName} with ${wad.title}.`);
    render();
  } catch (error) {
    console.error(error);
    showAlert('error', `${error.message || 'PWAD scan failed.'} Make sure local_server.py is running and the folder path is correct.`);
  }
}

function findBestWadFileMatch(wadTitle, files) {
  const title = compactSearchText(wadTitle);
  if (!title) return 0;
  let bestIndex = 0;
  let bestScore = -1;
  files.forEach((file, index) => {
    const rel = compactSearchText(file.relativePath || file.fileName || '');
    const base = compactSearchText(String(file.fileName || '').replace(/\.(wad|pk3)$/i, ''));
    let score = 0;
    if (base === title) score = 100;
    else if (base.includes(title) || title.includes(base)) score = 85;
    else {
      const titleTokens = tokenSet(wadTitle);
      const fileTokens = tokenSet(`${file.relativePath || ''} ${file.fileName || ''}`);
      const overlap = [...titleTokens].filter((token) => fileTokens.has(token)).length;
      score = overlap * 12;
      if (rel.includes(title.slice(0, Math.min(8, title.length)))) score += 20;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function compactSearchText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function tokenSet(value) {
  return new Set(String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

async function extractTitlepicFromAssociatedWad(wadId) {
  const wad = state.app.wads.find((entry) => entry.id === wadId);
  if (!wad) return;
  if (!wad.pwadPath) {
    showAlert('error', 'Set WAD first, then extract the TITLEPIC.');
    return;
  }

  try {
    const response = await fetch('/api/extract-titlepic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wadPath: wad.pwadPath,
        iwadField: wad.iwad || '',
        iwadFolder: getAppSetting('defaultIwadFolder') || '',
        iwadPath: wad.iwadPath || getAppSetting('defaultIwadPath') || '',
        titlepicsFolder: getAppSetting('defaultTitlepicsFolder') || '',
        titleHint: wad.title || wad.pwadFileName || 'titlepic',
        existingFileName: wad.titlePicFileName || '',
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'TITLEPIC extraction failed.');
    if (!payload.titlePicFileName && !payload.titlePicDataUrl) throw new Error('No TITLEPIC was returned by the local server.');

    if (payload.titlePicFileName) {
      wad.titlePicFileName = payload.titlePicFileName;
      wad.titlePicPath = payload.titlePicPath || '';
      delete wad.titlePicDataUrl;
    } else {
      const saved = await saveManagedTitlepic(wad, payload.titlePicDataUrl);
      wad.titlePicFileName = saved.titlePicFileName || '';
      wad.titlePicPath = saved.titlePicPath || '';
      delete wad.titlePicDataUrl;
    }
    wad.updatedAt = new Date().toISOString();
    await saveState();
    const paletteNote = payload.usedFallbackPalette ? ' using the base IWAD PLAYPAL' : '';
    showAlert('success', `Extracted TITLEPIC from ${payload.fileName || 'associated WAD'}${paletteNote}.`);
    render();
  } catch (error) {
    console.error(error);
    showAlert('error', `${error.message || 'TITLEPIC extraction failed.'} Make sure the WAD has TITLEPIC, or set the IWAD field/default IWAD folder so its PLAYPAL can be used.`);
  }
}

async function scanIwadsFromSettings() {
  const iwadFolder = getAppSetting('defaultIwadFolder') || getAppSetting('defaultIwadPath');
  if (!iwadFolder) {
    showAlert('error', 'Set the Default IWAD folder in Settings first.');
    return;
  }
  showAlert('success', `Scanning IWAD folder: ${iwadFolder}`);
  try {
    const response = await fetch('/api/scan-iwads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iwadFolder }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'IWAD scan failed.');

    const found = Array.isArray(payload.found) ? payload.found : [];
    const skipped = Array.isArray(payload.skipped) ? payload.skipped : [];
    let added = 0;
    let updated = 0;

    for (const incoming of found) {
      const normalizedIncoming = normalizeImportedWad(incoming);
      const scanKey = incoming.iwadScanKey || normalizedIncoming.iwadScanKey;
      const existingIndex = state.app.wads.findIndex((wad) =>
        (scanKey && wad.iwadScanKey === scanKey) ||
        (wad.iwadPath && normalizedIncoming.iwadPath && wad.iwadPath === normalizedIncoming.iwadPath) ||
        (wad.title.toLowerCase() === normalizedIncoming.title.toLowerCase() && wad.author === normalizedIncoming.author)
      );
      if (existingIndex >= 0) {
        const existing = state.app.wads[existingIndex];
        state.app.wads[existingIndex] = {
          ...existing,
          ...normalizedIncoming,
          id: existing.id,
          folderId: existing.folderId ?? state.currentFolderId,
          playState: existing.playState || normalizedIncoming.playState,
          saveFolderPath: existing.saveFolderPath || normalizedIncoming.saveFolderPath,
          runs: existing.runs?.some((run) => run.maps?.some((map) => !isUnplayedPlaceholderMap(map))) ? existing.runs : normalizedIncoming.runs,
          selectedRunId: existing.selectedRunId || normalizedIncoming.selectedRunId,
        };
        updated += 1;
      } else {
        normalizedIncoming.folderId = state.currentFolderId;
        state.app.wads.unshift(normalizedIncoming);
        added += 1;
      }
    }

    await saveState();
    render();
    const skippedText = skipped.length ? ` ${skipped.length} unsupported/non-IWAD file${skipped.length === 1 ? '' : 's'} skipped.` : '';
    showAlert('success', `IWAD scan complete: ${added} added, ${updated} updated.${skippedText}`);
  } catch (error) {
    console.error(error);
    showAlert('error', `${error.message || 'IWAD scan failed.'} Make sure local_server.py is running and the folder path is correct.`);
  }
}

async function autoDetectSaveFolder(wadId) {
  const wad = state.app.wads.find((entry) => entry.id === wadId);
  if (!wad) return;

  const rootFolder = getAppSetting('defaultRootSaveFolder');
  if (!rootFolder) {
    showAlert('error', 'Set the Default root save folder in Settings first.');
    return;
  }

  const resultEl = document.getElementById('saveFolderDetectResult');
  if (resultEl) {
    resultEl.className = 'auto-detect-result loading';
    resultEl.textContent = `Searching ${rootFolder} for a save folder match...`;
  }

  try {
    const response = await fetch('/api/detect-save-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootFolder, wadName: wad.title }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Auto detect failed.');

    if (!payload.bestMatch?.path) {
      if (resultEl) {
        resultEl.className = 'auto-detect-result error';
        resultEl.textContent = 'No matching save subfolder found.';
      }
      showAlert('error', 'No matching save subfolder found.');
      return;
    }

    wad.saveFolderPath = payload.bestMatch.path;
    saveState();

    const input = document.getElementById('saveFolderPathInput');
    if (input) input.value = payload.bestMatch.path;

    const confidence = Math.round(Number(payload.bestMatch.score || 0) * 100);
    const folderName = payload.bestMatch.name || payload.bestMatch.path;
    if (resultEl) {
      resultEl.className = 'auto-detect-result success';
      resultEl.innerHTML = `Matched <strong>${escapeHtml(folderName)}</strong> at ${confidence}% confidence.`;
    }
    showAlert('success', `Auto detected save folder: ${folderName}`);
  } catch (error) {
    console.error(error);
    if (resultEl) {
      resultEl.className = 'auto-detect-result error';
      resultEl.textContent = `${error.message || 'Auto detect failed.'} Make sure local_server.py is running.`;
    }
    showAlert('error', `${error.message || 'Auto detect failed.'} Make sure local_server.py is running.`);
  }
}

function refreshScreenshotSignature(screenshots) {
  return (Array.isArray(screenshots) ? screenshots : [])
    .map((shot) => [
      String(shot?.filePath || '').trim(),
      String(shot?.fileName || '').trim(),
      Number(shot?.modifiedTime) || 0,
      Number(shot?.sizeBytes) || 0,
    ].join('|'))
    .sort()
    .join('\n');
}

function isRefreshAllChangeResult(entry) {
  const status = String(entry?.status || '').toLowerCase();
  const kind = String(entry?.kind || '').toLowerCase();
  if (kind === 'metadata txt' && ['missing', 'optional', 'found'].includes(status)) return false;
  return ['updated', 'deleted', 'error', 'warning'].includes(status);
}

function isMissingLatestZdsError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('no .zds files found') || message.includes('no zds files found');
}

async function refreshAllTrackedData() {
  let wads = Array.isArray(state.app.wads) ? state.app.wads : [];
  const settings = normalizeImportedSettings(state.app?.settings || {});
  const fileCheckResults = [];
  if (settings.checkMissingDeletedFilesOnRefreshAll) {
    try {
      await saveState();
      const response = await fetch('/api/check-missing-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Missing/deleted file check failed.');
      if (payload.app) {
        state.app = normalizeImportedAppState(payload.app);
        applyAppSettingsToUiState();
        wads = Array.isArray(state.app.wads) ? state.app.wads : [];
      }
      const entries = Array.isArray(payload.results) ? payload.results : [];
      fileCheckResults.push(...entries
        .filter(isRefreshAllChangeResult)
        .map((entry) => ({
          title: entry.title || 'File check',
          kind: entry.kind || 'Missing/deleted files',
          status: entry.status || 'Checked',
          detail: entry.detail || '',
        })));
    } catch (error) {
      console.error(error);
      fileCheckResults.push({ title: 'File check', kind: 'Missing/deleted files', status: 'Error', detail: error.message || 'Missing/deleted file check failed.' });
    }
  }
  const excludedTargets = wads.filter((wad) => wad.excludeFromRefreshAll === true);
  const refreshableWads = wads.filter((wad) => wad.excludeFromRefreshAll !== true);
  const saveTargets = refreshableWads.filter((wad) => String(wad.saveFolderPath || '').trim());
  const screenshotTargets = refreshableWads.filter((wad) => String(wad.screenshotFolderPath || '').trim());
  if (!saveTargets.length && !screenshotTargets.length) {
    if (fileCheckResults.length) {
      showRefreshAllResults(fileCheckResults, { excludedTargets: excludedTargets.length, changedResults: fileCheckResults.length });
      showAlert('success', 'Refresh All file check complete. No refreshable save or screenshot changes found.');
      render();
      return;
    }
    showAlert('error', excludedTargets.length
      ? 'No non-excluded WAD cards have a Local Save Folder or Screenshot Folder set.'
      : 'No WAD cards have a Local Save Folder or Screenshot Folder set.');
    if (excludedTargets.length) {
      showRefreshAllResults([], { excludedTargets: excludedTargets.length, changedResults: 0 });
    }
    return;
  }

  const results = [...fileCheckResults];
  let saveUpdatedMaps = 0;
  let screenshotUpdatedWads = 0;
  let hadChanges = false;

  showAlert('success', `Refresh All started: ${saveTargets.length} save folder${saveTargets.length === 1 ? '' : 's'}, ${screenshotTargets.length} screenshot folder${screenshotTargets.length === 1 ? '' : 's'}${excludedTargets.length ? `, ${excludedTargets.length} excluded` : ''}.`);

  for (const wad of saveTargets) {
    const folderPath = String(wad.saveFolderPath || '').trim();
    const run = wad.runs?.find((entry) => entry.id === wad.selectedRunId) || getLatestRun(wad);
    if (!run) {
      continue;
    }

    try {
      const response = await fetch('/api/refresh-stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Local server refresh failed.');
      recordLatestSaveInfo(wad, payload);
      const levels = payload?.statistics?.levels || payload?.levels;
      if (!Array.isArray(levels)) throw new Error('The local server did not return statistics.levels[].');

      const saveDifficulty = skillFlagToDifficulty(payload?.servercvars?.skill || payload?.skill);
      const mergeResult = mergeImportedLevelsIntoRun(run, levels, payload.fileName || 'latest.zds', saveDifficulty);
      const imported = Number(mergeResult?.imported ?? mergeResult) || 0;
      const newlyPlayed = Number(mergeResult?.newlyPlayed) || 0;
      const changedMaps = Number(mergeResult?.changedMaps) || 0;
      const stateChange = applyAutomaticPlayStateFromRefresh(wad, run, newlyPlayed);
      if (changedMaps || stateChange) {
        saveUpdatedMaps += changedMaps;
        hadChanges = true;
        const allChangedNames = Array.isArray(mergeResult?.changedLevelNames) ? mergeResult.changedLevelNames : [];
        const changedNames = allChangedNames.slice(0, 8);
        const changedSuffix = changedNames.length ? ` Changed: ${changedNames.join(', ')}${allChangedNames.length > changedNames.length ? ', …' : ''}.` : '';
        results.push({
          title: wad.title,
          kind: 'Latest .zds',
          status: 'Updated',
          detail: `${changedMaps} changed map record${changedMaps === 1 ? '' : 's'} from ${payload.fileName || 'latest .zds'}${saveDifficulty ? ` (${saveDifficulty})` : ''}.${changedSuffix}${stateChange ? ` ${stateChange}` : ''}`,
        });
      }
    } catch (error) {
      if (isMissingLatestZdsError(error)) {
        // No save yet usually means this WAD has not been played. Keep Refresh All clean.
        continue;
      }
      console.error(error);
      results.push({ title: wad.title, kind: 'Latest .zds', status: 'Error', detail: error.message || 'Refresh failed.' });
    }
  }

  for (const wad of screenshotTargets) {
    const folderPath = String(wad.screenshotFolderPath || '').trim();
    try {
      const response = await fetch('/api/scan-screenshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Screenshot scan failed.');

      const screenshots = Array.isArray(payload.screenshots) ? payload.screenshots : [];
      const before = Array.isArray(wad.screenshots) ? wad.screenshots.length : 0;
      const beforeSignature = refreshScreenshotSignature(wad.screenshots);
      const afterSignature = refreshScreenshotSignature(screenshots);
      if (beforeSignature !== afterSignature || wad.screenshotFolderPath !== (payload.folderPath || folderPath)) {
        wad.screenshots = screenshots;
        wad.screenshotFolderPath = payload.folderPath || folderPath;
        wad.lastScreenshotScanAt = new Date().toISOString();
        screenshotUpdatedWads += 1;
        hadChanges = true;
        results.push({
          title: wad.title,
          kind: 'Screenshots',
          status: 'Updated',
          detail: `${screenshots.length} screenshot${screenshots.length === 1 ? '' : 's'} found (${before} before).`,
        });
      }
    } catch (error) {
      console.error(error);
      results.push({ title: wad.title, kind: 'Screenshots', status: 'Error', detail: error.message || 'Screenshot scan failed.' });
    }
  }

  if (hadChanges) await saveState();
  render();
  const errors = results.filter((entry) => entry.status === 'Error').length;
  const changedResults = results.filter((entry) => entry.status !== 'Error').length;
  showRefreshAllResults(results, { saveTargets: saveTargets.length, screenshotTargets: screenshotTargets.length, excludedTargets: excludedTargets.length, saveUpdatedMaps, screenshotUpdatedWads, changedResults });
  showAlert(errors ? 'error' : 'success', changedResults || errors
    ? `Refresh All complete: ${saveUpdatedMaps} changed map record${saveUpdatedMaps === 1 ? '' : 's'}, ${screenshotUpdatedWads} changed screenshot folder${screenshotUpdatedWads === 1 ? '' : 's'}${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}.`
    : 'Refresh All complete: no changes since the last Refresh All.');
}

function showRefreshAllResults(results, summary = {}) {
  let dialog = document.getElementById('refreshAllResultsDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'refreshAllResultsDialog';
    dialog.className = 'modal';
    document.body.appendChild(dialog);
  }

  const rows = (Array.isArray(results) ? results : []).map((entry) => `
    <tr>
      <td>${escapeHtml(entry.title || '')}</td>
      <td>${escapeHtml(entry.kind || '')}</td>
      <td><span class="status-pill ${entry.status === 'Error' ? 'state-dropped' : entry.status === 'Skipped' ? 'state-hold' : 'state-completed'}">${escapeHtml(entry.status || '')}</span></td>
      <td>${escapeHtml(entry.detail || '')}</td>
    </tr>`).join('');

  dialog.innerHTML = `
    <form method="dialog" class="modal-card refresh-all-results-card">
      <div class="modal-head">
        <h3>Refresh All Results</h3>
        <button type="submit" class="ghost-button">✕</button>
      </div>
      <p class="muted">Scanned ${Number(summary.saveTargets) || 0} save folder${Number(summary.saveTargets) === 1 ? '' : 's'} and ${Number(summary.screenshotTargets) || 0} screenshot folder${Number(summary.screenshotTargets) === 1 ? '' : 's'}.</p>
      <p class="muted">Showing only changes since the previous Refresh All: ${Number(summary.saveUpdatedMaps) || 0} changed map record${Number(summary.saveUpdatedMaps) === 1 ? '' : 's'} and ${Number(summary.screenshotUpdatedWads) || 0} changed screenshot ${Number(summary.screenshotUpdatedWads) === 1 ? 'gallery' : 'galleries'}.</p>
      <div class="table-shell refresh-all-results-table">
        <table>
          <thead><tr><th>WAD</th><th>Task</th><th>Status</th><th>Result</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4">No changes since the last Refresh All.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="form-actions"><button type="submit" class="primary-button">Done</button></div>
    </form>`;
  dialog.showModal();
}

function recordLatestSaveInfo(wad, payload) {
  if (!wad || !payload) return;
  const modified = Number(payload.modifiedTime) || 0;
  if (modified > 0) {
    wad.lastSaveModifiedTime = modified;
    wad.lastPlayedAt = new Date(modified * 1000).toISOString();
  }
  wad.lastSaveFileName = String(payload.fileName || wad.lastSaveFileName || '');
  wad.lastSaveFilePath = String(payload.filePath || wad.lastSaveFilePath || '');
}

async function refreshLatestSaveFromFolder(wadId, runId) {
  let wad = state.app.wads.find((entry) => entry.id === wadId);
  if (!wad) return;

  const selectedRunId = runId || getSelectedRunIdForWad(wadId);
  const input = document.getElementById('saveFolderPathInput');
  const folderPath = String(input?.value || wad.saveFolderPath || '').trim();
  if (!folderPath) {
    showAlert('error', 'Set a save folder path first.');
    return;
  }

  // Do not save the folder path before refreshing. If the death monitor has
  // written fresh deaths to the database while this page is stale, an early save
  // would overwrite them before the preservation merge can see them.
  wad.saveFolderPath = folderPath;

  try {
    const response = await fetch('/api/refresh-stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Local server refresh failed.');

    // Pull in any live terminal death monitor changes before merging the .zds.
    // This keeps Refresh Latest .zds consistent with Refresh All.
    await preserveLiveDeathCountsBeforeSave();

    wad = state.app.wads.find((entry) => entry.id === wadId);
    if (!wad) return;
    wad.saveFolderPath = folderPath;
    const run = wad.runs.find((entry) => entry.id === selectedRunId) || getLatestRun(wad);
    if (!run) return;
    wad.selectedRunId = run.id;

    recordLatestSaveInfo(wad, payload);

    const levels = payload?.statistics?.levels || payload?.levels;
    if (!Array.isArray(levels)) throw new Error('The local server did not return statistics.levels[].');
    const saveDifficulty = skillFlagToDifficulty(payload?.servercvars?.skill || payload?.skill);

    const mergeResult = mergeImportedLevelsIntoRun(run, levels, payload.fileName || 'latest.zds', saveDifficulty);
    const imported = Number(mergeResult?.imported ?? mergeResult) || 0;
    const newlyPlayed = Number(mergeResult?.newlyPlayed) || 0;
    const stateChange = applyAutomaticPlayStateFromRefresh(wad, run, newlyPlayed);
    await saveState();
    showAlert('success', `Refreshed ${imported} map record${imported === 1 ? '' : 's'} from ${payload.fileName || 'latest .zds'}.${stateChange ? ` ${stateChange}` : ''}`);
    render();
  } catch (error) {
    console.error(error);
    showAlert('error', `${error.message || 'Refresh failed.'} Make sure local_server.py is running.`);
  }
}

async function loadCompanionTxtPreview(wadId) {
  const wad = state.app.wads.find((entry) => entry.id === wadId);
  const statusEl = document.getElementById('companionTxtStatus');
  const previewEl = document.getElementById('companionTxtPreview');
  if (!wad || !statusEl || !previewEl) return;

  if (!wad.pwadPath) {
    statusEl.textContent = 'Set a WAD/PK3 first to look for an exact companion TXT.';
    previewEl.textContent = 'No associated WAD/PK3 path.';
    return;
  }

  const metadataFolder = getAppSetting('defaultMetadataFolder');
  if (!metadataFolder) {
    statusEl.textContent = 'Set the Default metadata TXT folder in Settings to preview companion TXT files.';
    previewEl.textContent = 'No metadata TXT folder configured.';
    return;
  }

  statusEl.textContent = 'Checking for companion TXT...';
  previewEl.textContent = 'Loading...';

  try {
    const response = await fetch('/api/read-companion-txt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wadPath: wad.pwadPath, metadataFolder, txtPath: wad.txtMetadataFile || "" }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'TXT preview failed.');

    if (!payload.found) {
      statusEl.textContent = `No exact TXT match found for ${payload.expectedFileName || 'this WAD/PK3'}.`;
      previewEl.textContent = 'No companion TXT found.';
      return;
    }

    statusEl.innerHTML = `Showing <code>${escapeHtml(payload.fileName || payload.filePath || 'companion TXT')}</code>`;
    previewEl.textContent = payload.content || '(TXT file was empty)';
  } catch (error) {
    console.error(error);
    statusEl.textContent = `${error.message || 'TXT preview failed.'} Make sure local_server.py is running and the metadata folder exists.`;
    previewEl.textContent = 'TXT preview unavailable.';
  }
}

function normalizeImportedLevel(level, fileName, existingMap = null, saveDifficulty = '') {
  const levelName = String(level.levelname).trim();
  return {
    id: crypto.randomUUID(),
    levelName,
    displayName: existingMap?.displayName || levelName,
    mapAuthor: existingMap?.mapAuthor || '',
    killcount: Number(level.killcount) || 0,
    totalkills: Number(level.totalkills) || 0,
    itemcount: Number(level.itemcount) || 0,
    totalitems: Number(level.totalitems) || 0,
    secretcount: Number(level.secretcount) || 0,
    totalsecrets: Number(level.totalsecrets) || 0,
    leveltime: Number(level.leveltime) || 0,
    deaths: Number(existingMap?.deaths) || 0,
    difficulty: (!existingMap || isUnplayedPlaceholderMap(existingMap)) && saveDifficulty ? saveDifficulty : (existingMap?.difficulty || saveDifficulty || ''),
    sourceType: existingMap?.sourceType === 'manual' ? 'edited' : 'imported',
    saveFileName: fileName,
    notes: existingMap?.notes || '',
    createdAt: existingMap?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function importUmapinfoFile(file, runId) {
  const wad = getCurrentWad();
  if (!wad) return;
  const run = wad.runs.find((r) => r.id === runId);
  if (!run) return;

  try {
    const raw = await file.text();
    const maps = parseUmapinfo(raw);
    if (!maps.length) throw new Error('No map blocks were found in the UMAPINFO file.');

    const imported = mergeImportedMetadataIntoRun(run, wad, maps, file.name, 'metadata');
    showAlert('success', `Imported ${imported} map definition${imported === 1 ? '' : 's'} from ${file.name}.`);
    render();

    const importList = document.getElementById('importList');
    if (importList) {
      importList.innerHTML = `
      <div class="import-item">
      <strong>${escapeHtml(file.name)}</strong>
      <div class="subtle" style="margin-top:0.35rem;">Imported ${imported} map definitions from <code>UMAPINFO</code>.</div>
      </div>
      ` + importList.innerHTML;
    }
  } catch (error) {
    console.error(error);
    showAlert('error', error.message || 'UMAPINFO import failed.');
    renderAlerts();
  }
}

function parseUmapinfo(rawText) {
  const text = String(rawText || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const lines = text.split('\n');
  const results = [];
  let i = 0;

  const headerRegex = /^\s*map\s+([A-Za-z0-9_]+)\b/i;

  while (i < lines.length) {
    const header = lines[i].match(headerRegex);
    if (!header) {
      i += 1;
      continue;
    }

    const levelName = header[1].trim().toUpperCase();
    const blockLines = [lines[i]];
    let braceDepth = (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    let sawOpenBrace = lines[i].includes('{');
    i += 1;

    while (i < lines.length) {
      const nextHeader = lines[i].match(headerRegex);
      if (nextHeader && (!sawOpenBrace || braceDepth <= 0)) break;

      blockLines.push(lines[i]);
      if (lines[i].includes('{')) sawOpenBrace = true;
      braceDepth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
      i += 1;

      if (sawOpenBrace && braceDepth <= 0) break;
    }

    const block = blockLines.join('\n');
    const displayName = extractUmapinfoString(block, 'levelname') || extractUmapinfoString(block, 'name') || '';
    const mapAuthor = extractUmapinfoString(block, 'author') || extractUmapinfoString(block, 'mapauthor') || '';

    results.push({ levelName, displayName, mapAuthor });
  }

  return dedupeMetadataMaps(results).sort(compareMapSlots);
}

function extractUmapinfoString(block, key) {
  const regex = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|([^\\n]+))`, 'im');
  const match = block.match(regex);
  if (!match) return '';
  const value = (match[1] ?? match[2] ?? '').trim();
  if (!value || value.toLowerCase() === 'clear') return '';
  return value.replace(/,$/, '').trim();
}


async function importDehackedFile(file, runId) {
  const wad = getCurrentWad();
  if (!wad) return;
  const run = wad.runs.find((r) => r.id === runId);
  if (!run) return;

  try {
    const raw = await file.text();
    const maps = parseDehackedMetadata(raw);
    if (!maps.length) throw new Error('No map names were found in the DEHACKED file.');

    const imported = mergeImportedMetadataIntoRun(run, wad, maps, file.name, 'dehacked');
    showAlert('success', `Imported ${imported} map definition${imported === 1 ? '' : 's'} from ${file.name}.`);
    render();

    const importList = document.getElementById('importList');
    if (importList) {
      importList.innerHTML = `
      <div class="import-item">
      <strong>${escapeHtml(file.name)}</strong>
      <div class="subtle" style="margin-top:0.35rem;">Imported ${imported} map definitions from <code>DEHACKED</code>.</div>
      </div>
      ` + importList.innerHTML;
    }
  } catch (error) {
    console.error(error);
    showAlert('error', error.message || 'DEHACKED import failed.');
    renderAlerts();
  }
}


async function importMapinfoFile(file, runId) {
  const wad = getCurrentWad();
  if (!wad) return;
  const run = wad.runs.find((r) => r.id === runId);
  if (!run) return;

  try {
    const raw = await file.text();
    const maps = parseMapinfoMetadata(raw);
    if (!maps.length) throw new Error('No map definitions were found in the MAPINFO file.');

    const imported = mergeImportedMetadataIntoRun(run, wad, maps, file.name, 'mapinfo');
    showAlert('success', `Imported ${imported} map definition${imported === 1 ? '' : 's'} from ${file.name}.`);
    render();

    const importList = document.getElementById('importList');
    if (importList) {
      importList.innerHTML = `
      <div class="import-item">
      <strong>${escapeHtml(file.name)}</strong>
      <div class="subtle" style="margin-top:0.35rem;">Imported ${imported} map definitions from <code>MAPINFO</code>.</div>
      </div>
      ` + importList.innerHTML;
    }
  } catch (error) {
    console.error(error);
    showAlert('error', error.message || 'MAPINFO import failed.');
    renderAlerts();
  }
}

function parseMapinfoMetadata(rawText) {
  const text = String(rawText || '').replace(/\r\n?/g, '\n');
  const merged = new Map();

  for (const entry of parseMapinfoBlockStyle(text)) {
    const key = entry.levelName.toUpperCase();
    const existing = merged.get(key) || { levelName: entry.levelName, displayName: '', mapAuthor: '' };
    merged.set(key, {
      ...existing,
      levelName: entry.levelName,
      displayName: entry.displayName || existing.displayName || entry.levelName,
      mapAuthor: entry.mapAuthor || existing.mapAuthor || '',
    });
  }

  for (const entry of parseMapinfoLegacyStyle(text)) {
    const key = entry.levelName.toUpperCase();
    const existing = merged.get(key) || { levelName: entry.levelName, displayName: '', mapAuthor: '' };
    merged.set(key, {
      ...existing,
      levelName: entry.levelName,
      displayName: entry.displayName || existing.displayName || entry.levelName,
      mapAuthor: entry.mapAuthor || existing.mapAuthor || '',
    });
  }

  return Array.from(merged.values()).sort(compareMapSlots);
}

function parseMapinfoBlockStyle(text) {
  const results = [];
  const regex = /(^|\n)\s*map\s+(?:"([^"]+)"|([A-Za-z0-9_]+))\s+"([^"]+)"\s*\{([\s\S]*?)\}/gim;
  let match;

  while ((match = regex.exec(text))) {
    const lump = (match[2] || match[3] || '').trim();
    const displayName = String(match[4] || '').trim();
    const block = match[5] || '';
    const levelName = normalizeMapinfoLevelName(lump, block);
    if (!levelName || !displayName) continue;

    results.push({
      levelName,
      displayName: normalizeDehackedDisplayName(displayName),
      mapAuthor: extractMapinfoValue(block, 'author') || extractMapinfoValue(block, 'mapauthor') || '',
    });
  }

  return results;
}

function parseMapinfoLegacyStyle(text) {
  const results = [];
  const regex = /^\s*map\s+([A-Za-z0-9_]+|\d+)\s+"([^"]+)"\s*$/gim;
  let match;

  while ((match = regex.exec(text))) {
    const ident = String(match[1] || '').trim();
    const displayName = String(match[2] || '').trim();
    const start = regex.lastIndex;
    const nextMatch = /^\s*map\s+([A-Za-z0-9_]+|\d+)\s+"([^"]+)"\s*$/gim;
    nextMatch.lastIndex = start;
    const next = nextMatch.exec(text);
    const end = next ? next.index : text.length;
    const block = text.slice(start, end);
    const levelName = normalizeMapinfoLevelName(ident, block);
    if (!levelName || !displayName) continue;

    results.push({
      levelName,
      displayName: normalizeDehackedDisplayName(displayName),
      mapAuthor: extractMapinfoValue(block, 'author') || extractMapinfoValue(block, 'mapauthor') || '',
    });
  }

  return results;
}

function normalizeMapinfoLevelName(identifier, block = '') {
  const raw = String(identifier || '').replace(/^"|"$/g, '').trim();
  if (!raw) return '';

  if (/^MAP\d{1,2}$/i.test(raw)) return `MAP${String(Number(raw.slice(3))).padStart(2, '0')}`;
  if (/^E\d+M\d+$/i.test(raw)) return raw.toUpperCase();

  if (/^\d+$/.test(raw)) return `MAP${String(Number(raw)).padStart(2, '0')}`;

  const episodeNum = Number(extractMapinfoValue(block, 'episodenumber'));
  const mapNum = Number(extractMapinfoValue(block, 'mapnumber'));
  if (Number.isFinite(episodeNum) && episodeNum > 0 && Number.isFinite(mapNum) && mapNum > 0) {
    return `E${episodeNum}M${mapNum}`;
  }

  return raw.toUpperCase();
}

function extractMapinfoValue(block, key) {
  const quotedEq = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'im');
  const rawEq = new RegExp(`^\\s*${key}\\s*=\\s*([^\\n]+)`, 'im');
  const rawSpace = new RegExp(`^\\s*${key}\\s+([^\\n]+)`, 'im');

  let match = block.match(quotedEq);
  if (match) return match[1].trim();
  match = block.match(rawEq);
  if (match) return match[1].split('//')[0].replace(/,$/, '').trim();
  match = block.match(rawSpace);
  if (match) return match[1].split('//')[0].replace(/,$/, '').trim();
  return '';
}

function mergeImportedMetadataIntoRun(run, wad, maps, fileName, sourceType) {
  let imported = 0;
  for (const entry of maps) {
    const levelName = String(entry.levelName || '').trim();
    if (!levelName) continue;

    const existingIndex = run.maps.findIndex((map) => String(map.levelName || '').trim().toUpperCase() === levelName.toUpperCase());
    if (existingIndex >= 0) {
      const existing = run.maps[existingIndex];
      run.maps[existingIndex] = {
        ...existing,
        levelName,
        displayName: String(entry.displayName || '').trim() || existing.displayName || levelName,
        mapAuthor: String(entry.mapAuthor || '').trim() || existing.mapAuthor || '',
        sourceType: existing.sourceType === 'manual' ? 'edited' : sourceType,
        metadataFileName: fileName,
        updatedAt: new Date().toISOString(),
      };
    } else {
      run.maps.push({
        id: crypto.randomUUID(),
        levelName,
        displayName: String(entry.displayName || '').trim() || levelName,
        mapAuthor: String(entry.mapAuthor || '').trim(),
        killcount: 0,
        totalkills: 0,
        itemcount: 0,
        totalitems: 0,
        secretcount: 0,
        totalsecrets: 0,
        leveltime: 0,
        deaths: 0,
        sourceType,
        saveFileName: '',
        metadataFileName: fileName,
        notes: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      imported += 1;
    }
  }

  if (wad.totalMaps < run.maps.length) wad.totalMaps = run.maps.length;
  sortRunMaps(run);
  saveState();
  return imported || maps.length;
}

function parseDehackedMetadata(rawText) {
  const text = String(rawText || '').replace(/\r\n?/g, '\n');
  const merged = new Map();

  for (const entry of parseDehackedStringTable(text)) {
    const key = entry.levelName.toUpperCase();
    merged.set(key, { levelName: entry.levelName, displayName: entry.displayName, mapAuthor: '' });
  }

  for (const entry of parseDehackedTextBlocks(text)) {
    const key = entry.levelName.toUpperCase();
    const existing = merged.get(key) || { levelName: entry.levelName, displayName: '', mapAuthor: '' };
    merged.set(key, {
      ...existing,
      levelName: entry.levelName,
      displayName: entry.displayName || existing.displayName || entry.levelName,
    });
  }

  return Array.from(merged.values()).sort(compareMapSlots);
}

function parseDehackedStringTable(text) {
  const results = [];
  const mapRegex = /^\s*(?:HUSTR|THUSTR)_(E\dM\d|\d+)\s*=\s*(.+)$/gim;
  const epiRegex = /^\s*PHUSTR_(\d+)\s*=\s*(.+)$/gim;
  let match;

  while ((match = mapRegex.exec(text))) {
    const key = String(match[1] || '').toUpperCase();
    const slot = Number(key);
    const value = normalizeDehackedDisplayName(match[2]);
    const levelName = key.startsWith('E') ? key : (slot >= 1 && slot <= 99 ? `MAP${String(slot).padStart(2, '0')}` : '');
    if (!levelName || !value) continue;
    results.push({ levelName, displayName: value, mapAuthor: '' });
  }

  while ((match = epiRegex.exec(text))) {
    const slot = Number(match[1]);
    const levelName = `E${Math.floor((slot - 1) / 9) + 1}M${((slot - 1) % 9) + 1}`;
    const value = normalizeDehackedDisplayName(match[2]);
    if (!value) continue;
    results.push({ levelName, displayName: value, mapAuthor: '' });
  }

  return results;
}

function parseDehackedTextBlocks(text) {
  const results = [];
  let cursor = 0;

  while (cursor < text.length) {
    const match = /^Text\s+(\d+)\s+(\d+)\s*$/im.exec(text.slice(cursor));
    if (!match) break;

    const absoluteHeaderStart = cursor + match.index;
    const headerEnd = absoluteHeaderStart + match[0].length;
    const oldLen = Number(match[1]);
    const newLen = Number(match[2]);

    let payloadStart = headerEnd;
    if (text[payloadStart] === '\n') payloadStart += 1;

    const payload = text.slice(payloadStart, payloadStart + oldLen + newLen);
    const oldText = payload.slice(0, oldLen);
    const newText = payload.slice(oldLen, oldLen + newLen);

    const levelName = inferLevelNameFromDehackedOldText(oldText);
    const displayName = normalizeDehackedDisplayName(newText);

    if (levelName && displayName) {
      results.push({ levelName, displayName, mapAuthor: '' });
    }

    cursor = payloadStart + oldLen + newLen;
    while (text[cursor] === '\n') cursor += 1;
  }

  return results;
}

function inferLevelNameFromDehackedOldText(oldText) {
  const text = String(oldText || '').trim();

  let match = text.match(/^level\s+(\d+)\s*:/i);
  if (match) return `MAP${String(Number(match[1])).padStart(2, '0')}`;

  match = text.match(/^MAP(\d+)\s*:/i);
  if (match) return `MAP${String(Number(match[1])).padStart(2, '0')}`;

  match = text.match(/^E(\d)M(\d)\s*:/i);
  if (match) return `E${match[1]}M${match[2]}`;

  return '';
}

function normalizeDehackedDisplayName(value) {
  let text = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';

  text = text.replace(/\n+/g, ' ').trim();
  text = text.replace(/^(?:MAP\d{1,2}|E\dM\d)\s*:\s*/i, '');
  text = text.replace(/^level\s+\d+\s*:\s*/i, '');
  text = text.replace(/^MAP\s*\d+\s*:\s*/i, '');
  text = text.replace(/^\d+\s*[:\/-]\s*/i, '');
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}


function createRun(name) {
  return {
    id: crypto.randomUUID(),
    name,
    mode: 'Continuous',
    difficulty: 'UV',
    mods: '',
    createdAt: new Date().toISOString(),
    maps: [],
  };
}

function computeRunSummary(run, totalMaps, wad = null) {
  const maps = run.maps || [];
  const playedMaps = maps.filter((map) => !isUnplayedPlaceholderMap(map));
  const killPercents = playedMaps.map((map) => calcPercent(map.killcount, map.totalkills));
  const itemPercents = playedMaps.map((map) => calcPercent(map.itemcount, map.totalitems));
  const secretPercents = playedMaps.map((map) => calcPercent(map.secretcount, map.totalsecrets));
  const totals = computeMapCollectionTotals(playedMaps);
  const medals = maps.reduce((acc, map) => {
    const medal = getMedal(map).tier;
    acc[medal] += 1;
    return acc;
  }, { gold: 0, silver: 0, bronze: 0, none: 0, unplayed: 0 });

  const completionMet = wad ? isRunCompleteForWad(wad, run) : (totalMaps ? playedMaps.length >= totalMaps : false);

  return {
    avgKillPercent: average(killPercents),
    avgItemPercent: average(itemPercents),
    avgSecretPercent: average(secretPercents),
    weightedKillPercent: calcPercent(totals.totalKills, sum(playedMaps.map((m) => m.totalkills))),
    totalDeaths: sum(playedMaps.map((m) => Number(m.deaths) || 0)),
    totalTimeTics: totals.totalTimeTics,
    totalKills: totals.totalKills,
    totalItems: totals.totalItems,
    totalSecrets: totals.totalSecrets,
    averageKillsPerMinute: totals.averageKillsPerMinute,
    medals,
    completedMaps: playedMaps.length,
    progressPercent: completionMet ? 100 : (totalMaps ? Math.min(100, (playedMaps.length / totalMaps) * 100) : 0),
    statusClass: playedMaps.length === 0 ? 'not-started' : completionMet ? 'completed' : '',
    statusLabel: playedMaps.length === 0 ? 'Not Started' : completionMet ? 'Completed' : 'In Progress',
    runCount: 1,
  };
}

function createEmptySummary(totalMaps) {
  return {
    avgKillPercent: 0,
    avgItemPercent: 0,
    avgSecretPercent: 0,
    weightedKillPercent: 0,
    totalDeaths: 0,
    totalTimeTics: 0,
    totalKills: 0,
    totalItems: 0,
    totalSecrets: 0,
    averageKillsPerMinute: 0,
    medals: { gold: 0, silver: 0, bronze: 0, none: 0, unplayed: 0 },
    completedMaps: 0,
    progressPercent: 0,
    statusClass: 'not-started',
    statusLabel: 'Not Started',
    runCount: 0,
  };
}

function getMedal(map) {
  if (isUnplayedPlaceholderMap(map)) {
    return { tier: 'unplayed', label: '— Unplayed' };
  }

  const categories = [
    isCategoryComplete(map.killcount, map.totalkills),
    isCategoryComplete(map.itemcount, map.totalitems),
    isCategoryComplete(map.secretcount, map.totalsecrets),
  ];
  const count = categories.filter(Boolean).length;
  if (count === 3) return { tier: 'gold', label: '🥇 Gold' };
  if (count === 2) return { tier: 'silver', label: '🥈 Silver' };
  if (count === 1) return { tier: 'bronze', label: '🥉 Bronze' };
  return { tier: 'none', label: '⚫ None' };
}

function isUnplayedPlaceholderMap(map) {
  if (!map) return false;
  const values = [
    map.killcount,
    map.totalkills,
    map.itemcount,
    map.totalitems,
    map.secretcount,
    map.totalsecrets,
    map.leveltime,
  ].map((value) => Number(value) || 0);

  return values.every((value) => value === 0);
}

function isCategoryComplete(found, total) {
  const normalizedTotal = Number(total) || 0;
  const normalizedFound = Number(found) || 0;
  if (normalizedTotal === 0) return true;
  return normalizedFound >= normalizedTotal;
}

function renderMedalBadge(medal) {
  return `<span class="medal-badge ${medal.tier}">${medal.label}</span>`;
}

function renderStatValue(found, total) {
  const percent = calcPercent(found, total);
  const counts = `${Number(found) || 0} / ${Number(total) || 0}`;
  if (state.displayMode === 'counts') return counts;
  if (state.displayMode === 'percent') return formatPercent(percent);
  return `${counts} (${formatPercent(percent)})`;
}

function mapFormDataToMapResult(formData) {
  const isPercentMode = state.mapInputMode === 'percent';

  let killcount, itemcount, secretcount;

  if (isPercentMode) {
    const totalkills = Number(formData.get('totalkills')) || 0;
    const totalitems = Number(formData.get('totalitems')) || 0;
    const totalsecrets = Number(formData.get('totalsecrets')) || 0;
    const killPct = Number(document.getElementById('killPctInput')?.value) || 0;
    const itemPct = Number(document.getElementById('itemPctInput')?.value) || 0;
    const secretPct = Number(document.getElementById('secretPctInput')?.value) || 0;
    killcount = Math.round(totalkills * killPct / 100);
    itemcount = Math.round(totalitems * itemPct / 100);
    secretcount = Math.round(totalsecrets * secretPct / 100);
  } else {
    killcount = Number(formData.get('killcount')) || 0;
    itemcount = Number(formData.get('itemcount')) || 0;
    secretcount = Number(formData.get('secretcount')) || 0;
  }

  return {
    id: String(formData.get('mapId') || crypto.randomUUID()),
    levelName: String(formData.get('levelName')).trim(),
    displayName: String(formData.get('displayName') || '').trim() || String(formData.get('levelName')).trim(),
    mapAuthor: String(formData.get('mapAuthor') || '').trim(),
    killcount,
    totalkills: Number(formData.get('totalkills')) || 0,
    itemcount,
    totalitems: Number(formData.get('totalitems')) || 0,
    secretcount,
    totalsecrets: Number(formData.get('totalsecrets')) || 0,
    leveltime: parseLevelTimeInput(formData.get('leveltime')),
    deaths: Number(formData.get('deaths')) || 0,
    difficulty: String(formData.get('difficulty') || '').trim(),
    sourceType: String(formData.get('sourceType') || 'manual'),
    saveFileName: String(formData.get('saveFileName') || '').trim(),
    notes: String(formData.get('notes') || '').trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function compareMapSlots(a, b) {
  return extractMapOrder(a.levelName) - extractMapOrder(b.levelName);
}

function extractMapOrder(levelName) {
  const upper = String(levelName || '').toUpperCase();
  const mapMatch = upper.match(/^MAP(\d{1,2})$/);
  if (mapMatch) return Number(mapMatch[1]);
  const EpisodeMatch = upper.match(/^E(\d)M(\d)$/);
  if (EpisodeMatch) return Number(EpisodeMatch[1]) * 100 + Number(EpisodeMatch[2]);
  const anyDigits = upper.match(/(\d+)/);
  return anyDigits ? Number(anyDigits[1]) : 9999;
}

function sortRunMaps(run) {
  run.maps.sort(compareMapSlots);
}

function computeMapCollectionTotals(maps) {
  const safeMaps = Array.isArray(maps) ? maps : [];
  const totalKills = sum(safeMaps.map((map) => map.killcount));
  const totalItems = sum(safeMaps.map((map) => map.itemcount));
  const totalSecrets = sum(safeMaps.map((map) => map.secretcount));
  const totalTimeTics = sum(safeMaps.map((map) => map.leveltime));
  const totalMinutes = totalTimeTics > 0 ? totalTimeTics / 35 / 60 : 0;
  return {
    totalKills,
    totalItems,
    totalSecrets,
    totalTimeTics,
    averageKillsPerMinute: totalMinutes > 0 ? totalKills / totalMinutes : 0,
  };
}

function calcPercent(found, total) {
  const normalizedTotal = Number(total) || 0;
  const normalizedFound = Number(found) || 0;
  if (normalizedTotal === 0) return 100;
  return (normalizedFound / normalizedTotal) * 100;
}

function average(values) {
  if (!values.length) return 0;
  return sum(values) / values.length;
}

function sum(values) {
  return values.reduce((acc, value) => acc + (Number(value) || 0), 0);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.round(value * 10) / 10}%`;
}

function formatInteger(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatNumber(value, digits = 1) {
  const normalized = Number(value) || 0;
  return normalized.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function renderLibraryFilterButton(value, label) {
  return `<button class="filter-pill ${state.libraryFilter === value ? 'active' : ''}" onclick="window.appActions.setLibraryFilter('${value}')">${label}</button>`;
}

function getLibraryQuickFilters() {
  return state.libraryQuickFilters && typeof state.libraryQuickFilters === 'object' ? state.libraryQuickFilters : {};
}

function setLibraryQuickFilter(key, value) {
  const allowed = ['playState', 'iwad', 'type', 'difficulty', 'author', 'sourcePort', 'tag'];
  if (!allowed.includes(key)) return;
  state.libraryQuickFilters = getLibraryQuickFilters();
  const normalized = String(value || '').trim();
  if (!normalized) delete state.libraryQuickFilters[key];
  else state.libraryQuickFilters[key] = normalized;
  render();
}

function clearLibraryQuickFilter(key) {
  state.libraryQuickFilters = getLibraryQuickFilters();
  delete state.libraryQuickFilters[key];
  render();
}

function clearAllLibraryQuickFilters() {
  state.libraryQuickFilters = {};
  state.libraryFilter = 'all';
  render();
}

function renderActiveLibraryQuickFilters() {
  const filters = getLibraryQuickFilters();
  const chips = [];
  if (state.libraryFilter !== 'all') chips.push({ label: 'State', value: playStateLabel(state.libraryFilter), clear: "window.appActions.setLibraryFilter('all')" });
  for (const [key, value] of Object.entries(filters)) {
    const label = ({ playState: 'State', iwad: 'IWAD', type: 'Type', difficulty: 'Difficulty', author: 'Author', sourcePort: 'Port', tag: 'Tag' })[key] || key;
    const display = key === 'playState' ? playStateLabel(value) : value;
    chips.push({ label, value: display, clear: `window.appActions.clearLibraryQuickFilter('${escapeJsString(key)}')` });
  }
  if (!chips.length) return '';
  return `<div class="active-filter-row">
    <span class="subtle">Active quick filters:</span>
    ${chips.map((chip) => `<button type="button" class="filter-pill active" onclick="${chip.clear}" title="Clear ${escapeHtml(chip.label)} filter">${escapeHtml(chip.label)}: ${escapeHtml(chip.value)} ✕</button>`).join('')}
    <button type="button" class="ghost-button" onclick="window.appActions.clearAllLibraryQuickFilters()">Clear all</button>
  </div>`;
}

function renderQuickFilterButton(key, value, label, cssClass = 'inline-link-button') {
  const cleanValue = String(value || '').trim();
  if (!cleanValue) return `<span>${escapeHtml(label || 'Not set')}</span>`;
  const cleanLabel = String(label || cleanValue).trim();
  return `<button type="button" class="${cssClass}" onclick="window.appActions.setLibraryQuickFilter('${escapeJsString(key)}', '${escapeJsString(cleanValue)}')" title="Filter library by ${escapeHtml(cleanLabel)}">${escapeHtml(cleanLabel)}</button>`;
}

function parseTags(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  const seen = new Set();
  return raw.split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag) => {
      const key = normalizeSearchText(tag);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getWadTags(wad) {
  return parseTags(wad?.tags || []);
}

function renderWadTagButton(tag, cssClass = 'tag-chip tag-chip-button') {
  const clean = String(tag || '').trim();
  if (!clean) return '';
  return `<button type="button" class="${cssClass}" onclick="window.appActions.setLibraryQuickFilter('tag', '${escapeJsString(clean)}')" title="Filter library by tag: ${escapeHtml(clean)}">#${escapeHtml(clean)}</button>`;
}

function renderWadTagPreview(wad, limit = 3) {
  const tags = getWadTags(wad);
  if (!tags.length) return '';
  const shown = tags.slice(0, limit).map((tag) => renderWadTagButton(tag)).join('');
  const remaining = tags.length - limit;
  const more = remaining > 0
    ? `<button type="button" class="tag-chip tag-chip-button" onclick="window.appActions.showAllWadTags('${escapeJsString(wad.id)}')" title="Show all tags for ${escapeHtml(wad.title || 'this WAD')}">+${remaining}</button>`
    : '';
  return `${shown}${more}`;
}

function showAllWadTags(wadId) {
  const wad = state.app.wads.find((entry) => entry.id === wadId);
  if (!wad) return;
  const tags = getWadTags(wad);
  let dialog = document.getElementById('wadTagsDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'wadTagsDialog';
    dialog.className = 'modal';
    document.body.appendChild(dialog);
  }
  dialog.innerHTML = `
    <form method="dialog" class="modal-card wad-tags-card">
      <div class="modal-head">
        <div>
          <h3>${escapeHtml(wad.title)} — Tags</h3>
          <p class="muted">Click a tag to filter the library.</p>
        </div>
        <button type="submit" class="ghost-button">✕</button>
      </div>
      <div class="tag-row tag-popup-row">${tags.length ? tags.map((tag) => renderWadTagButton(tag)).join('') : '<span class="muted">No tags set.</span>'}</div>
      <div class="modal-actions"><button type="submit" class="primary-button">Close</button></div>
    </form>`;
  dialog.showModal();
}
function renderMetricSortButton(sortKey, label, value) {
  const active = state.librarySortKey === sortKey ? ' active' : '';
  return `<button type="button" class="metric-chip metric-chip-button${active}" onclick="window.appActions.sortLibraryByMetric('${escapeJsString(sortKey)}')" title="Sort library by ${escapeHtml(label)}">${escapeHtml(label)} ${escapeHtml(formatPercent(value))}</button>`;
}
function getLibrarySortLabel(key) {
  return LIBRARY_SORT_OPTIONS.find((option) => option.key === key)?.label || 'Alphabetical';
}

function renderLibrarySortControls() {
  const options = LIBRARY_SORT_OPTIONS.map((option) => `
    <option value="${option.key}" ${state.librarySortKey === option.key ? 'selected' : ''}>${escapeHtml(option.label)}</option>
  `).join('');
  const isAsc = state.librarySortDirection !== 'desc';
  return `
  <div class="library-sort-controls">
    <label class="sort-select-label" for="librarySortSelect">Sort library</label>
    <select id="librarySortSelect" class="sort-select" onchange="window.appActions.setLibrarySortKey(this.value)" title="Choose how WAD cards are sorted. Folders always stay first.">
      ${options}
    </select>
    <button type="button" class="sort-direction-button" onclick="window.appActions.toggleLibrarySortDirection()" title="Toggle ascending / descending">
      <span class="sort-direction-icon">${isAsc ? '⬆️' : '⬇️'}</span>
      <span>${isAsc ? 'Ascending' : 'Descending'}</span>
    </button>
  </div>`;
}

function sortLibraryFolders(folders) {
  return [...folders].sort((a, b) => compareText(a?.name || '', b?.name || ''));
}

function sortLibraryWads(wads) {
  const key = LIBRARY_SORT_OPTIONS.some((option) => option.key === state.librarySortKey) ? state.librarySortKey : 'title';
  const direction = state.librarySortDirection === 'desc' ? -1 : 1;
  return [...wads].sort((a, b) => {
    const primary = compareLibrarySortValue(a, b, key);
    if (primary !== 0) return primary * direction;
    return compareText(a?.title || '', b?.title || '');
  });
}

function compareLibrarySortValue(a, b, key) {
  if (['title', 'author', 'iwad'].includes(key)) {
    return compareText(getLibrarySortValue(a, key), getLibrarySortValue(b, key));
  }
  return compareNumber(getLibrarySortValue(a, key), getLibrarySortValue(b, key));
}

function getLibrarySortValue(wad, key) {
  const latestRun = getLatestRun(wad);
  const summary = latestRun ? computeRunSummary(latestRun, wad.totalMaps, wad) : createEmptySummary(wad.totalMaps);
  switch (key) {
    case 'lastPlayed': return getLastPlayedTimestamp(wad);
    case 'dateAdded': return Date.parse(wad?.createdAt || '') || 0;
    case 'completion': return Number(summary.progressPercent) || 0;
    case 'avgKills': return Number(summary.avgKillPercent) || 0;
    case 'avgItems': return Number(summary.avgItemPercent) || 0;
    case 'avgSecrets': return Number(summary.avgSecretPercent) || 0;
    case 'goldMedals': return Number(summary.medals?.gold) || 0;
    case 'totalTime': return Number(summary.totalTimeTics) || 0;
    case 'deaths': return Number(summary.totalDeaths) || 0;
    case 'mapCount': return Number(wad?.totalMaps) || 0;
    case 'playState': return playStateSortRank(wad?.playState || 'plan');
    case 'author': return wad?.author || '';
    case 'iwad': return wad?.iwad || '';
    case 'updated': return Date.parse(wad?.updatedAt || wad?.createdAt || '') || 0;
    case 'title':
    default: return wad?.title || '';
  }
}

function getLastPlayedTimestamp(wad) {
  const savedModified = Number(wad?.lastSaveModifiedTime) || 0;
  if (savedModified > 0) return savedModified * 1000;
  const latestRun = getLatestRun(wad);
  const maps = Array.isArray(latestRun?.maps) ? latestRun.maps : [];
  return maps.reduce((latest, map) => {
    if (isUnplayedPlaceholderMap(map)) return latest;
    const parsed = Date.parse(map?.updatedAt || map?.createdAt || '');
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, 0);
}

function playStateSortRank(value) {
  const ranks = { current: 0, plan: 1, hold: 2, completed: 3, dropped: 4 };
  return Object.prototype.hasOwnProperty.call(ranks, value) ? ranks[value] : 99;
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function compareNumber(a, b) {
  const left = Number(a) || 0;
  const right = Number(b) || 0;
  return left === right ? 0 : left < right ? -1 : 1;
}

function renderLibraryViewControls() {
  const densityLabel = state.libraryViewMode === 'compact' ? 'Row density' : 'Card width';
  const densityValue = state.libraryViewMode === 'compact'
    ? `${Math.round(getLibraryDensityScale() * 100)}%`
    : `${state.libraryDensity}px`;
  return `
  <div class="library-view-controls">
    <div class="segmented-control" aria-label="Library view mode">
      <button class="segment-button ${state.libraryViewMode === 'card' ? 'active' : ''}" onclick="window.appActions.setLibraryViewMode('card')">Card mode</button>
      <button class="segment-button ${state.libraryViewMode === 'compact' ? 'active' : ''}" onclick="window.appActions.setLibraryViewMode('compact')">Compact directory</button>
    </div>
    <label class="density-control">${densityLabel}: <strong>${densityValue}</strong>
      <input type="range" min="520" max="900" step="20" value="${state.libraryDensity}" oninput="window.appActions.setLibraryDensity(this.value)" onchange="window.appActions.saveLibraryViewSettings()" />
    </label>
  </div>`;
}

function getLibraryDensityScale() {
  const clamped = Math.min(900, Math.max(520, Number(state.libraryDensity) || 680));
  return (900 - clamped) / 380 * 0.45 + 0.78;
}

function formatLibraryDate(timestamp) {
  const ms = Number(timestamp) || 0;
  if (!ms) return 'Never';
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (_) {
    return 'Never';
  }
}

function formatLastPlayedRelative(timestamp) {
  const ms = Number(timestamp) || 0;
  if (!ms) return 'Last played never';
  const diffMs = Math.max(0, Date.now() - ms);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (diffMs < hour) {
    const minutes = Math.max(1, Math.floor(diffMs / minute));
    return `Last played ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  if (diffMs < day) {
    const hours = Math.max(1, Math.floor(diffMs / hour));
    return `Last played ${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (diffMs < week) {
    const days = Math.max(1, Math.floor(diffMs / day));
    return `Last played ${days} day${days === 1 ? '' : 's'} ago`;
  }
  if (diffMs < 4 * week) {
    const weeks = Math.max(1, Math.floor(diffMs / week));
    return `Last played ${weeks} week${weeks === 1 ? '' : 's'} ago`;
  }
  return `Last played ${formatLibraryDate(ms)}`;
}

function renderLibraryWadCard(wad) {


  const latestRun = getLatestRun(wad);
  const summary = latestRun ? computeRunSummary(latestRun, wad.totalMaps, wad) : createEmptySummary(wad.totalMaps);
  return `
    <article class="wad-card wad-card--library">
      <div class="wad-card-media-row">
        <div class="wad-card-thumb-shell">
          ${getTitlePicSrc(wad)
            ? `<button type="button" class="wad-card-thumb-button" onclick="window.appActions.openTitlepic('${escapeJsString(getTitlePicSrc(wad))}', '${escapeJsString(wad.title || 'TITLEPIC')}')" title="Open titlepic for ${escapeHtml(wad.title || 'this WAD')}"><img src="${getTitlePicSrc(wad)}" alt="${escapeHtml(wad.title)} titlepic" class="wad-card-thumb" /></button>`
            : `<div class="wad-card-thumb-placeholder">TITLEPIC</div>`}
        </div>
        <div class="wad-card-main">
          <div class="card-head">
            <div>
              <h3 class="card-title">${escapeHtml(wad.title)}</h3>
              <div class="card-meta">
                <span>${renderQuickFilterButton('type', wad.type, capitalize(wad.type), 'inline-link-button meta-filter-link')}</span>
                <span>${renderQuickFilterButton('author', wad.author || '', wad.author || 'Unknown author', 'inline-link-button meta-filter-link')}</span>
                <span>${renderQuickFilterButton('iwad', wad.iwad || '', wad.iwad || 'IWAD not set', 'inline-link-button meta-filter-link')}</span>
                <span>Folder: ${escapeHtml(getFolderPathLabel(wad.folderId))}</span>
              </div>
            </div>
            <button type="button" class="status-pill state-${wad.playState || 'plan'} status-pill-button" onclick="window.appActions.setLibraryQuickFilter('playState', '${escapeJsString(wad.playState || 'plan')}')" title="Filter by play state">${playStateLabel(wad.playState || 'plan')}</button>
          </div>
          <div class="progress-row">
            <div class="card-meta"><span>${renderLibraryMapSummaryButton(wad, summary, 'maps complete')}</span><span>${summary.runCount} run${summary.runCount === 1 ? '' : 's'}</span></div>
            <div class="progress-track"><div class="progress-fill" style="width:${summary.progressPercent}%"></div></div>
          </div>
          <div class="metric-chip-row">
            ${renderMetricSortButton('avgKills', 'Avg Kills', summary.avgKillPercent)}
            ${renderMetricSortButton('avgItems', 'Avg Items', summary.avgItemPercent)}
            ${renderMetricSortButton('avgSecrets', 'Avg Secrets', summary.avgSecretPercent)}
          </div>
          <div class="medal-row">
            <span class="medal-chip gold">🥇 ${summary.medals.gold}</span>
            <span class="medal-chip silver">🥈 ${summary.medals.silver}</span>
            <span class="medal-chip bronze">🥉 ${summary.medals.bronze}</span>
          </div>
          <div class="card-meta"><span>Total deaths ${summary.totalDeaths}</span><span>Total time ${formatTics(summary.totalTimeTics)}</span><span>Last played ${formatLibraryDate(getLastPlayedTimestamp(wad))}</span><span>${renderQuickFilterButton('sourcePort', wad.sourcePort || '', wad.sourcePort || 'Port not set', 'inline-link-button meta-filter-link')}</span><span>${renderQuickFilterButton('difficulty', latestRun?.difficulty || 'UV', latestRun?.difficulty || 'UV', 'inline-link-button meta-filter-link')}</span></div>
          <div class="section-bar">
            <div class="tag-row"><span class="tag-chip">Latest run: ${escapeHtml(latestRun?.name || 'None')}</span>${renderWadTagPreview(wad)}</div>
            ${renderWadLibraryActions(wad)}
          </div>
        </div>
      </div>
    </article>`;
}

function renderCompactWadRow(wad) {
  const latestRun = getLatestRun(wad);
  const summary = latestRun ? computeRunSummary(latestRun, wad.totalMaps, wad) : createEmptySummary(wad.totalMaps);
  return `
    <article class="compact-wad-row">
      <div class="compact-wad-mainline">
        <div class="compact-title-block">
          <span class="compact-icon">${hasTitlePic(wad) ? '🖼️' : '📄'}</span>
          <strong class="compact-title">${escapeHtml(wad.title)}</strong>
          <button type="button" class="status-pill state-${wad.playState || 'plan'} status-pill-button" onclick="window.appActions.setLibraryQuickFilter('playState', '${escapeJsString(wad.playState || 'plan')}')" title="Filter by play state">${playStateLabel(wad.playState || 'plan')}</button>
        </div>
        <div class="compact-stat-line">
          <span>${renderLibraryMapSummaryButton(wad, summary, 'maps')}</span>
          <span>${renderMetricSortButton('avgKills', 'K', summary.avgKillPercent)}</span>
          <span>${renderMetricSortButton('avgItems', 'I', summary.avgItemPercent)}</span>
          <span>${renderMetricSortButton('avgSecrets', 'S', summary.avgSecretPercent)}</span>
          <span>🥇 ${summary.medals.gold}</span>
          <span>🥈 ${summary.medals.silver}</span>
          <span>🥉 ${summary.medals.bronze}</span>
          <span>Deaths ${summary.totalDeaths}</span>
          <span>${formatTics(summary.totalTimeTics)}</span>
          <span>Last ${formatLibraryDate(getLastPlayedTimestamp(wad))}</span>
        </div>
      </div>
      <div class="compact-wad-subline">
        <div class="compact-meta-line">
          <span>${renderQuickFilterButton('type', wad.type, capitalize(wad.type), 'inline-link-button meta-filter-link')}</span>
          <span>${renderQuickFilterButton('author', wad.author || '', wad.author || 'Unknown author', 'inline-link-button meta-filter-link')}</span>
          <span>${renderQuickFilterButton('iwad', wad.iwad || '', wad.iwad || 'IWAD not set', 'inline-link-button meta-filter-link')}</span>
          <span>${renderQuickFilterButton('sourcePort', wad.sourcePort || '', wad.sourcePort || 'Port not set', 'inline-link-button meta-filter-link')}</span>
          <span>${renderQuickFilterButton('difficulty', latestRun?.difficulty || 'UV', latestRun?.difficulty || 'UV', 'inline-link-button meta-filter-link')}</span>
          <span>${escapeHtml(getFolderPathLabel(wad.folderId))}</span>
          <span class="compact-tags">${renderWadTagPreview(wad, 2)}</span>
        </div>
        ${renderWadLibraryActions(wad)}
      </div>
    </article>`;
}


function renderLibraryMapSummaryButton(wad, summary, suffix = 'maps') {
  const safeId = escapeJsString(wad.id);
  return `<button type="button" class="inline-link-button map-summary-link" onclick="window.appActions.showLibraryMapSummary('${safeId}')" title="Show map names, authors, and latest run results">${Number(summary.completedMaps) || 0} / ${Number(wad.totalMaps) || 0} ${escapeHtml(suffix)}</button>`;
}

function hasCompanionTxt(wad) {
  return Boolean(String(wad?.txtMetadataFileName || wad?.txtMetadataFile || '').trim());
}

function renderWadTxtInfoButton(wad) {
  if (!hasCompanionTxt(wad)) return '';
  return `<button class="secondary-button" onclick="window.appActions.showLibraryTxtInfo('${escapeJsString(wad.id)}')">Show TXT</button>`;
}

function buildMapSummaryRows(wad, latestRun) {
  const maps = [...(latestRun?.maps || [])].sort(compareMapSlots);
  const bySlot = new Map(maps.map((map) => [String(map.levelName || '').toUpperCase(), map]));
  const totalMaps = Math.max(Number(wad.totalMaps) || maps.length || 0, maps.length || 0);
  const slots = [];

  for (let index = 1; index <= totalMaps; index += 1) {
    const slot = `MAP${String(index).padStart(2, '0')}`;
    slots.push(bySlot.get(slot) || { levelName: slot, displayName: '', mapAuthor: '' });
  }

  for (const map of maps) {
    const slot = String(map.levelName || '').toUpperCase();
    if (!slots.some((entry) => String(entry.levelName || '').toUpperCase() === slot)) slots.push(map);
  }

  return slots.sort(compareMapSlots);
}

function showLibraryMapSummary(wadId) {
  const wad = state.app.wads.find((entry) => entry.id === wadId);
  if (!wad) return;
  const latestRun = getLatestRun(wad);
  const summary = latestRun ? computeRunSummary(latestRun, wad.totalMaps, wad) : createEmptySummary(wad.totalMaps);
  const rows = buildMapSummaryRows(wad, latestRun).map((map) => {
    const hasAnyResult = Boolean(Number(map.totalkills) || Number(map.totalitems) || Number(map.totalsecrets) || Number(map.leveltime) || Number(map.killcount) || Number(map.itemcount) || Number(map.secretcount));
    const isPlayed = hasAnyResult && !isUnplayedPlaceholderMap(map);
    const resultText = isPlayed
      ? `K ${renderStatValue(map.killcount, map.totalkills)} • I ${renderStatValue(map.itemcount, map.totalitems)} • S ${renderStatValue(map.secretcount, map.totalsecrets)}`
      : 'Unplayed';
    return `
      <tr>
        <td><strong>${escapeHtml(map.levelName || '')}</strong></td>
        <td>${escapeHtml(map.displayName || map.levelName || '')}</td>
        <td>${escapeHtml(map.mapAuthor || '')}</td>
        <td>${escapeHtml(resultText)}</td>
        <td>${escapeHtml(isPlayed ? formatTics(map.leveltime) : '—')}</td>
        <td>${renderMedalBadge(getMedal(map))}</td>
      </tr>`;
  }).join('');

  let dialog = document.getElementById('libraryMapSummaryDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'libraryMapSummaryDialog';
    dialog.className = 'modal';
    document.body.appendChild(dialog);
  }

  dialog.innerHTML = `
    <form method="dialog" class="modal-card library-map-summary-card">
      <div class="modal-head">
        <div>
          <h3>${escapeHtml(wad.title)} — Map Summary</h3>
          <p class="muted">Latest run: ${escapeHtml(latestRun?.name || 'None')} • ${Number(summary.completedMaps) || 0} / ${Number(wad.totalMaps) || 0} maps complete</p>
        </div>
        <button type="submit" class="ghost-button">✕</button>
      </div>
      <div class="table-shell modal-table-shell">
        <table>
          <thead><tr><th>Map</th><th>Name</th><th>Author</th><th>Latest result</th><th>Time</th><th>Medal</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6">No map metadata or runs found.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="modal-actions"><button type="submit" class="primary-button">Close</button></div>
    </form>`;
  dialog.showModal();
}

async function showLibraryTxtInfo(wadId) {
  const wad = state.app.wads.find((entry) => entry.id === wadId);
  if (!wad || !hasCompanionTxt(wad)) return;
  let dialog = document.getElementById('libraryTxtInfoDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'libraryTxtInfoDialog';
    dialog.className = 'modal';
    document.body.appendChild(dialog);
  }

  const fileLabel = wad.txtMetadataFileName || fileNameFromPath(wad.txtMetadataFile || '') || 'Companion TXT';
  dialog.innerHTML = `
    <form method="dialog" class="modal-card library-txt-info-card">
      <div class="modal-head">
        <div>
          <h3>${escapeHtml(wad.title)} — TXT Info</h3>
          <p class="muted">${escapeHtml(fileLabel)}</p>
        </div>
        <button type="submit" class="ghost-button">✕</button>
      </div>
      <pre class="metadata-txt-preview library-txt-preview">Loading companion TXT...</pre>
      <div class="modal-actions"><button type="submit" class="primary-button">Close</button></div>
    </form>`;
  dialog.showModal();

  const previewEl = dialog.querySelector('.library-txt-preview');
  const metadataFolder = getAppSetting('defaultMetadataFolder');
  if (!wad.pwadPath || !metadataFolder) {
    previewEl.textContent = wad.txtMetadataFile
      ? `Known TXT: ${wad.txtMetadataFile}\n\nSet the WAD path and Default metadata TXT folder to read the full file here.`
      : 'Set the WAD path and Default metadata TXT folder to read the full file here.';
    return;
  }

  try {
    const response = await fetch('/api/read-companion-txt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wadPath: wad.pwadPath, metadataFolder, txtPath: wad.txtMetadataFile || "" }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'TXT preview failed.');
    if (!payload.found) {
      previewEl.textContent = `TXT was previously found as ${fileLabel}, but no exact TXT match was found in the current metadata folder.`;
      return;
    }
    previewEl.textContent = payload.content || '(TXT file was empty)';
  } catch (error) {
    console.error(error);
    previewEl.textContent = `${error.message || 'TXT preview failed.'} Make sure local_server.py is running and the metadata folder exists.`;
  }
}

function renderWadLibraryActions(wad) {
  return `
    <div class="control-row library-entry-actions">
      <label class="move-select-label">Move
        <select class="folder-move-select" onchange="window.appActions.moveWadToFolder('${wad.id}', this.value)">
          ${renderFolderOptions(wad.folderId, { includeRoot: true })}
        </select>
      </label>
      ${renderWadTxtInfoButton(wad)}
      <button class="primary-button" onclick="window.appActions.openLaunchDialog('${escapeJsString(wad.id)}')">▶ Play</button>
      <button class="secondary-button" onclick="window.appActions.editWad('${wad.id}')">Edit</button>
      <button class="secondary-button" onclick="window.appActions.openWad('${wad.id}')">Open</button>
      <button class="danger-button" onclick="window.appActions.deleteWad('${wad.id}')">Delete</button>
    </div>`;
}



function matchesLibraryQuickFilters(wad) {
  const filters = getLibraryQuickFilters();
  const latestRun = getLatestRun(wad);
  for (const [key, rawValue] of Object.entries(filters)) {
    const value = normalizeSearchText(rawValue);
    if (!value) continue;
    if (key === 'playState' && normalizeSearchText(wad.playState || 'plan') !== value) return false;
    if (key === 'iwad' && normalizeSearchText(wad.iwad || '') !== value) return false;
    if (key === 'type' && normalizeSearchText(wad.type || '') !== value) return false;
    if (key === 'author' && normalizeSearchText(wad.author || '') !== value) return false;
    if (key === 'sourcePort' && normalizeSearchText(wad.sourcePort || '') !== value) return false;
    if (key === 'tag' && !getWadTags(wad).some((tag) => normalizeSearchText(tag) === value)) return false;
    if (key === 'difficulty') {
      const runs = Array.isArray(wad.runs) ? wad.runs : [];
      const hasMatchingRun = runs.some((run) => normalizeSearchText(run?.difficulty || 'UV') === value)
        || normalizeSearchText(latestRun?.difficulty || 'UV') === value;
      if (!hasMatchingRun) return false;
    }
  }
  return true;
}

function matchesLibrarySearch(wad, rawQuery) {
  const query = normalizeSearchText(rawQuery);
  if (!query) return true;

  const haystackParts = [
    wad.title,
    wad.author,
    ...getWadTags(wad),
    ...(wad.runs || []).flatMap((run) => (run.maps || []).flatMap((map) => [
      map.displayName,
      map.mapAuthor,
    ])),
  ];

  return haystackParts.some((part) => normalizeSearchText(part).includes(query));
}

function normalizeSearchText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}


function restoreLibrarySearchFocus() {
  if (state.currentView !== 'library') return;
  requestAnimationFrame(() => {
    const input = document.getElementById('librarySearchInput');
    if (!input) return;
    input.focus({ preventScroll: true });
    const pos = input.value.length;
    try {
      input.setSelectionRange(pos, pos);
    } catch {
      // Some input types/browsers do not support selection ranges.
    }
  });
}


async function refreshWadMetadataFromDisk() {
  if (!editWadForm) return;
  const wadId = String(editWadForm.elements.wadId?.value || '');
  const wad = state.app.wads.find((entry) => entry.id === wadId);
  if (!wad) {
    showAlert('error', 'Could not find that WAD entry.');
    return;
  }
  const wadPath = wad.pwadPath || wad.iwadPath || '';
  if (!wadPath) {
    showAlert('error', 'This WAD does not have an associated WAD/PK3 path to refresh from.');
    return;
  }
  try {
    const response = await fetch('/api/extract-pwad-metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wadPath,
        iwadField: wad.iwad || getAppSetting('defaultIwadPath') || '',
        iwadFolder: getAppSetting('defaultIwadFolder') || getAppSetting('defaultIwadPath') || '',
        iwadPath: getAppSetting('defaultIwadPath') || '',
        metadataFolder: getAppSetting('defaultMetadataFolder') || '',
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Metadata refresh failed.');

    wad.title = payload.title || wad.title;
    wad.author = payload.author || wad.author || '';
    wad.sourcePort = payload.sourcePort || wad.sourcePort || '';
    wad.iwad = payload.iwad || wad.iwad || '';
    wad.totalMaps = Math.max(1, Number(payload.totalMaps) || Number(wad.totalMaps) || 1);
    wad.type = payload.type || wad.type || autoTypeFromMapCount(wad.totalMaps);
    if (payload.notes) wad.notes = payload.notes;
    wad.metadataSource = payload.metadataSource || wad.metadataSource || '';
    wad.txtMetadataFileName = payload.txtMetadataFileName || wad.txtMetadataFileName || '';
    wad.txtMetadataFile = payload.txtMetadataFile || wad.txtMetadataFile || '';
    if (payload.titlePicDataUrl) {
      const saved = await saveManagedTitlepic(wad, payload.titlePicDataUrl);
      wad.titlePicFileName = saved.titlePicFileName || '';
      wad.titlePicPath = saved.titlePicPath || '';
      delete wad.titlePicDataUrl;
    }

    const refreshedMaps = Array.isArray(payload.maps) ? payload.maps.filter((entry) => entry && entry.levelName) : [];
    if (refreshedMaps.length) {
      const run = getMetadataRefreshRun(wad);
      mergeRefreshedMetadataMaps(run, refreshedMaps, payload.metadataSource || 'metadata');
      wad.selectedRunId = run.id;
      wad.totalMaps = refreshedMaps.length;
      wad.type = payload.type || autoTypeFromMapCount(refreshedMaps.length);
    }

    wad.updatedAt = new Date().toISOString();
    await saveState();
    openEditWadDialog(wad.id);
    showAlert('success', `Refreshed metadata and map names for ${wad.title}.`);
    render();
  } catch (error) {
    console.error(error);
    showAlert('error', error.message || 'Metadata refresh failed.');
  }
}

function autoTypeFromMapCount(count) {
  const n = Number(count) || 1;
  if (n <= 1) return 'single';
  if (n <= 7) return 'multiple';
  if (n <= 14) return 'episode';
  return 'megawad';
}


function getMetadataRefreshRun(wad) {
  if (!wad) return null;
  if (!Array.isArray(wad.runs)) wad.runs = [];
  let run = getLatestRun(wad);
  if (!run) {
    run = createRun('Metadata Refresh');
    wad.runs.push(run);
  }
  return run;
}

function mergeRefreshedMetadataMaps(run, maps, sourceType = 'metadata') {
  if (!run || !Array.isArray(maps)) return;
  if (!Array.isArray(run.maps)) run.maps = [];
  const byLevel = new Map(run.maps.map((map) => [String(map.levelName || '').toUpperCase(), map]));
  const refreshed = maps.map((entry) => {
    const level = String(entry.levelName || '').toUpperCase();
    const existing = byLevel.get(level);
    if (existing) {
      existing.displayName = String(entry.displayName || existing.displayName || level).trim();
      existing.mapAuthor = String(entry.mapAuthor || existing.mapAuthor || '').trim();
      existing.sourceType = existing.sourceType === 'manual' ? 'edited' : String(sourceType || 'metadata').toLowerCase();
      return existing;
    }
    return createMetadataPlaceholderMap(entry, sourceType);
  });
  run.maps = refreshed;
  sortRunMaps(run);
}

function openEditWadDialog(wadId) {
  const wad = state.app.wads.find((entry) => entry.id === wadId);
  if (!wad || !editWadForm || !editWadDialog) return;

  editWadForm.reset();
  editWadForm.elements.wadId.value = wad.id;
  editWadForm.elements.title.value = wad.title || '';
  editWadForm.elements.author.value = wad.author || '';
  editWadForm.elements.sourcePort.value = wad.sourcePort || '';
  editWadForm.elements.totalMaps.value = Math.max(1, Number(wad.totalMaps) || 1);
  editWadForm.elements.type.value = wad.type || 'megawad';
  editWadForm.elements.iwad.value = wad.iwad || '';
  editWadForm.elements.notes.value = wad.notes || '';
  if (editWadForm.elements.tags) editWadForm.elements.tags.value = getWadTags(wad).join(', ');
  if (editWadForm.elements.createMissingFolders) editWadForm.elements.createMissingFolders.checked = false;
  if (editWadForm.elements.excludeFromRefreshAll) editWadForm.elements.excludeFromRefreshAll.checked = wad.excludeFromRefreshAll === true;
  editWadDialog.showModal();
}

function renderPlayStateOptions(selected) {
  return [
    ['plan', 'Plan to Play'],
    ['current', 'Currently Playing'],
    ['hold', 'On Hold'],
    ['dropped', 'Dropped'],
    ['completed', 'Completed'],
  ].map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
}

function renderDifficultyOptions(selected) {
  return ['ITYTD', 'HNTR', 'HMP', 'UV', 'Nightmare', 'Custom'].map((value) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${value}</option>`).join('');
}


function skillFlagToDifficulty(skill) {
  const normalized = String(skill ?? '').trim();
  return ({
    '0': 'ITYTD',
    '1': 'HNTR',
    '2': 'HMP',
    '3': 'UV',
    '4': 'Nightmare',
  })[normalized] || '';
}

function getMapDifficulty(map, run) {
  return String(map?.difficulty || run?.difficulty || 'UV');
}


function pathJoinClient(base, child) {
  const root = String(base || '').trim().replace(/[\\/]+$/, '');
  const name = String(child || '').trim().replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
  if (!root || !name) return '';
  return root + (root.includes('\\') && !root.includes('/') ? '\\' : '/') + name;
}

function wadTitleFolderName(wadOrTitle) {
  const value = typeof wadOrTitle === 'string' ? wadOrTitle : wadOrTitle?.title;
  return clientSafeSlug(value || 'wad', 'wad');
}

function wadAdditionalFolderName(wad, metadata = null) {
  const fileName = String(metadata?.fileName || wad?.pwadFileName || fileNameFromPath(wad?.pwadPath) || wad?.iwadFileName || fileNameFromPath(wad?.iwadPath) || wad?.title || 'wad');
  const stem = fileName.replace(/\.(wad|pk3|pk7)$/i, '');
  return clientSafeSlug(stem, 'wad');
}

function isUnsetOrRootFolder(currentValue, rootValue) {
  const current = normalizePathForCompare(currentValue);
  const root = normalizePathForCompare(rootValue);
  return !current || (!!root && current === root);
}

function applyAutoFolderPathsToWad(wad, { metadata = null, onlyWhenUnset = true } = {}) {
  const settings = normalizeImportedSettings(state.app?.settings || {});
  const titleFolder = wadTitleFolderName(wad);
  const additionalFolder = wadAdditionalFolderName(wad, metadata);
  const targets = [];

  const maybeSet = (field, root, folderName, label) => {
    const target = pathJoinClient(root, folderName);
    if (!target) return;
    if (!onlyWhenUnset || isUnsetOrRootFolder(wad[field], root)) {
      wad[field] = target;
      targets.push({ label, path: target });
    }
  };

  maybeSet('saveFolderPath', settings.defaultRootSaveFolder, titleFolder, 'Save folder');
  maybeSet('screenshotFolderPath', settings.defaultScreenshotFolder, titleFolder, 'Screenshot folder');
  maybeSet('additionalFilesPath', settings.additionalFilesFolder, additionalFolder, 'Additional files folder');
  return targets;
}

async function createFoldersForWadIfRequested(wad, options = {}) {
  const targets = applyAutoFolderPathsToWad(wad, options);
  if (!targets.length) return { created: [], existing: [], skipped: [] };
  const response = await fetch('/api/create-folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folders: targets }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Folder creation failed.');
  return payload;
}

function summarizeFolderCreation(payload) {
  const created = Array.isArray(payload?.created) ? payload.created.length : 0;
  const existing = Array.isArray(payload?.existing) ? payload.existing.length : 0;
  const skipped = Array.isArray(payload?.skipped) ? payload.skipped.length : 0;
  const parts = [];
  if (created) parts.push(`${created} created`);
  if (existing) parts.push(`${existing} already existed`);
  if (skipped) parts.push(`${skipped} skipped`);
  return parts.length ? ` Folders: ${parts.join(', ')}.` : '';
}

function playStateLabel(value) {
  return ({
    plan: 'Plan to Play',
    current: 'Currently Playing',
    hold: 'On Hold',
    dropped: 'Dropped',
    completed: 'Completed',
  })[value] || 'Plan to Play';
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function formatTics(tics) {
  const totalSeconds = Math.floor((Number(tics) || 0) / 35);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatTicsForInput(tics) {
  return formatTics(tics || 0);
}

function parseLevelTimeInput(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 0;

  const ticsMatch = raw.match(/^(\d+(?:\.\d+)?)\s*(?:t|tic|tics)$/);
  if (ticsMatch) return Math.max(0, Math.round(Number(ticsMatch[1]) || 0));

  const minutesMatch = raw.match(/^(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)$/);
  if (minutesMatch) return Math.max(0, Math.round((Number(minutesMatch[1]) || 0) * 60 * 35));

  const secondsMatch = raw.match(/^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)$/);
  if (secondsMatch) return Math.max(0, Math.round((Number(secondsMatch[1]) || 0) * 35));

  if (raw.includes(':')) {
    const parts = raw.split(':').map((part) => part.trim());
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => part === '' || Number.isNaN(Number(part)))) {
      throw new Error('Level time must look like 7:32, 1:02:15, 452s, or 15820 tics.');
    }
    const numbers = parts.map(Number);
    const totalSeconds = parts.length === 3
      ? (numbers[0] * 3600) + (numbers[1] * 60) + numbers[2]
      : (numbers[0] * 60) + numbers[1];
    return Math.max(0, Math.round(totalSeconds * 35));
  }

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    return Math.max(0, Math.round((Number(raw) || 0) * 35));
  }

  throw new Error('Level time must look like 7:32, 1:02:15, 452s, or 15820 tics.');
}

function updateLevelTimePreview() {
  const input = mapForm?.elements?.leveltime;
  const hint = document.getElementById('timeComputed');
  if (!input || !hint) return;
  try {
    const tics = parseLevelTimeInput(input.value);
    hint.textContent = `= ${tics} tics (${formatTics(tics)})`;
  } catch {
    hint.textContent = '= invalid time';
  }
}

function formatDate(value) {
  return new Date(value).toLocaleDateString();
}

function sourceLabel(sourceType) {
  if (sourceType === 'edited') return 'Imported + Edited';
  if (sourceType === 'metadata') return 'UMAPINFO';
  if (sourceType === 'dehacked') return 'DEHACKED';
  if (sourceType === 'mapinfo') return 'MAPINFO';
  return capitalize(sourceType || 'manual');
}

function getCurrentWad() {
  return state.app.wads.find((wad) => wad.id === state.currentWadId) || null;
}

function getLatestRun(wad) {
  if (!wad.runs.length) return null;
  if (wad.selectedRunId) return wad.runs.find((run) => run.id === wad.selectedRunId) || wad.runs[wad.runs.length - 1];
  return wad.runs[wad.runs.length - 1];
}

function getSelectedRunIdForWad(wadId) {
  const selector = document.getElementById('runSelector');
  if (selector && selector.value) return selector.value;
  const wad = state.app.wads.find((entry) => String(entry.id) === String(wadId));
  return wad?.selectedRunId || getLatestRun(wad)?.id || '';
}

function getSelectedRunForWad(wadId) {
  const wad = state.app.wads.find((entry) => String(entry.id) === String(wadId));
  if (!wad) return null;
  const runId = getSelectedRunIdForWad(wadId);
  return wad.runs.find((entry) => String(entry.id) === String(runId)) || getLatestRun(wad);
}


async function handleDatabaseImport(event) {
  const file = event.target?.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const incomingApp = parsed?.app ?? parsed;
    state.app = normalizeImportedAppState(incomingApp);
    saveState();
    state.currentWadId = state.app.wads[0]?.id || null;
    state.currentView = 'library';
    state.libraryFilter = 'all';
    state.librarySearch = '';
    applyAppSettingsToUiState();
    state.currentFolderId = null;
    showAlert('success', `Imported database from ${file.name}.`);
    render();
  } catch (error) {
    console.error(error);
    showAlert('error', error?.message || 'Database import failed.');
  } finally {
    if (event.target) event.target.value = '';
  }
}

function exportDatabase() {
  const payload = {
    app: state.app,
    exportedAt: new Date().toISOString(),
    appName: 'Doom Entryway',
    version: APP_VERSION,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z');
  anchor.href = url;
  anchor.download = `doom-run-tracker-backup-${stamp}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showAlert('success', 'Database exported.');
}

function ensureFolderState() {
  if (!state.app || typeof state.app !== 'object') state.app = { wads: [], folders: [] };
  if (!Array.isArray(state.app.wads)) state.app.wads = [];
  if (!Array.isArray(state.app.folders)) state.app.folders = [];
  state.app.folders = normalizeImportedFolders(state.app.folders);
  const validIds = new Set(state.app.folders.map((folder) => folder.id));
  state.app.wads.forEach((wad) => {
    wad.folderId = validIds.has(wad.folderId) ? wad.folderId : null;
  });
}

function normalizeImportedFolders(folders) {
  const source = Array.isArray(folders) ? folders : [];
  const normalized = source.map((folder) => ({
    id: String(folder?.id || crypto.randomUUID()),
    name: String(folder?.name || 'New Folder').trim() || 'New Folder',
    parentId: normalizeFolderId(folder?.parentId),
    createdAt: folder?.createdAt || new Date().toISOString(),
  }));
  const ids = new Set(normalized.map((folder) => folder.id));
  normalized.forEach((folder) => {
    if (folder.parentId && (!ids.has(folder.parentId) || folder.parentId === folder.id)) folder.parentId = null;
  });
  return normalized;
}

function normalizeFolderId(value) {
  const text = String(value || '').trim();
  return text && text !== 'root' && text !== 'null' ? text : null;
}

function getFolderById(folderId) {
  const id = normalizeFolderId(folderId);
  if (!id) return null;
  if (!state.app?.folders) return null;
  return state.app.folders.find((folder) => folder.id === id) || null;
}

function getChildFolders(parentId) {
  const normalizedParentId = normalizeFolderId(parentId);
  return (state.app.folders || [])
    .filter((folder) => normalizeFolderId(folder.parentId) === normalizedParentId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getFolderAncestors(folderId) {
  const chain = [];
  let current = getFolderById(folderId);
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    chain.unshift(current);
    seen.add(current.id);
    current = getFolderById(current.parentId);
  }
  return chain;
}

function getDescendantFolderIds(folderId) {
  const ids = [];
  const walk = (parentId) => {
    for (const child of getChildFolders(parentId)) {
      ids.push(child.id);
      walk(child.id);
    }
  };
  walk(folderId);
  return ids;
}

function getCurrentFolderName() {
  return state.currentFolderId ? getFolderById(state.currentFolderId)?.name || 'Folder' : 'Root Library';
}

function getFolderPathLabel(folderId) {
  const chain = getFolderAncestors(folderId);
  return chain.length ? `Root / ${chain.map((folder) => folder.name).join(' / ')}` : 'Root';
}

function renderFolderBreadcrumb() {
  const chain = getFolderAncestors(state.currentFolderId);
  const rootClass = state.currentFolderId ? '' : 'active';
  return `<button class="breadcrumb-button ${rootClass}" onclick="window.appActions.openFolder(null)">root</button>` + chain.map((folder) => {
    const active = folder.id === state.currentFolderId ? 'active' : '';
    return `<span class="breadcrumb-separator">/</span><button class="breadcrumb-button ${active}" onclick="window.appActions.openFolder('${folder.id}')">${escapeHtml(folder.name)}</button>`;
  }).join('');
}

function renderFolderOptions(selectedFolderId, options = {}) {
  const selected = normalizeFolderId(selectedFolderId);
  const includeRoot = options.includeRoot !== false;
  const rows = [];
  if (includeRoot) rows.push(`<option value="root" ${selected ? '' : 'selected'}>Root</option>`);
  const walk = (parentId, depth) => {
    for (const folder of getChildFolders(parentId)) {
      const indent = '— '.repeat(depth);
      rows.push(`<option value="${folder.id}" ${folder.id === selected ? 'selected' : ''}>${indent}${escapeHtml(folder.name)}</option>`);
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows.join('');
}


function normalizeImportedAppState(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('That backup file is not valid JSON for this app.');
  }

  const importedWads = Array.isArray(value.wads) ? value.wads : [];
  const settings = normalizeImportedSettings(value.settings || {});
  return {
    wads: importedWads.map(normalizeImportedWad),
    folders: normalizeImportedFolders(value.folders || []),
    settings,
  };
}

function normalizeImportedSettings(settings) {
  const mode = settings?.libraryViewMode === 'compact' ? 'compact' : 'card';
  const density = Math.min(900, Math.max(520, Number(settings?.libraryDensity) || 680));
  const sortKey = LIBRARY_SORT_OPTIONS.some((option) => option.key === settings?.librarySortKey) ? settings.librarySortKey : 'title';
  const sortDirection = settings?.librarySortDirection === 'desc' ? 'desc' : 'asc';
  const boolSetting = (key, fallback = false) => {
    const value = settings?.[key];
    if (value === true || value === 'true' || value === 1 || value === '1' || value === 'on') return true;
    if (value === false || value === 'false' || value === 0 || value === '0' || value === 'off') return false;
    return fallback;
  };
  const deleteAssociatedFilesOnWadDelete = boolSetting('deleteAssociatedFilesOnWadDelete', false);
  const webdavEnabled = boolSetting('webdavEnabled', false);
  const webdavVerifySsl = boolSetting('webdavVerifySsl', true);
  return {
    libraryViewMode: mode,
    libraryDensity: density,
    librarySortKey: sortKey,
    librarySortDirection: sortDirection,
    defaultRootSaveFolder: String(settings?.defaultRootSaveFolder || '').trim(),
    defaultPwadPath: String(settings?.defaultPwadPath || '').trim(),
    defaultMetadataFolder: String(settings?.defaultMetadataFolder || '').trim(),
    defaultTitlepicsFolder: String(settings?.defaultTitlepicsFolder || '').trim(),
    defaultScreenshotFolder: String(settings?.defaultScreenshotFolder || '').trim(),
    defaultIwadPath: String(settings?.defaultIwadPath || '').trim(),
    defaultIwadFolder: String(settings?.defaultIwadFolder || settings?.defaultIwadPath || '').trim(),
    gameExecutable: String(settings?.gameExecutable || '').trim(),
    modsFolder: String(settings?.modsFolder || '').trim(),
    additionalFilesFolder: String(settings?.additionalFilesFolder || '').trim(),
    defaultMods: normalizeDefaultMods(settings?.defaultMods),
    webdavEnabled,
    webdavUrl: String(settings?.webdavUrl || '').trim(),
    webdavRemotePath: String(settings?.webdavRemotePath || '').trim(),
    webdavUsername: String(settings?.webdavUsername || '').trim(),
    webdavPassword: String(settings?.webdavPassword || ''),
    webdavVerifySsl,
    webdavHashCheckBeforeOverwrite: boolSetting('webdavHashCheckBeforeOverwrite', false),
    checkMissingDeletedFilesOnRefreshAll: boolSetting('checkMissingDeletedFilesOnRefreshAll', false),
    syncSaves: boolSetting('syncSaves', true),
    syncPwads: boolSetting('syncPwads', true),
    syncIwads: boolSetting('syncIwads', true),
    syncMetadataTxt: boolSetting('syncMetadataTxt', true),
    syncTitlepics: boolSetting('syncTitlepics', true),
    syncScreenshots: boolSetting('syncScreenshots', true),
    syncMods: boolSetting('syncMods', true),
    syncAdditionalFiles: boolSetting('syncAdditionalFiles', true),
    syncDatabase: boolSetting('syncDatabase', true),
    deleteAssociatedFilesOnWadDelete,
    webdavDeletedFiles: Array.isArray(settings?.webdavDeletedFiles) ? settings.webdavDeletedFiles.filter((entry) => entry && typeof entry === 'object' && entry.remote).map((entry) => ({ remote: String(entry.remote), deletedAt: String(entry.deletedAt || '') })) : [],
    webdavMovedFiles: Array.isArray(settings?.webdavMovedFiles) ? settings.webdavMovedFiles.filter((entry) => entry && typeof entry === 'object' && entry.from && entry.to).map((entry) => ({ from: String(entry.from), to: String(entry.to), movedAt: String(entry.movedAt || '') })) : [],
  };
}

function getAppSetting(key) {
  const settings = normalizeImportedSettings(state.app?.settings || {});
  state.app.settings = settings;
  return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : '';
}

function getLaunchFolderSetting(key) {
  const settings = normalizeImportedSettings(state.app?.settings || {});
  state.app.settings = settings;
  if (key === 'modsFolder') {
    return String(settings.modsFolder || settings.globalModsFolder || settings.modFolder || settings.modsPath || '').trim();
  }
  if (key === 'additionalFilesFolder') {
    return String(settings.additionalFilesFolder || settings.additionalFilesRoot || settings.additionalFilesPath || settings.additionalFiles || '').trim();
  }
  return String(settings[key] || '').trim();
}

function applyAppSettingsToUiState() {
  const settings = normalizeImportedSettings(state.app?.settings || {});
  state.libraryViewMode = settings.libraryViewMode;
  state.libraryDensity = settings.libraryDensity;
  state.librarySortKey = settings.librarySortKey;
  state.librarySortDirection = settings.librarySortDirection;
  state.app.settings = settings;
}

function persistLibraryViewSettings() {
  if (!state.app || typeof state.app !== 'object') state.app = { wads: [], folders: [], settings: {} };
  state.app.settings = normalizeImportedSettings({
    ...(state.app.settings || {}),
    libraryViewMode: state.libraryViewMode,
    libraryDensity: state.libraryDensity,
    librarySortKey: state.librarySortKey,
    librarySortDirection: state.librarySortDirection,
  });
  saveState();
}

function normalizeImportedWad(wad) {
  const normalized = {
    id: String(wad?.id || crypto.randomUUID()),
    title: String(wad?.title || 'Untitled WAD').trim(),
    type: String(wad?.type || 'megawad'),
    author: String(wad?.author || '').trim(),
    iwad: String(wad?.iwad || '').trim(),
    sourcePort: String(wad?.sourcePort || '').trim(),
    saveFolderPath: String(wad?.saveFolderPath || '').trim(),
    screenshotFolderPath: String(wad?.screenshotFolderPath || '').trim(),
    additionalFilesPath: String(wad?.additionalFilesPath || '').trim(),
    screenshots: Array.isArray(wad?.screenshots) ? wad.screenshots.map(normalizeImportedScreenshot) : [],
    pwadPath: String(wad?.pwadPath || '').trim(),
    pwadFileName: String(wad?.pwadFileName || '').trim(),
    pwadRelativePath: String(wad?.pwadRelativePath || '').trim(),
    fileKind: String(wad?.fileKind || '').trim(),
    metadataSource: String(wad?.metadataSource || '').trim(),
    txtMetadataFile: String(wad?.txtMetadataFile || '').trim(),
    txtMetadataFileName: String(wad?.txtMetadataFileName || '').trim(),
    iwadPath: String(wad?.iwadPath || '').trim(),
    totalMaps: Math.max(1, Number(wad?.totalMaps) || 1),
    notes: String(wad?.notes || '').trim(),
    tags: parseTags(wad?.tags),
    playState: String(wad?.playState || 'plan'),
    excludeFromRefreshAll: wad?.excludeFromRefreshAll === true || wad?.excludeFromRefreshAll === 'true' || wad?.excludeFromRefreshAll === 1 || wad?.excludeFromRefreshAll === '1',
    titlePicDataUrl: typeof wad?.titlePicDataUrl === 'string' ? wad.titlePicDataUrl : '',
    titlePicFileName: typeof wad?.titlePicFileName === 'string' ? wad.titlePicFileName : '',
    titlePicPath: typeof wad?.titlePicPath === 'string' ? wad.titlePicPath : '',
    updatedAt: typeof wad?.updatedAt === 'string' ? wad.updatedAt : '',
    lastSaveFileName: typeof wad?.lastSaveFileName === 'string' ? wad.lastSaveFileName : '',
    lastSaveFilePath: typeof wad?.lastSaveFilePath === 'string' ? wad.lastSaveFilePath : '',
    lastSaveModifiedTime: Number(wad?.lastSaveModifiedTime) || 0,
    lastPlayedAt: typeof wad?.lastPlayedAt === 'string' ? wad.lastPlayedAt : '',
    folderId: normalizeFolderId(wad?.folderId),
    createdAt: wad?.createdAt || new Date().toISOString(),
    runs: Array.isArray(wad?.runs) && wad.runs.length ? wad.runs.map(normalizeImportedRun) : [createRun('Default Run')],
  };

  const selectedRunId = String(wad?.selectedRunId || '');
  normalized.selectedRunId = normalized.runs.some((run) => run.id === selectedRunId)
    ? selectedRunId
    : normalized.runs[0].id;

  normalized.iwadScanKey = typeof wad?.iwadScanKey === 'string' ? wad.iwadScanKey : '';
  normalized.iwadFileName = typeof wad?.iwadFileName === 'string' ? wad.iwadFileName : '';
  normalized.launcherSettings = normalizeLauncherSettings(wad?.launcherSettings || wad?.launchSettings || {});

  return normalized;
}

function normalizeLauncherSettings(value = {}) {
  return {
    selectedMods: Array.isArray(value?.selectedMods) ? value.selectedMods.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
    selectedAdditionalFiles: Array.isArray(value?.selectedAdditionalFiles) ? value.selectedAdditionalFiles.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
    sectionOrder: normalizeLaunchSectionOrder(value?.sectionOrder),
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : '',
  };
}

function saveLauncherSettingsForWad(wadId, { persist = false } = {}) {
  const wad = state.app?.wads?.find((entry) => entry.id === wadId);
  const launchState = state.launchDialog;
  if (!wad || !launchState || launchState.wadId !== wadId) return;
  wad.launcherSettings = normalizeLauncherSettings({
    selectedMods: launchState.selectedMods || [],
    selectedAdditionalFiles: launchState.selectedAdditionalFiles || [],
    sectionOrder: launchState.sectionOrder || ['map', 'additional', 'mods'],
    updatedAt: new Date().toISOString(),
  });
  wad.updatedAt = new Date().toISOString();
  if (persist) saveState();
}

function normalizeImportedScreenshot(shot) {
  const filePath = String(shot?.filePath || '').trim();
  return {
    fileName: String(shot?.fileName || filePath.split(/[\/]/).pop() || '').trim(),
    filePath,
    modifiedTime: Number(shot?.modifiedTime) || 0,
    sizeBytes: Number(shot?.sizeBytes) || 0,
    mimeType: String(shot?.mimeType || 'image/png'),
  };
}

function normalizeImportedRun(run) {
  const normalized = {
    id: String(run?.id || crypto.randomUUID()),
    name: String(run?.name || 'Default Run').trim() || 'Default Run',
    mode: String(run?.mode || 'Continuous'),
    difficulty: String(run?.difficulty || 'UV'),
    mods: String(run?.mods || '').trim(),
    createdAt: run?.createdAt || new Date().toISOString(),
    maps: Array.isArray(run?.maps) ? run.maps.map(normalizeImportedMap) : [],
  };

  sortRunMaps(normalized);
  return normalized;
}

function normalizeImportedMap(map) {
  const levelName = String(map?.levelName || '').trim() || 'MAP01';
  return {
    id: String(map?.id || crypto.randomUUID()),
    levelName,
    displayName: String(map?.displayName || '').trim() || levelName,
    mapAuthor: String(map?.mapAuthor || '').trim(),
    killcount: Math.max(0, Number(map?.killcount) || 0),
    totalkills: Math.max(0, Number(map?.totalkills) || 0),
    itemcount: Math.max(0, Number(map?.itemcount) || 0),
    totalitems: Math.max(0, Number(map?.totalitems) || 0),
    secretcount: Math.max(0, Number(map?.secretcount) || 0),
    totalsecrets: Math.max(0, Number(map?.totalsecrets) || 0),
    leveltime: Math.max(0, Number(map?.leveltime) || 0),
    deaths: Math.max(0, Number(map?.deaths) || 0),
    difficulty: String(map?.difficulty || '').trim(),
    sourceType: String(map?.sourceType || 'manual'),
    saveFileName: String(map?.saveFileName || '').trim(),
    notes: String(map?.notes || '').trim(),
    createdAt: map?.createdAt || new Date().toISOString(),
    updatedAt: map?.updatedAt || new Date().toISOString(),
  };
}

function showAlert(type, message) {
  state.alerts = [{ id: crypto.randomUUID(), type, message }];
  renderAlerts();
  setTimeout(() => {
    state.alerts = [];
    renderAlerts();
  }, 4000);
}

async function loadState() {
  try {
    const response = await fetch(DATABASE_API, { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not load local database.');

    state.app = normalizeImportedAppState(payload.app || payload);
    applyAppSettingsToUiState();
    state.databaseReady = true;

    // Server JSON is the only main database path now.
    // Do not auto-read old browser localStorage, because Firefox can make it look like
    // the app is still using browser storage instead of doom_tracker_database.json.
  } catch (error) {
    console.error(error);
    state.app = { wads: [], folders: [], settings: normalizeImportedSettings({}) };
    applyAppSettingsToUiState();
    state.databaseReady = false;
    showAlert('error', 'Could not load doom_tracker_database.json from the local server. Make sure you opened the app through local_server.py.');
  }
}


function mergeDeathCountsFromExternalAppState(externalApp) {
  const externalWads = Array.isArray(externalApp?.wads) ? externalApp.wads : [];
  const localWads = Array.isArray(state.app?.wads) ? state.app.wads : [];
  let preserved = 0;

  for (const localWad of localWads) {
    const externalWad = externalWads.find((entry) => String(entry?.id || '') === String(localWad?.id || ''));
    if (!externalWad) continue;

    const localRuns = Array.isArray(localWad.runs) ? localWad.runs : [];
    const externalRuns = Array.isArray(externalWad.runs) ? externalWad.runs : [];

    for (let runIndex = 0; runIndex < localRuns.length; runIndex += 1) {
      const localRun = localRuns[runIndex];
      const externalRun = externalRuns.find((entry) => String(entry?.id || '') === String(localRun?.id || '')) || externalRuns[runIndex];
      if (!externalRun) continue;

      if (!Array.isArray(localRun.maps)) localRun.maps = [];
      const externalMaps = Array.isArray(externalRun.maps) ? externalRun.maps : [];

      for (const externalMap of externalMaps) {
        const externalDeaths = Math.max(0, Number(externalMap?.deaths) || 0);
        if (!externalDeaths) continue;

        const externalLevel = String(externalMap?.levelName || '').trim().toUpperCase();
        if (!externalLevel) continue;

        let localMap = localRun.maps.find((map) => String(map?.levelName || '').trim().toUpperCase() === externalLevel);
        if (!localMap) {
          localRun.maps.push(normalizeImportedMap(externalMap));
          preserved += externalDeaths;
          continue;
        }

        const localDeaths = Math.max(0, Number(localMap.deaths) || 0);
        if (externalDeaths > localDeaths) {
          localMap.deaths = externalDeaths;
          localMap.updatedAt = externalMap.updatedAt || new Date().toISOString();
          if (externalMap.notes && !String(localMap.notes || '').includes(String(externalMap.notes))) {
            localMap.notes = String(localMap.notes || '')
              ? `${String(localMap.notes || '')}\n${String(externalMap.notes || '')}`.slice(-1000)
              : String(externalMap.notes || '');
          }
          preserved += externalDeaths - localDeaths;
        }
      }
    }
  }

  return preserved;
}

async function preserveLiveDeathCountsBeforeSave() {
  try {
    const response = await fetch(DATABASE_API, { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return 0;
    const externalApp = payload.app || payload;
    return mergeDeathCountsFromExternalAppState(externalApp);
  } catch (error) {
    console.warn('Could not pre-merge live death counts before saving.', error);
    return 0;
  }
}

async function saveState() {
  try {
    await preserveLiveDeathCountsBeforeSave();
    const response = await fetch(DATABASE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: state.app, version: APP_VERSION }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not save local database.');
    if (payload.app) {
      state.app = normalizeImportedAppState(payload.app);
      applyAppSettingsToUiState();
    }
    state.databaseReady = true;
  } catch (error) {
    console.error(error);
    state.databaseReady = false;
    showAlert('error', 'Database save failed. Check the local server terminal.');
  }
}

function escapeHtml(value) {
  return String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');
}

function capitalize(value) {
  const text = String(value || '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}


async function testWebdavConnectionFromSettings() {
  const form = document.getElementById('settingsForm');
  const resultEl = document.getElementById('webdavTestResult');
  if (!form) return;
  const formData = new FormData(form);
  const payload = {
    webdavUrl: String(formData.get('webdavUrl') || '').trim(),
    webdavRemotePath: String(formData.get('webdavRemotePath') || '').trim(),
    webdavUsername: String(formData.get('webdavUsername') || '').trim(),
    webdavPassword: String(formData.get('webdavPassword') || ''),
    webdavVerifySsl: formData.get('webdavVerifySsl') === 'on',
  };
  if (!payload.webdavUrl) {
    showAlert('error', 'Enter a WebDAV server URL first.');
    if (resultEl) resultEl.textContent = 'Missing WebDAV server URL.';
    return;
  }
  if (resultEl) {
    resultEl.textContent = 'Testing WebDAV connection...';
    resultEl.className = 'field-help';
  }
  try {
    const response = await fetch('/api/test-webdav', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'WebDAV test failed.');
    const message = `WebDAV connection OK (${data.method || 'PROPFIND'} ${data.status || 200}). ${data.url || ''}`;
    if (resultEl) {
      resultEl.textContent = message;
      resultEl.className = 'field-help success-text';
    }
    showAlert('success', 'WebDAV connection test succeeded.');
  } catch (error) {
    const message = error?.message || String(error);
    if (resultEl) {
      resultEl.textContent = `WebDAV connection failed: ${message}`;
      resultEl.className = 'field-help warning-text';
    }
    showAlert('error', `WebDAV connection failed: ${message}`);
  }
}



const SYNC_ROOTS = {
  saves: 'Saves',
  screenshots: 'Screenshots',
  pwads: 'PWADs',
  iwads: 'IWADs',
  metadata: 'Metadata',
  titlepics: 'Titlepics',
  database: 'Database',
};

function clientSafeSlug(value, fallback = 'wad') {
  const slug = String(value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 80);
  return slug || fallback;
}

function clientWadSyncSlug(wad) {
  return clientSafeSlug(wad?.title || wad?.pwadFileName || wad?.iwadFileName || wad?.id || 'wad', 'wad');
}

function fileNameFromPath(value) {
  return String(value || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function addWebdavDeleteTombstone(remotePath) {
  const remote = String(remotePath || '').replace(/^\/+/, '');
  if (!remote) return;
  const settings = state.app.settings || (state.app.settings = {});
  const list = Array.isArray(settings.webdavDeletedFiles) ? settings.webdavDeletedFiles : [];
  if (!list.some((entry) => String(entry?.remote || '') === remote)) {
    list.push({ remote, deletedAt: new Date().toISOString() });
  }
  settings.webdavDeletedFiles = list;
}

function tombstoneScreenshot(wad, filePath) {
  const name = fileNameFromPath(filePath);
  if (wad && name) addWebdavDeleteTombstone(`${SYNC_ROOTS.screenshots}/${clientWadSyncSlug(wad)}/${name}`);
}

function tombstoneTitlepic(fileName) {
  const name = fileNameFromPath(fileName);
  if (name) addWebdavDeleteTombstone(`${SYNC_ROOTS.titlepics}/${name}`);
}

function tombstoneWadFiles(wad) {
  if (!wad) return;
  const wadPath = wad.pwadPath || wad.iwadPath || '';
  const wadName = fileNameFromPath(wadPath);
  if (wadName) addWebdavDeleteTombstone(`${wad.pwadPath ? SYNC_ROOTS.pwads : SYNC_ROOTS.iwads}/${wadName}`);
  const txtName = fileNameFromPath(wad.pwadFileName || wad.iwadFileName || wadPath).replace(/\.[^.]+$/, '.txt');
  if (txtName) addWebdavDeleteTombstone(`${SYNC_ROOTS.metadata}/${txtName}`);
  if (wad.titlePicFileName) tombstoneTitlepic(wad.titlePicFileName);
}
async function runWebdavOneWaySync(forceUpload = false) {
  const settings = normalizeImportedSettings(state.app?.settings || {});
  if (!settings.webdavEnabled) {
    showAlert('error', 'Enable WebDAV sync settings first.');
    showView('settings');
    setTimeout(() => window.appActions.showSettingsTab('webdav'), 0);
    return;
  }
  if (!settings.webdavUrl) {
    showAlert('error', 'Set a WebDAV server URL first.');
    showView('settings');
    setTimeout(() => window.appActions.showSettingsTab('webdav'), 0);
    return;
  }
  const syncButton = document.getElementById('syncButton');
  const oldText = syncButton?.textContent;
  if (syncButton) {
    syncButton.disabled = true;
    syncButton.textContent = 'Syncing...';
  }
  showAlert('success', forceUpload ? 'WebDAV force upload started...' : 'WebDAV two-way sync started...');
  try {
    // Save current in-memory settings/database first so the server syncs the latest state.
    await saveState();
    const response = await fetch('/api/webdav-sync-one-way', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings, forceUpload }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok && !payload.summary) throw new Error(payload.error || 'WebDAV sync failed.');
    if (payload.app) {
      state.app = normalizeImportedAppState(payload.app);
      applyAppSettingsToUiState();
    }
    showWebdavSyncResults(payload);
    const summary = payload.summary || {};
    if ((summary.errors || 0) > 0) {
      showAlert('error', `Sync finished with ${summary.errors || 0} error(s). Uploaded ${summary.uploaded || 0}, downloaded ${summary.downloaded || 0}, deleted ${summary.deletedRemote || 0}, skipped ${summary.skipped || 0}.`);
    } else {
      showAlert('success', `Sync complete. Uploaded ${summary.uploaded || 0}, downloaded ${summary.downloaded || 0}, deleted ${summary.deletedRemote || 0}, skipped ${summary.skipped || 0}.`);
    }
    render();
  } catch (error) {
    console.error(error);
    showAlert('error', error?.message || 'WebDAV sync failed.');
  } finally {
    if (syncButton) {
      syncButton.disabled = false;
      syncButton.textContent = oldText || 'Sync';
    }
  }
}


async function forceUploadWebdavFromSettings() {
  const ok = confirm('Force upload everything selected for sync?\n\nThis skips normal unchanged checks and overwrites matching files on WebDAV.');
  if (!ok) return;
  await runWebdavOneWaySync(true);
}

async function purgeWebdavFromSettings() {
  const settings = normalizeImportedSettings(state.app?.settings || {});
  if (!settings.webdavEnabled || !settings.webdavUrl) {
    showAlert('error', 'Enable WebDAV sync and set the server URL first.');
    showView('settings');
    setTimeout(() => window.appActions.showSettingsTab('webdav'), 0);
    return;
  }
  const ok = confirm('Purge WebDAV sync folder?\n\nThis permanently deletes the Doom Entryway sync folders from the configured WebDAV location. This cannot be undone.');
  if (!ok) return;
  try {
    await saveState();
    const response = await fetch('/api/webdav-purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok && !payload.summary) throw new Error(payload.error || 'WebDAV purge failed.');
    console.log('WebDAV purge result:', payload);
    const deleted = payload.summary?.deleted || 0;
    const errors = payload.summary?.errors || 0;
    showAlert(errors ? 'error' : 'success', `WebDAV purge complete. Deleted ${deleted} folder(s), ${errors} error(s).`);
  } catch (error) {
    console.error(error);
    showAlert('error', error?.message || 'WebDAV purge failed.');
  }
}
function showWebdavSyncResults(payload) {
  const existing = document.getElementById('syncResultsDialog');
  existing?.remove();
  const summary = payload.summary || {};
  const uploaded = Array.isArray(payload.uploaded) ? payload.uploaded : [];
  const downloaded = Array.isArray(payload.downloaded) ? payload.downloaded : [];
  const deletedRemote = (Array.isArray(payload.deletedRemote) ? payload.deletedRemote : []).filter((entry) => entry?.deleted !== false);
  const movedRemote = Array.isArray(payload.movedRemote) ? payload.movedRemote : [];
  const skipped = Array.isArray(payload.skipped) ? payload.skipped : [];
  const folders = Array.isArray(payload.folders) ? payload.folders : [];
  const errors = Array.isArray(payload.errors) ? payload.errors : [];

  const row = (entry) => {
    const remote = escapeHtml(entry.remote || '');
    const local = entry.local ? `<br><span class="muted tiny-text">${escapeHtml(entry.local)}</span>` : '';
    const extra = entry.reason || entry.error || entry.message || entry.action || '';
    return `<li><code>${remote}</code>${local}${extra ? `<br><span class="field-help">${escapeHtml(extra)}</span>` : ''}</li>`;
  };
  const list = (items, empty, limit = 80) => items.length ? `<ul class="list-tight sync-results-list">${items.slice(0, limit).map(row).join('')}</ul>${items.length > limit ? `<p class="field-help">Showing first ${limit} of ${items.length} entries. Full result is in the browser console.</p>` : ''}` : `<p class="muted">${escapeHtml(empty)}</p>`;
  const skippedSummary = (items) => {
    if (!items.length) return '<p class="muted">Nothing skipped.</p>';
    const reasonCounts = {};
    for (const entry of items) {
      const reason = String(entry?.reason || entry?.action || 'skipped');
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
    const reasonRows = Object.entries(reasonCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `<li><strong>${count}</strong> ${escapeHtml(reason)}</li>`)
      .join('');
    const noteworthy = items.filter((entry) => !['hash match', 'unchanged'].includes(String(entry?.reason || '').toLowerCase()));
    return `
      <p class="muted">${items.length} skipped / unchanged file${items.length === 1 ? '' : 's'}.</p>
      <ul class="list-tight sync-results-list">${reasonRows}</ul>
      ${noteworthy.length ? `<p class="field-help">Non-routine skipped entries:</p>${list(noteworthy, 'No non-routine skipped entries.', 12)}` : '<p class="field-help">Routine hash-match/unchanged files are summarized instead of listed.</p>'}
    `;
  };

  const dialog = document.createElement('dialog');
  dialog.id = 'syncResultsDialog';
  dialog.className = 'modal';
  dialog.innerHTML = `
    <div class="modal-card sync-results-card">
      <div class="modal-head">
        <h3>WebDAV Sync Results</h3>
        <button type="button" class="ghost-button" onclick="document.getElementById('syncResultsDialog')?.close()">✕</button>
      </div>
      <div class="kpi-grid sync-kpis">
        <div class="kpi-card"><div class="label">Uploaded</div><div class="value">${Number(summary.uploaded || 0)}</div></div>
        <div class="kpi-card"><div class="label">Downloaded</div><div class="value">${Number(summary.downloaded || 0)}</div></div>
        <div class="kpi-card"><div class="label">Remote deletes</div><div class="value">${Number(summary.deletedRemote || 0)}</div></div>
        <div class="kpi-card"><div class="label">Remote moves</div><div class="value">${Number(summary.movedRemote || 0)}</div></div>
        <div class="kpi-card"><div class="label">Skipped</div><div class="value">${Number(summary.skipped || 0)}</div></div>
        <div class="kpi-card"><div class="label">Folders created</div><div class="value">${Number(summary.foldersCreated || 0)}</div></div>
        <div class="kpi-card"><div class="label">Temp files removed</div><div class="value">${Number(summary.tempFilesDeleted || 0)}</div></div>
        <div class="kpi-card"><div class="label">Errors</div><div class="value">${Number(summary.errors || 0)}</div></div>
      </div>
      <div class="sync-results-scroll">
        <h4>Uploaded / updated</h4>
        ${list(uploaded, 'Nothing needed uploading.')}
        <h4>Downloaded</h4>
        ${list(downloaded, 'Nothing needed downloading.')}
        <h4>Moved remotely</h4>
        ${list(movedRemote, 'No remote moves queued.')}
        <h4>Deleted remotely</h4>
        ${list(deletedRemote, 'No remote deletes queued.')}
        <h4>Skipped</h4>
        ${skippedSummary(skipped)}
        <h4>Folder / backup actions</h4>
        ${list(folders, 'No folder or backup actions.')}
        <h4>Errors</h4>
        ${list(errors, 'No errors.')}
      </div>
      <div class="modal-actions">
        <button type="button" class="primary-button" onclick="document.getElementById('syncResultsDialog')?.close()">Done</button>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  console.log('WebDAV sync result:', payload);
  dialog.showModal();
}

async function cleanupUnassociatedFilesFromSettings() {
  const settings = normalizeImportedSettings(state.app?.settings || {});
  const associatedWadPaths = state.app.wads
    .map((entry) => entry.pwadPath || entry.iwadPath || '')
    .filter(Boolean);
  const associatedTitlepicFiles = state.app.wads
    .map((entry) => entry.titlePicFileName || '')
    .filter(Boolean);

  const warning = `Scan for unassociated files and permanently delete them?

This will check:
- Default PWAD path for .wad/.pk3 files not linked to a WAD card
- Default metadata TXT folder for companion .txt files not linked to a WAD card
- Default Titlepics folder for .png files not linked to a WAD card

This cannot be undone.`;
  if (!confirm(warning)) return;

  try {
    const response = await fetch('/api/delete-unassociated-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pwadFolder: settings.defaultPwadPath || '',
        metadataFolder: settings.defaultMetadataFolder || '',
        titlepicsFolder: settings.defaultTitlepicsFolder || '',
        associatedWadPaths,
        associatedTitlepicFiles,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Unassociated file cleanup failed.');
    if (payload.app) {
      state.app = normalizeImportedAppState(payload.app);
      applyAppSettingsToUiState();
    }
    const deleted = Array.isArray(payload.deleted) ? payload.deleted : [];
    const skipped = Array.isArray(payload.skipped) ? payload.skipped : [];
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    const tombstoned = Array.isArray(payload.tombstoned) ? payload.tombstoned : [];
    const deletedCount = deleted.filter((entry) => entry.deleted).length;
    const skippedCount = skipped.length;
    const tombstoneText = tombstoned.length ? ` Marked ${tombstoned.length} remote file(s) for WebDAV deletion.` : '';
    const errorText = errors.length ? ` ${errors.length} error(s) occurred; check the server console/details.` : '';
    showAlert('success', `Cleanup complete: deleted ${deletedCount} file(s), skipped ${skippedCount}.${tombstoneText}${errorText}`);
    console.log('Unassociated cleanup result:', payload);
  } catch (error) {
    console.error(error);
    showAlert('error', error.message || 'Could not delete unassociated files.');
  }
}


function shellQuote(value) {
  const text = String(value ?? '');
  return '"' + text.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

function buildLaunchPayload(wad) {
  const settings = normalizeImportedSettings(state.app?.settings || {});
  const executable = settings.gameExecutable;
  const iwadInfo = resolveLaunchIwadInfo(wad, settings);
  const isIwadLaunch = isIwadLaunchCard(wad, settings);
  const pwadPath = isIwadLaunch ? '' : String(wad?.pwadPath || '').trim();
  const saveDir = String(wad?.saveFolderPath || '').trim();
  const shotDir = String(wad?.screenshotFolderPath || wad?.saveFolderPath || '').trim();
  const launchSelection = getActiveLaunchSelection(wad?.id || '');
  const selectedAdditionalFiles = launchSelection.selectedAdditionalFiles || [];
  const selectedMods = launchSelection.selectedMods || [];
  const sectionOrder = launchSelection.sectionOrder || ['map', 'additional', 'mods'];
  const filePaths = buildOrderedLaunchFiles({ pwadPath, isIwadLaunch, selectedAdditionalFiles, selectedMods, sectionOrder });
  return {
    wadId: wad?.id || '',
    executable,
    iwadPath: iwadInfo.path,
    iwadSourceLabel: iwadInfo.label,
    pwadPath,
    filePaths,
    selectedAdditionalFiles,
    selectedMods,
    sectionOrder,
    saveDir,
    shotDir,
    isIwadLaunch,
    monitorDeaths: true,
    assumeFlatpak: executable.toLowerCase().endsWith('.sh'),
  };
}

function isIwadLaunchCard(wad, settings = normalizeImportedSettings(state.app?.settings || {})) {
  const iwadPath = String(wad?.iwadPath || '').trim();
  const pwadPath = String(wad?.pwadPath || '').trim();
  if (iwadPath && !pwadPath) return true;
  const launchPath = pwadPath || iwadPath;
  const iwadFolder = settings.defaultIwadFolder || '';
  return Boolean(launchPath && iwadFolder && isPathInsideFolder(launchPath, iwadFolder));
}

function resolveLaunchIwadInfo(wad, settings = normalizeImportedSettings(state.app?.settings || {})) {
  if (isIwadLaunchCard(wad, settings)) {
    const directPath = String(wad?.iwadPath || wad?.pwadPath || '').trim();
    return { path: directPath, label: 'this IWAD card' };
  }

  const field = String(wad?.iwad || '').trim();
  const match = findScannedIwadForField(field);
  if (match?.iwadPath) {
    return { path: String(match.iwadPath).trim(), label: `${match.title || match.iwadFileName || 'scanned IWAD'} from IWAD scan` };
  }

  const directPath = String(wad?.iwadPath || '').trim();
  if (directPath) return { path: directPath, label: 'WAD IWAD path' };

  const defaultPath = String(settings.defaultIwadPath || '').trim();
  return { path: defaultPath, label: defaultPath ? 'default IWAD path' : '' };
}

function findScannedIwadForField(field) {
  const key = iwadLaunchKeyFromText(field);
  const wanted = normalizeIwadFieldForLaunch(field);
  const candidates = (state.app?.wads || []).filter((entry) => String(entry?.iwadPath || '').trim());

  if (key) {
    const byKey = candidates.find((entry) => String(entry.iwadScanKey || '').toUpperCase() === key);
    if (byKey) return byKey;
  }

  if (wanted) {
    const exact = candidates.find((entry) => {
      const values = [entry.title, entry.iwad, entry.iwadFileName, entry.iwadScanKey].map(normalizeIwadFieldForLaunch);
      return values.includes(wanted);
    });
    if (exact) return exact;

    const fuzzy = candidates.find((entry) => {
      const values = [entry.title, entry.iwad, entry.iwadFileName, entry.iwadScanKey].map(normalizeIwadFieldForLaunch).filter(Boolean);
      return values.some((value) => value.includes(wanted) || wanted.includes(value));
    });
    if (fuzzy) return fuzzy;
  }

  return null;
}

function iwadLaunchKeyFromText(value) {
  const text = normalizeIwadFieldForLaunch(value);
  if (!text) return '';
  if (text.includes('plutonia')) return 'PLUTONIA';
  if (text.includes('tnt') || text.includes('evilution')) return 'TNT';
  if (text.includes('doomii') || text.includes('doom2') || text.includes('doomtwo')) return 'DOOM2';
  if (text === 'doom' || text.includes('ultimatedoom') || (text.includes('doom') && !text.includes('doom2') && !text.includes('doomii'))) return 'ULTIMATE_DOOM';
  return '';
}

function normalizeIwadFieldForLaunch(value) {
  return String(value || '').toLowerCase().replace(/\.wad$/i, '').replace(/[^a-z0-9]+/g, '').trim();
}

function isPathInsideFolder(filePath, folderPath) {
  const file = normalizePathForCompare(filePath);
  const folder = normalizePathForCompare(folderPath);
  return Boolean(file && folder && (file === folder || file.startsWith(folder.endsWith('/') ? folder : `${folder}/`)));
}

function normalizePathForCompare(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase().trim();
}

const LAUNCH_SECTION_LABELS = { map: 'Map file', additional: 'Additional files', mods: 'Mod files' };

function getActiveLaunchSelection(wadId = '') {
  if (!state.launchDialog || state.launchDialog.wadId !== wadId) {
    return { wadId, globalMods: [], additionalFiles: [], selectedMods: [], selectedAdditionalFiles: [], sectionOrder: ['map', 'additional', 'mods'], modsFolder: '', additionalFilesFolder: '', collapsedSections: { additional: true, mods: true, command: true } };
  }
  return state.launchDialog;
}

function launchFileKey(path) {
  return normalizePathForCompare(path);
}

function uniqueExistingOrder(paths, availableFiles = []) {
  const available = new Set((availableFiles || []).map((file) => launchFileKey(file.path)));
  const seen = new Set();
  return (paths || []).filter((path) => {
    const key = launchFileKey(path);
    if (!key || seen.has(key)) return false;
    if (available.size && !available.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeSelectionWithFiles(selectedPaths, files) {
  return uniqueExistingOrder(selectedPaths, files);
}

function buildOrderedLaunchFiles({ pwadPath = '', isIwadLaunch = false, selectedAdditionalFiles = [], selectedMods = [], sectionOrder = ['map', 'additional', 'mods'] } = {}) {
  const parts = {
    map: (!isIwadLaunch && pwadPath) ? [pwadPath] : [],
    additional: Array.isArray(selectedAdditionalFiles) ? selectedAdditionalFiles : [],
    mods: Array.isArray(selectedMods) ? selectedMods : [],
  };
  const seen = new Set();
  const order = normalizeLaunchSectionOrder(sectionOrder);
  return order.flatMap((section) => parts[section] || []).filter((path) => {
    const key = launchFileKey(path);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function launchFileLabel(fileOrPath) {
  if (typeof fileOrPath === 'string') return fileOrPath.split(/[\\/]/).pop() || fileOrPath;
  return fileOrPath?.relativePath || fileOrPath?.fileName || fileOrPath?.path || 'file';
}

function normalizeLaunchSectionOrder(order) {
  const valid = ['map', 'additional', 'mods'];
  const clean = (Array.isArray(order) ? order : []).filter((entry, index, arr) => valid.includes(entry) && arr.indexOf(entry) === index);
  valid.forEach((entry) => { if (!clean.includes(entry)) clean.push(entry); });
  return clean;
}

function renderLaunchFilePicker(sectionKey, files, selectedPaths) {
  const normalizedSelected = uniqueExistingOrder(selectedPaths, files);
  const selected = new Set(normalizedSelected.map(launchFileKey));
  if (!files.length) {
    const empty = sectionKey === 'mods' ? 'No global mod files found in the Mods folder.' : 'No WAD-specific additional files found.';
    return `<p class="muted">${empty}</p>`;
  }
  const ordered = [
    ...normalizedSelected.map((path) => files.find((file) => launchFileKey(file.path) === launchFileKey(path))).filter(Boolean),
    ...files.filter((file) => !selected.has(launchFileKey(file.path))),
  ];
  return `<div class="launch-file-list">${ordered.map((file) => {
    const checked = selected.has(launchFileKey(file.path));
    const selectedIndex = normalizedSelected.findIndex((path) => launchFileKey(path) === launchFileKey(file.path));
    return `<div class="launch-file-row ${checked ? 'selected' : ''}">
      <label class="checkbox-line launch-file-check"><span><input type="checkbox" ${checked ? 'checked' : ''} onchange="window.appActions.toggleLaunchFile('${sectionKey}', '${escapeJsString(file.path)}', this.checked)" /> ${escapeHtml(launchFileLabel(file))}</span></label>
      <code title="${escapeHtml(file.path)}">${escapeHtml(file.relativePath || file.path)}</code>
      <div class="launch-file-actions">
        <button type="button" class="secondary-button mini-button" ${!checked || selectedIndex <= 0 ? 'disabled' : ''} onclick="window.appActions.moveLaunchFile('${sectionKey}', '${escapeJsString(file.path)}', -1)">↑</button>
        <button type="button" class="secondary-button mini-button" ${!checked || selectedIndex < 0 || selectedIndex >= normalizedSelected.length - 1 ? 'disabled' : ''} onclick="window.appActions.moveLaunchFile('${sectionKey}', '${escapeJsString(file.path)}', 1)">↓</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderLaunchSectionOrder(order) {
  const clean = normalizeLaunchSectionOrder(order);
  return `<div class="launch-order-list">${clean.map((section, index) => `<div class="launch-order-row">
    <strong>${index + 1}. ${LAUNCH_SECTION_LABELS[section]}</strong>
    <div class="launch-file-actions">
      <button type="button" class="secondary-button mini-button" ${index === 0 ? 'disabled' : ''} onclick="window.appActions.moveLaunchSection('${section}', -1)">↑</button>
      <button type="button" class="secondary-button mini-button" ${index === clean.length - 1 ? 'disabled' : ''} onclick="window.appActions.moveLaunchSection('${section}', 1)">↓</button>
    </div>
  </div>`).join('')}</div>`;
}

function renderLaunchCollapsibleSection({ sectionKey, title, description = '', summary = '', collapsed = false, content = '' }) {
  const safeKey = escapeJsString(sectionKey);
  const expanded = !collapsed;
  return `<section class="summary-card launch-picker-card launch-collapsible-card ${collapsed ? 'is-collapsed' : ''}">
    <div class="section-bar compact-section-bar launch-collapsible-head">
      <div>
        <h4>${escapeHtml(title)}</h4>
        ${description ? `<p class="muted">${description}</p>` : ''}
        ${summary ? `<p class="muted launch-section-summary">${escapeHtml(summary)}</p>` : ''}
      </div>
      <button type="button" class="secondary-button mini-button launch-collapse-button" aria-expanded="${expanded ? 'true' : 'false'}" onclick="window.appActions.toggleLaunchDialogSection('${safeKey}')">${collapsed ? 'Expand' : 'Collapse'}</button>
    </div>
    <div class="launch-collapsible-body" ${collapsed ? 'hidden' : ''}>${content}</div>
  </section>`;
}

function renderLaunchFileSectionToolbar(sectionKey, files = [], selectedPaths = []) {
  const totalCount = Array.isArray(files) ? files.length : 0;
  const selectedCount = uniqueExistingOrder(selectedPaths, files).length;
  const sectionLabel = sectionKey === 'mods' ? 'mods' : 'files';
  const defaultButton = sectionKey === 'mods'
    ? `<button type="button" class="secondary-button mini-button" onclick="window.appActions.applyDefaultModsToLaunch()">Apply Default Mods</button>`
    : '';
  return `<div class="section-bar compact-section-bar launch-file-toolbar">
    <p class="muted">${selectedCount} / ${totalCount} selected</p>
    <div class="button-row">
      ${defaultButton}
      <button type="button" class="secondary-button mini-button" ${!totalCount ? 'disabled' : ''} onclick="window.appActions.selectAllLaunchFiles('${sectionKey}')">Select All</button>
      <button type="button" class="secondary-button mini-button" ${!selectedCount ? 'disabled' : ''} onclick="window.appActions.clearLaunchFiles('${sectionKey}')">Unselect All</button>
    </div>
  </div>`;
}

function launchSectionSummary(sectionKey, files = [], selectedPaths = []) {
  const selectedCount = uniqueExistingOrder(selectedPaths, files).length;
  const totalCount = Array.isArray(files) ? files.length : 0;
  if (sectionKey === 'mods') {
    return `${selectedCount} of ${totalCount} mod file${totalCount === 1 ? '' : 's'} selected`;
  }
  if (sectionKey === 'additional') {
    return `${selectedCount} of ${totalCount} additional file${totalCount === 1 ? '' : 's'} selected`;
  }
  return '';
}

async function scanLaunchFilesForWad(wad) {
  const modsFolder = getLaunchFolderSetting('modsFolder');
  const additionalRoot = getLaunchFolderSetting('additionalFilesFolder');
  const additionalSubfolder = wadAdditionalFolderName(wad);
  const additionalFolder = pathJoinClient(additionalRoot, additionalSubfolder);
  const response = await fetch('/api/scan-launch-files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      modsFolder,
      additionalFilesFolder: additionalFolder,
      additionalFilesRoot: additionalRoot,
      additionalSubfolder,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Could not scan launch files.');
  return {
    globalMods: Array.isArray(payload.globalMods) ? payload.globalMods : [],
    additionalFiles: Array.isArray(payload.additionalFiles) ? payload.additionalFiles : [],
    additionalFilesFolder: payload.additionalFilesFolder || additionalFolder,
    modsFolder: payload.modsFolder || modsFolder || '',
  };
}

function rerenderLaunchDialogBody(wadId) {
  const wad = state.app.wads.find((entry) => entry.id === wadId);
  const body = document.getElementById('launchDialogBody');
  if (!wad || !body) return;
  const payload = buildLaunchPayload(wad);
  const errors = validateLaunchPayload(payload);
  const launchState = getActiveLaunchSelection(wad.id);
  body.innerHTML = `
    <p class="muted">Choose global mods and WAD-specific additional files, set priority inside each section, then choose the overall section load order.</p>
    <div class="upload-callout">Death monitor enabled: Doom Entryway will watch terminal output for map headers like <code>MAP01</code> / <code>E1M1</code> and obituary lines, then add 1 death to that map.</div>
    ${payload.assumeFlatpak ? '<div class="upload-callout">Shell script executable detected, so Doom Entryway will launch it through <code>flatpak-spawn --host</code>.</div>' : ''}
    ${payload.iwadSourceLabel ? `<div class="upload-callout">IWAD resolved from: <strong>${escapeHtml(payload.iwadSourceLabel)}</strong></div>` : ''}
    <div id="launchDialogErrors">${errors.length ? `<div class="launch-warning"><strong>Needs attention before launch:</strong><ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul></div>` : ''}</div>
    <section class="summary-card launch-picker-card">
      <div class="section-bar compact-section-bar"><h4>Overall load order</h4><p class="muted">Later files override earlier files when they replace the same assets.</p></div>
      ${renderLaunchSectionOrder(launchState.sectionOrder)}
    </section>
    <section class="summary-card launch-picker-card">
      <div class="section-bar compact-section-bar"><h4>Map file</h4></div>
      <p class="muted">${payload.isIwadLaunch ? 'IWAD launch: no separate map file is loaded.' : escapeHtml(payload.pwadPath || 'No WAD/PK3 associated yet.')}</p>
    </section>
    ${renderLaunchCollapsibleSection({
      sectionKey: 'additional',
      title: 'Additional files',
      description: `WAD-specific files from <code>${escapeHtml(launchState.additionalFilesFolder || 'not set')}</code>.`,
      summary: launchSectionSummary('additional', launchState.additionalFiles || [], launchState.selectedAdditionalFiles || []),
      collapsed: Boolean(launchState.collapsedSections?.additional),
      content: renderLaunchFileSectionToolbar('additional', launchState.additionalFiles || [], launchState.selectedAdditionalFiles || []) + renderLaunchFilePicker('additional', launchState.additionalFiles || [], launchState.selectedAdditionalFiles || []),
    })}
    ${renderLaunchCollapsibleSection({
      sectionKey: 'mods',
      title: 'Mod files',
      description: `Global mods from <code>${escapeHtml(launchState.modsFolder || 'not set')}</code>.`,
      summary: launchSectionSummary('mods', launchState.globalMods || [], launchState.selectedMods || []),
      collapsed: Boolean(launchState.collapsedSections?.mods),
      content: renderLaunchFileSectionToolbar('mods', launchState.globalMods || [], launchState.selectedMods || []) + renderLaunchFilePicker('mods', launchState.globalMods || [], launchState.selectedMods || []),
    })}
    ${renderLaunchCollapsibleSection({
      sectionKey: 'command',
      title: 'Command line preview',
      summary: 'Show or hide the exact command Doom Entryway will run.',
      collapsed: Boolean(launchState.collapsedSections?.command),
      content: `<textarea id="launchCommandPreview" class="command-preview" readonly rows="6">${escapeHtml(buildLaunchCommandPreview(wad))}</textarea>`,
    })}
  `;
  const launchButton = document.getElementById('launchDialogLaunchButton');
  if (launchButton) launchButton.disabled = errors.length > 0;
}


function toggleLaunchDialogSection(sectionKey) {
  const launchState = state.launchDialog;
  if (!launchState?.wadId) return;
  const key = ['additional', 'mods', 'command'].includes(sectionKey) ? sectionKey : '';
  if (!key) return;
  launchState.collapsedSections = { additional: true, mods: true, command: true, ...(launchState.collapsedSections || {}) };
  launchState.collapsedSections[key] = !launchState.collapsedSections[key];
  rerenderLaunchDialogBody(launchState.wadId);
}

function toggleLaunchFile(section, path, checked) {
  const launchState = state.launchDialog;
  const key = section === 'mods' ? 'selectedMods' : 'selectedAdditionalFiles';
  const current = Array.isArray(launchState[key]) ? [...launchState[key]] : [];
  const normalized = launchFileKey(path);
  const exists = current.some((entry) => launchFileKey(entry) === normalized);
  if (checked && !exists) current.push(path);
  if (!checked) {
    const index = current.findIndex((entry) => launchFileKey(entry) === normalized);
    if (index >= 0) current.splice(index, 1);
  }
  launchState[key] = current;
  saveLauncherSettingsForWad(launchState.wadId, { persist: true });
  rerenderLaunchDialogBody(launchState.wadId);
}

function moveLaunchFile(section, path, direction) {
  const launchState = state.launchDialog;
  const key = section === 'mods' ? 'selectedMods' : 'selectedAdditionalFiles';
  const current = Array.isArray(launchState[key]) ? [...launchState[key]] : [];
  const index = current.findIndex((entry) => launchFileKey(entry) === launchFileKey(path));
  const next = index + Number(direction || 0);
  if (index < 0 || next < 0 || next >= current.length) return;
  [current[index], current[next]] = [current[next], current[index]];
  launchState[key] = current;
  saveLauncherSettingsForWad(launchState.wadId, { persist: true });
  rerenderLaunchDialogBody(launchState.wadId);
}

function selectAllLaunchFiles(section) {
  const launchState = state.launchDialog;
  if (!launchState?.wadId) return;
  const isMods = section === 'mods';
  const key = isMods ? 'selectedMods' : 'selectedAdditionalFiles';
  const files = isMods ? (launchState.globalMods || []) : (launchState.additionalFiles || []);
  launchState[key] = files.map((file) => file.path).filter(Boolean);
  saveLauncherSettingsForWad(launchState.wadId, { persist: true });
  rerenderLaunchDialogBody(launchState.wadId);
}

function clearLaunchFiles(section) {
  const launchState = state.launchDialog;
  if (!launchState?.wadId) return;
  const key = section === 'mods' ? 'selectedMods' : 'selectedAdditionalFiles';
  launchState[key] = [];
  saveLauncherSettingsForWad(launchState.wadId, { persist: true });
  rerenderLaunchDialogBody(launchState.wadId);
}

function applyDefaultModsToLaunch() {
  const launchState = state.launchDialog;
  if (!launchState?.wadId) return;
  launchState.selectedMods = mergeSelectionWithFiles(getDefaultMods(), launchState.globalMods || []);
  saveLauncherSettingsForWad(launchState.wadId, { persist: true });
  rerenderLaunchDialogBody(launchState.wadId);
}

function moveLaunchSection(section, direction) {
  const launchState = state.launchDialog;
  const order = normalizeLaunchSectionOrder(launchState.sectionOrder);
  const index = order.indexOf(section);
  const next = index + Number(direction || 0);
  if (index < 0 || next < 0 || next >= order.length) return;
  [order[index], order[next]] = [order[next], order[index]];
  launchState.sectionOrder = order;
  saveLauncherSettingsForWad(launchState.wadId, { persist: true });
  rerenderLaunchDialogBody(launchState.wadId);
}

function buildLaunchCommandPreview(wad) {
  return buildLaunchCommandPreviewFromPayload(buildLaunchPayload(wad));
}

function buildLaunchCommandPreviewFromPayload(payload) {
  const command = [];
  if (payload.assumeFlatpak) {
    command.push('flatpak-spawn', '--host', payload.executable);
  } else {
    command.push(payload.executable);
  }
  if (payload.iwadPath) command.push('-iwad', payload.iwadPath);
  const fileList = Array.isArray(payload.filePaths) && payload.filePaths.length ? payload.filePaths : (payload.pwadPath ? [payload.pwadPath] : []);
  if (fileList.length) command.push('-file', ...fileList);
  if (payload.saveDir) command.push('-savedir', payload.saveDir);
  if (payload.shotDir) command.push('-shotdir', payload.shotDir);
  return command.map(shellQuote).join(' ');
}

function validateLaunchPayload(payload) {
  const errors = [];
  if (!payload.executable) errors.push('Set Game Executable in Settings first.');
  if (!payload.iwadPath) errors.push('Set this WAD\'s IWAD field to a scanned IWAD, set an IWAD path, or set the Default IWAD path in Settings.');
  if (!payload.isIwadLaunch && !payload.pwadPath) errors.push('Associate a WAD/PK3 file with this PWAD card first.');
  if (!payload.saveDir) errors.push('Set this WAD\'s Local Save Folder first.');
  if (!payload.shotDir) errors.push('Set this WAD\'s Screenshot Folder or Local Save Folder first.');
  return errors;
}

async function openLaunchDialog(wadId) {
  const wad = state.app.wads.find((entry) => entry.id === wadId);
  const dialog = document.getElementById('launchDialog');
  const title = document.getElementById('launchDialogTitle');
  const body = document.getElementById('launchDialogBody');
  const launchButton = document.getElementById('launchDialogLaunchButton');
  if (!wad || !dialog || !title || !body || !launchButton) return;
  title.textContent = `Launch ${wad.title || 'WAD'}`;
  launchButton.disabled = true;
  launchButton.onclick = () => launchWad(wad.id);
  const savedLaunchSettings = normalizeLauncherSettings(wad.launcherSettings || {});
  state.launchDialog = {
    wadId: wad.id,
    globalMods: [],
    additionalFiles: [],
    selectedMods: savedLaunchSettings.selectedMods || [],
    selectedAdditionalFiles: savedLaunchSettings.selectedAdditionalFiles || [],
    sectionOrder: savedLaunchSettings.sectionOrder || ['map', 'additional', 'mods'],
    modsFolder: '',
    additionalFilesFolder: '',
    collapsedSections: { additional: true, mods: true, command: true },
  };
  body.innerHTML = '<p class="muted">Scanning Mods and Additional Files folders...</p>';
  dialog.showModal();
  try {
    const files = await scanLaunchFilesForWad(wad);
    state.launchDialog.globalMods = files.globalMods;
    state.launchDialog.additionalFiles = files.additionalFiles;
    state.launchDialog.modsFolder = files.modsFolder;
    state.launchDialog.additionalFilesFolder = files.additionalFilesFolder;
    const savedLaunchSettings = normalizeLauncherSettings(wad.launcherSettings || {});
    const hasSavedModList = Boolean(savedLaunchSettings.updatedAt) || (Array.isArray(savedLaunchSettings.selectedMods) && savedLaunchSettings.selectedMods.length > 0);
    const startingMods = hasSavedModList ? (savedLaunchSettings.selectedMods || []) : getDefaultMods();
    state.launchDialog.selectedMods = mergeSelectionWithFiles(startingMods, files.globalMods);
    state.launchDialog.selectedAdditionalFiles = savedLaunchSettings.selectedAdditionalFiles?.length
      ? mergeSelectionWithFiles(savedLaunchSettings.selectedAdditionalFiles, files.additionalFiles)
      : mergeSelectionWithFiles(files.additionalFiles.map((file) => file.path), files.additionalFiles);
    state.launchDialog.sectionOrder = normalizeLaunchSectionOrder(savedLaunchSettings.sectionOrder || state.launchDialog.sectionOrder);
  } catch (error) {
    console.error(error);
    body.innerHTML = `<div class="launch-warning"><strong>Could not scan launch files:</strong> ${escapeHtml(error.message || 'Unknown error')}</div>`;
  }
  rerenderLaunchDialogBody(wad.id);
}

async function launchWad(wadId) {
  const wad = state.app.wads.find((entry) => entry.id === wadId);
  if (!wad) return;
  saveLauncherSettingsForWad(wad.id, { persist: true });
  const payload = buildLaunchPayload(wad);
  const errors = validateLaunchPayload(payload);
  if (errors.length) {
    showAlert('error', errors[0]);
    return;
  }
  const button = document.getElementById('launchDialogLaunchButton');
  if (button) {
    button.disabled = true;
    button.textContent = 'Launching...';
  }
  try {
    const response = await fetch('/api/launch-game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Launch failed.');
    document.getElementById('launchDialog')?.close();
    showAlert('success', `Launched ${wad.title || 'WAD'}. Death monitor is watching terminal output.`);
  } catch (error) {
    showAlert('error', error.message || 'Launch failed. Check the local server terminal.');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Launch';
    }
  }
}

function getScannedIwadLaunchOptions() {
  return (state.app?.wads || [])
    .filter((entry) => String(entry?.iwadPath || '').trim())
    .map((entry) => ({
      id: entry.id,
      label: entry.title || entry.iwadFileName || entry.iwadScanKey || entry.iwad || 'Scanned IWAD',
      path: String(entry.iwadPath || '').trim(),
      key: entry.iwadScanKey || '',
    }))
    .filter((entry, index, array) => entry.path && array.findIndex((other) => normalizePathForCompare(other.path) === normalizePathForCompare(entry.path)) === index)
    .sort((a, b) => a.label.localeCompare(b.label));
}

function getTestWadDialogElements() {
  return {
    dialog: document.getElementById('testWadDialog'),
    status: document.getElementById('testWadStatus'),
    wadSelect: document.getElementById('testWadSelect'),
    iwadSelect: document.getElementById('testIwadSelect'),
    preview: document.getElementById('testWadCommandPreview'),
    launchButton: document.getElementById('testWadLaunchButton'),
  };
}

async function openTestWadDialog() {
  const settings = normalizeImportedSettings(state.app?.settings || {});
  const els = getTestWadDialogElements();
  if (!els.dialog || !els.status || !els.wadSelect || !els.iwadSelect || !els.preview || !els.launchButton) return;

  els.status.textContent = 'Scanning unassociated PWAD/PK3 files...';
  els.wadSelect.innerHTML = '<option value="">Scanning...</option>';
  els.iwadSelect.innerHTML = '';
  els.preview.value = '';
  els.launchButton.disabled = true;
  els.dialog.showModal();

  const iwadOptions = getScannedIwadLaunchOptions();
  if (iwadOptions.length) {
    els.iwadSelect.innerHTML = iwadOptions.map((entry, index) => `<option value="${escapeHtml(entry.path)}" ${index === 0 ? 'selected' : ''}>${escapeHtml(entry.label)} — ${escapeHtml(entry.path)}</option>`).join('');
  } else {
    els.iwadSelect.innerHTML = '<option value="">No scanned IWADs found</option>';
  }

  if (!settings.defaultPwadPath) {
    els.status.textContent = 'Set Default PWAD path in Settings first.';
    updateTestWadPreview();
    return;
  }

  try {
    const associatedFiles = getAssociatedModFiles();
    const associatedPaths = associatedFiles.map((entry) => entry.path).filter(Boolean);
    const response = await fetch('/api/scan-pwads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pwadFolder: settings.defaultPwadPath, associatedPaths, associatedFiles }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'PWAD scan failed.');
    const found = Array.isArray(payload.found) ? payload.found : [];
    if (!found.length) {
      els.wadSelect.innerHTML = '<option value="">No unassociated PWAD/PK3 files found</option>';
      els.status.textContent = 'No unassociated PWAD/PK3 files were found in the Default PWAD path.';
      updateTestWadPreview();
      return;
    }
    els.wadSelect.innerHTML = found.map((file, index) => {
      const label = `${file.relativePath || file.fileName}${Number(file.mapCount) ? ` [${file.mapCount} maps]` : ''}`;
      return `<option value="${escapeHtml(file.path)}" ${index === 0 ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
    els.status.textContent = `Found ${found.length} unassociated PWAD/PK3 file${found.length === 1 ? '' : 's'}. Pick one and launch it without adding a WAD card.`;
    updateTestWadPreview();
  } catch (error) {
    console.error(error);
    els.wadSelect.innerHTML = '<option value="">Scan failed</option>';
    els.status.textContent = error.message || 'Could not scan PWAD folder.';
    updateTestWadPreview();
  }
}

function buildTestWadLaunchPayload() {
  const settings = normalizeImportedSettings(state.app?.settings || {});
  const els = getTestWadDialogElements();
  const executable = settings.gameExecutable;
  const pwadPath = els.wadSelect?.value || '';
  const iwadPath = els.iwadSelect?.value || '';
  const saveDir = settings.defaultRootSaveFolder || '';
  const shotDir = settings.defaultScreenshotFolder || settings.defaultRootSaveFolder || '';
  return {
    executable,
    iwadPath,
    iwadSourceLabel: 'Test WAD IWAD selector',
    pwadPath,
    saveDir,
    shotDir,
    isIwadLaunch: false,
    assumeFlatpak: String(executable || '').toLowerCase().endsWith('.sh'),
  };
}

function validateTestWadLaunchPayload(payload) {
  const errors = [];
  if (!payload.executable) errors.push('Set Game Executable in Settings first.');
  if (!payload.pwadPath) errors.push('Select an unassociated PWAD/PK3 file.');
  if (!payload.iwadPath) errors.push('Scan IWADs first, then select the IWAD this test WAD should use.');
  if (!payload.saveDir) errors.push('Set Default root save folder in Settings first.');
  if (!payload.shotDir) errors.push('Set Default Screenshot folder or Default root save folder in Settings first.');
  return errors;
}

function updateTestWadPreview() {
  const els = getTestWadDialogElements();
  if (!els.preview || !els.launchButton) return;
  const payload = buildTestWadLaunchPayload();
  const errors = validateTestWadLaunchPayload(payload);
  els.preview.value = buildLaunchCommandPreviewFromPayload(payload);
  els.launchButton.disabled = errors.length > 0;
  const warning = document.getElementById('testWadWarnings');
  if (warning) {
    warning.innerHTML = errors.length ? `<div class="launch-warning"><strong>Needs attention before launch:</strong><ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul></div>` : '';
  }
}

async function launchTestWad() {
  const payload = buildTestWadLaunchPayload();
  const errors = validateTestWadLaunchPayload(payload);
  if (errors.length) {
    showAlert('error', errors[0]);
    return;
  }
  const els = getTestWadDialogElements();
  if (els.launchButton) {
    els.launchButton.disabled = true;
    els.launchButton.textContent = 'Launching...';
  }
  try {
    const response = await fetch('/api/launch-game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Launch failed.');
    els.dialog?.close();
    const selected = els.wadSelect?.selectedOptions?.[0]?.textContent || 'test WAD';
    showAlert('success', `Launched ${selected}.`);
  } catch (error) {
    showAlert('error', error.message || 'Launch failed. Check the local server terminal.');
  } finally {
    if (els.launchButton) {
      els.launchButton.disabled = false;
      els.launchButton.textContent = 'Launch';
    }
  }
}


window.appActions = {
  refreshDebugLogs: loadDebugLogs,
  clearDebugLogs,
  openWad: (wadId) => showWadDetail(wadId),
  goStats: () => { activateNav('stats'); showView('stats'); },
  openLibraryPreset,
  showLibraryMapSummary,
  showLibraryTxtInfo,
  showAllWadTags,
  openTitlepic: openTitlepicPopup,
  openLaunchDialog,
  toggleLaunchFile,
  moveLaunchFile,
  moveLaunchSection,
  selectAllLaunchFiles,
  clearLaunchFiles,
  applyDefaultModsToLaunch,
  toggleLaunchDialogSection,
  openTestWadDialog,
  updateTestWadPreview,
  launchTestWad,
  editWad: openEditWadDialog,
  refreshWadMetadata: refreshWadMetadataFromDisk,
  associateWadFile,
  extractTitlepicFromAssociatedWad,
  setLibraryFilter: (value) => { state.libraryFilter = value; render(); },
  setLibraryQuickFilter,
  clearLibraryQuickFilter,
  clearAllLibraryQuickFilters,
  sortLibraryByMetric: (value) => {
    state.librarySortKey = LIBRARY_SORT_OPTIONS.some((option) => option.key === value) ? value : 'title';
    state.librarySortDirection = 'desc';
    persistLibraryViewSettings();
    render();
  },
  setLibrarySortKey: (value) => {
    state.librarySortKey = LIBRARY_SORT_OPTIONS.some((option) => option.key === value) ? value : 'title';
    persistLibraryViewSettings();
    render();
  },
  toggleLibrarySortDirection: () => {
    state.librarySortDirection = state.librarySortDirection === 'desc' ? 'asc' : 'desc';
    persistLibraryViewSettings();
    render();
  },
  setLibraryViewMode: (value) => {
    state.libraryViewMode = value === 'compact' ? 'compact' : 'card';
    persistLibraryViewSettings();
    render();
  },
  setLibraryDensity: (value) => {
    state.libraryDensity = Math.min(900, Math.max(520, Number(value) || 680));
    if (state.app?.settings) {
      state.app.settings.libraryDensity = state.libraryDensity;
      state.app.settings.libraryViewMode = state.libraryViewMode;
      state.app.settings.librarySortKey = state.librarySortKey;
      state.app.settings.librarySortDirection = state.librarySortDirection;
    }
    render();
  },
  saveLibraryViewSettings: () => persistLibraryViewSettings(),
  showSettingsTab: (tabName) => {
    const target = tabName === 'webdav' ? 'webdav' : (tabName === 'defaultMods' ? 'defaultMods' : 'main');
    const tabs = {
      main: document.getElementById('settingsMainTab'),
      defaultMods: document.getElementById('settingsDefaultModsTab'),
      webdav: document.getElementById('settingsWebdavTab'),
    };
    const panels = {
      main: document.getElementById('settingsMainPanel'),
      defaultMods: document.getElementById('settingsDefaultModsPanel'),
      webdav: document.getElementById('settingsWebdavPanel'),
    };
    if (!tabs.main || !tabs.defaultMods || !tabs.webdav || !panels.main || !panels.defaultMods || !panels.webdav) return;
    Object.keys(tabs).forEach((key) => {
      const active = key === target;
      tabs[key].classList.toggle('active', active);
      tabs[key].setAttribute('aria-selected', active ? 'true' : 'false');
      panels[key].classList.toggle('active', active);
    });
    if (target === 'defaultMods' && !state.defaultModsManager.loading && !(state.defaultModsManager.files || []).length && !state.defaultModsManager.error) {
      setTimeout(() => scanDefaultModsForSettings(), 0);
    }
  },
  scanDefaultModsForSettings,
  toggleDefaultMod: (path, checked) => {
    const current = getDefaultMods();
    const key = launchFileKey(path);
    const exists = current.some((entry) => launchFileKey(entry) === key);
    if (checked && !exists) current.push(path);
    if (!checked) {
      const index = current.findIndex((entry) => launchFileKey(entry) === key);
      if (index >= 0) current.splice(index, 1);
    }
    setDefaultMods(current, { persist: true });
    refreshDefaultModsManager();
  },
  moveDefaultMod: (path, direction) => {
    const current = getDefaultMods();
    const index = current.findIndex((entry) => launchFileKey(entry) === launchFileKey(path));
    const next = index + Number(direction || 0);
    if (index < 0 || next < 0 || next >= current.length) return;
    [current[index], current[next]] = [current[next], current[index]];
    setDefaultMods(current, { persist: true });
    refreshDefaultModsManager();
  },
  selectAllDefaultMods: () => {
    const files = state.defaultModsManager?.files || [];
    setDefaultMods(files.map((file) => file.path), { persist: true });
    refreshDefaultModsManager();
  },
  clearDefaultMods: () => {
    setDefaultMods([], { persist: true });
    refreshDefaultModsManager();
  },
  saveSettings: (event) => {
    event?.preventDefault?.();
    const form = document.getElementById('settingsForm');
    if (!form) return;
    const formData = new FormData(form);
    state.app.settings = normalizeImportedSettings({
      ...(state.app.settings || {}),
      defaultRootSaveFolder: formData.get('defaultRootSaveFolder'),
      defaultPwadPath: formData.get('defaultPwadPath'),
      defaultMetadataFolder: formData.get('defaultMetadataFolder'),
      defaultTitlepicsFolder: formData.get('defaultTitlepicsFolder'),
      defaultScreenshotFolder: formData.get('defaultScreenshotFolder'),
      defaultIwadPath: formData.get('defaultIwadPath'),
      defaultIwadFolder: formData.get('defaultIwadFolder'),
      gameExecutable: formData.get('gameExecutable'),
      modsFolder: formData.get('modsFolder'),
      additionalFilesFolder: formData.get('additionalFilesFolder'),
      defaultMods: normalizeDefaultMods(state.app?.settings?.defaultMods),
      webdavEnabled: formData.get('webdavEnabled') === 'on',
      webdavUrl: formData.get('webdavUrl'),
      webdavRemotePath: formData.get('webdavRemotePath'),
      webdavUsername: formData.get('webdavUsername'),
      webdavPassword: formData.get('webdavPassword'),
      webdavVerifySsl: formData.get('webdavVerifySsl') === 'on',
      webdavHashCheckBeforeOverwrite: formData.get('webdavHashCheckBeforeOverwrite') === 'on',
      syncSaves: formData.get('syncSaves') === 'on',
      syncPwads: formData.get('syncPwads') === 'on',
      syncIwads: formData.get('syncIwads') === 'on',
      syncMetadataTxt: formData.get('syncMetadataTxt') === 'on',
      syncTitlepics: formData.get('syncTitlepics') === 'on',
      syncScreenshots: formData.get('syncScreenshots') === 'on',
      syncMods: formData.get('syncMods') === 'on',
      syncAdditionalFiles: formData.get('syncAdditionalFiles') === 'on',
      syncDatabase: formData.get('syncDatabase') === 'on',
      deleteAssociatedFilesOnWadDelete: formData.get('deleteAssociatedFilesOnWadDelete') === 'on',
      checkMissingDeletedFilesOnRefreshAll: formData.get('checkMissingDeletedFilesOnRefreshAll') === 'on',
      libraryViewMode: state.libraryViewMode,
      libraryDensity: state.libraryDensity,
    });
    saveState();
    showAlert('success', 'Settings saved. Future WAD entries will use these defaults.');
    render();
  },
  resetSettingsForm: () => render(),
  cleanupUnassociatedFiles: cleanupUnassociatedFilesFromSettings,
  testWebdavConnection: testWebdavConnectionFromSettings,
  syncNow: runWebdavOneWaySync,
  forceUploadWebdav: forceUploadWebdavFromSettings,
  purgeWebdav: purgeWebdavFromSettings,
  openScreenshot: openScreenshotPopup,
  deleteScreenshot: deleteScreenshotFile,
  setLibrarySearch: (value) => {
    state.librarySearch = String(value || '');
    render();
    restoreLibrarySearchFocus();
  },
  clearLibrarySearch: () => {
    state.librarySearch = '';
    render();
    restoreLibrarySearchFocus();
  },
  goLibrary: () => { activateNav('library'); showView('library'); },
  openFolder: (folderId) => {
    ensureFolderState();
    const normalized = normalizeFolderId(folderId);
    state.currentFolderId = normalized && getFolderById(normalized) ? normalized : null;
    render();
  },
  createFolder: () => {
    ensureFolderState();
    const name = prompt('Folder name?');
    if (!name || !name.trim()) return;
    const folder = {
      id: crypto.randomUUID(),
      name: name.trim(),
      parentId: state.currentFolderId,
      createdAt: new Date().toISOString(),
    };
    state.app.folders.push(folder);
    saveState();
    showAlert('success', `Created folder ${folder.name}.`);
    render();
  },
  renameFolder: (folderId) => {
    ensureFolderState();
    const folder = getFolderById(folderId);
    if (!folder) return;
    const name = prompt('New folder name?', folder.name);
    if (!name || !name.trim()) return;
    folder.name = name.trim();
    saveState();
    showAlert('success', 'Folder renamed.');
    render();
  },
  deleteFolder: (folderId) => {
    ensureFolderState();
    const folder = getFolderById(folderId);
    if (!folder) return;
    const deleteIds = [folder.id, ...getDescendantFolderIds(folder.id)];
    const movedCards = state.app.wads.filter((wad) => deleteIds.includes(normalizeFolderId(wad.folderId))).length;
    const ok = confirm(`Delete folder "${folder.name}"? ${movedCards} WAD card${movedCards === 1 ? '' : 's'} in this folder or its subfolders will move back to Root.`);
    if (!ok) return;
    state.app.wads.forEach((wad) => {
      if (deleteIds.includes(normalizeFolderId(wad.folderId))) wad.folderId = null;
    });
    state.app.folders = state.app.folders.filter((entry) => !deleteIds.includes(entry.id));
    if (deleteIds.includes(state.currentFolderId)) state.currentFolderId = null;
    saveState();
    showAlert('success', `Deleted folder. ${movedCards} WAD card${movedCards === 1 ? '' : 's'} moved to Root.`);
    render();
  },
  moveWadToFolder: (wadId, folderId) => {
    ensureFolderState();
    const wad = state.app.wads.find((entry) => entry.id === wadId);
    if (!wad) return;
    const targetId = normalizeFolderId(folderId);
    wad.folderId = targetId && getFolderById(targetId) ? targetId : null;
    saveState();
    showAlert('success', `Moved ${wad.title} to ${getFolderPathLabel(wad.folderId)}.`);
    render();
  },
  addRun: (wadId) => {
    const wad = state.app.wads.find((entry) => entry.id === wadId);
    if (!wad) return;
    const name = prompt('Run name?', `Run ${wad.runs.length + 1}`);
    if (!name) return;
    const run = createRun(name.trim());
    wad.runs.push(run);
    wad.selectedRunId = run.id;
    saveState();
    showAlert('success', `Created ${name.trim()}.`);
    render();
  },
  deleteRun: (wadId, runId) => {
    const wad = state.app.wads.find((entry) => entry.id === wadId);
    if (!wad) return;
    const run = wad.runs.find((entry) => entry.id === runId);
    if (!run) return;

    const ok = confirm(`Delete run "${run.name}"? This will remove all map stats imported or entered for that run.`);
    if (!ok) return;

    wad.runs = wad.runs.filter((entry) => entry.id !== runId);

    if (!wad.runs.length) {
      const replacementRun = createRun('Default Run');
      wad.runs.push(replacementRun);
      wad.selectedRunId = replacementRun.id;
    } else if (wad.selectedRunId === runId) {
      wad.selectedRunId = wad.runs[wad.runs.length - 1].id;
    }

    saveState();
    showAlert('success', `Deleted ${run.name}.`);
    render();
  },
  deleteWad: async (wadId) => {
    const wad = state.app.wads.find((entry) => entry.id === wadId);
    if (!wad) return;

    const deleteFiles = Boolean(getAppSetting('deleteAssociatedFilesOnWadDelete'));
    let message = `Delete "${wad.title}"? This will remove all runs and map stats for this entry.`;
    if (deleteFiles) {
      message += `

WARNING: Your setting to delete associated files is enabled. This will permanently delete the associated WAD/PK3, companion TXT, and titlepic PNG from disk when found. This cannot be undone.`;
    }
    const ok = confirm(message);
    if (!ok) return;

    if (deleteFiles) {
      tombstoneWadFiles(wad);
      try {
        const response = await fetch('/api/delete-associated-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wadPath: wad.pwadPath || wad.iwadPath || '',
            metadataFolder: getAppSetting('defaultMetadataFolder') || '',
            titlepicsFolder: getAppSetting('defaultTitlepicsFolder') || '',
            titlePicFileName: wad.titlePicFileName || '',
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Associated file deletion failed.');
        const deletedCount = (payload.deleted || []).filter((entry) => entry.deleted).length;
        if (deletedCount) showAlert('success', `Deleted ${deletedCount} associated file(s) from disk.`);
      } catch (error) {
        console.error(error);
        showAlert('error', error.message || 'Could not delete associated files. The WAD card will still be removed.');
      }
    }

    state.app.wads = state.app.wads.filter((entry) => entry.id !== wadId);

    if (state.currentWadId === wadId) {
      state.currentWadId = null;
      window.appActions.goLibrary();
    }

    await saveState();
    showAlert('success', `Deleted ${wad.title}.`);
    render();
  },
  addManualMap: (runId) => {
    state.currentMapContext = { runId, mapId: null };
    state.mapInputMode = 'counts';
    mapForm.reset();
    mapForm.elements.runId.value = runId;
    mapForm.elements.mapId.value = '';
    mapForm.elements.sourceType.value = 'manual';
    if (mapForm.elements.difficulty) mapForm.elements.difficulty.value = getLatestRun(getCurrentWad())?.difficulty || 'UV';
    mapForm.elements.mapAuthor.value = '';
    mapForm.elements.leveltime.value = '0:00';
    updateLevelTimePreview();
    deleteMapButton.style.visibility = 'hidden';
    updateInputModeUI();
    mapDialog.showModal();
  },
  editMap: (runId, mapId) => {
    const wad = getCurrentWad();
    if (!wad) return;
    const run = wad.runs.find((entry) => entry.id === runId);
    const map = run?.maps.find((entry) => entry.id === mapId);
    if (!map) return;
    state.currentMapContext = { runId, mapId };
    state.mapInputMode = 'counts';
    mapForm.reset();
    mapForm.elements.runId.value = runId;
    mapForm.elements.mapId.value = map.id;
    mapForm.elements.levelName.value = map.levelName;
    mapForm.elements.displayName.value = map.displayName || '';
    mapForm.elements.mapAuthor.value = map.mapAuthor || '';
    setNamedInputValues('totalkills', map.totalkills);
    setNamedInputValues('totalitems', map.totalitems);
    setNamedInputValues('totalsecrets', map.totalsecrets);
    mapForm.elements.killcount.value = map.killcount;
    mapForm.elements.itemcount.value = map.itemcount;
    mapForm.elements.secretcount.value = map.secretcount;
    mapForm.elements.leveltime.value = formatTicsForInput(map.leveltime);
    updateLevelTimePreview();
    mapForm.elements.deaths.value = map.deaths || 0;
    if (mapForm.elements.difficulty) mapForm.elements.difficulty.value = map.difficulty || run.difficulty || 'UV';
    mapForm.elements.sourceType.value = map.sourceType || 'manual';
    mapForm.elements.saveFileName.value = map.saveFileName || '';
    mapForm.elements.notes.value = map.notes || '';
    deleteMapButton.style.visibility = 'visible';
    updateInputModeUI();
    mapDialog.showModal();
  },
};
