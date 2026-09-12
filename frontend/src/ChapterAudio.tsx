import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, type BookDetail } from './api';
import { chapterTrack, usePlayback, type Progress } from './Playback';

interface Job { id: string; section_id: string; profile_id: string; profile_name: string; model_name: string;
  state: string; error: string | null; completed: number; total: number; audio_url: string | null; duration: number | null }
interface Voice { id: string; name: string; models: { id: string; name: string; downloaded: boolean }[] }


export default function ChapterAudio({ book, sectionId, navigate, onStatus }: {
  book: BookDetail; sectionId: string; navigate: (id: string) => void; onStatus: (status: string) => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [profileId, setProfileId] = useState('');
  const [modelId, setModelId] = useState('');
  const [connection, setConnection] = useState('Checking Voicebox…');
  const [error, setError] = useState('');
  const playback = usePlayback();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [voiceRefresh, setVoiceRefresh] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [versionId, setVersionId] = useState('');
  const [confirmUnknown, setConfirmUnknown] = useState(false);
  const saved = useRef<Progress | null>(null);
  const scope = useRef(sectionId);
  scope.current = sectionId;
  const activeVersion = jobs.find((job) => job.id === versionId && job.section_id === sectionId && job.state === 'ready');
  const sectionJobs = jobs.filter((job) => job.section_id === sectionId);
  const job = sectionJobs.find((item) => item.profile_id === profileId && item.model_name === modelId) ?? sectionJobs[0];
  const voice = voices.find((item) => item.id === profileId);
  const model = voice?.models.find((item) => item.id === modelId);

  useEffect(() => { onStatus(job ? `${job.state} · ${job.completed} of ${job.total} chunks` : 'generation and saved versions'); }, [job?.state, job?.completed, job?.total]);

  useEffect(() => { setConfirmUnknown(false); }, [sectionId, job?.id]);

  useEffect(() => {
    const controller = new AbortController();
    api<Progress | null>(`/books/${book.id}/listening-progress`, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        saved.current = value;
        if (value) { setVersionId(value.version_id); if (scope.current === sectionId) navigate(value.section_id); }
        setLoaded(true);
      }).catch((error: unknown) => { if (!controller.signal.aborted) { setError(errorMessage(error)); setLoaded(true); } });
    return () => controller.abort();
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
    if (!jobs.some((item) => item.id === versionId && item.section_id === sectionId && item.state === 'ready')) {
      const restored = jobs.find((item) => item.id === saved.current?.version_id && item.section_id === sectionId && item.state === 'ready');
      const ready = restored || jobs.find((item) => item.section_id === sectionId && item.state === 'ready');
      setVersionId(ready?.id || '');
    }
  }, [jobs, sectionId, loaded, versionId]);

  useEffect(() => {
    if (!loaded || !saved.current) return;
    const restored = jobs.find((item) => item.id === saved.current?.version_id && item.state === 'ready' && item.audio_url);
    if (restored) playback.load(chapterTrack(book, restored, saved.current), true);
  }, [loaded, jobs]);

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
    <label>Saved audio version<select value={versionId} onChange={(e) => setVersionId(e.target.value)}><option value="">No version selected</option>{sectionJobs.filter((j) => j.state === 'ready').map((j) => <option key={j.id} value={j.id}>{j.profile_name} · {j.model_name} · {j.id.slice(0, 8)}</option>)}</select></label>
    {!activeVersion && <p>No saved audio is available for this chapter yet. Reading still works.</p>}
    {activeVersion && <button onClick={() => void playback.loadChapter(book, activeVersion)}>{playback.track?.id === activeVersion.id ? 'Loaded in player' : 'Load chapter in player'}</button>}
    <p className="help">Saved chapter files play without Voicebox. A replacement leaves previous versions available. Restoring a position never starts playback.</p>
  </aside>;
}
