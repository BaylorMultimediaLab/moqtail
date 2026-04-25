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

import { cn } from '@/lib/utils';
import { type AbrSettings } from '@/lib/abr/types';
import { type BlurSettings, type BlurMode, type LiveCatchupSettings, type AbrPreset } from '@/app';
import type { CatchupControllerMode, CatchupControllerSettings } from '@/lib/buffer';

export interface SettingsPanelProps {
  open: boolean;
  settings: AbrSettings;
  onSettingsChange: (settings: AbrSettings) => void;
  catchupSettings: LiveCatchupSettings;
  onCatchupSettingsChange: (settings: LiveCatchupSettings) => void;
  blurSettings: BlurSettings;
  onBlurSettingsChange: (settings: BlurSettings) => void;
  experimentLabel: string;
  onExperimentLabelChange: (label: string) => void;
  onAbrPreset: (preset: AbrPreset) => void;
}

function SettingCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-0.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange((e.target as HTMLInputElement).checked)}
        className="accent-blue-500"
      />
      <span className="text-xs text-neutral-300">{label}</span>
    </label>
  );
}

function NumberInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: number;
  placeholder: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-xs text-neutral-400">{label}</span>
      <input
        type="number"
        value={value === -1 ? '' : value}
        placeholder={placeholder}
        onInput={e => {
          const v = (e.target as HTMLInputElement).value;
          onChange(v === '' ? -1 : parseFloat(v));
        }}
        className="w-20 rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-right font-mono text-xs text-neutral-200 focus:border-blue-500 focus:outline-none"
      />
    </div>
  );
}

function OptionCard({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <div
      className="flex-none snap-start overflow-hidden rounded-md border border-neutral-700/60 bg-neutral-900/80"
      style={{ width: '220px' }}
    >
      <div className="border-b border-neutral-700/60 bg-neutral-800/60 px-3 py-1.5">
        <span className="text-[11px] font-semibold tracking-widest text-blue-400 uppercase">
          {title}
        </span>
      </div>
      <div className="scrollbar-thin max-h-[320px] overflow-y-auto px-3 py-2">{children}</div>
    </div>
  );
}

function SectionLabel({ children }: { children: preact.ComponentChildren }) {
  return (
    <p className="mt-2 mb-1 border-b border-neutral-700/50 pb-0.5 text-[10px] font-semibold tracking-widest text-blue-400/80 uppercase first:mt-0">
      {children}
    </p>
  );
}

