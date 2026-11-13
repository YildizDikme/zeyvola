export interface SystemProbeReport {
  ok?: boolean;
  skipped?: boolean;
  engine?: string;
  error?: string;
  problems?: string[];
  duration?: number;
  video?: { codec: string; decodedFrames?: number; spread?: number; error?: string; width?: number; height?: number } | null;
  audio?: { codec: string; decodedSeconds?: number; peak?: number; error?: string } | null;
}
export function problemsOf(report: SystemProbeReport, opts?: { require?: string; duration?: number }): string[];
export function avCheck(file: string, opts?: { require?: string; duration?: number }): SystemProbeReport & { ok: boolean; problems: string[] };
export function buildAvCheck(): string;
