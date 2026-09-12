import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, type BookDetail } from './api';

interface Job { id: string; section_id: string; profile_id: string; profile_name: string; model_name: string;
  state: string; error: string | null; completed: number; total: number; audio_url: string | null; duration: number | null }
interface Voice { id: string; name: string; models: { id: string; name: string; downloaded: boolean }[] }
interface Progress { version_id: string; section_id: string; offset: number; speed: number; updated_at_ms: number }

export default function ChapterAudio({ book, sectionId, navigate }: {
  book: BookDetail; sectionId: string; navigate: (id: string) => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [profileId, setProfileId] = useState('');
  const [modelId, setModelId] = useState('');
  const [connection, setConnection] = useState('Checking Voicebox…');
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [voiceRefresh, setVoiceRefresh] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [versionId, setVersionId] = useState('');
  const [speed, setSpeed] = useState(1);
  const [confirmUnknown, setConfirmUnknown] = useState(false);
  const player = useRef<HTMLAudioElement>(null);
  const saved = useRef<Progress | null>(null);
  const current = useRef<{ id: string; section: string; offset: number; speed: number; touched: boolean } | null>(null);
  const lastSent = useRef(0);
  const timestamp = useRef(0);
  const continueTo = useRef<string | null>(null);
  const userStarted = useRef(false);
  const previousSection = useRef(sectionId);
  const scope = useRef(sectionId);
  scope.current = sectionId;
  const activeVersion = jobs.find((job) => job.id === versionId && job.section_id === sectionId && job.state === 'ready');
  const sectionJobs = jobs.filter((job) => job.section_id === sectionId);
  const job = sectionJobs.find((item) => item.profile_id === profileId && item.model_name === modelId) ?? sectionJobs[0];
  const voice = voices.find((item) => item.id === profileId);
  const model = voice?.models.find((item) => item.id === modelId);

  useEffect(() => { setConfirmUnknown(false); }, [sectionId, job?.id]);

  function save() {
    const value = current.current;
    if (!value?.touched) return;
    timestamp.current = Math.max(Date.now(), timestamp.current + 1);
    const payload = { version_id: value.id, offset: value.offset, speed: value.speed, updated_at_ms: timestamp.current };
    saved.current = { ...payload, section_id: value.section };
    void api(`/books/${book.id}/listening-progress`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true,
    }).then(() => setSaveError('')).catch(() => setSaveError('Listening position could not be saved. Keep this page open and retry.'));
  }

  useEffect(() => {
    const controller = new AbortController();
    api<Progress | null>(`/books/${book.id}/listening-progress`, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        saved.current = value;
        if (value) { setSpeed(value.speed); setVersionId(value.version_id); navigate(value.section_id); }
        setLoaded(true);
      }).catch((error: unknown) => { if (!controller.signal.aborted) { setError(errorMessage(error)); setLoaded(true); } });
    const leave = () => save();
    window.addEventListener('pagehide', leave);
    return () => { controller.abort(); save(); window.removeEventListener('pagehide', leave); };
    // Book-scoped component: do not restore again when the selected section changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    async function poll() {
      try {
        const result = await api<Job[]>(`/chapters?book_id=${book.id}`, { signal: controller.signal });
        if (!controller.signal.aborted) setJobs(result);
      } catch (error) { if (!controller.signal.aborted) setError(errorMessage(error)); }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [book.id, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    setConnection('Checking Voicebox…');
    api<{ profiles: Voice[] }>('/voicebox/profiles', { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setVoices(result.profiles); setConnection('Voicebox connected');
      setProfileId((old) => old || result.profiles.find((p) => p.models.some((m) => m.downloaded))?.id || result.profiles[0]?.id || '');
    }).catch((error: unknown) => { if (!controller.signal.aborted) { setVoices([]); setConnection(errorMessage(error)); } });
    return () => controller.abort();
  }, [voiceRefresh]);

  useEffect(() => {
    if (voice) setModelId((old) => voice.models.some((m) => m.id === old) ? old : voice.models.find((m) => m.downloaded)?.id || voice.models[0]?.id || '');
  }, [voice]);

  useEffect(() => {
    if (!loaded) return;
    if (previousSection.current !== sectionId) {
      save(); current.current = null; userStarted.current = false;
      previousSection.current = sectionId;
    }
    if (!jobs.some((item) => item.id === versionId && item.section_id === sectionId && item.state === 'ready')) {
      const restored = jobs.find((item) => item.id === saved.current?.version_id && item.section_id === sectionId && item.state === 'ready');
      const ready = restored || jobs.find((item) => item.section_id === sectionId && item.state === 'ready');
      setVersionId(ready?.id || '');
    }
  }, [jobs, sectionId, loaded, versionId]);

  async function action(kind: 'generate' | 'replace' | 'retry' | 'cancel') {
    const originalSection = sectionId;
    setBusy(true); setError('');
    try {
      await api(kind === 'retry' || kind === 'cancel' ? `/chapters/${job?.id}/${kind}` : '/chapters', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'retry' ? { confirm_unknown: confirmUnknown } : kind === 'cancel' ? {} :
          { section_id: sectionId, profile_id: profileId, model_name: modelId, replace: kind === 'replace' }),
      });
      setRefresh((n) => n + 1);
      setConfirmUnknown(false);
    } catch (error) { if (scope.current === originalSection) setError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  function chooseVersion(id: string) {
    save(); current.current = null; userStarted.current = false; continueTo.current = null;
    setVersionId(id);
  }

  function adjacent(delta: number, continuePlaying = false) {
    save();
    const position = book.sections.findIndex((item) => item.id === sectionId);
    const next = book.sections[position + delta];
    if (!next) { setNotice('You have reached the end of the book.'); return; }
    const ready = jobs.find((item) => item.section_id === next.id && item.state === 'ready'
      && (!activeVersion || (item.profile_id === activeVersion.profile_id && item.model_name === activeVersion.model_name)));
    if (continuePlaying && !ready) {
      userStarted.current = false;
      setNotice('The next chapter has no ready audio for this voice/model. Generate it or use Next chapter to read it.');
      return;
    }
    continueTo.current = continuePlaying ? ready?.id || null : null;
    if (continuePlaying && ready) saved.current = { version_id: ready.id, section_id: next.id, offset: 0, speed, updated_at_ms: Date.now() };
    if (ready) setVersionId(ready.id);
    setNotice(''); navigate(next.id);
  }

  const inProgress = job && ['queued', 'generating', 'assembling'].includes(job.state);
  return <aside className="narration-panel" aria-label="Chapter audiobook">
    <h2>Chapter audiobook</h2>
    <p>{connection}</p><button className="secondary" onClick={() => setVoiceRefresh((n) => n + 1)}>Refresh chapter voices</button>
    <div className="voice-controls">
      <label>Voice<select value={profileId} onChange={(e) => setProfileId(e.target.value)}><option value="">Choose voice</option>{voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      <label>Model<select value={modelId} onChange={(e) => setModelId(e.target.value)}><option value="">Choose model</option>{voice?.models.map((m) => <option key={m.id} value={m.id}>{m.name}{m.downloaded ? '' : ' — not downloaded'}</option>)}</select></label>
    </div>
    <div className="narration-actions">
      <button disabled={busy || !!inProgress || !model?.downloaded} onClick={() => void action('generate')}>Generate chapter</button>
      <button className="secondary" disabled={busy || !!inProgress || !model?.downloaded} onClick={() => void action('replace')}>Generate replacement</button>
      {inProgress && <button disabled={busy} onClick={() => void action('cancel')}>Cancel remaining work</button>}
      {job && ['failed', 'cancelled'].includes(job.state) && <button disabled={busy} onClick={() => void action('retry')}>Retry / resume remaining work</button>}
    </div>
    {job && <p role="status">{job.state} · {job.completed} of {job.total} chunks completed · {job.profile_name}</p>}
    {job?.error && <p className="error" role="alert">{job.error}</p>}
    {job?.state === 'failed' && <label className="help"><input type="checkbox" checked={confirmUnknown} onChange={(e) => setConfirmUnknown(e.target.checked)} /> I checked Voicebox history and explicitly allow new submissions for unknown outcomes.</label>}
    {error && <p className="error" role="alert">{error}</p>}
    <label>Saved audio version<select value={versionId} onChange={(e) => chooseVersion(e.target.value)}><option value="">No version selected</option>{sectionJobs.filter((j) => j.state === 'ready').map((j) => <option key={j.id} value={j.id}>{j.profile_name} · {j.model_name} · {j.id.slice(0, 8)}</option>)}</select></label>
    {!activeVersion && <p>No saved audio is available for this chapter yet. Reading still works.</p>}
    {activeVersion && loaded && <audio key={activeVersion.id} ref={player} controls preload="metadata" src={activeVersion.audio_url!}
      onLoadedMetadata={(e) => {
        const audio = e.currentTarget;
        const offset = saved.current?.version_id === activeVersion.id ? saved.current.offset : 0;
        audio.currentTime = Math.min(offset, Number.isFinite(audio.duration) ? audio.duration : offset);
        audio.playbackRate = speed;
        current.current = { id: activeVersion.id, section: sectionId, offset: audio.currentTime, speed, touched: false };
        if (continueTo.current === activeVersion.id) { continueTo.current = null; void audio.play().catch(() => setNotice('Press Play to continue; the browser blocked automatic continuation.')); }
      }}
      onPlay={() => { userStarted.current = true; if (current.current) current.current.touched = true; setNotice(''); }}
      onPointerDown={() => { if (current.current) current.current.touched = true; }}
      onKeyDown={() => { if (current.current) current.current.touched = true; }}
      onTimeUpdate={(e) => {
        if (current.current?.id !== activeVersion.id) return;
        current.current.offset = e.currentTarget.currentTime;
        if (Date.now() - lastSent.current > 5000 && !e.currentTarget.paused) { lastSent.current = Date.now(); save(); }
      }}
      onPause={(e) => {
        if (!e.currentTarget.ended) userStarted.current = false;
        if (current.current?.id === activeVersion.id) { current.current.offset = e.currentTarget.currentTime; save(); }
      }}
      onSeeked={(e) => { if (current.current?.id === activeVersion.id) { current.current.offset = e.currentTarget.currentTime; save(); } }}
      onEnded={() => { if (userStarted.current) adjacent(1, true); }}
      onError={() => setError('Saved audio could not be loaded. Check the backend and chapter file.')} />}
    <label>Playback speed<select value={speed} onChange={(e) => {
      const value = Number(e.target.value); setSpeed(value); if (player.current) player.current.playbackRate = value;
      if (current.current) { current.current.speed = value; current.current.touched = true; save(); }
    }}>{[.5, .75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
    <nav className="section-navigation" aria-label="Audiobook chapters"><button disabled={book.sections[0]?.id === sectionId} onClick={() => adjacent(-1)}>Previous chapter</button><button disabled={book.sections.at(-1)?.id === sectionId} onClick={() => adjacent(1)}>Next chapter</button></nav>
    {notice && <p role="status">{notice}</p>}
    {saveError && <p role="alert" className="error">{saveError} <button onClick={save}>Retry save</button></p>}
    <p className="help">Saved chapter files play without Voicebox. A replacement leaves previous versions available. Restoring a position never starts playback.</p>
  </aside>;
}
