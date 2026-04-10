// ============================================
// OpenSwarm - Local Model Adapter
// Created: 2026-04-10
// Purpose: Ollama, LMStudio, llama.cpp 등 로컬 OpenAI 호환 서버 지원
// ============================================

import type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  WorkerResult,
  ReviewResult,
} from './types.js';
import { t } from '../locale/index.js';

// 로컬 프로바이더 기본 URL 후보 (우선순위 순)
const DEFAULT_ENDPOINTS = [
  'http://localhost:11434',  // Ollama
  'http://localhost:1234',   // LMStudio
  'http://localhost:8080',   // llama.cpp server
];

const DEFAULT_MODEL = 'gemma3:4b';
const HEALTH_CHECK_TIMEOUT_MS = 2000;

export class LocalModelAdapter implements CliAdapter {
  readonly name = 'local';

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: false,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
  };

  // 활성 서버 URL (isAvailable에서 감지, run에서 사용)
  private activeUrl: string | null = null;
  private configuredUrl: string | null = null;

  /** config.yaml에서 baseUrl을 주입받을 때 사용 */
  setBaseUrl(url: string): void {
    this.configuredUrl = url;
  }

  async isAvailable(): Promise<boolean> {
    const candidates = this.configuredUrl
      ? [this.configuredUrl, ...DEFAULT_ENDPOINTS]
      : DEFAULT_ENDPOINTS;

    for (const url of candidates) {
      try {
        const res = await fetch(`${url}/v1/models`, {
          signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        });
        if (res.ok) {
          this.activeUrl = url;
          return true;
        }
      } catch {
        // 서버 미실행 — 다음 후보로
      }
    }
    return false;
  }

  /** 현재 활성 서버 URL 반환 (디버깅용) */
  getActiveUrl(): string | null {
    return this.activeUrl;
  }

  /** 사용 가능한 모델 목록 조회 */
  async listModels(): Promise<string[]> {
    if (!this.activeUrl) {
      const available = await this.isAvailable();
      if (!available) return [];
    }

    try {
      const res = await fetch(`${this.activeUrl}/v1/models`, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!res.ok) return [];

      const data = (await res.json()) as { data?: Array<{ id: string }> };
      return data.data?.map(m => m.id) ?? [];
    } catch {
      return [];
    }
  }

  buildCommand(_options: CliRunOptions): { command: string; args: string[] } {
    return { command: 'echo', args: ['"Local adapter uses run() — not shell spawn"'] };
  }

  async run(options: CliRunOptions): Promise<CliRunResult> {
    const startTime = Date.now();

    // 서버 연결 확인
    if (!this.activeUrl) {
      const available = await this.isAvailable();
      if (!available) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'No local model server found. Start Ollama, LMStudio, or llama.cpp server first.\n' +
            `Checked: ${(this.configuredUrl ? [this.configuredUrl, ...DEFAULT_ENDPOINTS] : DEFAULT_ENDPOINTS).join(', ')}`,
          durationMs: Date.now() - startTime,
        };
      }
    }

    const model = options.model ?? DEFAULT_MODEL;
    const body = {
      model,
      messages: [
        { role: 'user' as const, content: options.prompt },
      ],
      temperature: 0.2,
      stream: false,
    };

    try {
      const res = await fetch(`${this.activeUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.timeoutMs
          ? AbortSignal.timeout(options.timeoutMs)
          : undefined,
      });

      const durationMs = Date.now() - startTime;

      if (!res.ok) {
        const errText = await res.text().catch(() => '');

        // 모델 없음 에러 시 사용 가능한 모델 목록 안내
        if (res.status === 404 || errText.includes('not found')) {
          const models = await this.listModels();
          const modelList = models.length > 0
            ? `Available: ${models.slice(0, 10).join(', ')}`
            : 'No models loaded';
          return {
            exitCode: 1,
            stdout: '',
            stderr: `Model "${model}" not found on ${this.activeUrl}. ${modelList}`,
            durationMs,
          };
        }

        return {
          exitCode: 1,
          stdout: '',
          stderr: `Local API error (${res.status}): ${errText.slice(0, 500)}`,
          durationMs,
        };
      }

      const data = (await res.json()) as OpenAICompatResponse;
      const content = data.choices?.[0]?.message?.content ?? '';

      if (options.onLog) {
        options.onLog(content.slice(0, 300));
      }

      return {
        exitCode: 0,
        stdout: content,
        stderr: '',
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      // 타임아웃 또는 네트워크 에러
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('abort') || message.includes('timeout');

      return {
        exitCode: 1,
        stdout: '',
        stderr: isTimeout
          ? `Local model timeout after ${options.timeoutMs ?? 300000}ms (model: ${model}). Local models can be slow — consider increasing timeout.`
          : `Local model request failed: ${message}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    const text = raw.stdout;
    return extractWorkerResultJson(text) ?? extractWorkerFromText(text);
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    const text = raw.stdout;
    return extractReviewerResultJson(text) ?? extractReviewerFromText(text);
  }
}

