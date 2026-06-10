// Radio player. The audio element, current station, and playlist live in
// module scope so playback survives view-transition navigations. The mini bar
// and modal ("dock") are rendered by the Base layout on every page with
// transition:persist, so they are bound once; the station list section
// ([data-player]) is page-specific and re-bound on every astro:page-load.
import {
  type Station,
  STORE_EVENT,
  addToHistory,
  getFavorites,
  getHistory,
  isFavorite,
  toggleFavorite,
} from './store';

const API_STATIONS = '/api/stations';
const API_VOTE = '/api/vote';
const API_NOW_PLAYING = '/api/now-playing';
const LAST_KEY = 'br-last-station';
const VOLUME_KEY = 'br-volume';
const VIEW_KEY = 'br-view';
const BATCH_SIZE = 24;
const SONG_POLL_MS = 30_000;

const GENRE_MAP: Record<string, string> = {
  pop: 'Поп', rock: 'Рок', folk: 'Фолк', jazz: 'Джаз', classical: 'Класика',
  news: 'Новини', dance: 'Танцувална', electronic: 'Електронна', 'hip hop': 'Хип-хоп',
  '80s': 'Ретро', '90s': 'Ретро', retro: 'Ретро', oldies: 'Ретро',
  chalga: 'Чалга', 'pop folk': 'Чалга', turbofolk: 'Чалга',
  ambient: 'Релакс', chillout: 'Релакс', lounge: 'Релакс',
};
// CSS color-class slug for each Bulgarian genre label.
const GENRE_SLUG: Record<string, string> = {
  'Поп': 'pop', 'Рок': 'rock', 'Фолк': 'folk', 'Джаз': 'jazz', 'Класика': 'classical',
  'Новини': 'news', 'Танцувална': 'dance', 'Електронна': 'electronic', 'Хип-хоп': 'hiphop',
  'Ретро': 'retro', 'Чалга': 'chalga', 'Релакс': 'relax',
};

type View = 'list' | 'grid';
type Mode = 'browse' | 'favorites' | 'history';
type PlayState = 'playing' | 'paused' | 'loading' | 'error';

const ICON_PLAY =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
const ICON_STAR =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 17.3l-5.4 3.2 1.4-6.1L3 10.4l6.2-.5L12 4l2.8 5.9 6.2.5-5 4 1.4 6.1z"/></svg>';

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function escapeAttr(s: string) {
  return escapeHtml(s);
}
/**
 * First letter of a station name, restricted to letters/digits so it is safe
 * to interpolate into the inline onerror fallback string.
 */
function safeInitial(name: string) {
  const m = name.trim().match(/[\p{L}\p{N}]/u);
  return (m ? m[0] : '♪').toUpperCase();
}

/** Classify a station's tag string into one of our Bulgarian genre labels. */
function classifyGenre(tags: string): string | null {
  const t = tags.toLowerCase();
  for (const [key, bg] of Object.entries(GENRE_MAP)) {
    if (t.includes(key)) return bg;
  }
  return null;
}

// Cyrillic → Latin transliteration for fuzzy matching of directory names
// ("БГ Радио") against Radio Browser catalog names ("BG Radio").
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
  т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sht',
  ъ: 'a', ь: 'y', ю: 'yu', я: 'ya',
};
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .split('')
    .map((c) => TRANSLIT[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]/g, '');
}

function logoHtmlFor(s: Station): string {
  const initial = safeInitial(s.name);
  return s.favicon
    ? `<img src="${escapeAttr(s.favicon)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'fallback',textContent:'${initial}'}))" />`
    : `<span class="fallback">${initial}</span>`;
}

// ---------------------------------------------------------------------------
// Persistent (module-scope) playback state — survives soft navigations.
// ---------------------------------------------------------------------------

const audio = new Audio();
audio.preload = 'none';

let current: Station | null = null;
let state: PlayState = 'paused';
/** List used by prev/next — set whenever playback starts from a list. */
let playlist: Station[] = [];
/** Cached full browse catalog (fetched on demand, e.g. from station pages). */
let catalog: Station[] | null = null;
let catalogPromise: Promise<Station[]> | null = null;

let songTitle = '';
let songPollTimer: ReturnType<typeof setInterval> | null = null;

let sleepTimeout: ReturnType<typeof setTimeout> | null = null;
let sleepInterval: ReturnType<typeof setInterval> | null = null;
let sleepEnd = 0;

let listUI: ListUI | null = null;
let lastFocus: HTMLElement | null = null;

// ---------------------------------------------------------------------------
// Dock: mini bar + modal. Rendered by Base on every page with
// transition:persist, so these nodes (and their listeners) survive swaps.
// ---------------------------------------------------------------------------

