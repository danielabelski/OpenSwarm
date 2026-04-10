// ============================================
// OpenSwarm - GPT CLI Adapter
// Calls OpenAI Chat Completions API directly via OAuth token
// ============================================

import type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  WorkerResult,
  ReviewResult,
} from './types.js';
import { AuthProfileStore, ensureValidToken } from '../auth/index.js';
import { t } from '../locale/index.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o';
const PROFILE_KEY = 'openai-gpt:default';

export class GptCliAdapter implements CliAdapter {
  readonly name = 'gpt';

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: false,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
  };

  async isAvailable(): Promise<boolean> {
    try {
      const store = new AuthProfileStore();
      const profile = store.getProfile(PROFILE_KEY);
      return profile !== null;
    } catch {
      return false;
    }
  }

  buildCommand(_options: CliRunOptions): { command: string; args: string[] } {
    // GPT 어댑터는 run()을 사용하므로 이 메서드는 호출되지 않음
    return { command: 'echo', args: ['"GPT adapter uses run() — not shell spawn"'] };
  }

  async run(options: CliRunOptions): Promise<CliRunResult> {
    const store = new AuthProfileStore();
    const startTime = Date.now();

    // 1. 유효한 토큰 획득
    let accessToken: string;
    try {
      accessToken = await ensureValidToken(store, PROFILE_KEY);
    } catch (err) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Auth error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
      };
    }

    // 2. OpenAI API 호출
    const model = options.model ?? DEFAULT_MODEL;
    const body = {
      model,
      messages: [
        { role: 'user' as const, content: options.prompt },
      ],
      temperature: 0.2,
      max_tokens: 16384,
    };

    try {
      const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const durationMs = Date.now() - startTime;

      if (!res.ok) {
        const errText = await res.text().catch(() => '');

        // 401 → 토큰 갱신 후 1회 재시도
        if (res.status === 401) {
          try {
            const newToken = await refreshAndRetry(store);
            return await this.callApi(newToken, body, startTime, options.onLog);
          } catch (retryErr) {
            return {
              exitCode: 1,
              stdout: '',
              stderr: `OpenAI API 401 after retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
              durationMs: Date.now() - startTime,
            };
          }
        }

        return {
          exitCode: 1,
          stdout: '',
          stderr: `OpenAI API error (${res.status}): ${errText.slice(0, 500)}`,
          durationMs,
        };
      }

      const data = (await res.json()) as OpenAIChatResponse;
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
      return {
        exitCode: 1,
        stdout: '',
        stderr: `OpenAI API request failed: ${err instanceof Error ? err.message : String(err)}`,
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

  private async callApi(
    token: string,
    body: Record<string, unknown>,
    startTime: number,
    onLog?: (line: string) => void,
  ): Promise<CliRunResult> {
    const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        exitCode: 1,
        stdout: '',
        stderr: `OpenAI API error (${res.status}): ${errText.slice(0, 500)}`,
        durationMs: Date.now() - startTime,
      };
    }

    const data = (await res.json()) as OpenAIChatResponse;
    const content = data.choices?.[0]?.message?.content ?? '';

    if (onLog) {
      onLog(content.slice(0, 300));
    }

    return {
      exitCode: 0,
      stdout: content,
      stderr: '',
      durationMs: Date.now() - startTime,
    };
  }
}

// OpenAI API response type

interface OpenAIChatResponse {
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
}

async function refreshAndRetry(store: AuthProfileStore): Promise<string> {
  const profile = store.getProfile(PROFILE_KEY);
  if (!profile) {
    throw new Error('No auth profile found');
  }
  // 강제 갱신 (expires를 0으로 설정)
  profile.expires = 0;
  store.setProfile(PROFILE_KEY, profile);
  return ensureValidToken(store, PROFILE_KEY);
}

// Worker/Reviewer output parsing (Codex 어댑터와 동일한 로직)

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

// Helpers

function findJsonObject(text: string, marker: string): string | null {
  const idx = text.indexOf(marker);
  if (idx < 0) return null;

  // marker 앞의 '{' 찾기
  let start = text.lastIndexOf('{', idx);
  if (start < 0) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function extractSummary(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 10);
  if (lines.length === 0) return t('common.fallback.noSummary');
  const summary = lines[0].trim();
  return summary.length > 200 ? `${summary.slice(0, 200)}...` : summary;
}

function extractErrorMessage(text: string): string {
  const errorMatch = text.match(/(?:error|exception|failed?):\s*(.+)/i);
  if (errorMatch) return errorMatch[1].slice(0, 200);
  const lines = text.split('\n').filter((l) => /error|fail/i.test(l));
  return lines.length > 0 ? lines[0].slice(0, 200) : 'Unknown error';
}
