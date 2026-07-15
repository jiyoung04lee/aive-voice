"use client";

/**
 * AIVE Voice — 선배 인터뷰 음성 아카이브 프로토타입
 *
 * 화면 상태: idle → uploading → transcribing → completed | failed
 * 백엔드 계약 (구현 완료된 API 그대로 사용):
 *   POST /api/transcriptions            → { id }
 *   GET  /api/transcriptions/[id]       → { status: "transcribing" }
 *                                        | { status: "completed", utterances: [...] }
 *                                        | { status: "failed", error }
 *
 * 색상은 globals.css의 CSS 변수로 관리 (--aive-accent 하나만 바꾸면 브랜드 컬러 교체)
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { maskPersonalInfo } from "@/lib/masking";

type Utterance = {
  start_at: number;
  duration: number;
  spk: number;
  msg: string;
  lang?: string;
};

type Phase = "idle" | "uploading" | "transcribing" | "completed" | "failed";

const ACCEPTED_EXTENSIONS = [".m4a", ".mp3", ".wav"];
const POLL_INTERVAL_MS = 5000; // RTZR 권장 폴링 주기
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_KEYWORD_COUNT = 500;
const MAX_KEYWORD_LENGTH = 20;
const COMPLETE_HANGUL_SYLLABLE_PATTERN = /^[\uAC00-\uD7A3]+$/u;

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightSearchTerm(text: string, searchTerm: string): ReactNode {
  const normalizedSearchTerm = searchTerm.trim();

  if (normalizedSearchTerm === "") {
    return text;
  }

  const pattern = new RegExp(escapeRegExp(normalizedSearchTerm), "giu");
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const matchIndex = match.index ?? 0;

    if (matchIndex > lastIndex) {
      nodes.push(text.slice(lastIndex, matchIndex));
    }

    nodes.push(
      <mark
        key={`${matchIndex}-${nodes.length}`}
        className="rounded-sm bg-yellow-200 px-0.5 text-[var(--aive-ink)]"
      >
        {match[0]}
      </mark>,
    );
    lastIndex = matchIndex + match[0].length;
  }

  if (nodes.length === 0) {
    return text;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function buildTranscriptText(
  utterances: readonly Utterance[],
  shouldMaskPersonalInfo: boolean,
): string {
  const utteranceBlocks = utterances.map((utterance) => {
    const message = shouldMaskPersonalInfo
      ? maskPersonalInfo(utterance.msg)
      : utterance.msg;

    return `[${formatTimestamp(utterance.start_at)}] 화자 ${utterance.spk}\n${message}`;
  });

  return ["AIVE Voice 전사 결과", ...utteranceBlocks].join("\n\n");
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isSupportedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function normalizeKeywords(input: string): string[] {
  const keywords = input
    .split(",")
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);

  return Array.from(new Set(keywords));
}

function validateKeywords(keywords: readonly string[]): string | null {
  if (keywords.length > MAX_KEYWORD_COUNT) {
    return "키워드는 최대 500개까지 입력할 수 있습니다.";
  }

  if (
    keywords.some(
      (keyword) => Array.from(keyword).length > MAX_KEYWORD_LENGTH,
    )
  ) {
    return "키워드는 각각 20자 이하로 입력해주세요.";
  }

  if (
    keywords.some(
      (keyword) => !COMPLETE_HANGUL_SYLLABLE_PATTERN.test(keyword),
    )
  ) {
    return "키워드는 한글로만 입력해주세요.";
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasTranscriptionId(
  value: unknown,
): value is { id: string } {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0
  );
}

function getErrorMessage(value: unknown, fallback: string): string {
  if (
    isRecord(value) &&
    typeof value.error === "string" &&
    value.error.trim().length > 0
  ) {
    return value.error;
  }

  return fallback;
}

function isUtterance(value: unknown): value is Utterance {
  return (
    isRecord(value) &&
    typeof value.start_at === "number" &&
    typeof value.duration === "number" &&
    typeof value.spk === "number" &&
    typeof value.msg === "string" &&
    (value.lang === undefined || typeof value.lang === "string")
  );
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [keywordInput, setKeywordInput] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [isMaskingEnabled, setIsMaskingEnabled] = useState(true);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStartRef = useRef<number>(0);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const handleFileSelected = (selected: File | null) => {
    if (!selected) return;

    setErrorMessage(null);
    if (!isSupportedFile(selected.name)) {
      stopPolling();
      setPhase("idle");
      setFile(null);
      setUtterances([]);
      setPollCount(0);
      setIsDragging(false);
      pollStartRef.current = 0;
      if (fileInputRef.current) fileInputRef.current.value = "";
      setErrorMessage(
        "지원하지 않는 파일 형식입니다. m4a, mp3, wav 파일을 선택해주세요.",
      );
      return;
    }
    setFile(selected);
    setPhase("idle");
    setUtterances([]);
  };

  const poll = useCallback(
    async function pollStatus(id: string) {
      if (Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
        stopPolling();
        setPhase("failed");
        setErrorMessage(
          "전사가 제한 시간 내에 완료되지 않았습니다. 잠시 후 다시 시도해주세요.",
        );
        return;
      }
      try {
        const res = await fetch(`/api/transcriptions/${id}`);
        if (!res.ok) throw new Error();
        const data: unknown = await res.json();

        if (!isRecord(data)) {
          stopPolling();
          setPhase("failed");
          setErrorMessage("알 수 없는 전사 상태가 반환되었습니다.");
          return;
        }

        if (data.status === "transcribing") {
          setPollCount((n) => n + 1);
          pollTimerRef.current = setTimeout(
            () => pollStatus(id),
            POLL_INTERVAL_MS,
          );
          return;
        }

        if (data.status === "completed") {
          stopPolling();
          const completedUtterances = Array.isArray(data.utterances)
            ? data.utterances.filter(isUtterance)
            : [];
          setUtterances(completedUtterances);
          setPhase("completed");
          return;
        }

        if (data.status === "failed") {
          stopPolling();
          setPhase("failed");
          setErrorMessage(
            getErrorMessage(data, "음성 전사 작업에 실패했습니다."),
          );
          return;
        }

        stopPolling();
        setPhase("failed");
        setErrorMessage("알 수 없는 전사 상태가 반환되었습니다.");
      } catch {
        stopPolling();
        setPhase("failed");
        setErrorMessage(
          "전사 상태를 확인하지 못했습니다. 네트워크 연결을 확인하고 다시 시도해주세요.",
        );
      }
    },
    [stopPolling],
  );

  const startTranscription = async () => {
    if (!file) {
      setErrorMessage("먼저 음성 파일을 선택해주세요.");
      return;
    }

    const keywords = normalizeKeywords(keywordInput);
    const keywordError = validateKeywords(keywords);

    if (keywordError) {
      setPhase("idle");
      setErrorMessage(keywordError);
      return;
    }

    setErrorMessage(null);
    setUtterances([]);
    setPollCount(0);
    setSearchInput("");
    setIsMaskingEnabled(true);
    setPhase("uploading");

    try {
      const formData = new FormData();
      formData.append("file", file);

      if (keywords.length > 0) {
        formData.append("keywords", JSON.stringify(keywords));
      }

      const res = await fetch("/api/transcriptions", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const errorData: unknown = await res.json().catch(() => null);
        throw new Error(
          getErrorMessage(errorData, "전사 요청에 실패했습니다."),
        );
      }

      const data: unknown = await res.json().catch(() => null);

      if (!hasTranscriptionId(data)) {
        throw new Error("전사 작업 정보를 확인하지 못했습니다.");
      }

      const id = data.id.trim();
      setPhase("transcribing");
      pollStartRef.current = Date.now();
      pollTimerRef.current = setTimeout(() => poll(id), POLL_INTERVAL_MS);
    } catch (err) {
      setPhase("failed");
      setErrorMessage(
        err instanceof Error ? err.message : "전사 요청에 실패했습니다.",
      );
    }
  };

  const reset = () => {
    stopPolling();
    setPhase("idle");
    setFile(null);
    setUtterances([]);
    setErrorMessage(null);
    setPollCount(0);
    setIsDragging(false);
    setKeywordInput("");
    setSearchInput("");
    setIsMaskingEnabled(true);
    pollStartRef.current = 0;
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const downloadTranscript = () => {
    if (utterances.length === 0) {
      return;
    }

    const transcriptText = buildTranscriptText(
      utterances,
      isMaskingEnabled,
    );
    const blob = new Blob([`\uFEFF${transcriptText}`], {
      type: "text/plain;charset=utf-8",
    });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = objectUrl;
    anchor.download = "aive-voice-transcript.txt";

    try {
      document.body.appendChild(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    }
  };

  const speakerIds = Array.from(new Set(utterances.map((u) => u.spk))).sort(
    (a, b) => a - b,
  );
  const speakerCount = speakerIds.length;
  const totalDurationMs =
    utterances.length > 0
      ? utterances[utterances.length - 1].start_at +
        utterances[utterances.length - 1].duration
      : 0;
  const isBusy = phase === "uploading" || phase === "transcribing";
  const searchTerm = searchInput.trim();
  const normalizedSearchTerm = searchTerm.toLowerCase();
  const displayUtterances = utterances.map((utterance) => ({
    utterance,
    displayMessage: isMaskingEnabled
      ? maskPersonalInfo(utterance.msg)
      : utterance.msg,
  }));
  const visibleUtterances =
    normalizedSearchTerm === ""
      ? displayUtterances
      : displayUtterances.filter(({ displayMessage }) =>
          displayMessage.toLowerCase().includes(normalizedSearchTerm),
        );

  return (
    <div className="min-h-screen bg-[var(--aive-canvas)] font-sans text-[var(--aive-ink)] antialiased">
      <link
        rel="stylesheet"
        href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
      />

      {/* ── 헤더 ─────────────────────────────── */}
      <header className="border-b border-[var(--aive-line)] bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2.5">
            {/* 로고: 음성 파형을 형상화한 마크 */}
            <span
              aria-hidden
              className="flex h-8 w-8 items-end justify-center gap-[3px] rounded-lg bg-[var(--aive-accent)] px-1.5 pb-2"
            >
              <i className="w-[3px] rounded-full bg-white/90 h-2" />
              <i className="w-[3px] rounded-full bg-white h-4" />
              <i className="w-[3px] rounded-full bg-white/90 h-2.5" />
            </span>
            <div className="leading-tight">
              <p className="text-[15px] font-bold tracking-tight">
                AIVE <span className="text-[var(--aive-accent)]">Voice</span>
              </p>
              <p className="text-[11px] text-[var(--aive-mute)]">
                선배 인터뷰 음성 아카이브
              </p>
            </div>
          </div>
          <span className="rounded-full border border-[var(--aive-line)] px-2.5 py-1 text-[11px] font-medium text-[var(--aive-mute)]">
            프로토타입
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 pb-24 pt-10">
        {/* ── 인트로 ─────────────────────────── */}
        <section className="mb-8">
          <h1 className="text-[26px] font-bold leading-snug tracking-tight sm:text-3xl">
            선배의 경험을,
            <br className="sm:hidden" /> 읽고 검색할 수 있게
          </h1>
          <p className="mt-2.5 max-w-xl text-[15px] leading-relaxed text-[var(--aive-mute)]">
            인터뷰 녹음을 올리면 화자별 대화록으로 바꿔드립니다. 긴 글을 쓰지
            않아도 선배의 경험이 후배에게 남습니다.
          </p>
        </section>

        {/* ── 업로드 카드 ─────────────────────── */}
        <section className="rounded-2xl border border-[var(--aive-line)] bg-white p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04)] sm:p-6">
          <label
            htmlFor="audio-file"
            onDragOver={(e) => {
              e.preventDefault();
              if (!isBusy) setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              const droppedFile = e.dataTransfer.files?.[0];
              if (!isBusy && droppedFile) handleFileSelected(droppedFile);
            }}
            className={[
              "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
              isBusy ? "pointer-events-none opacity-60" : "",
              isDragging
                ? "border-[var(--aive-accent)] bg-[var(--aive-accent-soft)]"
                : "border-[var(--aive-line)] hover:border-[var(--aive-accent)] hover:bg-[var(--aive-accent-soft)]",
            ].join(" ")}
          >
            <svg
              aria-hidden
              className="mb-3 h-9 w-9 text-[var(--aive-accent)]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
              <path d="M5 21h14" />
            </svg>
            <p className="text-[15px] font-semibold">
              인터뷰 음성 파일을 올려주세요
            </p>
            <p className="mt-1 text-[13px] text-[var(--aive-mute)]">
              클릭해서 선택하거나 파일을 끌어다 놓기 · m4a, mp3, wav
            </p>
            <input
              ref={fileInputRef}
              id="audio-file"
              type="file"
              accept=".m4a,.mp3,.wav"
              className="sr-only"
              disabled={isBusy}
              onChange={(e) => handleFileSelected(e.target.files?.[0] ?? null)}
            />
          </label>

          {/* 선택된 파일 정보 */}
          {file && (
            <div className="mt-4 flex items-center justify-between rounded-xl bg-[var(--aive-surface)] px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-[var(--aive-accent)] shadow-sm"
                >
                  <svg
                    className="h-4.5 w-4.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  >
                    <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z" />
                  </svg>
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium">{file.name}</p>
                  <p className="text-[12px] text-[var(--aive-mute)]">
                    {formatFileSize(file.size)}
                  </p>
                </div>
              </div>
              {!isBusy && (
                <button
                  type="button"
                  onClick={reset}
                  className="shrink-0 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--aive-mute)] hover:bg-white hover:text-[var(--aive-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--aive-accent)]"
                >
                  제거
                </button>
              )}
            </div>
          )}

          {/* 키워드 부스팅 */}
          <div className="mt-5 border-t border-[var(--aive-line)] pt-5">
            <label
              htmlFor="transcription-keywords"
              className="block text-[14px] font-semibold text-[var(--aive-ink)]"
            >
              인식할 주요 용어
            </label>
            <p
              id="transcription-keywords-description"
              className="mt-1 text-[13px] leading-relaxed text-[var(--aive-mute)]"
            >
              회사명, 직무명처럼 정확히 인식해야 하는 단어를 쉼표로 구분해
              입력해주세요.
            </p>
            <input
              id="transcription-keywords"
              type="text"
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
              disabled={isBusy}
              aria-describedby="transcription-keywords-description transcription-keywords-help"
              placeholder="현대오토에버, 프론트엔드, 카카오뱅크, 커피챗"
              className="mt-3 w-full rounded-xl border border-[var(--aive-line)] bg-white px-4 py-3 text-[14px] text-[var(--aive-ink)] outline-none transition placeholder:text-[var(--aive-mute)] focus:border-[var(--aive-accent)] focus:ring-2 focus:ring-[var(--aive-accent-soft)] disabled:cursor-not-allowed disabled:bg-[var(--aive-surface)] disabled:text-[var(--aive-mute)]"
            />
            <p
              id="transcription-keywords-help"
              className="mt-2 text-[12px] text-[var(--aive-mute)]"
            >
              선택 입력 · 한글 단어만 가능 · 키워드당 최대 20자
            </p>
          </div>

          {/* 전사 시작 버튼 */}
          <button
            type="button"
            onClick={startTranscription}
            disabled={!file || isBusy}
            className="mt-4 w-full rounded-xl bg-[var(--aive-accent)] py-3.5 text-[15px] font-semibold text-white transition-colors hover:bg-[var(--aive-accent-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--aive-accent)] disabled:cursor-not-allowed disabled:bg-[var(--aive-line)] disabled:text-[var(--aive-mute)]"
          >
            {phase === "uploading"
              ? "파일을 전송하고 있습니다…"
              : phase === "transcribing"
                ? "음성을 분석하고 있습니다…"
                : "대화록 만들기"}
          </button>

          {/* 진행 상태 */}
          {isBusy && (
            <div
              role="status"
              className="mt-4 flex items-center gap-3 rounded-xl bg-[var(--aive-accent-soft)] px-4 py-3.5"
            >
              <span
                aria-hidden
                className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--aive-accent)] border-t-transparent motion-reduce:animate-none"
              />
              <div className="text-[13px] leading-relaxed">
                {phase === "uploading" ? (
                  <p className="font-medium text-[var(--aive-ink)]">
                    파일을 안전하게 전송하고 있습니다.
                  </p>
                ) : (
                  <>
                    <p className="font-medium text-[var(--aive-ink)]">
                      전사가 진행 중입니다. 5초마다 상태를 확인합니다.
                      {pollCount > 0 && (
                        <span className="ml-1 text-[var(--aive-mute)]">
                          ({pollCount}회 확인)
                        </span>
                      )}
                    </p>
                    <p className="text-[var(--aive-mute)]">
                      파일 길이와 서버 상황에 따라 처리 시간이 달라질 수 있습니다.
                      화면을 유지해주세요.
                    </p>
                  </>
                )}
              </div>
            </div>
          )}

          {/* 오류 메시지 */}
          {errorMessage && (
            <div
              role="alert"
              className="mt-4 flex items-start gap-3 rounded-xl border border-[var(--aive-danger-line)] bg-[var(--aive-danger-soft)] px-4 py-3.5"
            >
              <svg
                aria-hidden
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--aive-danger)]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
              <div className="text-[13px] leading-relaxed">
                <p className="font-medium text-[var(--aive-danger)]">
                  {errorMessage}
                </p>
                {phase === "failed" && (
                  <button
                    type="button"
                    onClick={reset}
                    className="mt-1 font-semibold text-[var(--aive-ink)] underline underline-offset-2 hover:text-[var(--aive-accent)]"
                  >
                    처음부터 다시 시도
                  </button>
                )}
              </div>
            </div>
          )}
        </section>

        {/* ── 전사 결과: 메신저형 대화 뷰 ─────────── */}
        {phase === "completed" && utterances.length > 0 && (
          <section className="mt-8" aria-label="전사 결과">
            {/* 요약 바 */}
            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl bg-[var(--aive-surface)] px-4 py-3 text-[13px] text-[var(--aive-mute)]">
              <span className="font-semibold text-[var(--aive-ink)]">
                전사 완료
              </span>
              <span>발화 {utterances.length}개</span>
              <span>화자 {speakerCount}명</span>
              <span>길이 {formatTimestamp(totalDurationMs)}</span>
              <div className="ml-auto flex items-center gap-3">
                <button
                  type="button"
                  onClick={downloadTranscript}
                  disabled={utterances.length === 0}
                  className="font-medium text-[var(--aive-accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--aive-accent)] disabled:cursor-not-allowed disabled:text-[var(--aive-mute)] disabled:no-underline"
                >
                  TXT 다운로드
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="font-medium text-[var(--aive-accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--aive-accent)]"
                >
                  새 인터뷰 전사
                </button>
              </div>
            </div>

            {/* 개인정보 표시 마스킹 */}
            <div className="mb-4 flex flex-col gap-3 rounded-xl border border-[var(--aive-line)] bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[13px] font-semibold text-[var(--aive-ink)]">
                  전화번호·이메일 가리기
                </p>
                <p
                  id="masking-description"
                  className="mt-1 text-[12px] leading-relaxed text-[var(--aive-mute)]"
                >
                  화면과 TXT 다운로드 파일에 현재 설정을 적용합니다.
                </p>
              </div>
              <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-[13px] font-medium text-[var(--aive-ink)]">
                <input
                  type="checkbox"
                  checked={isMaskingEnabled}
                  onChange={(event) =>
                    setIsMaskingEnabled(event.target.checked)
                  }
                  aria-label="전화번호·이메일 가리기"
                  aria-describedby="masking-description"
                  className="h-4 w-4 accent-[var(--aive-accent)]"
                />
                {isMaskingEnabled ? "켜짐" : "꺼짐"}
              </label>
            </div>

            {/* 전사문 검색 */}
            <div className="mb-4 rounded-xl border border-[var(--aive-line)] bg-white p-3">
              <label htmlFor="transcript-search" className="sr-only">
                전사 내용 검색
              </label>
              <input
                id="transcript-search"
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="전사 내용 검색"
                className="w-full rounded-lg border border-[var(--aive-line)] bg-white px-3.5 py-2.5 text-[14px] text-[var(--aive-ink)] outline-none transition placeholder:text-[var(--aive-mute)] focus:border-[var(--aive-accent)] focus:ring-2 focus:ring-[var(--aive-accent-soft)]"
              />
              {searchTerm !== "" && (
                <p
                  aria-live="polite"
                  className="mt-2 px-1 text-[12px] font-medium text-[var(--aive-mute)]"
                >
                  {visibleUtterances.length > 0
                    ? `검색 결과 ${visibleUtterances.length}건`
                    : "검색 결과가 없습니다."}
                </p>
              )}
            </div>

            {/* 화자 범례 */}
            <div className="mb-4 flex items-center gap-4 px-1 text-[12px] text-[var(--aive-mute)]">
              {speakerIds.map((speakerId) => (
                <span key={speakerId} className="flex items-center gap-1.5">
                  <i
                    className={[
                      "h-2.5 w-2.5 rounded-full",
                      speakerId === 0
                        ? "bg-[var(--aive-spk0)]"
                        : "bg-[var(--aive-accent)]",
                    ].join(" ")}
                  />
                  화자 {speakerId}
                </span>
              ))}
            </div>

            {/* 대화 목록 — VITO처럼 메신저 형태로 */}
            <ol className="space-y-3">
              {visibleUtterances.map(
                ({ utterance: u, displayMessage }, idx) => {
                  const isSpeakerZero = u.spk === 0;

                  return (
                    <li
                      key={`${u.start_at}-${idx}`}
                      className={[
                        "flex flex-col",
                        isSpeakerZero ? "items-start" : "items-end",
                      ].join(" ")}
                    >
                      <div
                        className={[
                          "flex items-baseline gap-2 px-1 pb-1 text-[11px]",
                          isSpeakerZero ? "" : "flex-row-reverse",
                        ].join(" ")}
                      >
                        <span
                          className={[
                            "font-semibold",
                            isSpeakerZero
                              ? "text-[var(--aive-mute)]"
                              : "text-[var(--aive-accent)]",
                          ].join(" ")}
                        >
                          화자 {u.spk}
                        </span>
                        <time className="tabular-nums text-[var(--aive-mute)]">
                          {formatTimestamp(u.start_at)}
                        </time>
                      </div>
                      <p
                        className={[
                          "max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-[14px] leading-relaxed sm:max-w-[75%]",
                          isSpeakerZero
                            ? "rounded-tl-md bg-[var(--aive-surface)] text-[var(--aive-ink)]"
                            : "rounded-tr-md bg-[var(--aive-accent)] text-white",
                        ].join(" ")}
                      >
                        {highlightSearchTerm(displayMessage, searchTerm)}
                      </p>
                    </li>
                  );
                },
              )}
            </ol>
          </section>
        )}

        {phase === "completed" && utterances.length === 0 && (
          <section className="mt-8" aria-label="빈 전사 결과">
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--aive-surface)] px-4 py-4 text-[13px] text-[var(--aive-mute)]">
              <p>전사는 완료되었지만 표시할 발화 내용이 없습니다.</p>
              <div className="ml-auto flex items-center gap-3">
                <button
                  type="button"
                  onClick={downloadTranscript}
                  disabled
                  className="cursor-not-allowed font-medium text-[var(--aive-mute)]"
                >
                  TXT 다운로드
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="font-medium text-[var(--aive-accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--aive-accent)]"
                >
                  새 인터뷰 전사
                </button>
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="border-t border-[var(--aive-line)] py-6 text-center text-[12px] text-[var(--aive-mute)]">
        AIVE Voice · RTZR STT OpenAPI 기반 프로토타입
      </footer>
    </div>
  );
}
