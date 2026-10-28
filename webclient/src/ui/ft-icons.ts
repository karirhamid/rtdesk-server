// RTDesk web client — Finder-style file icons for the file-transfer window.
//
// One hidden SVG sprite is inserted into the page once; every list row then
// references a symbol with <use>, so a folder of thousands of entries costs a
// few bytes of markup per row instead of a full icon each.

export type FtIconId =
  | 'folder'
  | 'drive'
  | 'computer'
  | 'remote'
  | 'file'
  | 'text'
  | 'code'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slides'
  | 'app';

// The blank page every document icon is drawn on (white sheet, folded corner).
const PAGE =
  '<path d="M8.5 2.5h10.8l7.2 7.2v17.8a2 2 0 0 1-2 2h-16a2 2 0 0 1-2-2v-23a2 2 0 0 1 2-2z" fill="#fff" stroke="#c3c9d2"/>' +
  '<path d="M19.3 2.5v5.2a2 2 0 0 0 2 2h5.2" fill="#e8ecf1" stroke="#c3c9d2" stroke-linejoin="round"/>';

const SYMBOLS: Record<FtIconId, string> = {
  folder:
    '<path d="M2.5 8a2.5 2.5 0 0 1 2.5-2.5h6.6c.8 0 1.5.3 2 .9l1.6 1.8H27a2.5 2.5 0 0 1 2.5 2.5v14.8A2.5 2.5 0 0 1 27 28H5a2.5 2.5 0 0 1-2.5-2.5z" fill="#2f8fe6"/>' +
    '<path d="M2.5 12.4A2.4 2.4 0 0 1 4.9 10h22.2a2.4 2.4 0 0 1 2.4 2.4v13.1A2.5 2.5 0 0 1 27 28H5a2.5 2.5 0 0 1-2.5-2.5z" fill="#6cb8f7"/>' +
    '<path d="M3.2 12.9h25.6" stroke="#a9d7fb" stroke-width="1.2"/>',
  drive:
    '<rect x="3" y="9" width="26" height="15" rx="3" fill="#c7ccd4"/>' +
    '<rect x="3" y="9" width="26" height="11" rx="3" fill="#e6e9ee"/>' +
    '<circle cx="24.5" cy="21.6" r="1.2" fill="#3fbf6f"/><path d="M6.5 21.6h10" stroke="#9aa2ad" stroke-width="1.2" stroke-linecap="round"/>',
  computer:
    '<rect x="3" y="5" width="26" height="17" rx="2.5" fill="#3a4250"/>' +
    '<rect x="4.8" y="6.8" width="22.4" height="13.4" rx="1.2" fill="#6cb8f7"/>' +
    '<path d="M13 22h6l1 4h-8z" fill="#aab2bd"/><rect x="9.5" y="25.5" width="13" height="2" rx="1" fill="#c7ccd4"/>',
  remote:
    '<rect x="3" y="5" width="26" height="17" rx="2.5" fill="#3a4250"/>' +
    '<rect x="4.8" y="6.8" width="22.4" height="13.4" rx="1.2" fill="#7c83f0"/>' +
    '<path d="M11 13.5h10M18 10.5l3 3-3 3" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M13 22h6l1 4h-8z" fill="#aab2bd"/><rect x="9.5" y="25.5" width="13" height="2" rx="1" fill="#c7ccd4"/>',
  file: PAGE,
  text:
    PAGE +
    '<path d="M10 14h12M10 17.5h12M10 21h12M10 24.5h7" stroke="#a7afba" stroke-width="1.3" stroke-linecap="round"/>',
  code:
    PAGE +
    '<path d="M13.5 15.5 10 19l3.5 3.5M18.5 15.5 22 19l-3.5 3.5" stroke="#5b6cf0" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  image:
    PAGE +
    '<rect x="9" y="13" width="14" height="11" rx="1.5" fill="#e3f2ff"/>' +
    '<path d="m9.5 23 4.2-5 3 3.4 2-2.2 3.8 3.8z" fill="#4cae6a"/><circle cx="19.2" cy="16.2" r="1.6" fill="#f5b83d"/>',
  video:
    PAGE +
    '<rect x="9" y="13.5" width="14" height="10" rx="2" fill="#8b5cf6"/><path d="m14.5 16.2 4 2.3-4 2.3z" fill="#fff"/>',
  audio:
    PAGE +
    '<path d="M18.5 13v7.6a2.4 2.4 0 1 1-1.6-2.2V15l-4.4 1v6.2a2.4 2.4 0 1 1-1.6-2.2v-5.3z" fill="#ec4899"/>',
  archive:
    PAGE +
    '<path d="M15 3v3h2v2h-2v2h2v2h-2v2h2v2h-2" stroke="#9a8a6d" stroke-width="1.6" fill="none"/>' +
    '<rect x="13.6" y="17.5" width="4.8" height="5.5" rx="1" fill="#c9a96a" stroke="#9a8a6d"/>',
  pdf:
    PAGE +
    '<rect x="6.5" y="17" width="15" height="7" rx="1.5" fill="#e5484d"/>' +
    '<text x="14" y="22.6" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="5.6" font-weight="700" fill="#fff">PDF</text>',
  doc:
    PAGE +
    '<rect x="6.5" y="17" width="9" height="7" rx="1.5" fill="#2f6fde"/>' +
    '<path d="M18 18.5h5M18 21h5M10 13h12" stroke="#a7afba" stroke-width="1.3" stroke-linecap="round"/>' +
    '<path d="m8.4 18.9.9 3.4 1.1-3 1.1 3 .9-3.4" stroke="#fff" stroke-width=".9" fill="none" stroke-linejoin="round"/>',
  sheet:
    PAGE +
    '<rect x="9" y="13" width="14" height="11" rx="1" fill="#e6f6ec" stroke="#2f9e5b"/>' +
    '<path d="M9 16.7h14M9 20.4h14M13.7 13v11M18.4 13v11" stroke="#2f9e5b" stroke-width=".9"/>',
  slides:
    PAGE +
    '<rect x="9" y="13" width="14" height="9.5" rx="1.2" fill="#f97316"/><path d="M12 19.5h8M12 16.5h5" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/>' +
    '<path d="M16 22.5v2.5" stroke="#f97316" stroke-width="1.3"/>',
  app:
    '<rect x="4" y="4" width="24" height="24" rx="6" fill="#4f7cf0"/><rect x="4" y="4" width="24" height="12" rx="6" fill="#6f95f5"/>' +
    '<path d="M11 21.5 16 10l5 11.5M12.8 17.6h6.4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
};

