#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    csv: null,
    help: false,
    behindLiveThreshold: 1.5,
    jumpThreshold: 0.35,
    misalignmentThreshold: 0.4,
    discontinuityLiveOffsetThreshold: 1.25,
    outputJson: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const current = argv[i];
    const next = argv[i + 1];

    if (current === '--csv' && next) {
      args.csv = next;
      i++;
      continue;
    }
    if (current === '--help' || current === '-h') {
      args.help = true;
      continue;
    }
    if (current === '--behind-live-threshold' && next) {
      args.behindLiveThreshold = Number(next);
      i++;
      continue;
    }
    if (current === '--jump-threshold' && next) {
      args.jumpThreshold = Number(next);
      i++;
      continue;
    }
    if (current === '--misalignment-threshold' && next) {
      args.misalignmentThreshold = Number(next);
      i++;
      continue;
    }
    if (current === '--discontinuity-live-offset-threshold' && next) {
      args.discontinuityLiveOffsetThreshold = Number(next);
      i++;
      continue;
    }
    if (current === '--output-json' && next) {
      args.outputJson = next;
      i++;
      continue;
    }
  }

  return args;
}

function parseCsv(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const headers = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? '';
    }
    rows.push(row);
  }

  return rows;
}

function num(row, key) {
  const raw = row[key];
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function text(row, key) {
  const value = row[key];
  return value === undefined || value === null || value === '' ? null : value;
}

function makeSignature(row) {
  const fields = [
    row.switch_outcome ?? '',
    row.switch_from_track ?? '',
    row.switch_to_track ?? '',
    row.switch_requested_at_ms ?? '',
    row.switch_settled_at_ms ?? '',
    row.switch_duration_ms ?? '',
    row.switch_from_group ?? '',
    row.switch_to_group ?? '',
    row.switch_group_delta ?? '',
    row.switch_playback_delta_s ?? '',
    row.switch_alignment_error_s ?? '',
  ];
  return fields.join('|');
}

function classifyEvent(row, thresholds) {
  const issues = [];
  const playbackDelta = num(row, 'switch_playback_delta_s');
  const alignmentError = num(row, 'switch_alignment_error_s');
  const liveOffsetDelta = num(row, 'switch_live_offset_delta_s');
  const groupDelta = num(row, 'switch_group_delta');
  const outcome = text(row, 'switch_outcome');

  if (playbackDelta !== null && playbackDelta > thresholds.jumpThreshold) {
    issues.push('jump-forward');
  }
  if (playbackDelta !== null && playbackDelta < -thresholds.jumpThreshold) {
    issues.push('jump-backward');
  }
  if (alignmentError !== null && Math.abs(alignmentError) > thresholds.misalignmentThreshold) {
    issues.push('misalignment');
  }

  const discontinuity =
    outcome === 'error' ||
    outcome === 'rejected' ||
    (groupDelta !== null && groupDelta < 0) ||
    (liveOffsetDelta !== null &&
      Math.abs(liveOffsetDelta) > thresholds.discontinuityLiveOffsetThreshold);

  if (discontinuity) {
    issues.push('discontinuity');
  }

  return {
    outcome,
    issues,
    playbackDelta,
    alignmentError,
    liveOffsetDelta,
    groupDelta,
    fromTrack: text(row, 'switch_from_track'),
    toTrack: text(row, 'switch_to_track'),
    fromGroup: text(row, 'switch_from_group'),
    toGroup: text(row, 'switch_to_group'),
    switchDurationMs: num(row, 'switch_duration_ms'),
    switchRequestedAtMs: num(row, 'switch_requested_at_ms'),
    switchSettledAtMs: num(row, 'switch_settled_at_ms'),
    liveOffsetAtSwitch: num(row, 'switch_from_live_offset_s'),
    timestamp: text(row, 'timestamp'),
  };
}

function extractTerminalSwitchEvents(rows, behindLiveThreshold) {
  const events = [];
  let lastSignature = null;

  for (const row of rows) {
    const outcome = text(row, 'switch_outcome');
    if (outcome !== 'success' && outcome !== 'rejected' && outcome !== 'error') {
      continue;
    }

    const liveOffsetAtSwitch = num(row, 'switch_from_live_offset_s');
    if (liveOffsetAtSwitch === null || liveOffsetAtSwitch < behindLiveThreshold) {
      continue;
    }

    const signature = makeSignature(row);
    if (signature === lastSignature) {
      continue;
    }

    events.push(row);
    lastSignature = signature;
  }

  return events;
}

function summarize(events) {
  const summary = {
    totalEvents: events.length,
    outcomes: {
      success: 0,
      rejected: 0,
      error: 0,
      other: 0,
    },
    findings: {
      jumpForward: 0,
      jumpBackward: 0,
      misalignment: 0,
      discontinuity: 0,
    },
  };

  for (const event of events) {
    const outcome = event.outcome ?? 'other';
    if (outcome === 'success' || outcome === 'rejected' || outcome === 'error') {
      summary.outcomes[outcome]++;
    } else {
      summary.outcomes.other++;
    }

    if (event.issues.includes('jump-forward')) summary.findings.jumpForward++;
    if (event.issues.includes('jump-backward')) summary.findings.jumpBackward++;
    if (event.issues.includes('misalignment')) summary.findings.misalignment++;
    if (event.issues.includes('discontinuity')) summary.findings.discontinuity++;
  }

  return summary;
}

function printReport(inputCsvPath, thresholds, summary, events) {
  console.log('=== Filtered Playback Switch Baseline Report ===');
  console.log(`CSV: ${inputCsvPath}`);
  console.log(`Events (behind-live only): ${summary.totalEvents}`);
  console.log('');
  console.log('Thresholds:');
  console.log(`  behindLiveThreshold: ${thresholds.behindLiveThreshold.toFixed(2)} s`);
  console.log(`  jumpThreshold: ${thresholds.jumpThreshold.toFixed(2)} s`);
  console.log(`  misalignmentThreshold: ${thresholds.misalignmentThreshold.toFixed(2)} s`);
  console.log(
    `  discontinuityLiveOffsetThreshold: ${thresholds.discontinuityLiveOffsetThreshold.toFixed(2)} s`,
  );
  console.log('');

  console.log('Outcome counts:');
  console.log(`  success: ${summary.outcomes.success}`);
  console.log(`  rejected: ${summary.outcomes.rejected}`);
  console.log(`  error: ${summary.outcomes.error}`);
  if (summary.outcomes.other > 0) {
    console.log(`  other: ${summary.outcomes.other}`);
  }
  console.log('');

  console.log('Finding counts:');
  console.log(`  jump-forward: ${summary.findings.jumpForward}`);
  console.log(`  jump-backward: ${summary.findings.jumpBackward}`);
  console.log(`  misalignment: ${summary.findings.misalignment}`);
  console.log(`  discontinuity: ${summary.findings.discontinuity}`);
  console.log('');

  if (events.length > 0) {
    console.log('Sample events:');
    const sampleSize = Math.min(10, events.length);
    for (let i = 0; i < sampleSize; i++) {
      const event = events[i];
      console.log(
        [
          `  [${i + 1}]`,
          event.timestamp ?? '-',
          `outcome=${event.outcome ?? '-'}`,
          `issues=${event.issues.join('|') || 'none'}`,
          `from=${event.fromTrack ?? '-'}(${event.fromGroup ?? '-'})`,
          `to=${event.toTrack ?? '-'}(${event.toGroup ?? '-'})`,
          `durationMs=${event.switchDurationMs ?? '-'}`,
          `playbackDelta=${event.playbackDelta ?? '-'}s`,
          `alignErr=${event.alignmentError ?? '-'}s`,
          `liveOffsetDelta=${event.liveOffsetDelta ?? '-'}s`,
        ].join(' '),
      );
    }
  }
}

function usage() {
  console.log('Usage: node scripts/analyze-switch-baseline.mjs --csv <path-to-csv> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --behind-live-threshold <seconds>              default: 1.5');
  console.log('  --jump-threshold <seconds>                     default: 0.35');
  console.log('  --misalignment-threshold <seconds>             default: 0.4');
  console.log('  --discontinuity-live-offset-threshold <sec>    default: 1.25');
  console.log('  --output-json <path>                           write full report JSON');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  if (!args.csv) {
    usage();
    process.exit(0);
  }

  const csvPath = path.resolve(process.cwd(), args.csv);
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    process.exit(1);
  }

  const csv = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(csv);
  const terminalRows = extractTerminalSwitchEvents(rows, args.behindLiveThreshold);
  const events = terminalRows.map(row =>
    classifyEvent(row, {
      jumpThreshold: args.jumpThreshold,
      misalignmentThreshold: args.misalignmentThreshold,
      discontinuityLiveOffsetThreshold: args.discontinuityLiveOffsetThreshold,
    }),
  );
  const summary = summarize(events);

  printReport(csvPath, args, summary, events);

  if (args.outputJson) {
    const outputPath = path.resolve(process.cwd(), args.outputJson);
    const payload = {
      inputCsv: csvPath,
      thresholds: {
        behindLiveThreshold: args.behindLiveThreshold,
        jumpThreshold: args.jumpThreshold,
        misalignmentThreshold: args.misalignmentThreshold,
        discontinuityLiveOffsetThreshold: args.discontinuityLiveOffsetThreshold,
      },
      summary,
      events,
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log('');
    console.log(`Wrote JSON report: ${outputPath}`);
  }
}

main();
