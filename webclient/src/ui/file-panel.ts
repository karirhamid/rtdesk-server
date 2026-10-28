// RTDesk web client — in-session file-transfer panel.
//
// A window over the live session (no second login): the panel opens its own
// FILE_TRANSFER relay connection to the same peer, authenticating silently with
// the credential the desktop session already proved. Laid out like AnyDesk's
// file manager: this computer left, the remote computer right, Send / Receive
// between them, the transfers underneath. Lists look like the macOS Finder
// (ft-icons.ts) and only the rows that change are touched on selection, so a
// large folder stays fast.
//
// Local side is the browser, so "local" means:
//   - Chromium: a real directory opened with showDirectoryPicker() — browse,
//     upload from and download into it (writes are atomic: data commits on
//     close, so a cancelled download never clobbers an existing file).
//   - Fallback: stage files with a picker/drag-drop for upload; downloads go
//     to the browser's Downloads folder.
//
// Wire protocol (second relay connection, ConnType.FILE_TRANSFER):
//   browse    read_dir -> dir(id=0)
//   download  send{id} -> dir(id) file list -> per file: digest -> our
//             send_confirm(offset) -> blocks (empty block = EOF) -> done(id)
//   upload    receive{id, files} -> per file: our digest -> peer confirm
//             (send_confirm, or digest{is_upload} asking us to decide) ->
//             blocks -> done(id, fileCount) -> peer echoes done
//   ops       create/remove_file/remove_dir/rename -> done/error ack
import './file-panel.css';
import type { FtDirectory, FtEntry, SessionConfig, SessionEvent, SessionState, UiCommand } from '../core/contracts';
import {
  FT_BLOCK_SIZE,
  formatBytes,
  isDirKind,
  joinRemote,
  parentRemote,
} from '../core/file-transfer';
import { escapeHtml, iconHtml, type IconName } from './common';
import { ensureFtSprite, ftDate, ftEta, ftIcon, ftKind, ftSize } from './ft-icons';