const SPRITE_ID = 'rdft-sprite';

/** Inserts the icon sprite once per page. */
export function ensureFtSprite(): void {
  if (document.getElementById(SPRITE_ID)) return;
  const holder = document.createElement('div');
  holder.innerHTML =
    `<svg id="${SPRITE_ID}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">` +
    Object.entries(SYMBOLS)
      .map(([id, body]) => `<symbol id="rdft-${id}" viewBox="0 0 32 32">${body}</symbol>`)
      .join('') +
    '</svg>';
  document.body.appendChild(holder.firstElementChild!);
}

export function ftIcon(id: FtIconId, cls = 'ftx-ic'): string {
  return `<svg class="${cls}" aria-hidden="true"><use href="#rdft-${id}"></use></svg>`;
}

const BY_EXT: Record<string, [FtIconId, string]> = {};
const group = (icon: FtIconId, label: string, exts: string): void => {
  for (const e of exts.split(' ')) BY_EXT[e] = [icon, label];
};
group('image', 'Image', 'png jpg jpeg gif bmp webp svg ico tif tiff heic heif raw cr2 nef psd');
group('video', 'Vidéo', 'mp4 mkv avi mov wmv webm flv m4v mpg mpeg 3gp');
group('audio', 'Audio', 'mp3 wav flac aac ogg m4a wma opus');
group('archive', 'Archive', 'zip rar 7z tar gz bz2 xz tgz iso cab zst');
group('pdf', 'Document PDF', 'pdf');
group('doc', 'Document', 'doc docx odt rtf pages');
group('sheet', 'Feuille de calcul', 'xls xlsx xlsm ods csv numbers');
group('slides', 'Présentation', 'ppt pptx odp key');
group('code', 'Code source', 'js mjs ts tsx jsx json html htm css scss py rs go java c cpp h hpp cs php rb sh ps1 bat cmd xml yml yaml sql ini cfg conf toml md vue dart kt swift');
group('text', 'Texte', 'txt log');
group('app', 'Application', 'exe msi dmg app apk dll sys com bin appimage deb rpm');

/** Icon and Finder-style "Kind" label for an entry. */
export function ftKind(name: string, kind: 'dir' | 'drive' | 'file'): { icon: FtIconId; label: string } {
  if (kind === 'drive') return { icon: 'drive', label: 'Disque' };
  if (kind === 'dir') return { icon: 'folder', label: 'Dossier' };
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const hit = BY_EXT[ext];
  if (hit) return { icon: hit[0], label: hit[1] };
  return { icon: 'file', label: ext ? `Fichier ${ext.toUpperCase()}` : 'Fichier' };
}

const SIZE_UNITS = ['octets', 'Ko', 'Mo', 'Go', 'To'];

/** "1,4 Mo", the way a French Finder shows sizes. */
export function ftSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${bytes} ${bytes < 2 ? 'octet' : 'octets'}`;
  let v = bytes;
  let u = 0;
  while (v >= 1000 && u < SIZE_UNITS.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${SIZE_UNITS[u]}`;
}

const DATE_FMT = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

export function ftDate(ms: number): string {
  return ms > 0 ? DATE_FMT.format(new Date(ms)) : '—';
}

/** "18 s", "3 min", "1 h 05" left at the current speed. */
export function ftEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)} s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  return `${h} h ${String(Math.round((seconds % 3600) / 60)).padStart(2, '0')}`;
}