function q<T extends HTMLElement>(sel: string): T {
  return document.querySelector<T>(sel)!;
}

const nowPlaying = q('[data-now-playing]');
const npLogo = q('[data-np-logo]');
const npName = q('[data-np-name]');
const npSong = q('[data-np-song]');
const npState = q('[data-np-state]');
const npSleep = q('[data-np-sleep]');
const npToggle = q<HTMLButtonElement>('[data-np-toggle]');
const npExpand = q<HTMLButtonElement>('[data-np-expand]');
const npPrev = q<HTMLButtonElement>('[data-np-prev]');
const npNext = q<HTMLButtonElement>('[data-np-next]');

const modal = q('[data-modal]');
const modalLogo = q('[data-modal-logo]');
const modalName = q('[data-modal-name]');
const modalSong = q('[data-modal-song]');
const modalLang = q('[data-modal-lang]');
const modalState = q('[data-modal-state]');
const modalTags = q('[data-modal-tags]');
const modalToggle = q<HTMLButtonElement>('[data-modal-toggle]');
const modalPrev = q<HTMLButtonElement>('[data-modal-prev]');
const modalNext = q<HTMLButtonElement>('[data-modal-next]');
const modalVolume = q<HTMLInputElement>('[data-modal-volume]');
const modalClose = q<HTMLButtonElement>('[data-modal-close]');
const modalFav = q<HTMLButtonElement>('[data-modal-fav]');
const modalVu = q('[data-modal-vu]');
const modalVote = q<HTMLButtonElement>('[data-modal-vote]');
const modalVoteLabel = q('[data-vote-label]');
const modalVoteCount = q('[data-vote-count]');

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

function ensureCatalog(): Promise<Station[]> {
  if (catalog) return Promise.resolve(catalog);
  if (!catalogPromise) {
    catalogPromise = fetch(API_STATIONS)
      .then((res) => {
        if (!res.ok) throw new Error('API ' + res.status);
        return res.json();
      })
      .then((data: Station[]) => {
        catalog = data;
        return data;
      })
      .catch((err) => {
        catalogPromise = null;
        throw err;
      });
  }
  return catalogPromise;
}

/** Find the best catalog match for a directory station name. */
function matchStation(query: string, list: Station[]): Station | null {
  const nq = normalizeName(query);
  if (!nq) return null;
  const candidates = list.filter((s) => {
    const ns = normalizeName(s.name);
    return ns === nq || ns.includes(nq) || nq.includes(ns);
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const ea = Number(normalizeName(a.name) === nq);
    const eb = Number(normalizeName(b.name) === nq);
    if (ea !== eb) return eb - ea;
    return (b.votes || 0) - (a.votes || 0);
  });
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

function playStation(s: Station, list?: Station[]) {
  if (list && list.length) playlist = list;
  if (current?.stationuuid === s.stationuuid && !audio.paused) {
    audio.pause();
    return;
  }
  current = s;
  songTitle = '';
  audio.src = s.url_resolved;
  void audio.play().catch(() => setState('error'));
  showNowPlaying(s, 'loading');
  listUI?.updateActiveCard(s.stationuuid);
  try { localStorage.setItem(LAST_KEY, JSON.stringify(s)); } catch {}
  addToHistory(s);
  updateNavButtons();
  updateMediaSession(s);
}

function toggle() {
  if (!current) return;
  if (audio.paused) {
    // Re-set the source so resuming rejoins the live stream instead of
    // replaying stale buffered audio.
    audio.src = current.url_resolved;
    void audio.play().catch(() => setState('error'));
    setState('loading');
  } else {
    audio.pause();
  }
}

/** Move to prev/next station within the active playlist, with wrap-around. */
function step(delta: number) {
  if (playlist.length < 2) return;
  let idx = current
    ? playlist.findIndex((s) => s.stationuuid === current!.stationuuid)
    : -1;
  if (idx < 0) idx = 0;
  const len = playlist.length;
  playStation(playlist[(idx + delta + len) % len]);
}

function updateNavButtons() {
  const enabled = playlist.length > 1;
  npPrev.disabled = !enabled;
  npNext.disabled = !enabled;
  modalPrev.disabled = !enabled;
  modalNext.disabled = !enabled;
}

function showNowPlaying(s: Station, st: PlayState) {
  nowPlaying.classList.add('visible');
  const logoHtml = logoHtmlFor(s);
  npLogo.innerHTML = logoHtml;
  npName.textContent = s.name;
  modalLogo.innerHTML = logoHtml;
  modalName.textContent = s.name;
  modalLang.textContent = s.language || s.country || '';
  // Clear the previous station's song title until the next poll.
  npSong.textContent = '';
  modalSong.textContent = '';
  listUI?.setActiveSong('');
  renderTags(s);
  refreshFavStars();
  updateVoteDisplay(s);
  setState(st);
}

function setState(st: PlayState) {
  state = st;
  const label =
    st === 'playing' ? 'В ЕФИР'
    : st === 'loading' ? 'Зареждане…'
    : st === 'error' ? 'Грешка'
    : 'ПАУЗА';
  npState.innerHTML = `<span class="dot ${st}"></span>${label}`;
  modalState.innerHTML =
    `<span class="dot ${st}"></span>${label}` +
    (st === 'error' && playlist.length > 1
      ? '<button class="err-next" type="button" data-err-next>Опитай следващата ▸</button>'
      : '');
  const icon = st === 'playing' ? ICON_PAUSE : ICON_PLAY;
  npToggle.innerHTML = icon;
  modalToggle.innerHTML = icon;
  const ariaLabel = st === 'playing' ? 'Пауза' : 'Пусни';
  npToggle.setAttribute('aria-label', ariaLabel);
  modalToggle.setAttribute('aria-label', ariaLabel);
  modalVu.classList.toggle('animating', st === 'playing');
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = st === 'playing' ? 'playing' : 'paused';
  }
  if (st === 'playing') startSongPoll(); else stopSongPoll();
  if (st === 'error' && current) listUI?.markBroken(current.stationuuid);
  if (current) {
    listUI?.updateActiveCard(!audio.paused ? current.stationuuid : null);
  }
}