type PickerWindow = Window & {
  showDirectoryPicker?(opts?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
};

// queryPermission/requestPermission are WICG additions not yet in lib.dom.
type PermissionedHandle = FileSystemDirectoryHandle & {
  queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
};

const MEM_DOWNLOAD_WARN = 512 * 1024 * 1024; // fallback downloads buffer in RAM
const UPLOAD_BACKLOG_LIMIT = 8 * 1024 * 1024; // pause while ws send buffer exceeds this

type ConflictDecision = { action: 'overwrite' | 'skip' | 'cancel'; applyAll: boolean };
type ConflictPolicy = 'ask' | 'overwrite' | 'skip';

type LocalEntry = {
  kind: 'dir' | 'file';
  name: string;
  size: number;
  modifiedMs: number;
  handle?: FileSystemDirectoryHandle | FileSystemFileHandle;
  file?: File; // fallback staged file
};

type UploadFile = { rel: string; file: File };

type Job = {
  id: number;
  kind: 'download' | 'upload';
  label: string;
  status: 'starting' | 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
  totalSize: number;
  doneBytes: number;
  fileCount: number;
  currentFile: string;
  policy: ConflictPolicy | null; // sticky per-job override from "apply to all"
  startMs: number;
  lastBytes: number; // for speed sampling
  lastSampleMs: number;
  speedBps: number;
  // download state
  remoteFiles?: FtEntry[];
  destDir?: FileSystemDirectoryHandle | null; // null = memory/anchor fallback
  curFileNum?: number;
  writable?: FileSystemWritableFileStream;
  memBuf?: Uint8Array[];
  writeChain?: Promise<void>;
  // upload state
  files?: UploadFile[];
  confirmWaiter?: (r: { skip: boolean; offsetBytes: number } | 'cancelled') => void;
  sentWaiter?: (buffered: number) => void;
  peerDone?: boolean;
};

type PendingConflict = {
  jobId: number;
  name: string;
  detail: string;
  resolve: (d: ConflictDecision) => void;
};

export type FilePanelOpts = {
  viewport: HTMLElement;
  workerUrl: string;
  toast: (msg: string) => void;
  // Built fresh on every (re)connect — must carry connType:'fileTransfer' and
  // the session's h1 credential; null when the desktop session isn't ready.
  getConfig: () => SessionConfig | null;
  /** Told when the window opens or closes (the dock button shows it). */
  onToggle?: (open: boolean) => void;
};

type Side = 'local' | 'remote';

type Els = {
  panel: HTMLElement;
  status: HTMLElement;
  btnHidden: HTMLButtonElement;
  localSub: HTMLElement;
  localCrumbs: HTMLElement;
  localBody: HTMLElement;
  localFoot: HTMLElement;
  localEmpty: HTMLElement;
  remoteSub: HTMLElement;
  remoteCrumbs: HTMLElement;
  remotePath: HTMLInputElement;
  remoteBody: HTMLElement;
  remoteFoot: HTMLElement;
  remoteEmpty: HTMLElement;
  btnSend: HTMLButtonElement;
  btnRecv: HTMLButtonElement;
  btnLog: HTMLButtonElement;
  btnClear: HTMLButtonElement;
  queueSum: HTMLElement;
  jobsWrap: HTMLElement;
  logWrap: HTMLElement;
  dialog: HTMLElement;
};

/** Drag between the two lists carries which side it came from. */
const DRAG_TYPE = 'application/x-rtdesk-ft';

function q<T extends Element>(scope: ParentNode, sel: string): T {
  const el = scope.querySelector<T>(sel);
  if (!el) throw new Error(`rdclient: missing element ${sel}`);
  return el;
}

function nowMs(): number {
  return Date.now();
}

export class FilePanel {
  private readonly opts: FilePanelOpts;
  private el!: Els;
  private worker: Worker | undefined;
  private state: SessionState = 'closed';
  private peerLabel = '';
  private sep: '\\' | '/' = '/';
  private showHidden = false;
  private nextId = 1;
  private jobs: Job[] = [];
  private conflicts: PendingConflict[] = [];
  private conflictOpen = false;
  private ops = new Map<number, { desc: string; refresh: boolean }>();
  private ticker: ReturnType<typeof setInterval> | undefined;
  private dragFrom: Side | null = null;
  private beforeUnload = (): void => this.post({ c: 'disconnect' });

  // remote pane
  private remotePathValue = '';
  private remoteEntries: FtEntry[] = [];
  private remoteSel = new Set<number>();
  private remoteAnchor = -1;

  // local pane
  private fsMode = false;
  private rootHandle: FileSystemDirectoryHandle | undefined;
  private dirStack: FileSystemDirectoryHandle[] = []; // [root, ..., cwd]
  private localEntries: LocalEntry[] = [];
  private staged: File[] = []; // fallback mode
  private localSel = new Set<number>();
  private localAnchor = -1;
  private localListGen = 0;

  constructor(opts: FilePanelOpts) {
    this.opts = opts;
    this.fsMode = typeof (window as PickerWindow).showDirectoryPicker === 'function';
    this.render();
    this.ticker = setInterval(() => this.tickJobs(), 500);
    window.addEventListener('beforeunload', this.beforeUnload);
    this.log('Fenêtre de transfert prête.');
    if (!this.fsMode) {
      this.log('Ce navigateur ne peut pas ouvrir de dossier : les fichiers à envoyer sont ajoutés un par un, les fichiers reçus vont dans Téléchargements.');
    }
  }

  get isOpen(): boolean {
    return !this.el.panel.classList.contains('rd-ft-closed');
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.el.panel.classList.remove('rd-ft-closed');
    this.connectIfNeeded();
    // Focus inside the window: keys typed here never reach the remote desktop.
    this.el.remoteBody.focus({ preventScroll: true });
    this.opts.onToggle?.(true);
  }

  close(): void {
    // Hide only — the file connection stays warm (the session core echoes the
    // peer's TestDelay keepalive) so reopening is instant and running
    // transfers continue in the background.
    this.el.panel.classList.add('rd-ft-closed');
    this.opts.onToggle?.(false);
  }

  destroy(): void {
    this.post({ c: 'disconnect' });
    this.teardown();
    if (this.ticker) clearInterval(this.ticker);
    window.removeEventListener('beforeunload', this.beforeUnload);
    this.el.panel.remove();
  }

  // --- connection ------------------------------------------------------------

  private connectIfNeeded(): void {
    if (this.worker && this.state !== 'error' && this.state !== 'closed') return;
    const config = this.opts.getConfig();
    if (!config) {
      this.setStatus('error', 'La session n’est pas connectée');
      return;
    }
    this.peerLabel = config.peerId;
    this.teardown();
    const worker = new Worker(this.opts.workerUrl, { type: 'module' });
    this.worker = worker;
    worker.onmessage = (e: MessageEvent) => this.onEvent(e.data as SessionEvent);
    worker.onerror = (e: ErrorEvent) => {
      this.state = 'error';
      this.setStatus('error', e.message || 'Le canal de fichiers s’est arrêté');
    };
    this.post({ c: 'connectFile', config });
    this.state = 'connecting';
    this.setStatus('busy', 'Ouverture du canal de fichiers…');
  }

  private teardown(): void {
    const w = this.worker;
    this.worker = undefined;
    if (w) setTimeout(() => w.terminate(), 250);
    for (const job of this.jobs) {
      if (job.status === 'running' || job.status === 'starting') {
        job.status = 'error';
        job.error = 'connexion fermée';
        job.confirmWaiter?.('cancelled');
        job.sentWaiter?.(0);
        void this.closeJobFile(job, false);
      }
    }
    this.renderJobs();
  }

  private post(cmd: UiCommand, transfer?: Transferable[]): void {
    if (!this.worker) return;
    if (transfer) this.worker.postMessage(cmd, transfer);
    else this.worker.postMessage(cmd);
  }

  // --- DOM -------------------------------------------------------------------

  private render(): void {
    ensureFtSprite();
    const ib = (id: string, icon: IconName, title: string, label = ''): string =>
      `<button type="button" class="ftx-ib${label ? ' ftx-ib-label' : ''}" id="${id}" title="${title}" aria-label="${title}">` +
      `${iconHtml(icon)}${label ? `<span>${label}</span>` : ''}</button>`;

    const pane = (side: Side): string => {
      const local = side === 'local';
      const actions = local
        ? (this.fsMode
            ? ib('rd-ft-local-open', 'folderOpen', 'Ouvrir un dossier de cet ordinateur', 'Ouvrir un dossier')
            : ib('rd-ft-local-add', 'folderOpen', 'Ajouter des fichiers à envoyer', 'Ajouter des fichiers')) +
          ib('rd-ft-local-send', 'fileUpload', 'Choisir des fichiers et les envoyer tout de suite', 'Envoyer des fichiers…')
        : ib('rd-ft-remote-new', 'newFolder', 'Nouveau dossier') +
          ib('rd-ft-remote-rename', 'rename', 'Renommer (F2)') +
          ib('rd-ft-remote-del', 'trash', 'Supprimer (Suppr)');
      return `
      <section class="ftx-pane" id="rd-ft-${side}" data-side="${side}">
        <header class="ftx-pane-head">
          ${ftIcon(local ? 'computer' : 'remote', 'ftx-pane-ic')}
          <div class="ftx-pane-title"><b>${local ? 'Cet ordinateur' : 'Poste distant'}</b><small id="rd-ft-${side}-sub"></small></div>
          <div class="ftx-pane-actions">${actions}</div>
        </header>
        <div class="ftx-nav">
          ${ib(`rd-ft-${side}-up`, 'arrowUp', 'Dossier parent (Retour arrière)')}
          ${local ? '' : ib('rd-ft-remote-home', 'home', 'Dossier personnel')}
          <nav class="ftx-crumbs" id="rd-ft-${side}-crumbs" aria-label="Emplacement"></nav>
          ${local ? '' : '<input id="rd-ft-remote-path" class="ftx-path" type="text" spellcheck="false" autocomplete="off" placeholder="Chemin du dossier, puis Entrée" hidden>' + ib('rd-ft-remote-edit', 'keyboard', 'Saisir un chemin')}
          ${ib(`rd-ft-${side}-refresh`, 'refresh', 'Actualiser')}
        </div>
        <div class="ftx-cols" aria-hidden="true"><span>Nom</span><span class="ftx-mod">Modifié le</span><span class="ftx-size">Taille</span><span class="ftx-kind">Type</span></div>
        <div class="ftx-listwrap">
          <div class="ftx-list" id="rd-ft-${side}-body" tabindex="0" role="listbox" aria-multiselectable="true"
               aria-label="${local ? 'Fichiers de cet ordinateur' : 'Fichiers du poste distant'}"></div>
          <div class="ftx-empty" id="rd-ft-${side}-empty" hidden></div>
        </div>
        <footer class="ftx-foot" id="rd-ft-${side}-foot"></footer>
      </section>`;
    };

    const panel = document.createElement('div');
    panel.id = 'rd-ft-overlay';
    panel.className = 'rd-ft-closed';
    panel.innerHTML = `
      <div class="ftx-backdrop" id="rd-ft-backdrop"></div>
      <div class="ftx-win" role="dialog" aria-modal="true" aria-labelledby="rd-ft-title">
        <header class="ftx-head">
          <span class="ftx-title" id="rd-ft-title">${iconHtml('folderTransfer')}<b>Transfert de fichiers</b></span>
          <span class="ftx-status" id="rd-ft-status"></span>
          <span class="ftx-spacer"></span>
          ${ib('rd-ft-hidden', 'eyeOff', 'Afficher les fichiers cachés', 'Fichiers cachés')}
          ${ib('rd-ft-close', 'close', 'Fermer (Échap)')}
        </header>
        <div class="ftx-panes">
          ${pane('local')}
          <div class="ftx-mid">
            <button type="button" class="ftx-go" id="rd-ft-send" disabled title="Envoyer la sélection vers le poste distant">
              <span class="ftx-go-ic">${iconHtml('sendRight')}</span><b>Envoyer</b><small>vers le poste distant</small>
            </button>
            <button type="button" class="ftx-go ftx-go-recv" id="rd-ft-recv" disabled title="Recevoir la sélection sur cet ordinateur">
              <span class="ftx-go-ic">${iconHtml('sendLeft')}</span><b>Recevoir</b><small>sur cet ordinateur</small>
            </button>
          </div>
          ${pane('remote')}
        </div>
        <section class="ftx-queue" aria-label="Transferts">
          <header class="ftx-queue-head">
            <b>Transferts</b><span class="ftx-queue-sum" id="rd-ft-queue-sum"></span>
            <span class="ftx-spacer"></span>
            <button type="button" class="ftx-link" id="rd-ft-clear" hidden>Effacer les terminés</button>
            <button type="button" class="ftx-link" id="rd-ft-tab-log" aria-expanded="false">Journal</button>
          </header>
          <div class="ftx-jobs" id="rd-ft-jobs"></div>
          <div class="ftx-log" id="rd-ft-log" hidden></div>
        </section>
        <div class="ftx-dialog" id="rd-ft-dialog" hidden></div>
      </div>`;
    this.opts.viewport.appendChild(panel);

    const m = panel;
    this.el = {
      panel,
      status: q(m, '#rd-ft-status'),
      btnHidden: q(m, '#rd-ft-hidden'),
      localSub: q(m, '#rd-ft-local-sub'),
      localCrumbs: q(m, '#rd-ft-local-crumbs'),
      localBody: q(m, '#rd-ft-local-body'),
      localFoot: q(m, '#rd-ft-local-foot'),
      localEmpty: q(m, '#rd-ft-local-empty'),
      remoteSub: q(m, '#rd-ft-remote-sub'),
      remoteCrumbs: q(m, '#rd-ft-remote-crumbs'),
      remotePath: q(m, '#rd-ft-remote-path'),
      remoteBody: q(m, '#rd-ft-remote-body'),
      remoteFoot: q(m, '#rd-ft-remote-foot'),
      remoteEmpty: q(m, '#rd-ft-remote-empty'),
      btnSend: q(m, '#rd-ft-send'),
      btnRecv: q(m, '#rd-ft-recv'),
      btnLog: q(m, '#rd-ft-tab-log'),
      btnClear: q(m, '#rd-ft-clear'),
      queueSum: q(m, '#rd-ft-queue-sum'),
      jobsWrap: q(m, '#rd-ft-jobs'),
      logWrap: q(m, '#rd-ft-log'),
      dialog: q(m, '#rd-ft-dialog'),
    };

    q<HTMLButtonElement>(m, '#rd-ft-close').addEventListener('click', () => this.close());
    q<HTMLElement>(m, '#rd-ft-backdrop').addEventListener('click', () => this.close());
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.el.dialog.hidden) {
        e.preventDefault();
        this.close();
      }
    });
    this.el.btnHidden.addEventListener('click', () => {
      this.showHidden = !this.showHidden;
      this.el.btnHidden.classList.toggle('is-on', this.showHidden);
      this.el.btnHidden.innerHTML = `${iconHtml(this.showHidden ? 'eye' : 'eyeOff')}<span>Fichiers cachés</span>`;
      this.el.btnHidden.title = this.showHidden ? 'Masquer les fichiers cachés' : 'Afficher les fichiers cachés';
      this.readRemote(this.remotePathValue);
      void this.refreshLocal();
    });

    q<HTMLButtonElement>(m, '#rd-ft-local-send').addEventListener('click', () => this.pickAndSendFiles());
    if (this.fsMode) {
      q<HTMLButtonElement>(m, '#rd-ft-local-open').addEventListener('click', () => void this.openLocalFolder());
    } else {
      q<HTMLButtonElement>(m, '#rd-ft-local-add').addEventListener('click', () => this.pickStagedFiles());
    }
    q<HTMLButtonElement>(m, '#rd-ft-local-up').addEventListener('click', () => void this.localUp());
    q<HTMLButtonElement>(m, '#rd-ft-local-refresh').addEventListener('click', () => void this.refreshLocal());
    q<HTMLButtonElement>(m, '#rd-ft-remote-up').addEventListener('click', () => this.remoteUp());
    q<HTMLButtonElement>(m, '#rd-ft-remote-home').addEventListener('click', () => this.readRemote(''));
    q<HTMLButtonElement>(m, '#rd-ft-remote-refresh').addEventListener('click', () => this.readRemote(this.remotePathValue));
    q<HTMLButtonElement>(m, '#rd-ft-remote-new').addEventListener('click', () => this.newRemoteFolder());
    q<HTMLButtonElement>(m, '#rd-ft-remote-rename').addEventListener('click', () => this.renameRemote());
    q<HTMLButtonElement>(m, '#rd-ft-remote-del').addEventListener('click', () => this.deleteRemote());
    q<HTMLButtonElement>(m, '#rd-ft-remote-edit').addEventListener('click', () => {
      const input = this.el.remotePath;
      input.hidden = !input.hidden;
      this.el.remoteCrumbs.hidden = !input.hidden;
      if (!input.hidden) {
        input.value = this.remotePathValue;
        input.focus();
        input.select();
      }
    });
    this.el.remotePath.addEventListener('keydown', (e) => {
      e.stopPropagation(); // Escape here closes the field, not the window
      if (e.key === 'Enter') this.readRemote(this.el.remotePath.value.trim());
      if (e.key === 'Escape' || e.key === 'Enter') {
        this.el.remotePath.hidden = true;
        this.el.remoteCrumbs.hidden = false;
      }
    });
    for (const [crumbs, go] of [
      [this.el.remoteCrumbs, (path: string) => this.readRemote(path)],
      [this.el.localCrumbs, (depth: string) => void this.localJump(Number(depth))],
    ] as Array<[HTMLElement, (v: string) => void]>) {
      crumbs.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-go]');
        if (b && !b.hasAttribute('aria-current')) go(b.dataset.go!);
      });
    }

    this.el.btnSend.addEventListener('click', () => void this.startUpload());
    this.el.btnRecv.addEventListener('click', () => this.startDownloads());
    this.el.btnClear.addEventListener('click', () => {
      this.jobs = this.jobs.filter((j) => j.status === 'running' || j.status === 'starting');
      this.renderJobs();
    });
    this.el.btnLog.addEventListener('click', () => {
      const show = this.el.logWrap.hidden;
      this.el.logWrap.hidden = !show;
      this.el.jobsWrap.hidden = show;
      this.el.btnLog.textContent = show ? 'Transferts' : 'Journal';
      this.el.btnLog.setAttribute('aria-expanded', String(show));
    });
    this.el.jobsWrap.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-job]');
      const job = b ? this.jobById(Number(b.dataset.job)) : undefined;
      if (job) this.cancelJob(job);
    });

    this.wireList(this.el.localBody, 'local');
    this.wireList(this.el.remoteBody, 'remote');

    // Drops: files from the computer onto the remote pane upload; onto the local
    // pane (no folder access) they are staged. Rows dragged from one pane onto
    // the other send or receive the selection, like dragging between two windows.
    const remotePane = q<HTMLElement>(m, '#rd-ft-remote');
    const localPane = q<HTMLElement>(m, '#rd-ft-local');
    for (const [paneEl, side] of [[remotePane, 'remote'], [localPane, 'local']] as Array<[HTMLElement, Side]>) {
      paneEl.addEventListener('dragover', (e) => {
        const types = e.dataTransfer?.types ?? [];
        const fromOther = types.includes(DRAG_TYPE) && this.dragFrom !== side;
        if (!fromOther && !types.includes('Files')) return;
        e.preventDefault();
        paneEl.classList.add('is-drop');
      });
      paneEl.addEventListener('dragleave', (e) => {
        if (!paneEl.contains(e.relatedTarget as Node | null)) paneEl.classList.remove('is-drop');
      });
      paneEl.addEventListener('drop', (e) => {
        e.preventDefault();
        paneEl.classList.remove('is-drop');
        const from = e.dataTransfer?.getData(DRAG_TYPE);
        if (from && from !== side) {
          if (side === 'remote') void this.startUpload();
          else this.startDownloads();
          return;
        }
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (!files.length) return;
        if (side === 'remote') void this.uploadFiles(files.map((f) => ({ rel: f.name, file: f })));
        else this.stageFiles(files);
      });
    }

    this.updateLocalEmpty();
    this.renderLocal();
    this.renderRemote();
    this.renderJobs();
    this.updateButtons();
  }

  private setStatus(kind: 'busy' | 'ok' | 'error', text: string): void {
    const s = this.el.status;
    s.className = `ftx-status is-${kind}`;
    s.innerHTML =
      (kind === 'busy' ? '<span class="rd-spinner" aria-hidden="true"></span>' : '<i aria-hidden="true"></i>') +
      `<span>${escapeHtml(text)}</span>` +
      (kind === 'error' ? '<button type="button" class="ftx-link" id="rd-ft-retry">Réessayer</button>' : '');
    s.querySelector('#rd-ft-retry')?.addEventListener('click', () => this.connectIfNeeded());
  }

  private wireList(list: HTMLElement, side: Side): void {
    const sel = (): Set<number> => (side === 'local' ? this.localSel : this.remoteSel);
    const count = (): number => (side === 'local' ? this.localEntries.length : this.remoteEntries.length);
    const setAnchor = (i: number): void => {
      if (side === 'local') this.localAnchor = i;
      else this.remoteAnchor = i;
    };
    const anchor = (): number => (side === 'local' ? this.localAnchor : this.remoteAnchor);
    const rowIdx = (t: EventTarget | null): number => {
      const row = (t as HTMLElement | null)?.closest<HTMLElement>('.ftx-row');
      return row ? Number(row.dataset.idx) : -1;
    };
    const open = (idx: number): void => {
      if (side === 'remote') {
        const entry = this.remoteEntries[idx];
        if (!entry) return;
        if (isDirKind(entry.kind)) this.readRemote(joinRemote(this.remotePathValue, entry.name, this.sep));
        else void this.startDownloadOf([entry]);
      } else {
        const entry = this.localEntries[idx];
        if (entry?.kind === 'dir' && this.fsMode) void this.localEnter(entry);
      }
    };

    list.addEventListener('click', (e) => {
      const idx = rowIdx(e.target);
      const s = sel();
      if (idx < 0) {
        // A click on the empty area clears the selection, as in Finder.
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey && s.size) {
          s.clear();
          this.paintSelection(side);
        }
        return;
      }
      if (e.shiftKey && anchor() >= 0) {
        s.clear();
        const [a, b] = [Math.min(anchor(), idx), Math.max(anchor(), idx)];
        for (let i = a; i <= b; i++) s.add(i);
      } else if (e.metaKey || e.ctrlKey) {
        if (s.has(idx)) s.delete(idx);
        else s.add(idx);
        setAnchor(idx);
      } else {
        s.clear();
        s.add(idx);
        setAnchor(idx);
      }
      this.paintSelection(side);
    });
    list.addEventListener('dblclick', (e) => {
      const idx = rowIdx(e.target);
      if (idx >= 0) open(idx);
    });
    list.addEventListener('keydown', (e) => {
      const s = sel();
      const n = count();
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n > 0) {
        e.preventDefault();
        const cur = anchor() >= 0 ? anchor() : -1;
        const next = Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
        if (!e.shiftKey) s.clear();
        s.add(next);
        setAnchor(next);
        this.paintSelection(side);
        list.querySelector<HTMLElement>(`.ftx-row[data-idx="${next}"]`)?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && s.size === 1) {
        e.preventDefault();
        open([...s][0]!);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        if (side === 'remote') this.remoteUp();
        else void this.localUp();
      } else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        for (let i = 0; i < n; i++) s.add(i);
        this.paintSelection(side);
      } else if (side === 'remote' && e.key === 'Delete') {
        e.preventDefault();
        this.deleteRemote();
      } else if (side === 'remote' && e.key === 'F2') {
        e.preventDefault();
        this.renameRemote();
      }
    });
    list.addEventListener('dragstart', (e) => {
      const idx = rowIdx(e.target);
      if (idx < 0 || !e.dataTransfer) return;
      const s = sel();
      if (!s.has(idx)) {
        s.clear();
        s.add(idx);
        setAnchor(idx);
        this.paintSelection(side);
      }
      this.dragFrom = side;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData(DRAG_TYPE, side);
    });
    list.addEventListener('dragend', () => {
      this.dragFrom = null;
    });
  }

  /** Selection change: toggles the affected rows only, never rebuilds the list. */
  private paintSelection(side: Side): void {
    const list = side === 'local' ? this.el.localBody : this.el.remoteBody;
    const sel = side === 'local' ? this.localSel : this.remoteSel;
    for (const row of Array.from(list.children) as HTMLElement[]) {
      const on = sel.has(Number(row.dataset.idx));
      if (row.classList.contains('is-sel') !== on) {
        row.classList.toggle('is-sel', on);
        row.setAttribute('aria-selected', String(on));
      }
    }
    this.renderFoot(side);
    this.updateButtons();
  }

  private renderFoot(side: Side): void {
    const entries: Array<{ size: number; kind: string }> = side === 'local' ? this.localEntries : this.remoteEntries;
    const sel = side === 'local' ? this.localSel : this.remoteSel;
    const foot = side === 'local' ? this.el.localFoot : this.el.remoteFoot;
    if (!entries.length) {
      foot.textContent = '';
      return;
    }
    const total = `${entries.length} élément${entries.length > 1 ? 's' : ''}`;
    if (!sel.size) {
      foot.textContent = total;
      return;
    }
    const bytes = [...sel].reduce((s, i) => s + (entries[i]?.size ?? 0), 0);
    foot.textContent = `${sel.size} sélectionné${sel.size > 1 ? 's' : ''} sur ${total}` + (bytes > 0 ? ` · ${ftSize(bytes)}` : '');
  }

  private rowHtml(i: number, name: string, kind: 'dir' | 'drive' | 'file', size: number, modMs: number, sel: boolean, hidden: boolean): string {
    const k = ftKind(name, kind);
    const safe = escapeHtml(name);
    return (
      `<div class="ftx-row${sel ? ' is-sel' : ''}${hidden ? ' is-hidden' : ''}" data-idx="${i}" role="option" aria-selected="${sel}" draggable="true" title="${safe}">` +
      `<span class="ftx-name">${ftIcon(k.icon)}<span class="ftx-label">${safe}</span></span>` +
      `<span class="ftx-mod">${ftDate(modMs)}</span>` +
      `<span class="ftx-size">${kind === 'file' ? ftSize(size) : '—'}</span>` +
      `<span class="ftx-kind">${k.label}</span></div>`
    );
  }

  private renderRemoteCrumbs(): void {
    const path = this.remotePathValue;
    const parts: Array<{ label: string; go: string }> = [];
    if (this.sep === '\\') {
      parts.push({ label: 'Ce PC', go: '/' });
      let acc = '';
      for (const seg of path.split('\\').filter((x) => x && x !== '/')) {
        acc = acc ? (acc.endsWith('\\') ? acc + seg : `${acc}\\${seg}`) : seg.endsWith(':') ? `${seg}\\` : seg;
        parts.push({ label: seg, go: acc });
      }
    } else {
      parts.push({ label: 'Racine', go: '/' });
      let acc = '';
      for (const seg of path.split('/').filter(Boolean)) {
        acc += `/${seg}`;
        parts.push({ label: seg, go: acc });
      }
    }
    this.el.remoteCrumbs.innerHTML = this.crumbsHtml(path ? parts : []);
  }

  private renderLocalCrumbs(): void {
    const parts = this.dirStack.map((d, i) => ({ label: d.name, go: String(i) }));
    this.el.localCrumbs.innerHTML = parts.length
      ? this.crumbsHtml(parts)
      : `<span class="ftx-crumb-none">${this.fsMode ? 'Aucun dossier ouvert' : 'Fichiers à envoyer'}</span>`;
  }

  private crumbsHtml(parts: Array<{ label: string; go: string }>): string {
    return parts
      .map((p, i) => {
        const last = i === parts.length - 1;
        return `<button type="button" class="ftx-crumb" data-go="${escapeHtml(p.go)}"${last ? ' aria-current="location"' : ''}>${escapeHtml(p.label)}</button>`;
      })
      .join('<span class="ftx-crumb-sep" aria-hidden="true">›</span>');
  }

  private async localJump(depth: number): Promise<void> {
    if (!this.fsMode || depth < 0 || depth >= this.dirStack.length - 1) return;
    this.dirStack.length = depth + 1;
    this.localSel.clear();
    this.localAnchor = -1;
    await this.refreshLocal();
  }

  // --- session events --------------------------------------------------------

  private onEvent(ev: SessionEvent): void {
    switch (ev.t) {
      case 'state':
        this.state = ev.state;
        switch (ev.state) {
          case 'streaming':
            this.setStatus('ok', `Connecté à ${this.peerLabel}`);
            this.log(`Canal de fichiers ouvert avec ${this.peerLabel}.`);
            if (!this.remotePathValue) this.readRemote('');
            break;
          case 'error':
            this.teardown();
            this.setStatus('error', ev.detail || 'La connexion a échoué');
            this.log(`Erreur du canal de fichiers : ${ev.detail || 'inconnue'}`);
            break;
          case 'closed':
            this.teardown();
            this.setStatus('error', 'Canal de fichiers fermé');
            this.log('Canal de fichiers fermé.');
            break;
          case 'needAccept':
            this.setStatus('busy', 'En attente de l’accord du poste distant…');
            break;
          default:
            this.setStatus('busy', 'Ouverture du canal de fichiers…');
        }
        this.updateButtons();
        this.renderRemote();
        break;
      case 'peerInfo':
        this.el.remoteSub.textContent = ev.username ? `${ev.username}@${ev.hostname}` : ev.hostname;
        break;
      case 'loginError':
        // Shouldn't happen (same credential as the live desktop session), but
        // surface it honestly if the peer rejects the file channel.
        this.teardown();
        this.state = 'error';
        this.setStatus('error', ev.message || 'Le poste distant a refusé le canal de fichiers');
        this.log(`Connexion du canal de fichiers refusée : ${ev.message}`);
        this.updateButtons();
        break;
      case 'msgbox': {
        const text = ev.text || ev.title;
        if (text) this.opts.toast(ev.title && ev.text ? `${ev.title}: ${ev.text}` : text);
        break;
      }
      case 'ftDir':
        this.onFtDir(ev.dir);
        break;
      case 'ftDigest':
        void this.onFtDigest(ev);
        break;
      case 'ftSendConfirm': {
        const job = this.jobById(ev.id);
        job?.confirmWaiter?.({ skip: ev.skip, offsetBytes: ev.offsetBytes });
        break;
      }
      case 'ftSent': {
        const job = this.jobById(ev.id);
        job?.sentWaiter?.(ev.buffered);
        break;
      }
      case 'ftBlock':
        this.onFtBlock(ev);
        break;
      case 'ftDone':
        this.onFtDone(ev.id, ev.fileNum);
        break;
      case 'ftError':
        this.onFtError(ev.id, ev.fileNum, ev.error);
        break;
      default:
        break;
    }
  }

  // --- remote pane -----------------------------------------------------------

  private readRemote(path: string): void {
    if (this.state !== 'streaming') return;
    this.post({ c: 'ftReadDir', path, includeHidden: this.showHidden });
  }

  private remoteUp(): void {
    const parent = parentRemote(this.remotePathValue, this.sep);
    // '' from a Windows drive root means "list the drives" (path "/").
    this.readRemote(parent === '' && this.sep === '\\' ? '/' : parent);
  }

  private onFtDir(dir: FtDirectory): void {
    // Directory listings for the browse pane come back with id=0 (and the
    // unsolicited post-login home listing). id>0 = a transfer job's file list.
    if (dir.id !== 0) {
      const job = this.jobById(dir.id);
      if (job && job.kind === 'download') {
        job.remoteFiles = dir.entries.map((e) => ({
          ...e,
          name: this.sep === '\\' ? e.name.replaceAll('\\', '/') : e.name,
        }));
        job.fileCount = job.remoteFiles.length;
        job.totalSize = job.remoteFiles.reduce((s, e) => s + e.size, 0);
        job.status = job.fileCount === 0 ? job.status : 'running';
        this.renderJobs();
      }
      return;
    }
    if (dir.path) {
      this.sep = dir.path.includes('\\') || /^[a-zA-Z]:/.test(dir.path) ? '\\' : '/';
    }
    this.remotePathValue = dir.path;
    this.el.remotePath.value = dir.path;
    this.el.remotePath.hidden = true;
    this.renderRemoteCrumbs();
    const entries = dir.entries.filter((e) => this.showHidden || !e.isHidden);
    entries.sort((a, b) => {
      const da = isDirKind(a.kind) ? 0 : 1;
      const db = isDirKind(b.kind) ? 0 : 1;
      if (da !== db) return da - db;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    this.remoteEntries = entries;
    this.remoteSel.clear();
    this.remoteAnchor = -1;
    this.renderRemote();
    this.updateButtons();
  }

  private renderRemote(): void {
    this.el.remoteBody.innerHTML = this.remoteEntries
      .map((e, i) =>
        this.rowHtml(
          i,
          e.name,
          isDirKind(e.kind) ? (e.kind === 'drive' ? 'drive' : 'dir') : 'file',
          e.size,
          e.modifiedSec * 1000,
          this.remoteSel.has(i),
          e.isHidden,
        ),
      )
      .join('');
    const empty = this.el.remoteEmpty;
    empty.hidden = this.remoteEntries.length > 0;
    empty.innerHTML =
      this.state === 'streaming'
        ? `${ftIcon('folder', 'ftx-empty-ic')}<p>Ce dossier est vide</p>`
        : `<p>${this.state === 'error' || this.state === 'closed' ? 'Non connecté' : 'Connexion au poste distant…'}</p>`;
    this.renderFoot('remote');
  }

  // --- remote ops ------------------------------------------------------------

  private op(desc: string, refresh: boolean): number {
    const id = this.nextId++;
    this.ops.set(id, { desc, refresh });
    return id;
  }

  private newRemoteFolder(): void {
    if (this.state !== 'streaming') return;
    this.promptDialog('Nouveau dossier', 'Nom du dossier', '', (name) => {
      if (!name) return;
      const id = this.op(`Création du dossier « ${name} »`, true);
      this.post({ c: 'ftCreateDir', id, path: joinRemote(this.remotePathValue, name, this.sep) });
    });
  }

  private renameRemote(): void {
    const idx = [...this.remoteSel][0];
    const entry = idx !== undefined ? this.remoteEntries[idx] : undefined;
    if (!entry || this.state !== 'streaming') return;
    this.promptDialog(`Renommer « ${entry.name} »`, 'Nouveau nom', entry.name, (name) => {
      if (!name || name === entry.name) return;
      const id = this.op(`Renommage de « ${entry.name} » en « ${name} »`, true);
      this.post({ c: 'ftRename', id, path: joinRemote(this.remotePathValue, entry.name, this.sep), newName: name });
    });
  }

  private deleteRemote(): void {
    const entries = [...this.remoteSel].map((i) => this.remoteEntries[i]).filter((e): e is FtEntry => !!e);
    if (!entries.length || this.state !== 'streaming') return;
    const what = entries.length === 1 ? `« ${entries[0]!.name} »` : `ces ${entries.length} éléments`;
    this.confirmDialog(`Supprimer ${what} du poste distant ? Cette action est définitive.`, () => {
      for (const e of entries) {
        const path = joinRemote(this.remotePathValue, e.name, this.sep);
        const id = this.op(`Suppression de « ${e.name} »`, true);
        if (isDirKind(e.kind)) this.post({ c: 'ftRemoveDir', id, path });
        else this.post({ c: 'ftRemoveFile', id, path, fileNum: 0 });
      }
    });
  }

  // --- local pane (File System Access mode) ----------------------------------

  private async openLocalFolder(): Promise<void> {
    const picker = (window as PickerWindow).showDirectoryPicker;
    if (!picker) return;
    try {
      // 'read' mode: Chrome's blocklist refuses readwrite grants on Desktop/
      // Documents etc. ("contains system files"). Reading is allowed almost
      // everywhere; write permission is requested per-folder when receiving.
      const handle = await picker.call(window, { mode: 'read' });
      this.rootHandle = handle;
      this.dirStack = [handle];
      this.localSel.clear();
      this.localAnchor = -1;
      await this.refreshLocal();
    } catch {
      return; // user cancelled the picker
    }
  }

  // True when Chrome grants (or the user approves) write access to `dir`.
  // Blocklisted folders auto-deny — callers fall back to Downloads saving.
  private async ensureWritable(dir: FileSystemDirectoryHandle): Promise<boolean> {
    const h = dir as PermissionedHandle;
    try {
      if (!h.queryPermission || !h.requestPermission) return true; // old impl: try and see
      if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
      return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
    } catch {
      return false;
    }
  }

  private localCwd(): FileSystemDirectoryHandle | undefined {
    return this.dirStack[this.dirStack.length - 1];
  }

  private async localEnter(entry: LocalEntry): Promise<void> {
    if (entry.kind !== 'dir' || !entry.handle) return;
    this.dirStack.push(entry.handle as FileSystemDirectoryHandle);
    this.localSel.clear();
    this.localAnchor = -1;
    await this.refreshLocal();
  }

  private async localUp(): Promise<void> {
    if (!this.fsMode || this.dirStack.length <= 1) return;
    this.dirStack.pop();
    this.localSel.clear();
    this.localAnchor = -1;
    await this.refreshLocal();
  }

  private async refreshLocal(): Promise<void> {
    if (!this.fsMode) {
      this.renderLocal();
      return;
    }
    const cwd = this.localCwd();
    if (!cwd) {
      this.renderLocal();
      return;
    }
    const gen = ++this.localListGen;
    const dirs: LocalEntry[] = [];
    const files: LocalEntry[] = [];
    try {
      for await (const handle of cwd.values()) {
        if (!this.showHidden && handle.name.startsWith('.')) continue;
        if (handle.kind === 'directory') {
          dirs.push({ kind: 'dir', name: handle.name, size: 0, modifiedMs: 0, handle: handle as FileSystemDirectoryHandle });
        } else {
          files.push({ kind: 'file', name: handle.name, size: 0, modifiedMs: 0, handle: handle as FileSystemFileHandle });
        }
      }
      await Promise.all(
        files.map(async (f) => {
          try {
            const file = await (f.handle as FileSystemFileHandle).getFile();
            f.size = file.size;
            f.modifiedMs = file.lastModified;
            f.file = file;
          } catch {
            /* unreadable entry — keep name only */
          }
        }),
      );
    } catch (e) {
      this.opts.toast(`Impossible de lire ce dossier : ${(e as Error).message}`);
    }
    if (gen !== this.localListGen) return; // superseded by a newer navigation
    const cmp = (a: LocalEntry, b: LocalEntry): number =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    dirs.sort(cmp);
    files.sort(cmp);
    this.localEntries = [...dirs, ...files];
    this.renderLocalCrumbs();
    this.el.localSub.textContent = this.rootHandle ? `Dossier ouvert : ${this.rootHandle.name}` : '';
    this.renderLocal();
    this.updateButtons();
  }

  // --- local pane (fallback staging mode) -------------------------------------

  private pickStagedFiles(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => this.stageFiles(Array.from(input.files ?? [])));
    input.click();
  }

  // "Send files…": pick files from anywhere (Desktop included — the file
  // picker has none of the directory blocklist restrictions) and upload them
  // straight to the current remote folder.
  private pickAndSendFiles(): void {
    if (this.state !== 'streaming') {
      this.opts.toast('Pas encore connecté');
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      if (files.length) void this.uploadFiles(files.map((f) => ({ rel: f.name, file: f })));
    });
    input.click();
  }

  private stageFiles(files: File[]): void {
    if (this.fsMode) return; // FS mode: local pane is a real folder, drops go via Send
    if (!files.length) return;
    this.staged.push(...files);
    this.renderLocal();
    this.updateButtons();
  }

  private renderLocal(): void {
    if (!this.fsMode) {
      this.localEntries = this.staged.map((f) => ({
        kind: 'file' as const,
        name: f.name,
        size: f.size,
        modifiedMs: f.lastModified,
        file: f,
      }));
    }
    this.el.localBody.innerHTML = this.localEntries
      .map((e, i) => this.rowHtml(i, e.name, e.kind, e.size, e.modifiedMs, this.localSel.has(i), e.name.startsWith('.')))
      .join('');
    this.renderLocalCrumbs();
    this.updateLocalEmpty();
    this.renderFoot('local');
  }

  private updateLocalEmpty(): void {
    const empty = this.el.localEmpty;
    if (this.localEntries.length > 0) {
      empty.hidden = true;
      return;
    }
    empty.hidden = false;
    if (this.fsMode && this.rootHandle) {
      empty.innerHTML = `${ftIcon('folder', 'ftx-empty-ic')}<p>Ce dossier est vide</p>`;
      return;
    }
    empty.innerHTML = this.fsMode
      ? `<div class="ftx-cta">${ftIcon('folder', 'ftx-cta-ic')}
           <b>Choisissez un dossier de cet ordinateur</b>
           <p>Il s’affiche ici pour envoyer ses fichiers ou y recevoir ceux du poste distant.
              Vous pouvez aussi glisser des fichiers sur le poste distant.</p>
           <div class="ftx-cta-btns">
             <button type="button" class="ftx-btn ftx-btn-primary" id="rd-ft-cta-open">Ouvrir un dossier…</button>
             <button type="button" class="ftx-btn" id="rd-ft-cta-send">Envoyer des fichiers…</button>
           </div></div>`
      : `<div class="ftx-cta">${ftIcon('folder', 'ftx-cta-ic')}
           <b>Ajoutez les fichiers à envoyer</b>
           <p>Glissez-les ici ou choisissez-les. Les fichiers reçus vont dans votre dossier Téléchargements.</p>
           <div class="ftx-cta-btns"><button type="button" class="ftx-btn ftx-btn-primary" id="rd-ft-cta-add">Ajouter des fichiers…</button></div></div>`;
    empty.querySelector('#rd-ft-cta-open')?.addEventListener('click', () => void this.openLocalFolder());
    empty.querySelector('#rd-ft-cta-send')?.addEventListener('click', () => this.pickAndSendFiles());
    empty.querySelector('#rd-ft-cta-add')?.addEventListener('click', () => this.pickStagedFiles());
  }

  // --- transfers: download ---------------------------------------------------

  private startDownloads(): void {
    const entries = [...this.remoteSel].map((i) => this.remoteEntries[i]).filter((e): e is FtEntry => !!e);
    void this.startDownloadOf(entries);
  }

  private async startDownloadOf(entries: FtEntry[]): Promise<void> {
    if (this.state !== 'streaming' || !entries.length) return;
    let destDir = this.fsMode ? this.localCwd() ?? null : null;
    if (destDir && !(await this.ensureWritable(destDir))) {
      destDir = null;
      this.log('Le navigateur refuse d’écrire dans ce dossier : les fichiers reçus vont dans Téléchargements.');
      this.opts.toast('Enregistrement dans Téléchargements (dossier en lecture seule)');
    } else if (this.fsMode && !destDir) {
      this.log('Aucun dossier ouvert : les fichiers reçus vont dans Téléchargements.');
    }
    for (const entry of entries) {
      const id = this.nextId++;
      const job: Job = {
        id,
        kind: 'download',
        label: entry.name,
        status: 'starting',
        totalSize: isDirKind(entry.kind) ? 0 : entry.size,
        doneBytes: 0,
        fileCount: isDirKind(entry.kind) ? 0 : 1,
        currentFile: entry.name,
        policy: null,
        startMs: nowMs(),
        lastBytes: 0,
        lastSampleMs: nowMs(),
        speedBps: 0,
        destDir,
        curFileNum: -1,
        memBuf: [],
        writeChain: Promise.resolve(),
      };
      this.jobs.unshift(job);
      this.post({
        c: 'ftSend',
        id,
        path: joinRemote(this.remotePathValue, entry.name, this.sep),
        includeHidden: this.showHidden,
        fileNum: 0,
      });
      this.log(`Réception de « ${entry.name} »…`);
      if (!destDir && entry.size > MEM_DOWNLOAD_WARN) {
        this.log(`Attention : « ${entry.name} » fait ${ftSize(entry.size)} et sera gardé en mémoire avant l’enregistrement.`);
      }
    }
    this.renderJobs();
  }

  // The peer announces each file with a digest and waits for our confirm.
  private async onFtDigest(ev: Extract<SessionEvent, { t: 'ftDigest' }>): Promise<void> {
    const job = this.jobById(ev.id);
    if (!job) return;
    if (job.kind === 'upload') {
      // Upload: the target exists on the remote side — our call.
      const decision = await this.resolveConflict(job, this.uploadFileName(job, ev.fileNum), ev);
      if (decision === 'cancel') {
        this.cancelJob(job);
        job.confirmWaiter?.('cancelled');
        return;
      }
      this.post({ c: 'ftConfirm', id: job.id, fileNum: ev.fileNum, skip: decision === 'skip', offsetBlk: 0 });
      job.confirmWaiter?.(decision === 'skip' ? { skip: true, offsetBytes: 0 } : { skip: false, offsetBytes: 0 });
      return;
    }
    // Download: digest describes the remote source file about to be sent.
    job.status = 'running';
    const rel = job.remoteFiles?.[ev.fileNum]?.name ?? job.label;
    job.currentFile = rel;
    let decision: 'overwrite' | 'skip' | 'cancel' = 'overwrite';
    if (job.destDir && (await this.localTargetExists(job.destDir, rel))) {
      decision = await this.resolveConflict(job, rel, ev);
    }
    if (decision === 'cancel') {
      this.cancelJob(job);
      return;
    }
    this.post({ c: 'ftConfirm', id: job.id, fileNum: ev.fileNum, skip: decision === 'skip', offsetBlk: 0 });
    if (decision === 'skip') this.log(`« ${rel} » ignoré (existe déjà).`);
    this.renderJobs();
  }

  private async localTargetExists(dir: FileSystemDirectoryHandle, rel: string): Promise<boolean> {
    try {
      const parts = rel.split('/').filter(Boolean);
      let d = dir;
      for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part);
      await d.getFileHandle(parts[parts.length - 1]!);
      return true;
    } catch {
      return false;
    }
  }

  private onFtBlock(ev: Extract<SessionEvent, { t: 'ftBlock' }>): void {
    const job = this.jobById(ev.id);
    if (!job || job.kind !== 'download' || job.status === 'cancelled' || job.status === 'error') return;
    job.writeChain = (job.writeChain ?? Promise.resolve()).then(async () => {
      try {
        if (job.curFileNum !== ev.fileNum) {
          await this.closeJobFile(job, true);
          job.curFileNum = ev.fileNum;
          const rel = job.remoteFiles?.[ev.fileNum]?.name ?? job.label;
          job.currentFile = rel;
          if (job.destDir) {
            job.writable = await this.createLocalWritable(job.destDir, rel);
          } else {
            job.memBuf = [];
          }
        }
        if (ev.data.length === 0) {
          await this.closeJobFile(job, true);
          job.curFileNum = -1;
          return;
        }
        if (job.writable) await job.writable.write(ev.data as Uint8Array<ArrayBuffer>);
        else job.memBuf?.push(ev.data);
        job.doneBytes += ev.data.length;
      } catch (e) {
        job.status = 'error';
        job.error = `écriture impossible : ${(e as Error).message}`;
        this.post({ c: 'ftCancel', id: job.id });
        this.log(`Échec de la réception de « ${job.label} » : ${job.error}`);
        this.renderJobs();
      }
    });
  }

  private async createLocalWritable(
    dir: FileSystemDirectoryHandle,
    rel: string,
  ): Promise<FileSystemWritableFileStream> {
    const parts = rel.split('/').filter(Boolean);
    let d = dir;
    for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
    const fh = await d.getFileHandle(parts[parts.length - 1]!, { create: true });
    return fh.createWritable(); // data commits atomically on close()
  }

  // Finalize the file currently streaming into `job` (if any).
  private async closeJobFile(job: Job, commit: boolean): Promise<void> {
    const w = job.writable;
    job.writable = undefined;
    if (w) {
      try {
        if (commit) await w.close();
        else await w.abort();
      } catch {
        /* already closed */
      }
    }
    if (!job.destDir && commit && job.memBuf && job.curFileNum !== undefined && job.curFileNum >= 0) {
      const rel = job.remoteFiles?.[job.curFileNum]?.name ?? job.label;
      this.saveBlobToDownloads(rel.split('/').join('_'), job.memBuf);
    }
    job.memBuf = [];
  }

  private saveBlobToDownloads(name: string, chunks: Uint8Array[]): void {
    const blob = new Blob(chunks as BlobPart[]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  private onFtDone(id: number, fileNum: number): void {
    const opInfo = this.ops.get(id);
    if (opInfo) {
      this.ops.delete(id);
      this.log(`${opInfo.desc} : terminé.`);
      if (opInfo.refresh) this.readRemote(this.remotePathValue);
      return;
    }
    const job = this.jobById(id);
    if (!job) return;
    if (job.kind === 'download') {
      job.writeChain = (job.writeChain ?? Promise.resolve()).then(async () => {
        await this.closeJobFile(job, true);
        job.curFileNum = -1;
        if (job.status !== 'error' && job.status !== 'cancelled') {
          job.status = 'done';
          job.doneBytes = Math.max(job.doneBytes, job.totalSize);
          this.log(`« ${job.label} » reçu (${ftSize(job.doneBytes)}).`);
          this.opts.toast(`${job.label} reçu`);
          if (this.fsMode) void this.refreshLocal();
        }
        this.renderJobs();
      });
    } else {
      // Peer's write side echoed done — upload fully flushed on the far end.
      job.peerDone = true;
      if (job.status === 'running' || job.status === 'starting') {
        job.status = 'done';
        this.log(`« ${job.label} » envoyé (${ftSize(job.doneBytes)}).`);
        this.opts.toast(`${job.label} envoyé`);
        this.readRemote(this.remotePathValue);
      }
      this.renderJobs();
    }
    void fileNum;
  }

  private onFtError(id: number, fileNum: number, error: string): void {
    const opInfo = this.ops.get(id);
    if (opInfo) {
      this.ops.delete(id);
      this.log(`${opInfo.desc} : échec (${error})`);
      this.opts.toast(`${opInfo.desc} : échec (${error})`);
      if (opInfo.refresh) this.readRemote(this.remotePathValue);
      return;
    }
    const job = this.jobById(id);
    if (!job) return;
    // "skipped" for a single-file job is the peer acknowledging our skip.
    if (/^skipped$/i.test(error)) {
      job.status = 'done';
      this.renderJobs();
      return;
    }
    job.status = 'error';
    job.error = error;
    job.confirmWaiter?.('cancelled');
    job.sentWaiter?.(0);
    void this.closeJobFile(job, false);
    this.log(`Échec du transfert « ${job.label} »${fileNum >= 0 ? ` (fichier ${fileNum + 1})` : ''} : ${error}`);
    this.renderJobs();
  }

  // --- transfers: upload -----------------------------------------------------

  private async startUpload(): Promise<void> {
    if (this.state !== 'streaming') return;
    const files: UploadFile[] = [];
    const selected = [...this.localSel].map((i) => this.localEntries[i]).filter((e): e is LocalEntry => !!e);
    for (const entry of selected) {
      if (entry.kind === 'file') {
        const f = entry.file ?? (entry.handle ? await (entry.handle as FileSystemFileHandle).getFile() : undefined);
        if (f) files.push({ rel: entry.name, file: f });
      } else if (entry.handle) {
        await this.collectDir(entry.handle as FileSystemDirectoryHandle, entry.name, files);
      }
    }
    await this.uploadFiles(files);
  }

  private async collectDir(dir: FileSystemDirectoryHandle, prefix: string, out: UploadFile[]): Promise<void> {
    for await (const handle of dir.values()) {
      if (!this.showHidden && handle.name.startsWith('.')) continue;
      if (handle.kind === 'directory') {
        await this.collectDir(handle as FileSystemDirectoryHandle, `${prefix}/${handle.name}`, out);
      } else {
        try {
          out.push({ rel: `${prefix}/${handle.name}`, file: await (handle as FileSystemFileHandle).getFile() });
        } catch {
          this.log(`Fichier illisible ignoré : « ${prefix}/${handle.name} ».`);
        }
      }
    }
  }

  private async uploadFiles(files: UploadFile[]): Promise<void> {
    if (this.state !== 'streaming' || !files.length) return;
    const id = this.nextId++;
    const totalSize = files.reduce((s, f) => s + f.file.size, 0);
    const label = files.length === 1 ? files[0]!.rel : `${files.length} files`;
    const job: Job = {
      id,
      kind: 'upload',
      label,
      status: 'running',
      totalSize,
      doneBytes: 0,
      fileCount: files.length,
      currentFile: files[0]!.rel,
      policy: null,
      startMs: nowMs(),
      lastBytes: 0,
      lastSampleMs: nowMs(),
      speedBps: 0,
      files,
    };
    this.jobs.unshift(job);
    this.renderJobs();
    this.log(`Envoi de ${label} vers ${this.remotePathValue || 'le dossier personnel'}…`);

    this.post({
      c: 'ftReceive',
      id,
      path: this.remotePathValue,
      files: files.map((f) => ({
        name: f.rel,
        size: f.file.size,
        modifiedSec: Math.floor(f.file.lastModified / 1000),
      })),
      totalSize,
      fileNum: 0,
    });

    try {
      for (let i = 0; i < files.length; i++) {
        if (this.jobStopped(job)) return;
        const { rel, file } = files[i]!;
        job.currentFile = rel;
        this.renderJobs();
        this.post({
          c: 'ftDigest',
          id,
          fileNum: i,
          fileSize: file.size,
          lastModifiedSec: Math.floor(file.lastModified / 1000),
        });
        // Wait for the go-ahead: either the peer's direct send_confirm (target
        // absent) or our own decision after its digest (handled in onFtDigest,
        // which resolves this same waiter).
        const confirm = await new Promise<{ skip: boolean; offsetBytes: number } | 'cancelled'>((resolve) => {
          job.confirmWaiter = resolve;
        });
        job.confirmWaiter = undefined;
        if (confirm === 'cancelled' || this.jobStopped(job)) return;
        if (confirm.skip) {
          job.doneBytes += file.size;
          this.log(`« ${rel} » ignoré (existe déjà sur le poste distant).`);
          continue;
        }
        let offset = confirm.offsetBytes;
        job.doneBytes += Math.min(offset, file.size);
        while (offset < file.size) {
          if (this.jobStopped(job)) return;
          const end = Math.min(offset + FT_BLOCK_SIZE, file.size);
          const buf = new Uint8Array(await file.slice(offset, end).arrayBuffer());
          const buffered = await new Promise<number>((resolve) => {
            job.sentWaiter = resolve;
            this.post({ c: 'ftBlock', id, fileNum: i, data: buf, blkId: 0 }, [buf.buffer]);
          });
          job.sentWaiter = undefined;
          job.doneBytes += end - offset;
          offset = end;
          // Self-clock: if the socket backlog is deep, let TCP drain.
          if (buffered > UPLOAD_BACKLOG_LIMIT) {
            await new Promise((r) => setTimeout(r, 120));
          }
        }
        // Empty block = end-of-file marker.
        this.post({ c: 'ftBlock', id, fileNum: i, data: new Uint8Array(0), blkId: 0 });
      }
      if (this.jobStopped(job)) return;
      this.post({ c: 'ftDone', id, fileNum: files.length });
      // Completion is reported when the peer echoes done (onFtDone).
    } catch (e) {
      if (!this.jobStopped(job)) {
        job.status = 'error';
        job.error = (e as Error).message;
        this.post({ c: 'ftError', id, fileNum: -1, error: job.error ?? 'read failed' });
        this.log(`Échec de l’envoi de « ${job.label} » : ${job.error}`);
        this.renderJobs();
      }
    }
  }

  private uploadFileName(job: Job, fileNum: number): string {
    return job.files?.[fileNum]?.rel ?? job.label;
  }

  private jobStopped(job: Job): boolean {
    return job.status === 'cancelled' || job.status === 'error' || this.state !== 'streaming';
  }

  // --- conflicts -------------------------------------------------------------

  private async resolveConflict(
    job: Job,
    name: string,
    ev: Extract<SessionEvent, { t: 'ftDigest' }>,
  ): Promise<'overwrite' | 'skip' | 'cancel'> {
    if (job.policy === 'overwrite') return 'overwrite';
    if (job.policy === 'skip') return 'skip';
    const detail =
      `${ev.fileSize ? formatBytes(ev.fileSize) : '—'} · modified ` +
      (ev.lastModifiedSec ? new Date(ev.lastModifiedSec * 1000).toLocaleString() : '—') +
      (job.kind === 'upload' ? ' (on remote)' : ' (incoming)');
    const decision = await new Promise<ConflictDecision>((resolve) => {
      this.conflicts.push({ jobId: job.id, name, detail, resolve });
      this.pumpConflicts();
    });
    if (decision.applyAll && decision.action !== 'cancel') job.policy = decision.action;
    return decision.action;
  }

  private pumpConflicts(): void {
    if (this.conflictOpen) return;
    const next = this.conflicts.shift();
    if (!next) return;
    this.conflictOpen = true;
    const d = this.el.dialog;
    d.hidden = false;
    d.innerHTML = `
      <div class="rd-ft-dlg">
        <h3>Ce fichier existe déjà</h3>
        <p class="rd-ft-dlg-file">${iconHtml('file')}<span>${escapeHtml(next.name)}</span></p>
        <p class="rd-ft-dlg-detail">${escapeHtml(next.detail)}</p>
        <label class="rd-save rd-ft-dlg-all"><input type="checkbox" id="rd-ft-dlg-applyall"><span>Faire de même pour tous les fichiers de ce transfert</span></label>
        <div class="rd-ft-dlg-btns">
          <button type="button" class="rd-ft-dlg-btn rd-ft-dlg-primary" data-act="overwrite">Remplacer</button>
          <button type="button" class="rd-ft-dlg-btn" data-act="skip">Ignorer</button>
          <button type="button" class="rd-ft-dlg-btn rd-ft-dlg-danger" data-act="cancel">Annuler le transfert</button>
        </div>
      </div>`;
    const finish = (action: ConflictDecision['action']): void => {
      const applyAll = (d.querySelector('#rd-ft-dlg-applyall') as HTMLInputElement | null)?.checked ?? false;
      d.hidden = true;
      d.innerHTML = '';
      this.conflictOpen = false;
      next.resolve({ action, applyAll });
      this.pumpConflicts();
    };
    d.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) =>
      b.addEventListener('click', () => finish(b.dataset.act as ConflictDecision['action'])),
    );
  }

  // --- small dialogs ---------------------------------------------------------

  private promptDialog(title: string, placeholder: string, initial: string, cb: (v: string | null) => void): void {
    const d = this.el.dialog;
    d.hidden = false;
    d.innerHTML = `
      <div class="rd-ft-dlg">
        <h3>${escapeHtml(title)}</h3>
        <input type="text" class="rd-ft-dlg-input" id="rd-ft-dlg-input" placeholder="${escapeHtml(placeholder)}"
               value="${escapeHtml(initial)}" spellcheck="false" autocomplete="off">
        <div class="rd-ft-dlg-btns">
          <button type="button" class="rd-ft-dlg-btn rd-ft-dlg-primary" data-act="ok">Valider</button>
          <button type="button" class="rd-ft-dlg-btn" data-act="no">Annuler</button>
        </div>
      </div>`;
    const input = q<HTMLInputElement>(d, '#rd-ft-dlg-input');
    input.focus();
    input.select();
    const finish = (ok: boolean): void => {
      const v = ok ? input.value.trim() : null;
      d.hidden = true;
      d.innerHTML = '';
      cb(v);
    };
    d.querySelector('[data-act="ok"]')!.addEventListener('click', () => finish(true));
    d.querySelector('[data-act="no"]')!.addEventListener('click', () => finish(false));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
  }

  private confirmDialog(text: string, cb: () => void): void {
    const d = this.el.dialog;
    d.hidden = false;
    d.innerHTML = `
      <div class="rd-ft-dlg">
        <h3>Confirmer la suppression</h3>
        <p class="rd-ft-dlg-detail">${escapeHtml(text)}</p>
        <div class="rd-ft-dlg-btns">
          <button type="button" class="rd-ft-dlg-btn rd-ft-dlg-danger" data-act="ok">Supprimer</button>
          <button type="button" class="rd-ft-dlg-btn" data-act="no">Annuler</button>
        </div>
      </div>`;
    const finish = (ok: boolean): void => {
      d.hidden = true;
      d.innerHTML = '';
      if (ok) cb();
    };
    d.querySelector('[data-act="ok"]')!.addEventListener('click', () => finish(true));
    d.querySelector('[data-act="no"]')!.addEventListener('click', () => finish(false));
    (d.querySelector('[data-act="no"]') as HTMLButtonElement).focus();
  }

  // --- job list / log --------------------------------------------------------

  private jobById(id: number): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  private cancelJob(job: Job): void {
    if (job.status === 'done' || job.status === 'cancelled') return;
    job.status = 'cancelled';
    this.post({ c: 'ftCancel', id: job.id });
    job.confirmWaiter?.('cancelled');
    job.sentWaiter?.(0);
    void this.closeJobFile(job, false);
    this.log(`« ${job.label} » annulé.`);
    this.renderJobs();
  }

  private tickJobs(): void {
    let active = false;
    const t = nowMs();
    for (const job of this.jobs) {
      if (job.status !== 'running' && job.status !== 'starting') continue;
      active = true;
      const dt = t - job.lastSampleMs;
      if (dt >= 900) {
        const inst = ((job.doneBytes - job.lastBytes) / dt) * 1000;
        job.speedBps = job.speedBps === 0 ? inst : job.speedBps * 0.5 + inst * 0.5;
        job.lastBytes = job.doneBytes;
        job.lastSampleMs = t;
      }
    }
    if (active) this.renderJobs();
  }

  private renderJobs(): void {
    const wrap = this.el.jobsWrap;
    const active = this.jobs.filter((j) => j.status === 'running' || j.status === 'starting').length;
    this.el.btnClear.hidden = this.jobs.length === active;
    this.el.queueSum.textContent = this.jobs.length ? (active ? `${active} en cours` : 'tous terminés') : '';
    if (!this.jobs.length) {
      wrap.innerHTML =
        '<div class="ftx-none">Sélectionnez des fichiers puis cliquez sur <b>Envoyer</b> ou <b>Recevoir</b> — ou glissez-les d’un côté à l’autre.</div>';
      return;
    }
    wrap.innerHTML = this.jobs
      .map((j) => {
        const pct = j.totalSize > 0 ? Math.min(100, Math.round((j.doneBytes / j.totalSize) * 100)) : j.status === 'done' ? 100 : 0;
        const running = j.status === 'running' || j.status === 'starting';
        const where = j.kind === 'download' ? 'vers cet ordinateur' : 'vers le poste distant';
        const eta = running && j.speedBps > 0 && j.totalSize > j.doneBytes ? ftEta((j.totalSize - j.doneBytes) / j.speedBps) : '';
        const detail = running
          ? `${ftSize(j.doneBytes)} sur ${j.totalSize ? ftSize(j.totalSize) : '?'}` +
            (j.speedBps > 0 ? ` · ${ftSize(j.speedBps)}/s` : '') +
            (eta ? ` · ${eta} restant${eta.endsWith('s') ? 'es' : ''}` : '')
          : j.status === 'done'
            ? `Terminé · ${ftSize(Math.max(j.doneBytes, j.totalSize))}`
            : j.status === 'cancelled'
              ? 'Annulé'
              : `Échec : ${j.error ?? 'erreur inconnue'}`;
        return `<div class="ftx-job is-${j.status}">
          <span class="ftx-job-dir">${iconHtml(j.kind === 'download' ? 'sendLeft' : 'sendRight')}</span>
          <div class="ftx-job-main">
            <div class="ftx-job-top"><b class="ftx-job-name">${escapeHtml(j.label)}</b><span class="ftx-job-where">${where}</span>
              <span class="ftx-spacer"></span><span class="ftx-job-detail">${escapeHtml(detail)}</span></div>
            <div class="ftx-bar"><i style="width:${pct}%"></i></div>
          </div>
          ${running ? `<button type="button" class="ftx-ib" data-job="${j.id}" title="Annuler" aria-label="Annuler ${escapeHtml(j.label)}">${iconHtml('close')}</button>` : ''}
        </div>`;
      })
      .join('');
  }

  private log(message: string): void {
    const line = document.createElement('div');
    line.className = 'ftx-logline';
    line.textContent = `${new Date().toLocaleTimeString('fr-FR')}  ${message}`;
    this.el.logWrap.appendChild(line);
    this.el.logWrap.scrollTop = this.el.logWrap.scrollHeight;
  }

  private updateButtons(): void {
    const connected = this.state === 'streaming';
    this.el.btnSend.disabled = !connected || this.localSel.size === 0;
    this.el.btnRecv.disabled = !connected || this.remoteSel.size === 0;
    const remoteSel = this.remoteSel.size;
    q<HTMLButtonElement>(this.el.panel, '#rd-ft-remote-rename').disabled = !connected || remoteSel !== 1;
    q<HTMLButtonElement>(this.el.panel, '#rd-ft-remote-del').disabled = !connected || remoteSel === 0;
    q<HTMLButtonElement>(this.el.panel, '#rd-ft-remote-new').disabled = !connected;
  }

}
