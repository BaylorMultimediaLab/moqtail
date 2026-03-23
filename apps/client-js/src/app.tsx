/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Player } from '@/lib/player';
import { cn } from '@/lib/utils';
import { Tuple, type CMSF } from 'moqtail';
import MSEBuffer from '@/lib/buffer';

type Track = CMSF['tracks'][number];
type Status = 'idle' | 'connecting' | 'ready' | 'restarting' | 'playing' | 'error';

type BlurMode = 'none' | 'global' | 'localized';

const GITHUB_REPO = 'moqtail/moqtail';

function GitHubIcon() {
  return (
    <svg height="18" viewBox="0 0 16 16" width="18" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

const STATUS_CONFIG: Record<Status, { dot: string; label: string }> = {
  idle: { dot: 'bg-neutral-600', label: 'Idle' },
  connecting: { dot: 'bg-yellow-400 animate-pulse', label: 'Connecting…' },
  ready: { dot: 'bg-emerald-400', label: 'Catalog loaded' },
  restarting: { dot: 'bg-yellow-400 animate-pulse', label: 'Starting…' },
  playing: { dot: 'bg-blue-400', label: 'Playing' },
  error: { dot: 'bg-red-400', label: 'Error' },
};

function StatusDot({ status }: { status: Status }) {
  const { dot, label } = STATUS_CONFIG[status];
  return (
    <span className="flex items-center gap-1.5 text-xs text-neutral-400 select-none">
      <span className={cn('h-2 w-2 rounded-full', dot)} />
      {label}
    </span>
  );
}

const inputCls =
  'w-full rounded-lg bg-neutral-900 border border-neutral-700/80 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all';

function Field({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div className="space-y-1">
      <label className="block text-[11px] font-semibold tracking-widest text-neutral-500 uppercase">
        {label}
      </label>
      {children}
    </div>
  );
}

function Checkbox({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <span className="flex shrink-0 items-center">
      {/* Real input — kept 1 px so it remains in the accessibility tree without position:absolute */}
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        className="size-px overflow-hidden opacity-0"
        onChange={e => onChange((e.target as HTMLInputElement).checked)}
      />
      {/* Visual indicator */}
      <span
        aria-hidden="true"
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
          checked ? 'border-blue-500 bg-blue-500' : 'border-neutral-600 bg-neutral-800/60',
        )}
      >
        {checked && (
          <svg
            className="h-2.5 w-2.5 text-white"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="2,5 4,8 8,2" />
          </svg>
        )}
      </span>
    </span>
  );
}

function TrackRow({
  track,
  checked,
  disabled,
  onChange,
}: {
  track: Track;
  checked: boolean;
  disabled: boolean;
  onChange: (track: Track, checked: boolean) => void;
}) {
  const selectable = !disabled;

  return (
    <label
      className={cn(
        'group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all select-none',
        selectable
          ? checked
            ? 'cursor-pointer bg-blue-600/15 ring-1 ring-blue-500/40'
            : 'cursor-pointer hover:bg-neutral-800/70'
          : 'cursor-not-allowed opacity-30',
      )}
    >
      <Checkbox checked={checked} disabled={disabled} onChange={val => onChange(track, val)} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs leading-5 text-neutral-200">
        {track.name}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        {track.bitrate ? (
          <span className="text-[10px] text-neutral-500 tabular-nums">
            {Math.round(track.bitrate / 1000)} kbps
          </span>
        ) : null}
        {track.width && track.height ? (
          <span className="text-[10px] text-neutral-500 tabular-nums">
            {track.width}&#x00d7;{track.height}
          </span>
        ) : null}
        {track.codec ? (
          <span className="font-mono text-[10px] text-neutral-500">
            {track.codec.split('.')[0]}
          </span>
        ) : null}
      </div>
    </label>
  );
}

function TrackGroup({
  title,
  color,
  tracks,
  selectedVideo,
  selectedAudio,
  disabled,
  onChange,
}: {
  title: string;
  color: string;
  tracks: Track[];
  selectedVideo: string | null;
  selectedAudio: string | null;
  disabled: boolean;
  onChange: (track: Track, checked: boolean) => void;
}) {
  if (tracks.length === 0) return null;
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 px-1">
        <span className={cn('h-1.5 w-1.5 rounded-full', color)} />
        <span className="text-[11px] font-semibold tracking-widest text-neutral-500 uppercase">
          {title}
        </span>
        <span className="text-[10px] text-neutral-600">({tracks.length})</span>
      </div>
      <div className="space-y-0.5">
        {tracks.map(track => {
          const isSelected = track.name === selectedVideo || track.name === selectedAudio;
          return (
            <TrackRow
              key={track.name}
              track={track}
              checked={isSelected}
              disabled={disabled}
              onChange={onChange}
            />
          );
        })}
      </div>
    </div>
  );
}