function renderTags(s: Station) {
  const tags = (s.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 3);
  modalTags.innerHTML = tags
    .map((t) => `<span class="tag-chip">${escapeHtml(t.toUpperCase())}</span>`)
    .join('');
}

/** Sync star states on rendered cards + the modal star to localStorage truth. */
function refreshFavStars() {
  listUI?.refreshFavStars();
  if (current) {
    const fav = isFavorite(current.stationuuid);
    modalFav.classList.toggle('active', fav);
    modalFav.setAttribute('aria-pressed', String(fav));
    modalFav.setAttribute('aria-label', fav ? 'Премахни от любими' : 'Добави в любими');
  }
}

// ---------------------------------------------------------------------------
// Now-playing song polling
// ---------------------------------------------------------------------------

function startSongPoll() {
  stopSongPoll();
  void fetchNowPlaying();
  songPollTimer = setInterval(() => void fetchNowPlaying(), SONG_POLL_MS);
}

function stopSongPoll() {
  if (songPollTimer) clearInterval(songPollTimer);
  songPollTimer = null;
}

async function fetchNowPlaying() {
  if (!current || state !== 'playing') return;
  try {
    const res = await fetch(API_NOW_PLAYING, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: current.url_resolved }),
    });
    const data = await res.json();
    songTitle = data.title || '';
    npSong.textContent = songTitle;
    modalSong.textContent = songTitle;
    listUI?.setActiveSong(songTitle);
    if (current) updateMediaSession(current, songTitle);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Media Session (lock-screen / hardware-key controls)
// ---------------------------------------------------------------------------

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler('play', () => toggle());
    navigator.mediaSession.setActionHandler('pause', () => toggle());
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
  } catch { /* unsupported action */ }
}

function updateMediaSession(s: Station, song = '') {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song || s.name,
      artist: song ? s.name : 'Радио България',
      artwork: s.favicon ? [{ src: s.favicon }] : [{ src: '/logo-512.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch { /* ignore malformed artwork URLs */ }
}

// ---------------------------------------------------------------------------
// Sleep timer
// ---------------------------------------------------------------------------

function setSleepTimer(minutes: number) {
  if (sleepTimeout) clearTimeout(sleepTimeout);
  if (sleepInterval) clearInterval(sleepInterval);
  sleepTimeout = null;
  sleepInterval = null;
  sleepEnd = 0;
  if (minutes <= 0) {
    updateSleepUI(0);
    return;
  }
  sleepEnd = Date.now() + minutes * 60_000;
  sleepTimeout = setTimeout(() => {
    audio.pause();
    setSleepTimer(0);
  }, minutes * 60_000);
  sleepInterval = setInterval(() => {
    updateSleepUI(Math.max(0, Math.ceil((sleepEnd - Date.now()) / 60_000)));
  }, 10_000);
  updateSleepUI(minutes);
}

function updateSleepUI(minutesLeft: number) {
  const label = document.querySelector<HTMLElement>('[data-sleep-label]');
  if (label) label.textContent = minutesLeft > 0 ? `${minutesLeft} мин` : 'Таймер';
  npSleep.hidden = minutesLeft <= 0;
  if (minutesLeft > 0) npSleep.textContent = `⏾ ${minutesLeft} мин`;
}

// ---------------------------------------------------------------------------
// Voting & sharing
// ---------------------------------------------------------------------------

function updateVoteDisplay(s: Station) {
  modalVoteCount.textContent = s.votes > 0 ? `★ ${s.votes}` : '';
  modalVoteLabel.textContent = 'Гласувай';
  modalVote.disabled = false;
}

async function vote() {
  if (!current) return;
  modalVote.disabled = true;
  modalVoteLabel.textContent = '...';
  try {
    const res = await fetch(API_VOTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: current.stationuuid }),
    });
    const data = await res.json();
    if (data.ok === true) {
      current.votes = (current.votes || 0) + 1;
      modalVoteCount.textContent = `★ ${current.votes}`;
      modalVoteLabel.textContent = 'Благодаря!';
    } else {
      modalVoteLabel.textContent = data.message || 'Вече сте гласували';
    }
  } catch {
    modalVoteLabel.textContent = 'Грешка';
  }
  setTimeout(() => {
    modalVoteLabel.textContent = 'Гласувай';
    modalVote.disabled = false;
  }, 3000);
}