// OpenAI 호환 응답 타입
interface OpenAICompatResponse {
  choices: Array<{
    message: {
      content: string;
      role: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model?: string;
}

// Worker/Reviewer 출력 파싱 (GPT 어댑터와 동일 로직)

function extractWorkerResultJson(text: string): WorkerResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch?.[1] ?? findJsonObject(text, '"success"');
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      success: Boolean(parsed.success),
      summary: parsed.summary || t('common.fallback.noSummary'),
      filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      output: text,
      error: parsed.error,
      confidencePercent: typeof parsed.confidencePercent === 'number'
        ? parsed.confidencePercent : undefined,
      haltReason: parsed.haltReason || undefined,
    };
  } catch {
    return null;
  }
}

function extractWorkerFromText(text: string): WorkerResult {
  const hasError = /error|fail|exception|cannot/i.test(text);
  const hasSuccess = /success|completed|done|finished/i.test(text);

  return {
    success: !hasError || hasSuccess,
    summary: extractSummary(text),
    filesChanged: [],
    commands: [],
    output: text,
    error: hasError ? extractErrorMessage(text) : undefined,
  };
}

function extractReviewerResultJson(text: string): ReviewResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch?.[1] ?? findJsonObject(text, '"decision"');
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr);
    const decision = parsed.decision === 'approve' || parsed.decision === 'reject'
      ? parsed.decision
      : 'revise';
    return {
      decision,
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback : t('common.fallback.noSummary'),
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.filter((v: unknown): v is string => typeof v === 'string')
        : [],
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((v: unknown): v is string => typeof v === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

function extractReviewerFromText(text: string): ReviewResult {
  const lower = text.toLowerCase();
  const decision = lower.includes('approve')
    ? 'approve'
    : lower.includes('reject')
      ? 'reject'
      : 'revise';
  return {
    decision,
    feedback: extractSummary(text),
    issues: [],
    suggestions: [],
  };
}

function findJsonObject(text: string, marker: string): string | null {
  const idx = text.indexOf(marker);
  if (idx < 0) return null;
  let start = text.lastIndexOf('{', idx);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extractSummary(text: string): string {
  const lines = text.split('\n').filter(l => l.trim().length > 10);
  if (lines.length === 0) return t('common.fallback.noSummary');
  const summary = lines[0].trim();
  return summary.length > 200 ? `${summary.slice(0, 200)}...` : summary;
}

function extractErrorMessage(text: string): string {
  const errorMatch = text.match(/(?:error|exception|failed?):\s*(.+)/i);
  if (errorMatch) return errorMatch[1].slice(0, 200);
  const lines = text.split('\n').filter(l => /error|fail/i.test(l));
  return lines.length > 0 ? lines[0].slice(0, 200) : 'Unknown error';
}
