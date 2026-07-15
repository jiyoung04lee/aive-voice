"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
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

type ConversationTurn = {
  speakerId: number;
  startAt: number;
  endAt: number;
  utteranceIndexes: number[];
};

const ACCEPTED_EXTENSIONS = [".m4a", ".mp3", ".wav"];
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_KEYWORD_COUNT = 500;
const MAX_KEYWORD_LENGTH = 20;
const COMPLETE_HANGUL_SYLLABLE_PATTERN = /^[\uAC00-\uD7A3]+$/u;
const DEFAULT_INTERVIEWER_NAME = "인터뷰어";
const DEFAULT_GUEST_NAME = "졸업생 선배";

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
  return ACCEPTED_EXTENSIONS.some((extension) => lower.endsWith(extension));
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

function normalizeSpeakerName(value: string, fallback: string): string {
  const normalized = value.trim();
  return normalized === "" ? fallback : normalized;
}

function getInitial(name: string): string {
  return Array.from(name.trim())[0] ?? "화";
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

function buildConversationTurns(
  utterances: readonly Utterance[],
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  utterances.forEach((utterance, utteranceIndex) => {
    const previousTurn = turns[turns.length - 1];
    const utteranceEnd = utterance.start_at + utterance.duration;

    if (previousTurn && previousTurn.speakerId === utterance.spk) {
      previousTurn.endAt = utteranceEnd;
      previousTurn.utteranceIndexes.push(utteranceIndex);
      return;
    }

    turns.push({
      speakerId: utterance.spk,
      startAt: utterance.start_at,
      endAt: utteranceEnd,
      utteranceIndexes: [utteranceIndex],
    });
  });

  return turns;
}

function getSpeakerOrder(utterances: readonly Utterance[]): number[] {
  const seen = new Set<number>();
  const speakerOrder: number[] = [];

  utterances.forEach((utterance) => {
    if (!seen.has(utterance.spk)) {
      seen.add(utterance.spk);
      speakerOrder.push(utterance.spk);
    }
  });

  return speakerOrder;
}

function resetAudioElement(audio: HTMLAudioElement | null): void {
  if (!audio) return;

  try {
    audio.pause();
    audio.currentTime = 0;
  } catch {
    // 오디오가 아직 준비되지 않아도 나머지 초기화는 계속 진행합니다.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasTranscriptionId(value: unknown): value is { id: string } {
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

function BrandHeader({ wide = false }: { wide?: boolean }) {
  return (
    <header className="border-b border-[var(--aive-line)] bg-white/90 backdrop-blur">
      <div
        className={[
          "mx-auto flex items-center justify-between px-5 py-4",
          wide ? "max-w-6xl" : "max-w-3xl",
        ].join(" ")}
      >
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-8 w-8 items-end justify-center gap-[3px] rounded-lg bg-[var(--aive-accent)] px-1.5 pb-2"
          >
            <i className="h-2 w-[3px] rounded-full bg-white/90" />
            <i className="h-4 w-[3px] rounded-full bg-white" />
            <i className="h-2.5 w-[3px] rounded-full bg-white/90" />
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
  );
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-[var(--aive-danger-line)] bg-[var(--aive-danger-soft)] px-4 py-3.5"
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
      <p className="text-[13px] font-medium leading-relaxed text-[var(--aive-danger)]">
        {message}
      </p>
    </div>
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
  const [interviewerName, setInterviewerName] = useState("");
  const [guestName, setGuestName] = useState("");
  const [isSpeakerOrderSwapped, setIsSpeakerOrderSwapped] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [isMaskingEnabled, setIsMaskingEnabled] = useState(true);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioMessage, setAudioMessage] = useState<string | null>(null);
  const [activeUtteranceIndex, setActiveUtteranceIndex] = useState<
    number | null
  >(null);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStartRef = useRef(0);
  const pendingMetadataCleanupRef = useRef<(() => void) | null>(null);
  const turnElementRefs = useRef(new Map<number, HTMLLIElement>());
  const lastHandledActiveTurnRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const clearPendingAudioSeek = useCallback(() => {
    pendingMetadataCleanupRef.current?.();
    pendingMetadataCleanupRef.current = null;
  }, []);

  const resetAudioPlayback = useCallback(() => {
    clearPendingAudioSeek();
    resetAudioElement(audioRef.current);
    setAudioMessage(null);
    setActiveUtteranceIndex(null);
    setIsAudioPlaying(false);
    lastHandledActiveTurnRef.current = null;
  }, [clearPendingAudioSeek]);

  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    if (!file) {
      setAudioUrl(null);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setAudioUrl(objectUrl);

    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  useEffect(
    () => () => {
      clearPendingAudioSeek();
      resetAudioElement(audioRef.current);
    },
    [clearPendingAudioSeek],
  );

  const handleFileSelected = (selected: File | null) => {
    if (!selected) return;

    resetAudioPlayback();
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
    setSearchInput("");
    setIsSpeakerOrderSwapped(false);
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
        const response = await fetch(`/api/transcriptions/${id}`);
        const data: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(
            getErrorMessage(
              data,
              "전사 상태를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.",
            ),
          );
        }

        if (!isRecord(data)) {
          stopPolling();
          setPhase("failed");
          setErrorMessage("알 수 없는 전사 상태가 반환되었습니다.");
          return;
        }

        if (data.status === "transcribing") {
          setPollCount((count) => count + 1);
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
      } catch (error) {
        stopPolling();
        setPhase("failed");
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "전사 상태를 확인하지 못했습니다. 네트워크 연결을 확인하고 다시 시도해주세요.",
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

    resetAudioPlayback();
    setErrorMessage(null);
    setUtterances([]);
    setPollCount(0);
    setSearchInput("");
    setIsMaskingEnabled(true);
    setIsSpeakerOrderSwapped(false);
    setPhase("uploading");

    try {
      const formData = new FormData();
      formData.append("file", file);

      if (keywords.length > 0) {
        formData.append("keywords", JSON.stringify(keywords));
      }

      const response = await fetch("/api/transcriptions", {
        method: "POST",
        body: formData,
      });
      const data: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(getErrorMessage(data, "전사 요청에 실패했습니다."));
      }

      if (!hasTranscriptionId(data)) {
        throw new Error("전사 작업 정보를 확인하지 못했습니다.");
      }

      const id = data.id.trim();
      setPhase("transcribing");
      pollStartRef.current = Date.now();
      pollTimerRef.current = setTimeout(() => poll(id), POLL_INTERVAL_MS);
    } catch (error) {
      setPhase("failed");
      setErrorMessage(
        error instanceof Error ? error.message : "전사 요청에 실패했습니다.",
      );
    }
  };

  const reset = () => {
    stopPolling();
    resetAudioPlayback();
    setPhase("idle");
    setFile(null);
    setUtterances([]);
    setErrorMessage(null);
    setPollCount(0);
    setIsDragging(false);
    setKeywordInput("");
    setInterviewerName("");
    setGuestName("");
    setIsSpeakerOrderSwapped(false);
    setSearchInput("");
    setIsMaskingEnabled(true);
    pollStartRef.current = 0;
    turnElementRefs.current.clear();
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const syncActiveUtterance = useCallback(
    (currentTimeSeconds: number) => {
      const currentTimeMs = currentTimeSeconds * 1000;

      if (!Number.isFinite(currentTimeMs)) {
        setActiveUtteranceIndex(null);
        return;
      }

      const currentIndex = utterances.findIndex((utterance) => {
        const utteranceEnd = utterance.start_at + utterance.duration;
        return (
          Number.isFinite(utterance.start_at) &&
          Number.isFinite(utterance.duration) &&
          currentTimeMs >= utterance.start_at &&
          currentTimeMs < utteranceEnd
        );
      });

      setActiveUtteranceIndex(currentIndex >= 0 ? currentIndex : null);
    },
    [utterances],
  );

  const playAudioFrom = (startAt: number) => {
    if (!Number.isFinite(startAt)) return;

    const audio = audioRef.current;
    if (!audio) return;

    clearPendingAudioSeek();
    setAudioMessage(null);

    const seekAndPlay = async () => {
      const requestedTime = Math.max(0, startAt / 1000);
      const targetTime = Number.isFinite(audio.duration)
        ? Math.min(requestedTime, audio.duration)
        : requestedTime;

      try {
        audio.currentTime = targetTime;
        syncActiveUtterance(targetTime);
        await audio.play();
      } catch {
        setAudioMessage(
          "오디오를 자동으로 재생하지 못했습니다. 재생 버튼을 눌러주세요.",
        );
      }
    };

    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      void seekAndPlay();
      return;
    }

    const handleLoadedMetadata = () => {
      pendingMetadataCleanupRef.current = null;
      void seekAndPlay();
    };

    audio.addEventListener("loadedmetadata", handleLoadedMetadata, {
      once: true,
    });
    pendingMetadataCleanupRef.current = () => {
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
    };
  };

  const speakerOrder = useMemo(() => getSpeakerOrder(utterances), [utterances]);
  const conversationTurns = useMemo(
    () => buildConversationTurns(utterances),
    [utterances],
  );

  const normalizedInterviewerName = normalizeSpeakerName(
    interviewerName,
    DEFAULT_INTERVIEWER_NAME,
  );
  const normalizedGuestName = normalizeSpeakerName(guestName, DEFAULT_GUEST_NAME);

  const speakerNameMap = useMemo(() => {
    const names = isSpeakerOrderSwapped
      ? [normalizedGuestName, normalizedInterviewerName]
      : [normalizedInterviewerName, normalizedGuestName];
    const map = new Map<number, string>();

    speakerOrder.forEach((speakerId, index) => {
      map.set(speakerId, names[index] ?? `추가 화자 ${index - 1}`);
    });

    return map;
  }, [
    isSpeakerOrderSwapped,
    normalizedGuestName,
    normalizedInterviewerName,
    speakerOrder,
  ]);

  const speakerSideMap = useMemo(() => {
    const map = new Map<number, "left" | "right">();
    speakerOrder.forEach((speakerId, index) => {
      if (index === 0) {
        map.set(speakerId, isSpeakerOrderSwapped ? "right" : "left");
      } else if (index === 1) {
        map.set(speakerId, isSpeakerOrderSwapped ? "left" : "right");
      } else {
        map.set(speakerId, "left");
      }
    });
    return map;
  }, [isSpeakerOrderSwapped, speakerOrder]);

  const searchTerm = searchInput.trim();
  const normalizedSearchTerm = searchTerm.toLowerCase();

  const displayTurns = useMemo(
    () =>
      conversationTurns.map((turn, turnIndex) => {
        const segments = turn.utteranceIndexes.map((utteranceIndex) => {
          const utterance = utterances[utteranceIndex];
          const displayMessage = isMaskingEnabled
            ? maskPersonalInfo(utterance.msg)
            : utterance.msg;
          return { utteranceIndex, displayMessage };
        });

        return {
          turn,
          turnIndex,
          segments,
          combinedMessage: segments
            .map(({ displayMessage }) => displayMessage)
            .join(" "),
          speakerName:
            speakerNameMap.get(turn.speakerId) ?? `화자 ${turn.speakerId}`,
          side: speakerSideMap.get(turn.speakerId) ?? "left",
        };
      }),
    [
      conversationTurns,
      isMaskingEnabled,
      speakerNameMap,
      speakerSideMap,
      utterances,
    ],
  );

  const visibleTurns = useMemo(
    () =>
      normalizedSearchTerm === ""
        ? displayTurns
        : displayTurns.filter(({ combinedMessage }) =>
            combinedMessage.toLowerCase().includes(normalizedSearchTerm),
          ),
    [displayTurns, normalizedSearchTerm],
  );

  const activeTurnIndex = useMemo(() => {
    if (activeUtteranceIndex === null) return null;
    const index = conversationTurns.findIndex((turn) =>
      turn.utteranceIndexes.includes(activeUtteranceIndex),
    );
    return index >= 0 ? index : null;
  }, [activeUtteranceIndex, conversationTurns]);

  const isActiveTurnVisible =
    activeTurnIndex !== null &&
    visibleTurns.some(({ turnIndex }) => turnIndex === activeTurnIndex);

  useEffect(() => {
    if (activeTurnIndex === null) {
      lastHandledActiveTurnRef.current = null;
      return;
    }

    if (!isAudioPlaying || !isActiveTurnVisible) return;
    if (lastHandledActiveTurnRef.current === activeTurnIndex) return;

    lastHandledActiveTurnRef.current = activeTurnIndex;
    turnElementRefs.current
      .get(activeTurnIndex)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeTurnIndex, isActiveTurnVisible, isAudioPlaying]);

  const totalDurationMs =
    utterances.length > 0
      ? utterances[utterances.length - 1].start_at +
        utterances[utterances.length - 1].duration
      : 0;
  const speakerCount = speakerOrder.length;
  const isBusy = phase === "uploading" || phase === "transcribing";

  const downloadTranscript = () => {
    if (conversationTurns.length === 0) return;

    const blocks = conversationTurns.map((turn) => {
      const speakerName =
        speakerNameMap.get(turn.speakerId) ?? `화자 ${turn.speakerId}`;
      const message = turn.utteranceIndexes
        .map((utteranceIndex) => {
          const originalMessage = utterances[utteranceIndex].msg;
          return isMaskingEnabled
            ? maskPersonalInfo(originalMessage)
            : originalMessage;
        })
        .join(" ");

      return `[${formatTimestamp(turn.startAt)}] ${speakerName}\n${message}`;
    });

    const transcriptText = ["AIVE Voice 전사 결과", ...blocks].join("\n\n");
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

  const renderAudio = () =>
    file && audioUrl ? (
      <>
        <audio
          ref={audioRef}
          src={audioUrl}
          controls
          preload="metadata"
          onTimeUpdate={(event) =>
            syncActiveUtterance(event.currentTarget.currentTime)
          }
          onSeeked={(event) =>
            syncActiveUtterance(event.currentTarget.currentTime)
          }
          onPlay={(event) => {
            setAudioMessage(null);
            setIsAudioPlaying(true);
            syncActiveUtterance(event.currentTarget.currentTime);
          }}
          onPause={() => setIsAudioPlaying(false)}
          onEnded={() => {
            setIsAudioPlaying(false);
            setActiveUtteranceIndex(null);
          }}
          className="block w-full max-w-full"
        />
        {audioMessage && (
          <p role="status" className="mt-2 text-xs text-[var(--aive-danger)]">
            {audioMessage}
          </p>
        )}
      </>
    ) : null;

  const pageWide = phase === "completed";

  return (
    <div className="min-h-screen bg-[var(--aive-canvas)] font-sans text-[var(--aive-ink)] antialiased">
      <link
        rel="stylesheet"
        href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
      />
      <BrandHeader wide={pageWide} />

      {phase === "idle" && (
        <main className="mx-auto max-w-3xl px-5 pb-24 pt-10">
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

          <section className="rounded-2xl border border-[var(--aive-line)] bg-white p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04)] sm:p-6">
            <label
              htmlFor="audio-file"
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                handleFileSelected(event.dataTransfer.files?.[0] ?? null);
              }}
              className={[
                "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
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
                onChange={(event) =>
                  handleFileSelected(event.target.files?.[0] ?? null)
                }
              />
            </label>

            {file && (
              <div className="mt-4 flex items-center justify-between rounded-xl bg-[var(--aive-surface)] px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-[var(--aive-accent)] shadow-sm"
                  >
                    <svg
                      className="h-5 w-5"
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
                    <p className="truncate text-sm font-medium">{file.name}</p>
                    <p className="text-xs text-[var(--aive-mute)]">
                      {formatFileSize(file.size)}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    resetAudioPlayback();
                    setFile(null);
                    setUtterances([]);
                    setErrorMessage(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--aive-mute)] hover:bg-white hover:text-[var(--aive-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--aive-accent)]"
                >
                  제거
                </button>
              </div>
            )}

            <div className="mt-5 border-t border-[var(--aive-line)] pt-5">
              <label
                htmlFor="transcription-keywords"
                className="block text-sm font-semibold"
              >
                인식할 주요 용어
              </label>
              <p className="mt-1 text-[13px] leading-relaxed text-[var(--aive-mute)]">
                회사명, 직무명처럼 정확히 인식해야 하는 단어를 쉼표로 구분해
                입력해주세요.
              </p>
              <input
                id="transcription-keywords"
                type="text"
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                placeholder="현대오토에버, 프론트엔드, 카카오뱅크, 커피챗"
                className="mt-3 w-full rounded-xl border border-[var(--aive-line)] bg-white px-4 py-3 text-sm outline-none transition placeholder:text-[var(--aive-mute)] focus:border-[var(--aive-accent)] focus:ring-2 focus:ring-[var(--aive-accent-soft)]"
              />
              <p className="mt-2 text-xs text-[var(--aive-mute)]">
                선택 입력 · 한글 단어만 가능 · 키워드당 최대 20자
              </p>
            </div>

            <div className="mt-5 border-t border-[var(--aive-line)] pt-5">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">화자 이름</h2>
                <span className="text-xs font-medium text-[var(--aive-mute)]">
                  선택
                </span>
              </div>

              <p className="mt-1 text-[13px] leading-relaxed text-[var(--aive-mute)]">
                입력하지 않으면 인터뷰어와 졸업생 선배로 표시됩니다. 결과 화면에서
                이름의 연결 순서를 바꿀 수 있습니다.
              </p>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-[var(--aive-mute)]">
                    인터뷰어 이름
                  </span>
                  <input
                    type="text"
                    value={interviewerName}
                    onChange={(event) => setInterviewerName(event.target.value)}
                    maxLength={24}
                    placeholder="예: 인터뷰어"
                    className="w-full rounded-xl border border-[var(--aive-line)] bg-white px-4 py-3 text-sm outline-none transition placeholder:text-[var(--aive-mute)] focus:border-[var(--aive-accent)] focus:ring-2 focus:ring-[var(--aive-accent-soft)]"
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-[var(--aive-mute)]">
                    인터뷰 대상자 이름
                  </span>
                  <input
                    type="text"
                    value={guestName}
                    onChange={(event) => setGuestName(event.target.value)}
                    maxLength={24}
                    placeholder="예: 졸업생 선배"
                    className="w-full rounded-xl border border-[var(--aive-line)] bg-white px-4 py-3 text-sm outline-none transition placeholder:text-[var(--aive-mute)] focus:border-[var(--aive-accent)] focus:ring-2 focus:ring-[var(--aive-accent-soft)]"
                  />
                </label>
              </div>
            </div>

            <button
              type="button"
              onClick={startTranscription}
              disabled={!file}
              className="mt-5 w-full rounded-xl bg-[var(--aive-accent)] py-3.5 text-[15px] font-semibold text-white transition-colors hover:bg-[var(--aive-accent-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--aive-accent)] disabled:cursor-not-allowed disabled:bg-[var(--aive-line)] disabled:text-[var(--aive-mute)]"
            >
              대화록 만들기
            </button>

            {errorMessage && (
              <div className="mt-4">
                <ErrorNotice message={errorMessage} />
              </div>
            )}
          </section>
        </main>
      )}

      {isBusy && (
        <main className="mx-auto flex max-w-3xl items-center px-5 py-16 sm:min-h-[calc(100vh-132px)]">
          <section
            role="status"
            aria-live="polite"
            className="w-full rounded-3xl border border-[var(--aive-line)] bg-white px-6 py-16 text-center shadow-[0_8px_30px_rgba(25,31,40,0.05)] sm:px-10"
          >
            <div
              aria-hidden
              className="mx-auto flex h-16 items-center justify-center gap-2"
            >
              {[28, 48, 64, 44, 30].map((height, index) => (
                <span
                  key={height}
                  className="w-2.5 animate-pulse rounded-full bg-[var(--aive-accent)] motion-reduce:animate-none"
                  style={{
                    height,
                    animationDelay: `${index * 120}ms`,
                    opacity: 0.45 + index * 0.1,
                  }}
                />
              ))}
            </div>
            <h1 className="mt-5 text-2xl font-bold tracking-tight">
              {phase === "uploading"
                ? "음성 파일을 전송하고 있습니다"
                : "음성을 분석하고 있습니다"}
            </h1>
            <p className="mt-3 text-[15px] text-[var(--aive-mute)]">
              {file?.name}
            </p>
            <p className="mt-1 text-sm font-medium text-[var(--aive-ink)]">
              5초마다 상태를 확인합니다
              {phase === "transcribing" && pollCount > 0
                ? ` · ${pollCount}회 확인`
                : ""}
            </p>
            <p className="mt-5 text-[13px] leading-relaxed text-[var(--aive-mute)]">
              파일 길이와 서버 상태에 따라 시간이 걸릴 수 있습니다.
              <br />화면을 유지해주세요.
            </p>
          </section>
        </main>
      )}

      {phase === "failed" && (
        <main className="mx-auto flex max-w-3xl items-center px-5 py-16 sm:min-h-[calc(100vh-132px)]">
          <section className="w-full rounded-3xl border border-[var(--aive-line)] bg-white px-6 py-12 text-center shadow-[0_8px_30px_rgba(25,31,40,0.05)] sm:px-10">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--aive-danger-soft)] text-[var(--aive-danger)]">
              <svg
                aria-hidden
                className="h-6 w-6"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
            </div>
            <h1 className="mt-5 text-2xl font-bold">
              대화록을 만들지 못했습니다
            </h1>
            <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[var(--aive-mute)]">
              {errorMessage ?? "요청을 처리하는 중 오류가 발생했습니다."}
            </p>
            <button
              type="button"
              onClick={reset}
              className="mt-7 rounded-xl bg-[var(--aive-accent)] px-6 py-3 text-sm font-semibold text-white hover:bg-[var(--aive-accent-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--aive-accent)]"
            >
              처음부터 다시 시도
            </button>
          </section>
        </main>
      )}

      {phase === "completed" && utterances.length > 0 && (
        <main className="mx-auto max-w-6xl px-5 pb-20 pt-7 lg:pt-9">
          <div className="grid items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
            <aside className="space-y-4 lg:sticky lg:top-6">
              <section className="rounded-2xl border border-[var(--aive-line)] bg-white p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--aive-mute)]">
                  업로드한 파일
                </p>
                <p className="mt-2 truncate text-base font-bold">{file?.name}</p>
                <p className="mt-1 text-sm text-[var(--aive-mute)]">
                  발화 {utterances.length}개 · 화자 {speakerCount}명 ·{" "}
                  {formatTimestamp(totalDurationMs)}
                </p>
              </section>

              <section className="rounded-2xl border border-[var(--aive-line)] bg-white p-5">
                <p className="mb-3 text-sm font-semibold">오디오</p>
                {renderAudio()}
                <p className="mt-3 text-xs leading-relaxed text-[var(--aive-mute)]">
                  타임스탬프를 누르면 해당 대화 위치부터 재생됩니다.
                </p>
              </section>

              <section className="rounded-2xl border border-[var(--aive-line)] bg-white p-5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold">화자 이름</p>
                  {speakerOrder.length >= 2 && (
                    <button
                      type="button"
                      onClick={() =>
                        setIsSpeakerOrderSwapped((value) => !value)
                      }
                      className="text-xs font-semibold text-[var(--aive-accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--aive-accent)]"
                    >
                      이름 순서 바꾸기
                    </button>
                  )}
                </div>
                <div className="mt-4 space-y-3">
                  {speakerOrder.slice(0, 2).map((speakerId) => {
                    const name = speakerNameMap.get(speakerId) ?? "화자";
                    return (
                      <div key={speakerId} className="flex items-center gap-3">
                        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--aive-accent-soft)] text-sm font-bold text-[var(--aive-accent)]">
                          {getInitial(name)}
                        </span>
                        <span className="text-sm font-medium">{name}</span>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-2xl border border-[var(--aive-line)] bg-white p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold">개인정보 가리기</p>
                    <p className="mt-1 text-xs leading-relaxed text-[var(--aive-mute)]">
                      화면과 TXT 파일에 적용됩니다.
                    </p>
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold">
                    <input
                      type="checkbox"
                      checked={isMaskingEnabled}
                      onChange={(event) =>
                        setIsMaskingEnabled(event.target.checked)
                      }
                      aria-label="전화번호·이메일 가리기"
                      className="h-4 w-4 accent-[var(--aive-accent)]"
                    />
                    {isMaskingEnabled ? "켜짐" : "꺼짐"}
                  </label>
                </div>
              </section>

              <div className="flex flex-wrap gap-x-4 gap-y-2 px-1 text-sm font-semibold text-[var(--aive-accent)]">
                <button
                  type="button"
                  onClick={downloadTranscript}
                  className="hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--aive-accent)]"
                >
                  TXT 다운로드
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--aive-accent)]"
                >
                  새 인터뷰 전사
                </button>
              </div>
            </aside>

            <section
              className="min-w-0 rounded-2xl border border-[var(--aive-line)] bg-white p-4 sm:p-6 lg:p-7"
              aria-label="인터뷰 대화록"
            >
              <div className="flex flex-col gap-5 border-b border-[var(--aive-line)] pb-5 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h1 className="text-2xl font-bold tracking-tight">
                    인터뷰 대화록
                  </h1>
                  <p className="mt-1 text-sm text-[var(--aive-mute)]">
                    {conversationTurns.length}개 대화 · 화자 {speakerCount}명 ·{" "}
                    {formatTimestamp(totalDurationMs)}
                  </p>
                </div>
                <div className="w-full sm:max-w-sm">
                  <label htmlFor="transcript-search" className="sr-only">
                    전사 내용 검색
                  </label>
                  <div className="relative">
                    <svg
                      aria-hidden
                      className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--aive-mute)]"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    >
                      <circle cx="11" cy="11" r="7" />
                      <path d="m20 20-4-4" />
                    </svg>
                    <input
                      id="transcript-search"
                      type="search"
                      value={searchInput}
                      onChange={(event) => setSearchInput(event.target.value)}
                      placeholder="전사 내용 검색"
                      className="w-full rounded-xl border border-[var(--aive-line)] bg-white py-3 pl-10 pr-4 text-sm outline-none transition placeholder:text-[var(--aive-mute)] focus:border-[var(--aive-accent)] focus:ring-2 focus:ring-[var(--aive-accent-soft)]"
                    />
                  </div>
                  {searchTerm !== "" && (
                    <p
                      aria-live="polite"
                      className="mt-2 text-xs font-medium text-[var(--aive-mute)]"
                    >
                      {visibleTurns.length > 0
                        ? `검색 결과 ${visibleTurns.length}개 대화`
                        : "검색 결과가 없습니다."}
                    </p>
                  )}
                </div>
              </div>

              {visibleTurns.length === 0 ? (
                <div className="py-20 text-center text-sm text-[var(--aive-mute)]">
                  검색 결과가 없습니다.
                </div>
              ) : (
                <ol className="mt-6 space-y-5">
                  {visibleTurns.map(
                    ({ turn, turnIndex, segments, speakerName, side }) => {
                      const isRight = side === "right";
                      const isActive = turnIndex === activeTurnIndex;

                      return (
                        <li
                          key={`${turn.startAt}-${turnIndex}`}
                          ref={(element) => {
                            if (element) {
                              turnElementRefs.current.set(turnIndex, element);
                            } else {
                              turnElementRefs.current.delete(turnIndex);
                            }
                          }}
                          aria-current={isActive ? "true" : undefined}
                          className={[
                            "scroll-mt-24 flex gap-3",
                            isRight ? "justify-end" : "justify-start",
                          ].join(" ")}
                        >
                          {!isRight && (
                            <span className="mt-6 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--aive-surface)] text-sm font-bold text-[var(--aive-ink)]">
                              {getInitial(speakerName)}
                            </span>
                          )}

                          <div className="max-w-[82%] sm:max-w-[76%]">
                            <div
                              className={[
                                "mb-1.5 flex items-center gap-2 px-1 text-xs",
                                isRight ? "justify-end" : "justify-start",
                              ].join(" ")}
                            >
                              <span
                                className={[
                                  "font-semibold",
                                  isRight
                                    ? "text-[var(--aive-accent)]"
                                    : "text-[var(--aive-ink)]",
                                ].join(" ")}
                              >
                                {speakerName}
                              </span>
                              <button
                                type="button"
                                onClick={() => playAudioFrom(turn.startAt)}
                                aria-label={`${formatTimestamp(turn.startAt)}부터 재생`}
                                className="rounded tabular-nums text-[var(--aive-mute)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--aive-accent)]"
                              >
                                {formatTimestamp(turn.startAt)}
                              </button>
                            </div>

                            <div
                              className={[
                                "rounded-2xl px-4 py-3.5 text-[15px] leading-7 transition",
                                isRight
                                  ? "rounded-tr-md bg-[var(--aive-accent)] text-white"
                                  : "rounded-tl-md bg-[var(--aive-surface)] text-[var(--aive-ink)]",
                                isActive
                                  ? "ring-2 ring-[var(--aive-accent)] ring-offset-2 shadow-[0_5px_18px_rgba(59,91,219,0.16)]"
                                  : "",
                              ].join(" ")}
                            >
                              {segments.map(
                                (
                                  { utteranceIndex, displayMessage },
                                  segmentIndex,
                                ) => {
                                  const isActiveSegment =
                                    utteranceIndex === activeUtteranceIndex;

                                  return (
                                    <span
                                      key={utteranceIndex}
                                      className={[
                                        "rounded px-0.5",
                                        isActiveSegment
                                          ? isRight
                                            ? "bg-white/15"
                                            : "bg-[var(--aive-accent-soft)]"
                                          : "",
                                      ].join(" ")}
                                    >
                                      {highlightSearchTerm(
                                        displayMessage,
                                        searchTerm,
                                      )}
                                      {segmentIndex < segments.length - 1
                                        ? " "
                                        : ""}
                                    </span>
                                  );
                                },
                              )}
                            </div>
                          </div>

                          {isRight && (
                            <span className="mt-6 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--aive-accent-soft)] text-sm font-bold text-[var(--aive-accent)]">
                              {getInitial(speakerName)}
                            </span>
                          )}
                        </li>
                      );
                    },
                  )}
                </ol>
              )}
            </section>
          </div>
        </main>
      )}

      {phase === "completed" && utterances.length === 0 && (
        <main className="mx-auto max-w-3xl px-5 py-16">
          <section className="rounded-2xl border border-[var(--aive-line)] bg-white p-8 text-center">
            <p className="text-sm text-[var(--aive-mute)]">
              전사는 완료되었지만 표시할 발화 내용이 없습니다.
            </p>
            <button
              type="button"
              onClick={reset}
              className="mt-5 rounded-xl bg-[var(--aive-accent)] px-5 py-3 text-sm font-semibold text-white hover:bg-[var(--aive-accent-strong)]"
            >
              새 인터뷰 전사
            </button>
          </section>
        </main>
      )}

      <footer className="border-t border-[var(--aive-line)] py-6 text-center text-xs text-[var(--aive-mute)]">
        AIVE Voice · RTZR STT OpenAPI 기반 프로토타입
      </footer>
    </div>
  );
}