async function share() {
  if (!current) return;
  const text = `Слушам ${current.name} в Радио България`;
  const url = window.location.origin;
  const label = document.querySelector<HTMLElement>('[data-share-label]');
  if (navigator.share) {
    try { await navigator.share({ title: text, url }); } catch { /* cancelled */ }
  } else {
    try {
      await navigator.clipboard.writeText(`${text} — ${url}`);
      if (label) { label.textContent = 'Копирано!'; setTimeout(() => { label.textContent = 'Сподели'; }, 2000); }
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Modal (with focus trap)
// ---------------------------------------------------------------------------

function openModal() {
  if (!current) return;
  lastFocus = document.activeElement as HTMLElement | null;
  modal.classList.add('visible');
  document.body.style.overflow = 'hidden';
  modalClose.focus();
}

function closeModal() {
  modal.classList.remove('visible');
  document.body.style.overflow = '';
  lastFocus?.focus();
  lastFocus = null;
}

function trapFocus(e: KeyboardEvent) {
  if (e.key !== 'Tab' || !modal.classList.contains('visible')) return;
  const focusables = [...modal.querySelectorAll<HTMLElement>(
    'button:not(:disabled):not([hidden]), input, [href]'
  )].filter((el) => el.offsetParent !== null);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !modal.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

// ---------------------------------------------------------------------------
// Page-specific station list
// ---------------------------------------------------------------------------

class ListUI {
  private mode: Mode;
  private all: Station[] = [];
  private filtered: Station[] = [];
  private rendered = 0;
  private view: View = 'list';
  private activeGenre = 'all';
  private activeCity = 'all';
  private stationCards = new Map<string, HTMLElement>();
  private observer: IntersectionObserver | null = null;
  private brokenIds = new Set<string>();

  private statusEl: HTMLElement;
  private stationsEl: HTMLElement;
  private searchEl: HTMLInputElement | null;
  private searchClear: HTMLButtonElement | null;
  private countEl: HTMLElement;
  private sentinelEl: HTMLElement;
  private toolbarEl: HTMLElement | null;
  private viewButtons: NodeListOf<HTMLButtonElement>;
  private genreContainer: HTMLElement | null;
  private cityContainer: HTMLElement | null;

  constructor(root: HTMLElement) {
    this.mode = (root.dataset.mode as Mode) || 'browse';
    this.statusEl = root.querySelector<HTMLElement>('[data-status]')!;
    this.stationsEl = root.querySelector<HTMLElement>('[data-stations]')!;
    this.searchEl = root.querySelector<HTMLInputElement>('[data-search]');
    this.searchClear = root.querySelector<HTMLButtonElement>('[data-search-clear]');
    this.countEl = root.querySelector<HTMLElement>('[data-count]')!;
    this.sentinelEl = root.querySelector<HTMLElement>('[data-sentinel]')!;
    this.toolbarEl = root.querySelector<HTMLElement>('.player-toolbar');
    this.viewButtons = root.querySelectorAll<HTMLButtonElement>('.vt-btn');
    this.genreContainer = root.querySelector<HTMLElement>('[data-genres]');
    this.cityContainer = root.querySelector<HTMLElement>('[data-cities]');

    const savedView = localStorage.getItem(VIEW_KEY) as View | null;
    this.view = savedView === 'grid' ? 'grid' : 'list';
    this.stationsEl.classList.add(`view-${this.view}`);
    this.viewButtons.forEach((b) => {
      b.classList.toggle('active', b.dataset.view === this.view);
      b.addEventListener('click', () => this.setView(b.dataset.view as View));
    });

    if (this.searchEl) {
      this.searchEl.addEventListener('input', () => {
        this.syncSearchClear();
        this.applyFilter();
      });
    }
    if (this.searchClear) {
      this.searchClear.addEventListener('click', () => {
        if (!this.searchEl) return;
        this.searchEl.value = '';
        this.searchEl.focus();
        this.syncSearchClear();
        this.applyFilter();
      });
    }
  }

  async init() {
    try {
      if (this.mode === 'browse') {
        this.all = await ensureCatalog();
      } else if (this.mode === 'favorites') {
        this.all = getFavorites();
      } else {
        this.all = getHistory().map((e) => e.station);
      }

      if (this.all.length === 0) {
        await this.showEmpty();
        return;
      }
      this.statusEl.style.display = 'none';
      if (this.toolbarEl) this.toolbarEl.style.display = '';
      if (this.mode === 'browse') {
        // Deep links: /?q=джаз&genre=Джаз&city=София#player (also used by the
        // sitelinks SearchAction in the structured data).
        const params = new URLSearchParams(window.location.search);
        const qParam = params.get('q');
        if (qParam && this.searchEl) this.searchEl.value = qParam;
        this.activeGenre = params.get('genre') || 'all';
        this.activeCity = params.get('city') || 'all';
        this.buildGenreFilters();
        this.buildCityFilters();
      }
      this.syncSearchClear();
      this.applyFilter();
      this.setupInfiniteScroll();
    } catch (err) {
      console.error(err);
      this.showError('Не успяхме да заредим станциите.');
    }
  }

  destroy() {
    this.observer?.disconnect();
    this.observer = null;
    this.stationCards.clear();
  }

  private syncSearchClear() {
    if (this.searchClear && this.searchEl) {
      this.searchClear.hidden = this.searchEl.value.length === 0;
    }
  }

  /** Re-source the in-memory list from localStorage and re-render. */
  reloadFromStore() {
    if (this.mode === 'favorites') this.all = getFavorites();
    else if (this.mode === 'history') this.all = getHistory().map((e) => e.station);
    else return;
    if (this.all.length === 0) {
      void this.showEmpty();
      if (this.toolbarEl) this.toolbarEl.style.display = 'none';
      this.stationsEl.innerHTML = '';
      this.stationCards.clear();
      this.sentinelEl.style.display = 'none';
      return;
    }
    this.statusEl.style.display = 'none';
    if (this.toolbarEl) this.toolbarEl.style.display = '';
    this.applyFilter();
  }

  private applyFilter() {
    const qStr = this.searchEl ? this.searchEl.value.trim().toLowerCase() : '';
    let list = this.all;
    if (this.activeGenre !== 'all') {
      list = list.filter((s) => this.stationMatchesGenre(s, this.activeGenre));
    }
    if (this.activeCity !== 'all') {
      list = list.filter((s) => (s.state || '').toLowerCase() === this.activeCity.toLowerCase());
    }
    this.filtered = qStr
      ? list.filter((s) =>
          s.name.toLowerCase().includes(qStr) || s.tags.toLowerCase().includes(qStr)
        )
      : list;
    this.rendered = 0;
    this.stationsEl.innerHTML = '';
    this.stationCards.clear();
    this.updateCount();
    if (this.filtered.length === 0 && this.all.length > 0) {
      this.stationsEl.innerHTML =
        '<p class="empty">Няма станции, отговарящи на търсенето.<br>Опитайте с друга дума или премахнете филтрите.</p>';
      this.sentinelEl.style.display = 'none';
    } else {
      this.renderNextBatch();
    }
    if (this.mode === 'browse') this.syncUrl(qStr);
  }

  /** Keep q/genre/city in the URL so filtered views are shareable. */
  private syncUrl(qStr: string) {
    const params = new URLSearchParams(window.location.search);
    const setOrDelete = (key: string, value: string, empty: string) => {
      if (value && value !== empty) params.set(key, value);
      else params.delete(key);
    };
    setOrDelete('q', qStr, '');
    setOrDelete('genre', this.activeGenre, 'all');
    setOrDelete('city', this.activeCity, 'all');
    const qs = params.toString();
    const next = `${window.location.pathname}${qs ? '?' + qs : ''}${window.location.hash}`;
    if (next !== window.location.pathname + window.location.search + window.location.hash) {
      history.replaceState(history.state, '', next);
    }
  }

  private stationMatchesGenre(s: Station, genre: string): boolean {
    const tags = s.tags.toLowerCase();
    for (const [key, bg] of Object.entries(GENRE_MAP)) {
      if (bg === genre && tags.includes(key)) return true;
    }
    return false;
  }

  private buildGenreFilters() {
    if (!this.genreContainer) return;
    const genreCounts = new Map<string, number>();
    for (const s of this.all) {
      const tags = s.tags.toLowerCase();
      for (const [key, bg] of Object.entries(GENRE_MAP)) {
        if (tags.includes(key)) {
          genreCounts.set(bg, (genreCounts.get(bg) || 0) + 1);
        }
      }
    }
    const sorted = [...genreCounts.entries()]
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return;

    if (!sorted.some(([name]) => name === this.activeGenre)) this.activeGenre = 'all';
    this.genreContainer.style.display = '';
    this.genreContainer.innerHTML = `<button class="genre-pill${this.activeGenre === 'all' ? ' active' : ''}" data-genre="all">Всички</button>`
      + sorted.map(([name]) =>
        `<button class="genre-pill${this.activeGenre === name ? ' active' : ''}" data-genre="${escapeAttr(name)}">${escapeHtml(name)}</button>`
      ).join('');
    this.genreContainer.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-genre]');
      if (!btn) return;
      this.activeGenre = btn.dataset.genre || 'all';
      this.genreContainer!.querySelectorAll('.genre-pill').forEach((b) =>
        b.classList.toggle('active', (b as HTMLElement).dataset.genre === this.activeGenre)
      );
      this.applyFilter();
    });
  }

  private buildCityFilters() {
    if (!this.cityContainer) return;
    const cityCounts = new Map<string, number>();
    for (const s of this.all) {
      const city = (s.state || '').trim();
      if (city) cityCounts.set(city, (cityCounts.get(city) || 0) + 1);
    }
    const sorted = [...cityCounts.entries()]
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    if (sorted.length === 0) return;

    if (!sorted.some(([name]) => name.toLowerCase() === this.activeCity.toLowerCase())) this.activeCity = 'all';
    this.cityContainer.style.display = '';
    this.cityContainer.innerHTML = `<button class="genre-pill${this.activeCity === 'all' ? ' active' : ''}" data-city="all">Всички градове</button>`
      + sorted.map(([name, count]) =>
        `<button class="genre-pill${this.activeCity === name ? ' active' : ''}" data-city="${escapeAttr(name)}">${escapeHtml(name)} (${count})</button>`
      ).join('');
    this.cityContainer.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-city]');
      if (!btn) return;
      this.activeCity = btn.dataset.city || 'all';
      this.cityContainer!.querySelectorAll('.genre-pill').forEach((b) =>
        b.classList.toggle('active', (b as HTMLElement).dataset.city === this.activeCity)
      );
      this.applyFilter();
    });
  }

  private updateCount() {
    const total = this.all.length;
    const shown = this.filtered.length;
    const word = this.mode === 'favorites' ? 'любими' : this.mode === 'history' ? 'в дневника' : 'станции';
    this.countEl.textContent =
      shown === total ? `${total} ${word}` : `${shown} от ${total} ${word}`;
  }

  private renderNextBatch() {
    const next = this.filtered.slice(this.rendered, this.rendered + BATCH_SIZE);
    const frag = document.createDocumentFragment();
    for (const s of next) {
      const card = this.makeStationCard(s);
      this.stationCards.set(s.stationuuid, card);
      frag.appendChild(card);
    }
    this.stationsEl.appendChild(frag);
    this.rendered += next.length;
    this.sentinelEl.style.display = this.rendered < this.filtered.length ? '' : 'none';
    if (current && !audio.paused) {
      this.updateActiveCard(current.stationuuid);
      this.setActiveSong(songTitle);
    }
  }

  private setupInfiniteScroll() {
    this.observer?.disconnect();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && this.rendered < this.filtered.length) {
            this.renderNextBatch();
          }
        }
      },
      { rootMargin: '400px 0px' }
    );
    this.observer.observe(this.sentinelEl);
  }

  private makeStationCard(s: Station, playFrom?: () => Station[]): HTMLElement {
    const card = document.createElement('div');
    card.className = 'station';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    if (this.brokenIds.has(s.stationuuid)) {
      card.classList.add('broken');
      card.title = 'Потокът не отговори при последния опит';
    }
    const tag = (s.tags.split(',')[0] || s.codec || '').trim();
    const genre = classifyGenre(s.tags);
    const genreClass = genre && GENRE_SLUG[genre] ? ` gc-${GENRE_SLUG[genre]}` : '';
    const fav = isFavorite(s.stationuuid);
    const votes = s.votes > 0 ? `<span class="station-votes" title="${s.votes} гласа">★ ${s.votes}</span>` : '';
    const bitrate = s.bitrate > 0 ? `<span class="station-bitrate">${s.bitrate} kbps</span>` : '';
    card.innerHTML = `
      <div class="station-logo">${logoHtmlFor(s)}</div>
      <div class="station-meta">
        <p class="station-name">${escapeHtml(s.name)}</p>
        <span class="station-tag-row">${tag ? `<span class="station-tag${genreClass}">${escapeHtml(tag)}</span>` : ''}${bitrate}${votes}<span class="station-song" data-card-song></span></span>
      </div>
      <button class="fav-btn ${fav ? 'active' : ''}" data-fav type="button" aria-label="${fav ? 'Премахни от любими' : 'Добави в любими'}" aria-pressed="${fav}">
        ${ICON_STAR}
      </button>
    `;
    const start = () => playStation(s, playFrom ? playFrom() : this.filtered);
    card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-fav]')) return;
      start();
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        start();
      }
    });
    const favBtn = card.querySelector<HTMLButtonElement>('[data-fav]')!;
    favBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(s);
    });
    return card;
  }

  private setView(view: View) {
    if (view !== 'list' && view !== 'grid') return;
    if (view === this.view) return;
    this.view = view;
    localStorage.setItem(VIEW_KEY, view);
    this.stationsEl.classList.remove('view-list', 'view-grid');
    this.stationsEl.classList.add(`view-${view}`);
    this.viewButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  }

  private async showEmpty() {
    const msg =
      this.mode === 'favorites'
        ? 'Все още нямате любими станции.<br>Натиснете звездичка до станция, за да я запазите.'
        : this.mode === 'history'
          ? 'Дневникът е празен.<br>Започнете да слушате, за да видите станциите тук.'
          : 'Няма налични станции.';
    this.statusEl.style.display = '';
    this.statusEl.innerHTML = `<p class="empty">${msg}</p>${this.mode !== 'browse' ? '<a class="cta cta-secondary" href="/">Виж всички станции</a>' : ''}`;

    // On the favorites page, suggest popular stations to star right away.
    if (this.mode === 'favorites') {
      try {
        const cat = await ensureCatalog();
        const top = cat.slice(0, 6);
        if (top.length === 0) return;
        this.stationsEl.innerHTML = '';
        this.stationCards.clear();
        const head = document.createElement('p');
        head.className = 'suggest-head';
        head.textContent = 'Популярни станции — добавете с ⭐:';
        this.stationsEl.classList.remove('view-grid');
        this.stationsEl.classList.add('view-list');
        this.stationsEl.appendChild(head);
        for (const s of top) {
          const card = this.makeStationCard(s, () => top);
          this.stationCards.set(s.stationuuid, card);
          this.stationsEl.appendChild(card);
        }
      } catch { /* suggestions are best-effort */ }
    }
  }

  private showError(msg: string) {
    this.statusEl.style.display = '';
    this.statusEl.innerHTML = `<p>${escapeHtml(msg)}<br>Опитайте отново или проверете интернет връзката си.</p>`;
  }

  updateActiveCard(activeId: string | null) {
    for (const [id, el] of this.stationCards) {
      el.classList.toggle('active', id === activeId);
    }
  }

  markBroken(id: string) {
    this.brokenIds.add(id);
    const card = this.stationCards.get(id);
    if (card) {
      card.classList.add('broken');
      card.title = 'Потокът не отговори при последния опит';
    }
  }

  /** Show the currently playing song on the active card (list view). */
  setActiveSong(title: string) {
    for (const [id, el] of this.stationCards) {
      const songEl = el.querySelector<HTMLElement>('[data-card-song]');
      if (songEl) songEl.textContent = id === current?.stationuuid ? title : '';
    }
  }

  refreshFavStars() {
    for (const [id, el] of this.stationCards) {
      const fav = isFavorite(id);
      const btn = el.querySelector<HTMLButtonElement>('[data-fav]');
      if (btn) {
        btn.classList.toggle('active', fav);
        btn.setAttribute('aria-pressed', String(fav));
        btn.setAttribute('aria-label', fav ? 'Премахни от любими' : 'Добави в любими');
      }
    }
  }

  onStoreChange(kind: string) {
    if (kind === 'favorites') this.refreshFavStars();
    if (this.mode === 'favorites' && kind === 'favorites') this.reloadFromStore();
    if (this.mode === 'history' && kind === 'history') this.reloadFromStore();
  }
}

