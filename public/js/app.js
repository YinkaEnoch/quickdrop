'use strict';

/**
 * QuickDrop UI — vanilla JS, no dependencies (CSP serves this as an
 * external file; no inline script/style anywhere). Never logs keys or text.
 */
(function () {
  const app = document.getElementById('app');
  if (!app) return;

  const limits = {
    maxFileSizeBytes: Number(app.dataset.maxFileSizeMb) * 1024 * 1024,
    maxFiles: Number(app.dataset.maxFiles),
    maxTextBytes: Number(app.dataset.maxTextKb) * 1024,
    expirationMinutes: Number(app.dataset.expirationMinutes),
  };

  const el = {
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    fileList: document.getElementById('file-list'),
    textInput: document.getElementById('text-input'),
    sendBtn: document.getElementById('send-btn'),
    progress: document.getElementById('upload-progress'),
    progressBar: document.getElementById('upload-progress-bar'),
    sendError: document.getElementById('send-error'),
    sendResult: document.getElementById('send-result'),
    shareKey: document.getElementById('share-key'),
    copyKeyBtn: document.getElementById('copy-key-btn'),
    keyInput: document.getElementById('key-input'),
    retrieveBtn: document.getElementById('retrieve-btn'),
    receiveError: document.getElementById('receive-error'),
    details: document.getElementById('transfer-details'),
    detailFiles: document.getElementById('detail-files'),
    detailText: document.getElementById('detail-text'),
    detailExpiry: document.getElementById('detail-expiry'),
    copyTextBtn: document.getElementById('copy-text-btn'),
    downloadTextBtn: document.getElementById('download-text-btn'),
    downloadAllBtn: document.getElementById('download-all-btn'),
    consumeStatus: document.getElementById('consume-status'),
  };

  /** Send-panel state. */
  const send = { files: [], uploading: false };
  /** Last retrieved transfer (non-consuming metadata view). */
  let current = null;
  let pollTimer = null;

  // --- helpers ---------------------------------------------------------

  function setHidden(node, hidden) {
    node.classList.toggle('hidden', hidden);
  }

  function showError(node, message) {
    node.textContent = message;
    setHidden(node, !message);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes;
    let unit = -1;
    do {
      value /= 1024;
      unit += 1;
    } while (value >= 1024 && unit < units.length - 1);
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
  }

  /** '7k4p 9xqm' → '7K4P9XQM'. */
  function compactKey(raw) {
    return raw.replace(/[\s-]+/g, '').toUpperCase().slice(0, 8);
  }

  /** '7K4P9XQM' → '7K4P-9XQM'. */
  function displayKey(canonical) {
    return canonical.length === 8
      ? `${canonical.slice(0, 4)}-${canonical.slice(4)}`
      : canonical;
  }

  function byteLength(text) {
    return new TextEncoder().encode(text).length;
  }

  /** Server messages are already user-facing; sensible fallbacks otherwise. */
  function friendlyError(status, serverMessage) {
    if (serverMessage) return serverMessage;
    if (status === 404) return 'Transfer not found or expired.';
    if (status === 409) return 'This transfer is currently being downloaded.';
    if (status === 413) return 'That is too large for a transfer.';
    if (status === 429) return 'Too many requests — please wait a moment and try again.';
    if (status >= 500) return 'The transfer could not be completed. Please try again.';
    return 'Something went wrong. Please try again.';
  }

  /** fetch wrapper: throws Error with `.status` set (0 = network failure). */
  async function request(url, options) {
    let response;
    try {
      response = await fetch(url, options);
    } catch {
      const error = new Error('Network error — check your connection and try again.');
      error.status = 0;
      throw error;
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* non-JSON body */
    }
    if (!response.ok) {
      const error = new Error(friendlyError(response.status, body && body.error));
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.className = 'clipboard-scratch';
    scratch.setAttribute('readonly', '');
    document.body.appendChild(scratch);
    scratch.select();
    document.execCommand('copy');
    scratch.remove();
  }

  // --- file selection (click + drag & drop) ----------------------------

  function renderFileList() {
    el.fileList.replaceChildren();
    send.files.forEach((entry, index) => {
      const item = document.createElement('li');
      item.className = 'file-item';

      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = entry.name; // textContent only — never innerHTML

      const size = document.createElement('span');
      size.className = 'file-size';
      size.textContent = formatBytes(entry.size);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'file-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${entry.name}`);
      remove.addEventListener('click', () => {
        send.files.splice(index, 1);
        renderFileList();
      });

      item.append(name, size, remove);
      el.fileList.appendChild(item);
    });
  }

  function addFiles(fileList) {
    showError(el.sendError, '');
    for (const file of fileList) {
      if (send.files.length >= limits.maxFiles) {
        showError(
          el.sendError,
          `A transfer can contain at most ${limits.maxFiles} files.`,
        );
        break;
      }
      if (file.size > limits.maxFileSizeBytes) {
        showError(
          el.sendError,
          `“${file.name}” exceeds the ${limits.maxFileSizeMb} MB per-file limit.`,
        );
        continue;
      }
      send.files.push(file);
    }
    renderFileList();
  }

  el.dropZone.addEventListener('click', () => el.fileInput.click());
  el.dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      el.fileInput.click();
    }
  });
  el.fileInput.addEventListener('change', () => {
    addFiles(el.fileInput.files);
    el.fileInput.value = ''; // allow re-selecting the same file later
  });

  for (const type of ['dragenter', 'dragover']) {
    el.dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      el.dropZone.classList.add('dragover');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    el.dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      el.dropZone.classList.remove('dragover');
    });
  }
  el.dropZone.addEventListener('drop', (event) => {
    if (event.dataTransfer && event.dataTransfer.files) {
      addFiles(event.dataTransfer.files);
    }
  });
  // Dropping a file anywhere else must not navigate away from the page.
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => event.preventDefault());


  // --- upload (XHR for real progress events) ---------------------------

  function setProgress(percent) {
    el.progressBar.style.width = `${percent}%`; // CSSOM write — CSP-safe
    el.progress.setAttribute('aria-valuenow', String(Math.round(percent)));
  }

  function resetSendForm() {
    send.files = [];
    renderFileList();
    el.textInput.value = '';
  }

  function showShareKey(key) {
    el.shareKey.textContent = key;
    el.shareKey.dataset.key = key;
    el.copyKeyBtn.textContent = 'Copy key';
    setHidden(el.sendResult, false);
  }

  function finishUpload() {
    send.uploading = false;
    el.sendBtn.disabled = false;
    el.sendBtn.textContent = 'Create transfer';
    window.setTimeout(() => setHidden(el.progress, true), 400);
  }

  function upload() {
    if (send.uploading) return;
    showError(el.sendError, '');

    const text = el.textInput.value;
    if (send.files.length === 0 && text.trim().length === 0) {
      showError(el.sendError, 'Add at least one file or some text to share.');
      return;
    }
    if (byteLength(text) > limits.maxTextBytes) {
      showError(el.sendError, `Text exceeds the ${limits.maxTextKb} KB limit.`);
      return;
    }

    const formData = new FormData();
    for (const file of send.files) formData.append('files', file, file.name);
    if (text.length > 0) formData.append('text', text);

    send.uploading = true;
    el.sendBtn.disabled = true;
    el.sendBtn.textContent = 'Uploading…';
    setHidden(el.progress, false);
    setHidden(el.sendResult, true);
    setProgress(0);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/transfers');
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        setProgress((event.loaded / event.total) * 100);
      }
    });
    xhr.addEventListener('load', () => {
      const body = xhr.response;
      finishUpload();
      if (xhr.status >= 200 && xhr.status < 300 && body && body.key) {
        setProgress(100);
        showShareKey(body.key);
        resetSendForm();
      } else {
        showError(el.sendError, friendlyError(xhr.status, body && body.error));
      }
    });
    xhr.addEventListener('error', () => {
      finishUpload();
      showError(el.sendError, 'Network error — check your connection and try again.');
    });
    xhr.addEventListener('abort', finishUpload);
    xhr.send(formData);
  }

  el.sendBtn.addEventListener('click', upload);

  el.copyKeyBtn.addEventListener('click', async () => {
    try {
      await copyText(el.shareKey.dataset.key || el.shareKey.textContent);
      el.copyKeyBtn.textContent = 'Copied!';
    } catch {
      el.copyKeyBtn.textContent = 'Copy failed';
    }
  });


  // --- retrieve (non-consuming metadata) -------------------------------

  function currentKeyUrl(suffix) {
    const key = displayKey(compactKey(el.keyInput.value));
    return `/api/transfers/${encodeURIComponent(key)}${suffix}`;
  }

  function renderDetails(meta) {
    current = meta;
    el.detailFiles.replaceChildren();
    for (const file of meta.files) {
      const item = document.createElement('li');
      item.className = 'file-item';
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = file.name;
      const size = document.createElement('span');
      size.className = 'file-size';
      size.textContent = formatBytes(file.size);
      item.append(name, size);
      el.detailFiles.appendChild(item);
    }

    const hasText = typeof meta.text === 'string' && meta.text.length > 0;
    el.detailText.textContent = hasText ? meta.text : '';
    setHidden(el.detailText, !hasText);
    setHidden(el.copyTextBtn, !hasText);
    setHidden(el.downloadTextBtn, !hasText);

    const expires = new Date(meta.expiresAt);
    el.detailExpiry.textContent =
      `Expires ${expires.toLocaleString()} · ${meta.files.length} file(s)`;
    setHidden(el.consumeStatus, true);
    el.consumeStatus.textContent = '';
    setHidden(el.details, false);
  }

  async function retrieve() {
    showError(el.receiveError, '');
    const key = compactKey(el.keyInput.value);
    if (key.length !== 8) {
      showError(el.receiveError, 'Enter the 8-character key you received (XXXX-XXXX).');
      return;
    }
    el.keyInput.value = displayKey(key);
    el.retrieveBtn.disabled = true;
    try {
      renderDetails(await request(currentKeyUrl('')));
    } catch (error) {
      current = null;
      setHidden(el.details, true);
      showError(el.receiveError, error.message);
    } finally {
      el.retrieveBtn.disabled = false;
    }
  }

  el.retrieveBtn.addEventListener('click', retrieve);
  el.keyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') retrieve();
  });
  el.keyInput.addEventListener('blur', () => {
    const key = compactKey(el.keyInput.value);
    if (key.length > 0) el.keyInput.value = displayKey(key);
  });

  el.copyTextBtn.addEventListener('click', async () => {
    if (!current) return;
    try {
      await copyText(current.text || '');
      el.copyTextBtn.textContent = 'Copied!';
      window.setTimeout(() => {
        el.copyTextBtn.textContent = 'Copy text';
      }, 1500);
    } catch {
      el.copyTextBtn.textContent = 'Copy failed';
    }
  });

  // Text download is client-side (Blob) on purpose: only “Download
  // everything” talks to /download, which is what consumes the transfer.
  el.downloadTextBtn.addEventListener('click', () => {
    if (!current || typeof current.text !== 'string') return;
    const url = URL.createObjectURL(new Blob([current.text], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'quickdrop.txt';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });


  // --- download everything + post-download consumption check ------------

  function setConsumed(message) {
    current = null;
    el.detailFiles.replaceChildren();
    el.detailText.textContent = '';
    setHidden(el.detailText, true);
    el.detailExpiry.textContent = 'Deleted after its first completed download.';
    setHidden(el.copyTextBtn, true);
    setHidden(el.downloadTextBtn, true);
    setHidden(el.downloadAllBtn, true);
    setHidden(el.consumeStatus, false);
    el.consumeStatus.textContent = message;
  }

  /**
   * The server deletes the transfer when the download stream finishes, so
   * polling the (non-consuming) metadata endpoint tells us when it's gone.
   * 404 → consumed; network trouble → stop quietly without lying.
   */
  function watchConsumption() {
    if (pollTimer !== null) window.clearInterval(pollTimer);
    let attempts = 0;
    pollTimer = window.setInterval(async () => {
      attempts += 1;
      if (current === null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
        return;
      }
      try {
        await request(currentKeyUrl(''));
        if (attempts >= 3) {
          setHidden(el.consumeStatus, false);
          el.consumeStatus.textContent =
            'Download in progress — the transfer is deleted when it finishes.';
        }
        if (attempts >= 30) {
          // Still present after ~30s: leave the UI as-is rather than lie.
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
      } catch (error) {
        window.clearInterval(pollTimer);
        pollTimer = null;
        if (error.status === 404) {
          setConsumed('Downloaded — this transfer has now been deleted.');
        }
      }
    }, 1000);
  }

  el.downloadAllBtn.addEventListener('click', () => {
    if (!current) return;
    const anchor = document.createElement('a');
    anchor.href = currentKeyUrl('/download');
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setHidden(el.consumeStatus, false);
    el.consumeStatus.textContent = 'Downloading — waiting for it to finish…';
    watchConsumption();
  });
})();