export function App() {
  const [relayUrl, setRelayUrl] = useState('https://ord.abr.moqtail.dev');
  const [namespace, setNamespace] = useState('moqtail');
  const [status, setStatus] = useState<Status>('idle');
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<string | null>(null);
  const [selectedAudio, setSelectedAudio] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [blurMode, setBlurMode] = useState<BlurMode>('none');

  const playerRef = useRef<Player | null>(null);
  const bufferRef = useRef<MSEBuffer | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Example detection rects, for real localized blurring (these come from your MoQ metadata)
  const [localRects] = useState([{ x: 100, y: 100, w: 300, h: 200 }]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const requestRef = useRef<number>();

  //localized blur code
  const renderFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || blurMode !== 'localized') return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Sync canvas resolution to the actual video stream dimensions
    if (canvas.width !== video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    localRects.forEach(rect => {
      ctx.save();
      // Clip the drawing area to the detection box
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.clip();
      
      // Draw the blurred video slice
      ctx.filter = 'blur(25px)';
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    });

    requestRef.current = requestAnimationFrame(renderFrame);
  }, [blurMode, localRects]);

  useEffect(() => {
    if (blurMode === 'localized') {
      requestRef.current = requestAnimationFrame(renderFrame);
    }
    return () => cancelAnimationFrame(requestRef.current!);
  }, [blurMode, renderFrame]);

  const disposePlayer = useCallback(async () => {
    if (playerRef.current) {
      try {
        await playerRef.current.dispose();
      } catch {}
      playerRef.current = null;
    }
    if (bufferRef.current) {
      try {
        bufferRef.current.dispose();
      } catch {}
      bufferRef.current = null;
    }
  }, []);

  const handleConnect = useCallback(async () => {
    if (!videoRef.current) return;
    setStatus('connecting');
    setError(null);
    setTracks([]);
    setSelectedVideo(null);
    setSelectedAudio(null);

    await disposePlayer();

    try {
      const player = new Player({
        relayUrl,
        namespace: Tuple.fromUtf8Path(namespace),
        receiveCatalogViaSubscribe: true,
      });
      playerRef.current = player;

      const catalog = await player.initialize();
      const allTracks = catalog.getTracks();
      setTracks(allTracks);

      const firstVideo = allTracks.find(t => t.role === 'video');
      if (firstVideo) {
        setSelectedVideo(firstVideo.name);
        setStatus('restarting');
        await player.attachMedia(videoRef.current);
        await player.addMediaTrack(firstVideo.name);
        await player.startMedia();
        setStatus('playing');
      } else {
        setStatus('ready');
      }
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
      await disposePlayer();
    }
  }, [relayUrl, namespace, disposePlayer]);

  const startPlayback = useCallback(
    async (videoTrack: string | null, audioTrack: string | null) => {
      if (!videoRef.current) return;
      if (!videoTrack && !audioTrack) {
        await disposePlayer();
        setStatus('ready');
        return;
      }

      setStatus('restarting');
      await disposePlayer();

      try {
        const player = new Player({
          relayUrl,
          namespace: Tuple.fromUtf8Path(namespace),
          receiveCatalogViaSubscribe: true,
        });
        playerRef.current = player;

        const catalog = await player.initialize();
        setTracks(catalog.getTracks());

        await player.attachMedia(videoRef.current);
        bufferRef.current = new MSEBuffer(videoRef.current);

        if (videoTrack) await player.addMediaTrack(videoTrack);
        if (audioTrack) await player.addMediaTrack(audioTrack);

        await player.startMedia();
        setStatus('playing');
      } catch (err) {
        setError((err as Error).message);
        setStatus('error');
        await disposePlayer();
      }
    },
    [relayUrl, namespace, disposePlayer],
  );

  const handleTrackChange = useCallback(
    (track: Track, checked: boolean) => {
      if (track.role !== 'video' && track.role !== 'audio') return;

      let newVideo = selectedVideo;
      let newAudio = selectedAudio;

      if (track.role === 'video') {
        // clicking the active track unchecks it; clicking any other switches to it
        newVideo = track.name === selectedVideo && !checked ? null : track.name;
      } else {
        newAudio = track.name === selectedAudio && !checked ? null : track.name;
      }

      setSelectedVideo(newVideo);
      setSelectedAudio(newAudio);
      startPlayback(newVideo, newAudio);
    },
    [selectedVideo, selectedAudio, startPlayback],
  );

  const isBusy = status === 'connecting' || status === 'restarting';

  const videoTracks = tracks.filter(t => t.role === 'video');
  const audioTracks = tracks.filter(t => t.role === 'audio');
  const hasTracks = tracks.length > 0;

  return (
    <div className="flex h-dvh w-dvw flex-col bg-neutral-950 font-sans text-neutral-100 antialiased">
      {/* Header */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-white/6 bg-neutral-950/80 px-4 backdrop-blur-sm md:px-5">
        <div className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="MOQtail logo" className="h-5 w-5" />
          <a
            href="https://moqtail.dev"
            target="_blank"
            rel="noreferrer"
            className="text-sm font-semibold tracking-tight transition-colors hover:text-neutral-300"
          >
            MOQtail Player
          </a>
          <span className="text-neutral-700 select-none">·</span>
          <StatusDot status={status} />
        </div>
        <div className="flex items-center gap-2 md:gap-3">
          {(import.meta.env.VITE_BUILD_COMMIT || import.meta.env.VITE_BUILD_DATE) && (
            <span className="hidden font-mono text-[10px] text-neutral-600 tabular-nums select-none sm:block">
              {[import.meta.env.VITE_BUILD_COMMIT, import.meta.env.VITE_BUILD_DATE]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
          <a
            href={`https://github.com/${GITHUB_REPO}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 text-sm text-neutral-400 transition-colors hover:text-neutral-100"
          >
            <GitHubIcon />
            <span className="hidden text-xs font-medium sm:block">{GITHUB_REPO}</span>
          </a>
        </div>
      </header>

      {/* Body */}
      <div className="flex h-full min-h-0 w-full flex-1 grow flex-col md:flex-row">
        {/* Sidebar */}
        <aside className="order-last flex max-h-full flex-col overflow-auto border-t border-white/6 bg-neutral-950 md:order-first md:w-72 md:border-t-0 md:border-r">
          {/* Connection */}
          <div className="space-y-3 border-b border-white/6 p-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-1">
              <Field label="Relay URL">
                <input
                  type="url"
                  value={relayUrl}
                  onInput={e => setRelayUrl((e.target as HTMLInputElement).value)}
                  placeholder="https://relay.example.com:443"
                  class={inputCls}
                />
              </Field>
              <Field label="Namespace">
                <input
                  type="text"
                  value={namespace}
                  onInput={e => setNamespace((e.target as HTMLInputElement).value)}
                  placeholder="org/channel"
                  class={inputCls}
                />
              </Field>
            </div>
            <button
              onClick={handleConnect}
              disabled={isBusy || !relayUrl || !namespace}
              className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium transition-colors hover:bg-blue-500 active:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
            {status === 'error' && error && (
              <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-400">
                {error}
              </p>
            )}
          </div>

          <div className="border-b border-white/6 p-4">
            <Field label="Blur Effects">
            <div className="mt-2 flex flex-col gap-2">
              <button
                onClick={() => setBlurMode(blurMode === 'global' ? 'none' : 'global')}
                disabled={!hasTracks}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-xs transition-all",
                  blurMode === 'global' ? "bg-blue-600/20 ring-1 ring-blue-500/50" : "bg-neutral-900/50 hover:bg-neutral-800"
                )}
              >
                <div className={cn("h-2 w-2 rounded-full", blurMode === 'global' ? "bg-blue-400" : "bg-neutral-600")} />
                <span className={blurMode === 'global' ? "text-blue-100" : "text-neutral-400"}>Full Video Blur</span>
              </button>

              <button
                onClick={() => setBlurMode(blurMode === 'localized' ? 'none' : 'localized')}
                disabled={!hasTracks}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-xs transition-all",
                  blurMode === 'localized' ? "bg-violet-600/20 ring-1 ring-violet-500/50" : "bg-neutral-900/50 hover:bg-neutral-800"
                )}
              >
                <div className={cn("h-2 w-2 rounded-full", blurMode === 'localized' ? "bg-violet-400" : "bg-neutral-600")} />
                <span className={blurMode === 'localized' ? "text-violet-100" : "text-neutral-400"}>Area Redaction</span>
              </button>
            </div>
            </Field>
          </div>

          {/* Tracks */}
          {hasTracks && (
            <div className="space-y-4 p-3">
              <TrackGroup
                title="Video"
                color="bg-violet-400"
                tracks={videoTracks}
                selectedVideo={selectedVideo}
                selectedAudio={selectedAudio}
                disabled={isBusy}
                onChange={handleTrackChange}
              />
              <TrackGroup
                title="Audio"
                color="bg-teal-400"
                tracks={audioTracks}
                selectedVideo={selectedVideo}
                selectedAudio={selectedAudio}
                disabled={isBusy}
                onChange={handleTrackChange}
              />
            </div>
          )}
        </aside>

        {/* Main — video */}
        <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden bg-neutral-950 p-4 md:p-6">
          <div 
            className={cn(
              "relative w-full overflow-hidden rounded-xl bg-black shadow-2xl shadow-black/60 transition-opacity duration-300",
              hasTracks ? 'opacity-100' : 'pointer-events-none opacity-0'
            )}
            style={{ aspectRatio: '16/9' }}
          >
            <video
              ref={videoRef}
              controls
              className={cn(
                'h-full w-full object-cover transition-all duration-300',
                // We scale slightly during blur to ensure the 'clear' edges of the filter are clipped
                isBlurred ? 'blur-2xl scale-110' : 'blur-0 scale-100'
              )}
            />
            
            {/* Optional: Add an overlay icon when blurred to signal "Filtered Content" */}
            {isBlurred && hasTracks && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/20 pointer-events-none">
                <svg className="h-12 w-12 text-white/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
              </div>
            )}
          </div>
          {!hasTracks && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 px-6 text-center select-none">
              {/* Icon */}
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/6 bg-neutral-900 text-neutral-600">
                <svg
                  viewBox="0 0 24 24"
                  className="h-8 w-8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347c-.75.412-1.667-.13-1.667-.986V5.653z"
                  />
                </svg>
              </div>

              {/* Heading */}
              <p className="text-sm font-medium text-neutral-300">
                Connect to a relay to start playback
              </p>

              {/* Info card */}
              <div className="w-full max-w-sm space-y-3 rounded-xl border border-white/6 bg-neutral-900/60 p-4 text-left backdrop-blur-sm">
                <p className="text-xs leading-relaxed text-neutral-400">
                  A minimal{' '}
                  <a
                    href="https://datatracker.ietf.org/doc/draft-ietf-moq-transport/"
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-400 underline decoration-blue-400/30 underline-offset-2 transition-colors hover:text-blue-300"
                  >
                    MOQT
                  </a>{' '}
                  player built on the{' '}
                  <a
                    href={`https://github.com/${GITHUB_REPO}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-400 underline decoration-blue-400/30 underline-offset-2 transition-colors hover:text-blue-300"
                  >
                    MOQtail library
                  </a>
                  . The source for this player lives in{' '}
                  <a
                    href={`https://github.com/${GITHUB_REPO}/tree/main/apps/client-js`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[11px] text-neutral-300 underline decoration-neutral-600 underline-offset-2 transition-colors hover:text-white"
                  >
                    /apps/client-js
                  </a>{' '}
                  in the MOQtail repository.
                </p>
                <p className="text-xs leading-relaxed text-neutral-400">
                  Modify the <span className="font-medium text-neutral-300">Relay URL</span> and{' '}
                  <span className="font-medium text-neutral-300">Namespace</span> in the sidebar to
                  point to your own stream.
                </p>
                <p className="text-xs leading-relaxed text-neutral-400">
                  Players with more advanced features are available in{' '}
                  <a
                    href={`https://moqtail.dev/demo`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-400 underline decoration-blue-400/30 underline-offset-2 transition-colors hover:text-blue-300"
                  >
                    MOQtail demos
                  </a>
                  .
                </p>
                <div className="border-t border-white/6 pt-3">
                  <a
                    href={`https://github.com/${GITHUB_REPO}/issues`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-neutral-500 transition-colors hover:text-neutral-300"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      className="h-3.5 w-3.5 shrink-0"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
                      <path d="M8 0a8 8 0 110 16A8 8 0 018 0zM1.5 8a6.5 6.5 0 1013 0 6.5 6.5 0 00-13 0z" />
                    </svg>
                    Found a problem? Open an issue on GitHub.
                  </a>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}