// ---------------------------------------------------------------------------
// One-time wiring (module scope — runs once per session)
// ---------------------------------------------------------------------------

function bindDock() {
  const savedVol = parseFloat(localStorage.getItem(VOLUME_KEY) || '0.8');
  audio.volume = isNaN(savedVol) ? 0.8 : savedVol;
  modalVolume.value = String(audio.volume);
  modalVolume.style.setProperty('--vol', `${audio.volume * 100}%`);

  audio.addEventListener('playing', () => setState('playing'));
  audio.addEventListener('pause', () => setState('paused'));
  audio.addEventListener('waiting', () => setState('loading'));
  audio.addEventListener('error', () => setState('error'));

  npToggle.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  npPrev.addEventListener('click', (e) => { e.stopPropagation(); step(-1); });
  npNext.addEventListener('click', (e) => { e.stopPropagation(); step(1); });
  npExpand.addEventListener('click', (e) => { e.stopPropagation(); openModal(); });
  nowPlaying.addEventListener('click', (e) => {
    if (e.target === nowPlaying || (e.target as HTMLElement).closest('.np-info')) {
      openModal();
    }
  });

  modalToggle.addEventListener('click', () => toggle());
  modalPrev.addEventListener('click', () => step(-1));
  modalNext.addEventListener('click', () => step(1));
  modalClose.addEventListener('click', () => closeModal());
  modalFav.addEventListener('click', () => {
    if (current) toggleFavorite(current);
  });
  modalVote.addEventListener('click', () => void vote());
  document.querySelector<HTMLButtonElement>('[data-modal-share]')
    ?.addEventListener('click', () => void share());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
    if ((e.target as HTMLElement).closest('[data-err-next]')) step(1);
  });
  modal.addEventListener('keydown', trapFocus);

  modalVolume.addEventListener('input', () => {
    const v = parseFloat(modalVolume.value);
    audio.volume = v;
    modalVolume.style.setProperty('--vol', `${v * 100}%`);
    localStorage.setItem(VOLUME_KEY, String(v));
  });

  const sleepToggle = document.querySelector<HTMLButtonElement>('[data-sleep-toggle]');
  const sleepOptions = document.querySelector<HTMLElement>('[data-sleep-options]');
  if (sleepToggle && sleepOptions) {
    sleepToggle.addEventListener('click', () => {
      sleepOptions.hidden = !sleepOptions.hidden;
    });
    sleepOptions.querySelectorAll<HTMLButtonElement>('[data-sleep-min]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setSleepTimer(parseInt(btn.dataset.sleepMin || '0'));
        sleepOptions.hidden = true;
      });
    });
  }
}

