import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, type TextBlock } from './api';

interface Voice { id: string; name: string; language: string; models: { id: string; name: string; downloaded: boolean }[] }
interface Job {
  id: string; paragraph_id: string; profile_id: string; profile_name: string; model_name: string;
  state: 'pending' | 'running' | 'completed' | 'failed'; error: string | null; error_kind: string | null;
  provider_job_id: string | null; audio_url: string | null; reused: boolean;
}
interface Catalog { profiles: Voice[]; text_limit: number }

export default function NarrationPanel({ paragraph }: { paragraph: TextBlock | null }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [connection, setConnection] = useState('Checking Voicebox…');
  const [profileId, setProfileId] = useState('');
  const [modelId, setModelId] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const requestEpoch = useRef(0);
  const paragraphId = paragraph?.id;
  const profile = catalog?.profiles.find((item) => item.id === profileId);
  const model = profile?.models.find((item) => item.id === modelId);
  const job = jobs.find((item) => item.paragraph_id === paragraphId && item.profile_id === profileId && item.model_name === modelId);
  const active = job?.state === 'pending' || job?.state === 'running';

  useEffect(() => {
    const controller = new AbortController();
    setConnection('Checking Voicebox…');
    async function discover() {
      try {
        const status = await api<{ connected: boolean; version?: string; error: string | null }>('/voicebox/status', { signal: controller.signal });
        if (!status.connected) throw new Error(status.error ?? 'Voicebox is offline.');
        const voices = await api<Catalog>('/voicebox/profiles', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setCatalog(voices);
        setConnection(`Voicebox connected${status.version ? ` · v${status.version}` : ''}`);
        setProfileId((current) => current || voices.profiles.find((voice) => voice.models.some((option) => option.downloaded))?.id || voices.profiles[0]?.id || '');
      } catch (error) {
        if (!controller.signal.aborted) { setCatalog(null); setConnection(errorMessage(error)); }
      }
    }
    void discover();
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (profile) setModelId((current) => profile.models.some((item) => item.id === current) ? current : profile.models.find((item) => item.downloaded)?.id || profile.models[0]?.id || '');
  }, [profile]);

  useEffect(() => {
    requestEpoch.current += 1;
    setBusy(false);
    setError('');
    setJobs([]);
    if (!paragraphId) return;
    const controller = new AbortController();
    api<Job[]>(`/narrations?paragraph_id=${paragraphId}`, { signal: controller.signal })
      .then((items) => { if (!controller.signal.aborted) setJobs(items); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [paragraphId, historyRefresh]);

  useEffect(() => {
    requestEpoch.current += 1;
    setBusy(false);
    setError('');
  }, [profileId, modelId]);

  useEffect(() => {
    if (!job || !active) return;
    const controller = new AbortController();
    let timer: number;
    const id = job.id;
    async function poll() {
      try {
        const update = await api<Job>(`/narrations/${id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setJobs((items) => items.map((item) => item.id === update.id ? update : item));
        setError('');
        if (update.state !== 'pending' && update.state !== 'running') return;
      } catch (error) {
        if (controller.signal.aborted) return;
        setError(errorMessage(error));
      }
      timer = window.setTimeout(() => void poll(), 2000);
    }
    timer = window.setTimeout(() => void poll(), 1000);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [job?.id, active]);

  async function generate(regenerate = false, retryAudio = false, reconcile = false) {
    if (!paragraphId) return;
    const epoch = ++requestEpoch.current;
    setBusy(true);
    setError('');
    try {
      const result = await api<Job>((retryAudio || reconcile) && job ? `/narrations/${job.id}/${reconcile ? 'reconcile' : 'retry-audio'}` : '/narrations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: retryAudio || reconcile ? undefined : JSON.stringify({ paragraph_id: paragraphId, profile_id: profileId, model_name: modelId, regenerate }),
      });
      if (epoch !== requestEpoch.current || result.paragraph_id !== paragraphId || result.profile_id !== profileId || result.model_name !== modelId) return;
      setJobs((items) => [result, ...items.filter((item) => item.id !== result.id)]);
    } catch (error) {
      if (epoch === requestEpoch.current) setError(`${errorMessage(error)} Refresh saved narrations before trying again if the request was interrupted.`);
    } finally {
      if (epoch === requestEpoch.current) setBusy(false);
    }
  }

  const tooLong = !!paragraph && !!catalog && Array.from(paragraph.text).length > catalog.text_limit;
  return <aside className="narration-panel" aria-label="Paragraph narration">
    <h2>Paragraph narration</h2>
    <p role="status">{connection}</p>
    <button className="secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh Voicebox</button>
    <p>{paragraph ? `Selected paragraph (${Array.from(paragraph.text).length} characters)` : 'Select Narrate beside a paragraph to get started.'}</p>
    {paragraph && <blockquote className="selected-preview">{paragraph.text}</blockquote>}
    {catalog && <div className="voice-controls">
      <label>Voice / profile<select value={profileId} onChange={(event) => { setProfileId(event.target.value); setModelId(''); }}>
        <option value="">Choose a voice</option>
        {catalog.profiles.map((voice) => <option key={voice.id} value={voice.id}>{voice.name} ({voice.language})</option>)}
      </select></label>
      <label>Model<select value={modelId} onChange={(event) => setModelId(event.target.value)}>
        <option value="">Choose a model</option>
        {profile?.models.map((option) => <option key={option.id} value={option.id}>{option.name}{option.downloaded ? '' : ' — not downloaded'}</option>)}
      </select></label>
    </div>}
    {catalog?.profiles.length === 0 && <p>Create a voice profile in Voicebox, then refresh here.</p>}
    {profile && profile.models.length === 0 && <p>This profile has no compatible models or reference samples. Configure it in Voicebox first.</p>}
    {model && !model.downloaded && <p>Download this model in Voicebox first. The reader does not download models.</p>}
    {tooLong && <p role="alert">This paragraph exceeds the {catalog?.text_limit}-character limit. Paragraph splitting is planned for milestone 4.</p>}
    <div className="narration-actions">
      <button disabled={!paragraph || !model?.downloaded || busy || active || tooLong} onClick={() => void generate()}>{busy ? 'Requesting…' : active ? 'Generating…' : 'Generate narration'}</button>
      <button className="secondary" disabled={!paragraph || !model?.downloaded || busy || active || tooLong} onClick={() => void generate(true)}>Regenerate</button>
      {paragraph && <button className="secondary" disabled={busy} onClick={() => setHistoryRefresh((value) => value + 1)}>Refresh saved narrations</button>}
    </div>
    <p className="help">Regenerate creates new audio using the current profile. Use it after changing a voice in Voicebox.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {job && <div aria-live="polite">
      <p>{job.profile_name} · {job.model_name} · {job.state === 'running' ? 'queued or generating in Voicebox' : job.state}{job.reused && job.state === 'completed' ? ' · cached audio' : ''}</p>
      {job.error && <p role="alert" className="error">{job.error}</p>}
      {job.error_kind === 'ambiguous' && <p>Do not regenerate until you check Voicebox history; the previous request may already be generating.</p>}
      {job.error_kind === 'audio' && <button disabled={busy} onClick={() => void generate(false, true)}>Retry audio retrieval</button>}
      {job.state === 'failed' && job.provider_job_id && job.error_kind !== 'audio' && <button disabled={busy} onClick={() => void generate(false, false, true)}>Recheck provider job</button>}
      {job.audio_url && <audio key={job.audio_url} controls preload="metadata" src={job.audio_url} onError={() => setError('The browser could not load this audio. Refresh saved narrations or use Generate to check the cache.')} />}
    </div>}
    {!catalog && jobs.length > 0 && <div><h3>Saved narrations for this paragraph</h3>{jobs.filter((item) => item.paragraph_id === paragraphId && item.id !== job?.id && item.audio_url).map((item) => <div key={item.id}><p>{item.profile_name} · {item.model_name}</p><audio key={item.audio_url} controls preload="metadata" src={item.audio_url!} /></div>)}</div>}
  </aside>;
}
