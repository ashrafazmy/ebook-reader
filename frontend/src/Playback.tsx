import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage, type BookDetail } from './api';
import { useDownloads } from './useDownloads';
import { downloadedVersions, readDownload } from './downloads';
import { readProgress, readVersionProgress, saveLocalProgress } from './progress';

export interface ChapterVersion { id: string; section_id: string; profile_id: string; profile_name: string; model_name: string; state: string; audio_url: string | null; duration?: number | null }
export interface Progress { version_id: string; section_id: string; offset: number; speed: number; updated_at_ms?: number }
interface ChapterTrack { id: string; url: string; title: string; chapter: { book: BookDetail; version: ChapterVersion }; offset?: number; speed?: number; device?: boolean }
interface PlaybackContext { track: ChapterTrack | null; load: (track: ChapterTrack, onlyIfEmpty?: boolean) => void; loadChapter: (book: BookDetail, version: ChapterVersion, localOnly?: boolean) => Promise<void> }
const Context = createContext<PlaybackContext | null>(null);
export function usePlayback() {
  const value = useContext(Context);
  if (!value) throw new Error('PlaybackProvider is required');
  return value;
}
export function chapterTrack(book: BookDetail, version: ChapterVersion, progress?: Progress | null): ChapterTrack {
  return { id: version.id, url: version.audio_url!, title: `${book.title} · ${book.sections.find((s) => s.id === version.section_id)?.title ?? 'Chapter'} · ${version.profile_name}`,
    chapter: { book, version }, offset: progress?.version_id === version.id ? progress.offset : 0, speed: progress?.speed ?? 1 };
}