/** Restore the last played station into the mini bar (paused) on first load. */
function restoreLastStation() {
  if (current) return;
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.stationuuid && parsed.url_resolved) {
      current = parsed as Station;
      playlist = [current];
      showNowPlaying(current, 'paused');
    }
  } catch { /* old uuid-only format or corrupt entry — ignore */ }
}

/** "Listen live" buttons on station directory pages. */
async function handlePlayButton(btn: HTMLElement) {
  const query = btn.dataset.playStation || '';
  const fallback = btn.dataset.playFallback || query;
  if (!query) return;
  btn.setAttribute('aria-busy', 'true');
  try {
    const cat = await ensureCatalog();
    const match = matchStation(query, cat);
    if (match) {
      playStation(match, cat);
      openModal();
      return;
    }
  } catch { /* fall through to search */ }
  finally {
    btn.removeAttribute('aria-busy');
  }
  window.location.href = `/?q=${encodeURIComponent(fallback)}#player`;
}

// Global listeners — attached once; they survive view-transition swaps.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modal.classList.contains('visible')) {
    closeModal();
    return;
  }
  // Skip while typing or when a control has focus, so Space/Enter don't
  // double-trigger focused buttons.
  const target = e.target as HTMLElement;
  if (target.closest('input, textarea, select, button, [contenteditable]')) return;
  if (e.key === ' ' && !modal.classList.contains('visible')) { e.preventDefault(); toggle(); }
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
  if (e.key === 'm' || e.key === 'M') { audio.muted = !audio.muted; }
});

document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-play-station]');
  if (btn) void handlePlayButton(btn);
});

document.addEventListener(STORE_EVENT, (e) => {
  const detail = (e as CustomEvent).detail as { kind: string };
  listUI?.onStoreChange(detail.kind);
  refreshFavStars();
});

// Re-bind the page-specific list after every (soft or hard) navigation.
document.addEventListener('astro:page-load', () => {
  listUI?.destroy();
  const root = document.querySelector<HTMLElement>('[data-player]');
  listUI = root ? new ListUI(root) : null;
  void listUI?.init();
});

bindDock();
setupMediaSession();
restoreLastStation();