const ABR_RULES = [
  'ThroughputRule',
  'BolaRule',
  'InsufficientBufferRule',
  'SwitchHistoryRule',
  'DroppedFramesRule',
  'AbandonRequestsRule',
] as const;
const LOW_LATENCY_RULES = ['L2ARule', 'LoLPRule'] as const;
const CATCHUP_CONTROLLER_MODES: CatchupControllerMode[] = [
  'sigmoid',
  'exponential',
  'linear',
  'step',
  'pid',
];

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function SettingsPanel({
  open,
  settings,
  onSettingsChange,
  catchupSettings,
  onCatchupSettingsChange,
  blurSettings,
  onBlurSettingsChange,
  experimentLabel,
  onExperimentLabelChange,
  onAbrPreset,
}: SettingsPanelProps) {
  const setBlurMode = (mode: BlurMode) => onBlurSettingsChange({ ...blurSettings, mode });
  const setBlurStrength = (strength: number) => onBlurSettingsChange({ ...blurSettings, strength });
  const setBlurRect = (patch: Partial<BlurSettings['rect']>) =>
    onBlurSettingsChange({ ...blurSettings, rect: { ...blurSettings.rect, ...patch } });

  const updateRule = (ruleName: string, active: boolean) => {
    const updated = { ...settings };
    updated.rules = { ...updated.rules };
    updated.rules[ruleName] = { ...updated.rules[ruleName], active };

    if (active && ruleName === 'L2ARule') {
      updated.rules.LoLPRule = { ...updated.rules.LoLPRule, active: false };
    } else if (active && ruleName === 'LoLPRule') {
      updated.rules.L2ARule = { ...updated.rules.L2ARule, active: false };
    }

    onSettingsChange(updated);
  };

  const updateCatchup = (patch: Partial<CatchupControllerSettings>) => {
    onCatchupSettingsChange({
      ...catchupSettings,
      catchup: {
        ...catchupSettings.catchup,
        ...patch,
      },
    });
  };

  return (
    <div
      className={cn(
        'overflow-hidden border-b border-white/6 bg-neutral-950/80 transition-all duration-300',
        open ? 'max-h-[420px] px-4 py-3 opacity-100' : 'max-h-0 px-4 py-0 opacity-0',
      )}
    >
      {/* Horizontal scroll wrapper */}
      <div className="relative">
        <div className="scrollbar-thin scrollbar-track-transparent scrollbar-thumb-neutral-700 flex snap-x snap-proximity gap-3 overflow-x-auto pb-2">
          {/* Experiment Card */}
          <OptionCard title="Experiment">
            <SectionLabel>Condition Label</SectionLabel>
            <input
              type="text"
              value={experimentLabel}
              placeholder="e.g. exp1-delay-3s"
              onInput={e => onExperimentLabelChange((e.target as HTMLInputElement).value)}
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder-neutral-600 focus:border-blue-500 focus:outline-none"
            />
            <SectionLabel>ABR Preset</SectionLabel>
            <div className="flex gap-1">
              {(['all', 'throughput', 'bola'] as const).map(p => (
                <button
                  key={p}
                  onClick={() => onAbrPreset(p)}
                  className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] text-neutral-400 capitalize hover:border-neutral-600 hover:text-neutral-200"
                >
                  {p === 'all' ? 'All' : p === 'throughput' ? 'Throughput' : 'BOLA'}
                </button>
              ))}
            </div>
            <SectionLabel>URL Params</SectionLabel>
            <p className="text-[10px] leading-relaxed text-neutral-500">
              ?delay=3&amp;mode=sigmoid
              <br />
              &amp;abr=bola&amp;label=cond-name
            </p>
          </OptionCard>

          {/* Blur Card */}
          <OptionCard title="Blur">
            <SectionLabel>Mode</SectionLabel>
            <div className="mb-1 flex gap-1">
              {(['none', 'global', 'localized'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setBlurMode(m)}
                  className={cn(
                    'flex-1 rounded border px-2 py-1 text-[10px] capitalize transition-colors',
                    blurSettings.mode === m
                      ? 'border-blue-500 bg-blue-500/20 text-blue-200'
                      : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200',
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
            <NumberInput
              label="Strength (px)"
              value={blurSettings.strength}
              placeholder="25"
              onChange={v => setBlurStrength(v === -1 ? 0 : v)}
            />
            <SectionLabel>Localized Rect (video px)</SectionLabel>
            <NumberInput
              label="X"
              value={blurSettings.rect.x}
              placeholder="0"
              onChange={v => setBlurRect({ x: v === -1 ? 0 : v })}
            />
            <NumberInput
              label="Y"
              value={blurSettings.rect.y}
              placeholder="0"
              onChange={v => setBlurRect({ y: v === -1 ? 0 : v })}
            />
            <NumberInput
              label="Width"
              value={blurSettings.rect.w}
              placeholder="300"
              onChange={v => setBlurRect({ w: v === -1 ? 0 : v })}
            />
            <NumberInput
              label="Height"
              value={blurSettings.rect.h}
              placeholder="200"
              onChange={v => setBlurRect({ h: v === -1 ? 0 : v })}
            />
          </OptionCard>

          {/* ABR Card */}
          <OptionCard title="ABR">
            <SettingCheckbox
              label="Fast Switching"
              checked={settings.fastSwitching}
              onChange={v => onSettingsChange({ ...settings, fastSwitching: v })}
            />
            <SettingCheckbox
              label="Video Auto Switch"
              checked={settings.videoAutoSwitch}
              onChange={v => onSettingsChange({ ...settings, videoAutoSwitch: v })}
            />
          </OptionCard>

          {/* Catchup Controller Card */}
          <OptionCard title="Catchup Controller">
            <SectionLabel>Latency Target</SectionLabel>
            <NumberInput
              label="Target Delay (s)"
              value={catchupSettings.liveEdgeDelay}
              placeholder="1.25"
              onChange={v =>
                onCatchupSettingsChange({
                  ...catchupSettings,
                  liveEdgeDelay: clamp(v === -1 ? 1.25 : v, 0.1, 30),
                })
              }
            />
            <NumberInput
              label="Tolerance (s)"
              value={catchupSettings.liveEdgeTolerance}
              placeholder="0.1"
              onChange={v =>
                onCatchupSettingsChange({
                  ...catchupSettings,
                  liveEdgeTolerance: clamp(v === -1 ? 0.1 : v, 0.01, 5),
                })
              }
            />

            <SectionLabel>Algorithm</SectionLabel>
            <div className="mb-2 grid grid-cols-2 gap-1">
              {CATCHUP_CONTROLLER_MODES.map(mode => (
                <button
                  key={mode}
                  onClick={() => updateCatchup({ mode })}
                  className={cn(
                    'rounded border px-2 py-1 text-[10px] capitalize transition-colors',
                    catchupSettings.catchup.mode === mode
                      ? 'border-blue-500 bg-blue-500/20 text-blue-200'
                      : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200',
                  )}
                >
                  {mode}
                </button>
              ))}
            </div>

            <NumberInput
              label="Max Rate Up (0..1)"
              value={catchupSettings.catchup.maxRateUp}
              placeholder="0.05"
              onChange={v => updateCatchup({ maxRateUp: clamp(v === -1 ? 0.05 : v, 0, 1) })}
            />
            <NumberInput
              label="Max Rate Down (0..0.5)"
              value={catchupSettings.catchup.maxRateDown}
              placeholder="0.05"
              onChange={v => updateCatchup({ maxRateDown: clamp(v === -1 ? 0.05 : v, 0, 0.5) })}
            />

            <SectionLabel>Hard Overrides</SectionLabel>
            <NumberInput
              label="Max Drift Seek (s)"
              value={catchupSettings.catchup.maxDriftSeconds}
              placeholder="3"
              onChange={v => updateCatchup({ maxDriftSeconds: clamp(v === -1 ? 3 : v, 0.1, 60) })}
            />
            <NumberInput
              label="Live Threshold (s)"
              value={catchupSettings.catchup.liveThresholdSeconds}
              placeholder="6"
              onChange={v =>
                updateCatchup({ liveThresholdSeconds: clamp(v === -1 ? 6 : v, 0.1, 60) })
              }
            />
            <NumberInput
              label="Stall Lookback (s)"
              value={catchupSettings.catchup.stallLookbackSeconds}
              placeholder="1.5"
              onChange={v =>
                updateCatchup({ stallLookbackSeconds: clamp(v === -1 ? 1.5 : v, 0, 10) })
              }
            />
            <NumberInput
              label="Min Change Thresh"
              value={
                Number.isFinite(catchupSettings.catchup.minChangeThreshold)
                  ? catchupSettings.catchup.minChangeThreshold
                  : -1
              }
              placeholder="auto"
              onChange={v => updateCatchup({ minChangeThreshold: v === -1 ? Number.NaN : v })}
            />

            <SectionLabel>Algorithm Params</SectionLabel>
            <NumberInput
              label="Linear Gain"
              value={catchupSettings.catchup.linearGain}
              placeholder="0.2"
              onChange={v => updateCatchup({ linearGain: clamp(v === -1 ? 0.2 : v, 0, 10) })}
            />
            <NumberInput
              label="Exp k"
              value={catchupSettings.catchup.expK}
              placeholder="1.6"
              onChange={v => updateCatchup({ expK: clamp(v === -1 ? 1.6 : v, 0.01, 20) })}
            />
            <NumberInput
              label="Step Delta (s)"
              value={catchupSettings.catchup.stepDeltaSeconds}
              placeholder="0.25"
              onChange={v =>
                updateCatchup({ stepDeltaSeconds: clamp(v === -1 ? 0.25 : v, 0.01, 10) })
              }
            />
            <NumberInput
              label="PID Kp"
              value={catchupSettings.catchup.pidKp}
              placeholder="0.2"
              onChange={v => updateCatchup({ pidKp: clamp(v === -1 ? 0.2 : v, 0, 10) })}
            />
            <NumberInput
              label="PID Ki"
              value={catchupSettings.catchup.pidKi}
              placeholder="0.05"
              onChange={v => updateCatchup({ pidKi: clamp(v === -1 ? 0.05 : v, 0, 10) })}
            />
            <NumberInput
              label="PID Kd"
              value={catchupSettings.catchup.pidKd}
              placeholder="0.1"
              onChange={v => updateCatchup({ pidKd: clamp(v === -1 ? 0.1 : v, 0, 10) })}
            />
          </OptionCard>

          {/* ABR Rules Card */}
          <OptionCard title="ABR Rules">
            {ABR_RULES.map(ruleName => (
              <SettingCheckbox
                key={ruleName}
                label={ruleName}
                checked={settings.rules[ruleName]?.active ?? false}
                onChange={v => updateRule(ruleName, v)}
              />
            ))}
            <SectionLabel>Low Latency</SectionLabel>
            {LOW_LATENCY_RULES.map(ruleName => (
              <SettingCheckbox
                key={ruleName}
                label={ruleName}
                checked={settings.rules[ruleName]?.active ?? false}
                onChange={v => updateRule(ruleName, v)}
              />
            ))}
          </OptionCard>

          {/* Buffer Card */}
          <OptionCard title="Buffer">
            <NumberInput
              label="Buffer Time (s)"
              value={settings.bufferTimeDefault}
              placeholder="18"
              onChange={v => onSettingsChange({ ...settings, bufferTimeDefault: v })}
            />
            <NumberInput
              label="Stable Buffer (s)"
              value={settings.stableBufferTime}
              placeholder="18"
              onChange={v => onSettingsChange({ ...settings, stableBufferTime: v })}
            />
            <NumberInput
              label="BW Safety Factor"
              value={settings.bandwidthSafetyFactor}
              placeholder="0.9"
              onChange={v => onSettingsChange({ ...settings, bandwidthSafetyFactor: v })}
            />
          </OptionCard>

          {/* Initial Settings Card */}
          <OptionCard title="Initial Settings">
            <NumberInput
              label="Initial Bitrate (kbps)"
              value={settings.initialBitrate}
              placeholder="auto"
              onChange={v => onSettingsChange({ ...settings, initialBitrate: v })}
            />
            <NumberInput
              label="Min Bitrate (kbps)"
              value={settings.minBitrate}
              placeholder="none"
              onChange={v => onSettingsChange({ ...settings, minBitrate: v })}
            />
            <NumberInput
              label="Max Bitrate (kbps)"
              value={settings.maxBitrate}
              placeholder="none"
              onChange={v => onSettingsChange({ ...settings, maxBitrate: v })}
            />
          </OptionCard>

          {/* EWMA Card */}
          <OptionCard title="EWMA">
            <NumberInput
              label="Fast Half-life (s)"
              value={settings.ewma.throughputFastHalfLifeSeconds}
              placeholder="3"
              onChange={v =>
                onSettingsChange({
                  ...settings,
                  ewma: { ...settings.ewma, throughputFastHalfLifeSeconds: v },
                })
              }
            />
            <NumberInput
              label="Slow Half-life (s)"
              value={settings.ewma.throughputSlowHalfLifeSeconds}
              placeholder="8"
              onChange={v =>
                onSettingsChange({
                  ...settings,
                  ewma: { ...settings.ewma, throughputSlowHalfLifeSeconds: v },
                })
              }
            />
          </OptionCard>
        </div>

        {/* Right-edge fade indicator */}
        <div className="pointer-events-none absolute top-0 right-0 bottom-2 w-10 bg-gradient-to-r from-transparent to-neutral-950/80" />
      </div>
    </div>
  );
}