export default function PlaybackProvider({ children }: { children: ReactNode }) {
  const { items: downloads } = useDownloads();
  const [track, setTrack] = useState<ChapterTrack | null>(null);
  const active = useRef<ChapterTrack | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const dock = useRef<HTMLElement>(null);
  const [speed, setSpeed] = useState(1);
  const [notice, setNotice] = useState('');
  const [saveError, setSaveError] = useState('');
  const touched = useRef(false);
  const timestamp = useRef(0);
  const lastSent = useRef(0);
  const autoContinue = useRef(false);
  const playOnLoad = useRef(false);
  const epoch = useRef(0);

  function save() {
    const current = active.current;
    const player = audio.current;
    if (!current || !player || player.readyState < 1 || !touched.current) return;
    timestamp.current = Math.max(Date.now(), timestamp.current + 1);
    void saveLocalProgress(current.chapter.book.id, {
      version_id: current.id, section_id: current.chapter.version.section_id,
      offset: player.currentTime, speed: player.playbackRate, updated_at_ms: timestamp.current,
    }).then(() => setSaveError('')).catch(() => setSaveError('Position could not be saved on this device. Free storage or check browser permissions and retry.'));

  }

  function load(next: ChapterTrack, onlyIfEmpty = false, autoplay = false) {
    if ((onlyIfEmpty && active.current) || (active.current?.id === next.id && active.current.url === next.url)) { if (next.url.startsWith('blob:') && next.url !== active.current?.url) URL.revokeObjectURL(next.url); return; }
    save();
    // Pause synchronously before switching sources: there is only one media element.
    audio.current?.pause();
    epoch.current += 1;
    touched.current = false;
    autoContinue.current = false;
    playOnLoad.current = autoplay;
    if (active.current?.url.startsWith('blob:')) URL.revokeObjectURL(active.current.url);
    active.current = next;
    setTrack(next); setSpeed(next.speed ?? 1); setNotice('');
    try {
      localStorage.setItem('reader-listening-book', next.chapter.book.id);
    } catch { /* Storage restrictions do not prevent playback. */ }
  }

  async function prepareChapter(book: BookDetail, version: ChapterVersion, progress?: Progress | null): Promise<ChapterTrack> {
    if (globalThis.indexedDB) {
      try {
        const { item, audio } = await readDownload(version.id);
        return { ...chapterTrack(item.book, item.version, progress), url: URL.createObjectURL(audio), device: true };
      } catch { /* A non-downloaded chapter still plays from the server when connected. */ }
    }
    if (navigator.onLine === false) throw new Error('This audio version is not downloaded. Open Device downloads to choose available audio.');
    return chapterTrack(book, version, progress);
  }
  async function loadChapter(book: BookDetail, version: ChapterVersion, localOnly = false, autoplay = !audio.current?.paused && !!audio.current) {
    if (active.current?.id === version.id && active.current.device) {
      window.location.hash = `download=${version.id}`; return;
    }
    save();
    const requestEpoch = ++epoch.current;
    let next: ChapterTrack | undefined;
    try {
      const progress = await readVersionProgress(book.id, version.id, localOnly);
      if (localOnly) {
        const { item, audio: blob } = await readDownload(version.id);
        next = { ...chapterTrack(item.book, item.version, progress), url: URL.createObjectURL(blob), device: true };
      } else next = await prepareChapter(book, version, progress);
      // Verify replacement metadata while the current player keeps its source.
      await verifyMedia(next.url);
      if (requestEpoch !== epoch.current) { if (next.device) URL.revokeObjectURL(next.url); return; }
      if (active.current?.id === next.id && audio.current) { next.offset = audio.current.currentTime; next.speed = audio.current.playbackRate; }
      load(next, false, autoplay);
      window.location.hash = next.device ? `download=${next.id}` : `book=${book.id}&section=${version.section_id}`;
    } catch (error) {
      if (next?.device) URL.revokeObjectURL(next.url);
      if (requestEpoch === epoch.current) setNotice(errorMessage(error));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    let bookId: string | null = null;
    try { bookId = localStorage.getItem('reader-listening-book'); } catch { /* Optional resume hint. */ }
    if (bookId && !new URLSearchParams(window.location.hash.slice(1)).has('book')) void (async () => {
      const progress = await readProgress(bookId!);
      if (!progress) return;
      let next: ChapterTrack | undefined;
      if (globalThis.indexedDB) {
        try { const { item, audio } = await readDownload(progress.version_id); next = { ...chapterTrack(item.book, item.version, progress), url: URL.createObjectURL(audio), device: true }; } catch { /* Try server below. */ }
      }
      if (!next) {
        const [book, jobs] = await Promise.all([api<BookDetail>(`/books/${bookId}`, { signal: controller.signal }), api<ChapterVersion[]>(`/chapters?book_id=${bookId}`, { signal: controller.signal })]);
        const version = jobs.find((j) => j.id === progress.version_id && j.state === 'ready' && j.audio_url);
        if (version) next = chapterTrack(book, version, progress);
      }
      if (next && !controller.signal.aborted) load(next, true);
      else if (next?.device) URL.revokeObjectURL(next.url);
    })().catch(() => { /* Device library remains available when the server is unreachable. */ });
    const leave = () => save();
    const visibility = () => { if (document.visibilityState === 'hidden') save(); };
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', visibility);
    return () => { controller.abort(); save(); window.removeEventListener('pagehide', leave); document.removeEventListener('visibilitychange', visibility); };
  }, []);

  useEffect(() => {
    if (!dock.current) return;
    const observer = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--player-height', `${dock.current?.getBoundingClientRect().height ?? 0}px`);
    });
    observer.observe(dock.current);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty('--player-height'); };
  }, [!!track]);

  async function adjacent(delta: number, autoplay = !!audio.current && !audio.current.paused) {
    const current = active.current;
    if (!current) return;
    save();
    const { book, version } = current.chapter;
    const next = book.sections[book.sections.findIndex((s) => s.id === version.section_id) + delta];
    if (!next) { setNotice('You have reached the end of the book.'); return; }
    try {
      const local = current.device || navigator.onLine === false;
      const jobs = local ? await downloadedVersions(book.id) : await api<ChapterVersion[]>(`/chapters?book_id=${book.id}`);
      const candidates = jobs.filter((j) => j.section_id === next.id && j.state === 'ready' && j.audio_url);
      const ready = candidates.find((j) => j.profile_id === version.profile_id && j.model_name === version.model_name) ?? candidates[0];
      if (!ready) { setNotice(`Chapter ${book.sections.indexOf(next) + 1}: ${next.title} ${local ? 'is not downloaded. Connect and download it first.' : 'has no ready audio. Open the book to read or generate it.'}`); return; }
      if (active.current?.id !== current.id) return;
      await loadChapter(book, ready, local, autoplay);
    } catch (error) { setNotice(errorMessage(error)); }
  }

  const playingBook = track?.chapter.book;
  const playingSection = playingBook?.sections.find((s) => s.id === track?.chapter.version.section_id);
  const chapterLabel = `Chapter ${(playingBook?.sections.findIndex((s) => s.id === playingSection?.id) ?? -1) + 1}: ${playingSection?.title ?? 'Chapter'}`;
  const choices = downloads.filter((item) => item.state === 'ready' && item.book.id === playingBook?.id)
    .sort((a, b) => (playingBook?.sections.findIndex((s) => s.id === a.version.section_id) ?? 0) - (playingBook?.sections.findIndex((s) => s.id === b.version.section_id) ?? 0) || a.id.localeCompare(b.id));

  return <Context.Provider value={{ track, load, loadChapter }}>{children}
    {!track && notice && <p className="error" role="alert">{notice}</p>}
    {track && <aside ref={dock} className="playback-dock" aria-label="Audio player">
      <div className="playback-inner">
        <div className="now-playing"><details className="playing-title"><summary aria-label={`${chapterLabel}. ${playingBook?.title}. Expand full playing title`}><strong>{chapterLabel}</strong><span>{playingBook?.title}</span></summary>
          <div className="playing-full-title" tabIndex={0} role="region" aria-label="Full playing chapter details"><p>{chapterLabel}</p><p>{playingBook?.title}</p><p>{track.chapter.version.profile_name} · {track.chapter.version.model_name} · version {track.id.slice(0, 8)}</p></div>
        </details><a href={track.device ? `#download=${track.id}` : `#book=${track.chapter.book.id}&section=${track.chapter.version.section_id}`}>Open chapter</a></div>
        <label className="download-selector">Downloaded chapters
          <select aria-label="Downloaded chapters for playing book" value={choices.some((item) => item.id === track.id) ? track.id : ''} onChange={(e) => {
            const choice = choices.find((item) => item.id === e.target.value);
            if (choice) void loadChapter(choice.book, choice.version, true);
          }}>
            {!choices.some((item) => item.id === track.id) && <option value="">Choose a downloaded chapter</option>}
            {choices.map((item) => <option key={item.id} value={item.id}>
              {item.id === track.id ? 'Playing · ' : ''}Chapter {(playingBook?.sections.findIndex((s) => s.id === item.version.section_id) ?? -1) + 1}: {item.section?.title} · {item.version.duration != null ? `${Math.floor(item.version.duration / 60)}:${String(Math.floor(item.version.duration % 60)).padStart(2, '0')} · ` : ''}{item.version.profile_name} · {item.id.slice(0, 8)}
            </option>)}
          </select>
        </label>
        <audio ref={audio} aria-label={track.title} controls preload="metadata" src={track.url}
          onLoadedMetadata={(event) => {
            const player = event.currentTarget;
            player.currentTime = Math.min(track.offset ?? 0, Number.isFinite(player.duration) ? player.duration : track.offset ?? 0);
            player.playbackRate = speed;
            if (playOnLoad.current) {
              playOnLoad.current = false;
              const id = track.id;
              void player.play().catch(() => { if (active.current?.id === id) setNotice('Press Play to continue; the browser could not start playback.'); });
            }
          }}
          onPlay={() => { epoch.current += 1; touched.current = true; autoContinue.current = true; setNotice(''); }}
          onTimeUpdate={() => { if (!audio.current?.paused && Date.now() - lastSent.current > 5000) { lastSent.current = Date.now(); save(); } }}
          onPause={(e) => { if (!e.currentTarget.ended) { autoContinue.current = false; epoch.current += 1; } save(); }}
          onPointerDown={() => { touched.current = true; }}
          onKeyDown={() => { touched.current = true; }}
          onSeeked={save}
          onEnded={() => { save(); if (autoContinue.current) void adjacent(1, true); }}
          onError={() => { autoContinue.current = false; setNotice('Audio playback failed. Retry loading audio; for a missing device download, reconnect and download it again.'); }} />
        <div className="playback-tools">
          {track.device && <span className="help">On device</span>}
          <button className="secondary" aria-label="Previous audio chapter" disabled={track.chapter.book.sections[0]?.id === track.chapter.version.section_id} onClick={() => void adjacent(-1)}>← Chapter</button><button className="secondary" aria-label="Next audio chapter" disabled={track.chapter.book.sections.at(-1)?.id === track.chapter.version.section_id} onClick={() => void adjacent(1)}>Chapter →</button>
          <label>Speed<select aria-label="Playback speed" value={speed} onChange={(e) => { const value = Number(e.target.value); setSpeed(value); if (audio.current) audio.current.playbackRate = value; touched.current = true; save(); }}>{[.5,.75,1,1.25,1.5,1.75,2,2.5,3].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
        </div>
        {notice && <p role="status">{notice} <button className="secondary" onClick={() => { if (active.current && audio.current) { active.current.offset = audio.current.currentTime; active.current.speed = audio.current.playbackRate; } audio.current?.load(); }}>Reload audio</button></p>}
        {saveError && <p role="alert">{saveError} <button onClick={save}>Retry save</button></p>}
      </div>
    </aside>}
  </Context.Provider>;
}

export function verifyMedia(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = document.createElement('audio');
    const finish = (error?: Error) => {
      clearTimeout(timer); probe.onloadedmetadata = probe.onerror = null;
      probe.removeAttribute('src');
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Replacement audio timed out. Current audio is unchanged; retry when available.')), 15000);
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => finish();
    probe.onerror = () => finish(new Error('Replacement audio could not be loaded. Current audio is unchanged.'));
    probe.src = url;
    if (probe.readyState >= 1) finish();
  });
}
