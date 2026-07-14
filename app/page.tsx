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

import { useCallback, useEffect, useRef, useState } from "react";

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

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isSupportedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
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
    setErrorMessage(null);
    setUtterances([]);
    setPollCount(0);
    setPhase("uploading");

    try {
      const formData = new FormData();
      formData.append("file", file);
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
    pollStartRef.current = 0;
    if (fileInputRef.current) fileInputRef.current.value = "";
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
              <button
                type="button"
                onClick={reset}
                className="ml-auto font-medium text-[var(--aive-accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--aive-accent)]"
              >
                새 인터뷰 전사
              </button>
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
              {utterances.map((u, idx) => {
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
                      {u.msg}
                    </p>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {phase === "completed" && utterances.length === 0 && (
          <section className="mt-8" aria-label="빈 전사 결과">
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-[var(--aive-surface)] px-4 py-4 text-[13px] text-[var(--aive-mute)]">
              <p>전사는 완료되었지만 표시할 발화 내용이 없습니다.</p>
              <button
                type="button"
                onClick={reset}
                className="ml-auto font-medium text-[var(--aive-accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--aive-accent)]"
              >
                새 인터뷰 전사
              </button>
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
