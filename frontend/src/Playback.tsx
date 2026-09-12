import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage, type BookDetail } from './api';

export interface ChapterVersion { id: string; section_id: string; profile_id: string; profile_name: string; model_name: string; state: string; audio_url: string | null }
export interface Progress { version_id: string; section_id: string; offset: number; speed: number }
interface Track { id: string; url: string; title: string; chapter?: { book: BookDetail; version: ChapterVersion }; offset?: number; speed?: number }
interface PlaybackContext { track: Track | null; load: (track: Track, onlyIfEmpty?: boolean) => void; loadChapter: (book: BookDetail, version: ChapterVersion) => Promise<void> }
const Context = createContext<PlaybackContext | null>(null);
export function usePlayback() {
  const value = useContext(Context);
  if (!value) throw new Error('PlaybackProvider is required');
  return value;
}
export function chapterTrack(book: BookDetail, version: ChapterVersion, progress?: Progress | null): Track {
  return { id: version.id, url: version.audio_url!, title: `${book.title} · ${book.sections.find((s) => s.id === version.section_id)?.title ?? 'Chapter'} · ${version.profile_name}`,
    chapter: { book, version }, offset: progress?.version_id === version.id ? progress.offset : 0, speed: progress?.speed ?? 1 };
}

export default function PlaybackProvider({ children }: { children: ReactNode }) {
  const [track, setTrack] = useState<Track | null>(null);
  const active = useRef<Track | null>(null);
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
    if (!current?.chapter || !player || player.readyState < 1 || !touched.current) return;
    timestamp.current = Math.max(Date.now(), timestamp.current + 1);
    void api(`/books/${current.chapter.book.id}/listening-progress`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ version_id: current.id, offset: player.currentTime, speed: player.playbackRate, updated_at_ms: timestamp.current }),
    }).then(() => setSaveError('')).catch(() => setSaveError('Position could not be saved. Check the backend and retry.'));
  }

  function load(next: Track, onlyIfEmpty = false, autoplay = false) {
    if ((onlyIfEmpty && active.current) || active.current?.id === next.id) return;
    save();
    // Pause synchronously before switching sources: there is only one media element.
    audio.current?.pause();
    epoch.current += 1;
    touched.current = false;
    autoContinue.current = false;
    playOnLoad.current = autoplay;
    active.current = next;
    setTrack(next); setSpeed(next.speed ?? 1); setNotice('');
    try {
      if (next.chapter) localStorage.setItem('reader-listening-book', next.chapter.book.id);
      else localStorage.removeItem('reader-listening-book');
    } catch { /* Storage restrictions do not prevent playback. */ }
  }

  async function loadChapter(book: BookDetail, version: ChapterVersion) {
    if (active.current?.id === version.id) return;
    const requestEpoch = ++epoch.current;
    try {
      const progress = await api<Progress | null>(`/books/${book.id}/listening-progress`);
      if (requestEpoch === epoch.current) load(chapterTrack(book, version, progress));
    } catch (error) { if (requestEpoch === epoch.current) setNotice(errorMessage(error)); }
  }

  useEffect(() => {
    const controller = new AbortController();
    let bookId: string | null = null;
    try { bookId = localStorage.getItem('reader-listening-book'); } catch { /* Optional resume hint. */ }
    if (bookId && !new URLSearchParams(window.location.hash.slice(1)).has('book')) void Promise.all([
      api<BookDetail>(`/books/${bookId}`, { signal: controller.signal }),
      api<Progress | null>(`/books/${bookId}/listening-progress`, { signal: controller.signal }),
      api<ChapterVersion[]>(`/chapters?book_id=${bookId}`, { signal: controller.signal }),
    ]).then(([book, progress, jobs]) => {
      const version = jobs.find((j) => j.id === progress?.version_id && j.state === 'ready' && j.audio_url);
      if (!controller.signal.aborted && version) load(chapterTrack(book, version, progress), true);
    }).catch(() => { /* Opening the book also offers saved versions and retries. */ });
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

  async function adjacent(delta: number, autoplay = false) {
    const current = active.current;
    if (!current?.chapter) return;
    save();
    const { book, version } = current.chapter;
    const next = book.sections[book.sections.findIndex((s) => s.id === version.section_id) + delta];
    if (!next) { setNotice('You have reached the end of the book.'); return; }
    const requestEpoch = ++epoch.current;
    try {
      const jobs = await api<ChapterVersion[]>(`/chapters?book_id=${book.id}`);
      if (requestEpoch !== epoch.current) return;
      const ready = jobs.find((j) => j.section_id === next.id && j.state === 'ready' && j.audio_url && j.profile_id === version.profile_id && j.model_name === version.model_name);
      if (!ready) { setNotice('That chapter has no ready audio for this voice/model. Open the book to read or generate it.'); return; }
      load({ ...chapterTrack(book, ready), speed: audio.current?.playbackRate ?? 1 }, false, autoplay);
    } catch (error) { if (requestEpoch === epoch.current) setNotice(errorMessage(error)); }
  }

  return <Context.Provider value={{ track, load, loadChapter }}>{children}
    {!track && notice && <p className="error" role="alert">{notice}</p>}
    {track && <aside ref={dock} className="playback-dock" aria-label="Audio player">
      <div className="playback-inner">
        <div className="now-playing"><strong title={track.title}>{track.title}</strong>{track.chapter && <a href={`#book=${track.chapter.book.id}`}>Open book</a>}</div>
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
          onError={() => { autoContinue.current = false; setNotice('Audio could not be loaded. Check the backend, then retry loading audio.'); }} />
        <div className="playback-tools">
          {track.chapter && <><button className="secondary" aria-label="Previous audio chapter" disabled={track.chapter.book.sections[0]?.id === track.chapter.version.section_id} onClick={() => void adjacent(-1)}>← Chapter</button><button className="secondary" aria-label="Next audio chapter" disabled={track.chapter.book.sections.at(-1)?.id === track.chapter.version.section_id} onClick={() => void adjacent(1)}>Chapter →</button></>}
          <label>Speed<select value={speed} onChange={(e) => { const value = Number(e.target.value); setSpeed(value); if (audio.current) audio.current.playbackRate = value; touched.current = true; save(); }}>{[.5,.75,1,1.25,1.5,1.75,2,2.5,3].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
        </div>
        {notice && <p role="status">{notice} <button className="secondary" onClick={() => { if (active.current && audio.current) { active.current.offset = audio.current.currentTime; active.current.speed = audio.current.playbackRate; } audio.current?.load(); }}>Reload audio</button></p>}
        {saveError && <p role="alert">{saveError} <button onClick={save}>Retry save</button></p>}
      </div>
    </aside>}
  </Context.Provider>;
}
